import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { GitHubAPI } from '../github/api.js'
import type {
  ProcessState,
  ReviewThread,
  StateManager
} from '../state/manager.js'
import type { OpenCodeClient } from '../opencode/client.js'

import { OrchestratorError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import {
  type PromptInjectionDetector,
  createPromptInjectionDetector
} from '../utils/prompt-injection-detector.js'
import { REVIEW_PROMPTS, buildSecuritySensitivity } from './prompts.js'
import type {
  ConversationMessage,
  DisputeContext,
  QuestionContext
} from '../task/types.js'
import type { TaskInfo } from '../task/task-info.js'
import type { PassResult, ReviewConfig, ReviewOutput } from './types.js'

type PassNumber = 1 | 2 | 3

type ReviewPhase =
  | 'idle'
  | 'fix-verification'
  | 'dispute-resolution'
  | 'multi-pass-review'

export class ReviewExecutor {
  private injectionDetector: PromptInjectionDetector
  private passResults: PassResult[] = []
  private processState: ProcessState | null = null
  private currentSessionId: string | null = null
  private currentPhase: ReviewPhase = 'idle'
  private passCompletionResolvers: Map<number, () => void> = new Map()
  private currentTaskInfo: TaskInfo | undefined = undefined

  constructor(
    private opencode: OpenCodeClient,
    private stateManager: StateManager,
    private github: GitHubAPI,
    private config: ReviewConfig,
    private workspaceRoot: string
  ) {
    this.injectionDetector = createPromptInjectionDetector(
      config.opencode.apiKey,
      config.security.injectionVerificationModel,
      config.security.injectionDetectionEnabled
    )
  }

  async executeReview(taskInfo?: TaskInfo): Promise<ReviewOutput> {
    return await logger.group('Executing Multi-Pass Review', async () => {
      this.currentTaskInfo = taskInfo
      if (taskInfo?.description.trim()) {
        logger.info('Task info provided from PR description')
      }
      logger.info(
        `Review configuration: timeout=${this.config.review.timeoutMs / 1000}s, maxRetries=${this.config.review.maxRetries}`
      )

      let attempts = 0

      while (attempts <= this.config.review.maxRetries) {
        try {
          attempts++

          if (attempts > 1) {
            logger.warning(
              `Retrying entire review session (attempt ${attempts}/${this.config.review.maxRetries + 1})`
            )

            await this.resetSession()
            this.passResults = []
          }

          this.processState = await this.stateManager.getOrCreateState()
          logger.info(
            `Loaded review state with ${this.processState.threads.length} existing threads`
          )

          const hasExistingIssues = this.processState.threads.some(
            (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
          )

          if (hasExistingIssues) {
            logger.info(
              'Found existing unresolved issues - running fix verification and dispute resolution'
            )
            await this.executeDisputeResolution()
            await this.executeFixVerification()
          }

          await this.executeReviewWithTimeout()

          const output = this.buildReviewOutput()
          logger.info(`Review completed: ${output.issuesFound} issues found`)

          return output
        } catch (error) {
          if (attempts > this.config.review.maxRetries) {
            throw new OrchestratorError(
              `Review failed after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
              error instanceof Error ? error : undefined
            )
          }

          logger.warning(
            `Review attempt ${attempts} failed: ${error instanceof Error ? error.message : String(error)}`
          )

          await this.delay(5000 * attempts)
        }
      }

      throw new OrchestratorError('Review failed - max retries exceeded')
    })
  }

  private async executeReviewWithTimeout(): Promise<void> {
    const timeoutMs = this.config.review.timeoutMs

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new OrchestratorError(
            `Review timeout: did not complete within ${timeoutMs / 1000}s`
          )
        )
      }, timeoutMs)
    })

    await Promise.race([this.executeMultiPassReview(), timeoutPromise])
  }

  private async executeMultiPassReview(): Promise<void> {
    this.currentPhase = 'multi-pass-review'
    this.passResults = []

    const files = await this.github.getPRFiles()
    const securitySensitivity = await this.detectSecuritySensitivity()

    // Log detailed file information for debugging
    logger.info(`Fetched ${files.length} changed files for review`)
    logger.info('=== FILES TO BE REVIEWED ===')
    for (const file of files) {
      logger.info(`  - ${file}`)
    }
    logger.info('=== END FILES LIST ===')

    // Log PR diff range info
    const prInfo = await this.github.getPRInfo()
    logger.info(
      `PR diff range: ${prInfo.base.sha.substring(0, 7)}...${prInfo.head.sha.substring(0, 7)}`
    )
    logger.info(
      `Base branch: ${prInfo.base.ref}, Head branch: ${prInfo.head.ref}`
    )

    logger.info(
      'Starting 3-pass review in single OpenCode session (context preserved across all passes)'
    )

    const taskInfoContext =
      this.currentTaskInfo?.description.trim() || undefined
    const linkedFilePaths = this.currentTaskInfo?.linkedFiles.map((f) => f.path)

    if (taskInfoContext) {
      logger.info('Task context from PR description will be included in review')
      if (linkedFilePaths && linkedFilePaths.length > 0) {
        logger.info(`Referenced task files: ${linkedFilePaths.join(', ')}`)
      }
    }

    await this.executePass(
      1,
      REVIEW_PROMPTS.PASS_1(files, taskInfoContext, linkedFilePaths)
    )
    await this.executePass(
      2,
      REVIEW_PROMPTS.PASS_2(taskInfoContext, linkedFilePaths)
    )
    await this.executePass(
      3,
      REVIEW_PROMPTS.PASS_3(securitySensitivity, taskInfoContext)
    )

    logger.info('All 3 passes completed in single session')

    this.currentPhase = 'idle'
  }

  private async executeFixVerification(): Promise<void> {
    await logger.group('Fix Verification', async () => {
      if (!this.processState) {
        throw new OrchestratorError('Review state not loaded')
      }

      this.currentPhase = 'fix-verification'

      const previousIssues = this.formatPreviousIssues()
      const newCommits = await this.getNewCommitsSummary()

      const prompt = REVIEW_PROMPTS.FIX_VERIFICATION(previousIssues, newCommits)

      logger.info(
        `Verifying ${this.processState.threads.filter((t) => t.status !== 'RESOLVED').length} unresolved issues`
      )

      await this.sendPromptToOpenCode(prompt)

      this.currentPhase = 'idle'
    })
  }

  async executeDisputeResolution(
    disputeContext?: DisputeContext
  ): Promise<void> {
    await logger.group('Dispute Resolution', async () => {
      this.currentPhase = 'dispute-resolution'

      if (disputeContext) {
        await this.handleSingleDispute(disputeContext)
        this.currentPhase = 'idle'
        return
      }

      const threadsWithReplies =
        await this.stateManager.getThreadsWithDeveloperReplies()

      if (threadsWithReplies.length === 0) {
        logger.info('No developer replies to evaluate')
        return
      }

      logger.info(
        `Evaluating ${threadsWithReplies.length} threads with developer replies`
      )

      for (const thread of threadsWithReplies) {
        const replies = thread.developer_replies
        if (!replies || replies.length === 0) {
          continue
        }

        const latestReply = replies[replies.length - 1]
        if (!latestReply) {
          continue
        }

        let sanitizedReplyBody: string
        try {
          sanitizedReplyBody = await this.sanitizeExternalInput(
            latestReply.body,
            `dispute reply from ${latestReply.author}`
          )
        } catch (error) {
          logger.error(
            `Skipping thread ${thread.id} due to blocked content: ${error instanceof Error ? error.message : String(error)}`
          )
          continue
        }

        const classification = await this.stateManager.classifyDeveloperReply(
          thread.assessment.finding,
          sanitizedReplyBody
        )

        logger.info(
          `Thread ${thread.id} has ${classification} response from ${latestReply.author}`
        )

        let prompt: string

        if (classification === 'question') {
          logger.info(
            'Developer asked for clarification - using Q&A mode for detailed explanation'
          )
          prompt = REVIEW_PROMPTS.CLARIFY_REVIEW_FINDING(
            thread.assessment.finding,
            thread.assessment.assessment,
            sanitizedReplyBody,
            thread.file,
            thread.line
          )
        } else {
          prompt = REVIEW_PROMPTS.DISPUTE_EVALUATION(
            thread.id,
            thread.assessment.finding,
            thread.assessment.assessment,
            thread.score,
            thread.file,
            thread.line,
            sanitizedReplyBody,
            classification,
            this.config.dispute.enableHumanEscalation
          )
        }

        await this.sendPromptToOpenCode(prompt)
      }

      this.currentPhase = 'idle'
    })
  }

  private async handleSingleDispute(
    disputeContext: DisputeContext
  ): Promise<void> {
    const { threadId, replyBody, replyAuthor, file, line } = disputeContext

    logger.info(`Processing reply from ${replyAuthor} on thread ${threadId}`)
    logger.info(`File: ${file}:${line || 'N/A'}`)

    const sanitizedReplyBody = await this.sanitizeExternalInput(
      replyBody,
      `dispute reply from ${replyAuthor}`
    )

    const state = await this.stateManager.getOrCreateState()
    const thread = state.threads.find((t) => t.id === threadId)

    if (!thread) {
      logger.warning(
        `Thread ${threadId} not found in state. This may be a reply to a non-bot comment.`
      )
      return
    }

    if (thread.status === 'RESOLVED') {
      logger.info(`Thread ${threadId} is already resolved, skipping.`)
      return
    }

    const classification = await this.stateManager.classifyDeveloperReply(
      thread.assessment.finding,
      sanitizedReplyBody
    )

    logger.info(
      `Classified reply as: ${classification} (thread ${threadId}, author: ${replyAuthor})`
    )

    let prompt: string

    if (classification === 'question') {
      logger.info(
        'Developer asked for clarification - using Q&A mode for detailed explanation'
      )
      prompt = REVIEW_PROMPTS.CLARIFY_REVIEW_FINDING(
        thread.assessment.finding,
        thread.assessment.assessment,
        sanitizedReplyBody,
        thread.file,
        thread.line
      )
    } else {
      prompt = REVIEW_PROMPTS.DISPUTE_EVALUATION(
        thread.id,
        thread.assessment.finding,
        thread.assessment.assessment,
        thread.score,
        thread.file,
        thread.line,
        sanitizedReplyBody,
        classification,
        this.config.dispute.enableHumanEscalation
      )
    }

    await this.sendPromptToOpenCode(prompt)
  }

  private async executePass(
    passNumber: PassNumber,
    prompt: string
  ): Promise<void> {
    await logger.group(`Pass ${passNumber} of 3`, async () => {
      const startTime = Date.now()

      logger.info(`Starting pass ${passNumber}`)
      logger.debug(`Pass ${passNumber} prompt length: ${prompt.length} chars`)

      // Create a promise that resolves when submit_pass_results is called
      const passCompletionPromise = new Promise<void>((resolve) => {
        this.passCompletionResolvers.set(passNumber, resolve)
      })

      // Send the prompt and wait for idle (with grace period)
      await this.sendPromptToOpenCode(prompt)

      // Check if submit_pass_results was already called during execution
      // This is the common case - model calls the tool then goes idle
      if (!this.isPassCompleted(passNumber)) {
        // Model went idle without calling submit_pass_results
        // Wait a bit longer in case it resumes, but don't wait forever
        const PASS_COMPLETION_TIMEOUT_MS = 30000
        logger.info(
          `Pass ${passNumber}: session idle but submit_pass_results not called, waiting up to ${PASS_COMPLETION_TIMEOUT_MS / 1000}s...`
        )

        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), PASS_COMPLETION_TIMEOUT_MS)
        })

        const result = await Promise.race([
          passCompletionPromise.then(() => 'completed' as const),
          timeoutPromise
        ])

        if (result === 'timeout') {
          logger.warning(
            `Pass ${passNumber}: timed out waiting for submit_pass_results, proceeding anyway`
          )
        }
      }

      // Clean up the resolver
      this.passCompletionResolvers.delete(passNumber)

      const duration = Date.now() - startTime
      logger.info(`Pass ${passNumber} completed in ${duration}ms`)
    })
  }

  private async ensureSession(): Promise<string> {
    if (this.currentSessionId) {
      return this.currentSessionId
    }

    logger.info('Creating new OpenCode review session')
    const session = await this.opencode.createSession('PR Code Review')
    this.currentSessionId = session.id
    logger.info(`Created session: ${session.id}`)

    logger.info('Injecting system prompt into session')
    await this.opencode.sendSystemPrompt(session.id, REVIEW_PROMPTS.SYSTEM)
    logger.info('System prompt injected successfully')

    return session.id
  }

  private async resetSession(): Promise<void> {
    if (this.currentSessionId) {
      logger.info(`Deleting old session: ${this.currentSessionId}`)
      try {
        await this.opencode.deleteSession(this.currentSessionId)
      } catch (error) {
        logger.warning(
          `Failed to delete session ${this.currentSessionId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      this.currentSessionId = null
    }

    await this.ensureSession()
  }

  private async sendPromptToOpenCode(prompt: string): Promise<void> {
    const sessionId = await this.ensureSession()
    logger.debug(`Sending prompt to session ${sessionId}`)
    await this.opencode.sendPrompt(sessionId, prompt)
  }

  async cleanup(): Promise<void> {
    if (this.currentSessionId) {
      logger.info(`Cleaning up session: ${this.currentSessionId}`)
      try {
        await this.opencode.deleteSession(this.currentSessionId)
        this.currentSessionId = null
      } catch (error) {
        logger.warning(
          `Failed to cleanup session: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  isPassCompleted(passNumber: number): boolean {
    return this.passResults.some((p) => p.passNumber === passNumber)
  }

  isInMultiPassReview(): boolean {
    return this.currentPhase === 'multi-pass-review'
  }

  recordPassCompletion(result: PassResult): void {
    logger.info(
      `Pass ${result.passNumber} completed: ${result.hasBlockingIssues ? 'HAS BLOCKING ISSUES' : 'no blocking issues'}`
    )

    const existingIndex = this.passResults.findIndex(
      (p) => p.passNumber === result.passNumber
    )

    if (existingIndex >= 0) {
      this.passResults[existingIndex] = result
    } else {
      this.passResults.push(result)
    }

    // Resolve the pass completion promise if one is waiting
    const resolver = this.passCompletionResolvers.get(result.passNumber)
    if (resolver) {
      logger.debug(`Resolving pass ${result.passNumber} completion promise`)
      resolver()
    }

    if (this.processState) {
      this.stateManager.recordPassCompletion(result).catch((error) => {
        logger.warning(`Failed to record pass completion: ${error}`)
      })
    }
  }

  findDuplicateThread(
    file: string,
    line: number,
    finding: string
  ): ReviewThread | null {
    return this.stateManager.findDuplicateThread(file, line, finding)
  }

  private async detectSecuritySensitivity(): Promise<string> {
    try {
      const packageJsonPath = join(this.workspaceRoot, 'package.json')
      const readmePath = join(this.workspaceRoot, 'README.md')

      let packageJson: Record<string, unknown> | null = null
      let readme: string | null = null

      try {
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8')
        packageJson = JSON.parse(packageJsonContent)
      } catch {
        logger.debug('No package.json found or failed to parse')
      }

      try {
        readme = await readFile(readmePath, 'utf-8')
      } catch {
        logger.debug('No README.md found')
      }

      const sensitivity = buildSecuritySensitivity(packageJson, readme)
      logger.info(`Security sensitivity: ${sensitivity}`)

      return sensitivity
    } catch (error) {
      logger.warning(
        `Failed to detect security sensitivity: ${error instanceof Error ? error.message : String(error)}`
      )
      return 'Standard - no special sensitivity detected'
    }
  }

  private formatPreviousIssues(): string {
    if (!this.processState) {
      return 'No previous issues'
    }

    const pendingCount = this.processState.threads.filter(
      (t) => t.status === 'PENDING'
    ).length
    const disputedCount = this.processState.threads.filter(
      (t) => t.status === 'DISPUTED'
    ).length

    const issueList = this.processState.threads
      .filter((t) => t.status !== 'RESOLVED')
      .map((thread) => {
        return `- **${thread.file}:${thread.line}** [${thread.status}] (score: ${thread.score})
  Thread ID: ${thread.id}
  Finding: ${thread.assessment.finding}
  Assessment: ${thread.assessment.assessment}`
      })
      .join('\n\n')

    return `Previous review had ${pendingCount} PENDING and ${disputedCount} DISPUTED issues:

${issueList}`
  }

  private async getNewCommitsSummary(): Promise<string> {
    if (!this.processState) {
      return 'No commit history available'
    }

    try {
      const files = await this.github.getPRFiles()

      return `New commits since last review:
- Last reviewed commit: ${this.processState.lastCommitSha.substring(0, 7)}
- Current HEAD: New changes detected
- Files changed: ${files.length}
- Changed files: ${files.join(', ')}

**Important:** Use OpenCode tools (read, grep, glob) to verify if previous issues are addressed.
Cross-file fixes are possible (e.g., issue in file_A.ts fixed by change in file_B.ts).

Use the \`read\` tool to examine the changed files and verify if issues have been fixed.`
    } catch (error) {
      logger.warning(
        `Failed to fetch new commits summary: ${error instanceof Error ? error.message : String(error)}`
      )

      return `New commits since last review:
- Last reviewed commit: ${this.processState.lastCommitSha.substring(0, 7)}
- Unable to fetch file list - use OpenCode tools to explore`
    }
  }

  private buildReviewOutput(): ReviewOutput {
    if (!this.processState) {
      return {
        status: 'failed',
        issuesFound: 0,
        blockingIssues: 0
      }
    }

    const activeThreads = this.processState.threads.filter(
      (t) => t.status !== 'RESOLVED'
    )

    const blockingCount = activeThreads.filter(
      (t) => t.score >= this.config.scoring.blockingThreshold
    ).length

    const hasBlocking =
      blockingCount > 0 || this.passResults.some((p) => p.hasBlockingIssues)

    return {
      status: hasBlocking ? 'has_blocking_issues' : 'completed',
      issuesFound: activeThreads.length,
      blockingIssues: blockingCount
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async sanitizeExternalInput(
    input: string,
    context: string
  ): Promise<string> {
    const result = await this.injectionDetector.detectAndSanitize(input)

    if (result.isConfirmedInjection) {
      logger.error(
        `Blocked prompt injection in ${context}. Threats: ${result.detectedThreats.join(', ')}`
      )
      throw new OrchestratorError(
        `Content blocked: potential prompt injection detected in ${context}`
      )
    }

    if (result.isSuspicious) {
      logger.warning(
        `Suspicious content in ${context} passed after LLM verification. Threats checked: ${result.detectedThreats.join(', ')}`
      )
    }

    return result.sanitizedInput
  }

  async updateThreadStatus(
    threadId: string,
    status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  ): Promise<void> {
    await this.stateManager.updateThreadStatus(threadId, status)

    if (this.processState) {
      const thread = this.processState.threads.find((t) => t.id === threadId)
      if (thread) {
        thread.status = status
      }
    }
  }

  async addThread(thread: ReviewThread): Promise<void> {
    await this.stateManager.addThread(thread)

    if (this.processState) {
      const existingIndex = this.processState.threads.findIndex(
        (t) => t.id === thread.id
      )
      if (existingIndex >= 0) {
        this.processState.threads[existingIndex] = thread
      } else {
        this.processState.threads.push(thread)
      }
    }
  }

  getState(): ProcessState | null {
    return this.processState
  }

  getConfig(): ReviewConfig {
    return this.config
  }

  async getThreadsRequiringVerification(): Promise<ReviewThread[]> {
    if (!this.processState) {
      return []
    }

    return this.processState.threads.filter(
      (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
    )
  }

  async getResolvedThreadsCount(): Promise<number> {
    if (!this.processState) {
      return 0
    }

    return this.processState.threads.filter((t) => t.status === 'RESOLVED')
      .length
  }

  async executeQuestionAnswering(
    questionContext?: QuestionContext,
    conversationHistory?: ConversationMessage[]
  ): Promise<string> {
    return await logger.group('Answering Developer Question', async () => {
      // Use passed context or fall back to config (for backward compatibility)
      const context = questionContext || this.config.execution.questionContext

      if (!context) {
        throw new OrchestratorError('No question context provided')
      }

      const sanitizedQuestion = await this.sanitizeExternalInput(
        context.question,
        `question from ${context.author}`
      )

      logger.info(`Question from ${context.author}: "${sanitizedQuestion}"`)

      if (context.fileContext) {
        logger.info(
          `Context: ${context.fileContext.path}${context.fileContext.line ? `:${context.fileContext.line}` : ''}`
        )
      }

      if (conversationHistory && conversationHistory.length > 0) {
        logger.info(
          `Including ${conversationHistory.length} prior messages in conversation`
        )
      }

      const prContext = await this.github.getPRContext()

      const sessionId = await this.ensureSession()

      logger.info('Injecting question-answering system prompt')
      await this.opencode.sendSystemPrompt(
        sessionId,
        REVIEW_PROMPTS.QUESTION_ANSWERING_SYSTEM
      )

      // Build prompt based on question type
      let prompt: string
      if (context.requiresFreshAnalysis) {
        // For summary/overview questions, use fresh analysis prompt
        // that instructs the agent to run git diff and examine actual changes
        logger.info('Using fresh analysis prompt (summary-type question)')
        prompt = REVIEW_PROMPTS.ANSWER_FRESH_ANALYSIS_QUESTION(
          sanitizedQuestion,
          context.author,
          prContext.files.length > 0 ? prContext : undefined
        )
      } else if (conversationHistory && conversationHistory.length > 0) {
        prompt = REVIEW_PROMPTS.ANSWER_FOLLOWUP_QUESTION(
          sanitizedQuestion,
          context.author,
          conversationHistory,
          context.fileContext,
          prContext.files.length > 0 ? prContext : undefined
        )
      } else {
        prompt = REVIEW_PROMPTS.ANSWER_QUESTION(
          sanitizedQuestion,
          context.author,
          context.fileContext,
          prContext.files.length > 0 ? prContext : undefined
        )
      }

      logger.info('Sending question to OpenCode agent')

      const response = await this.opencode.sendPromptAndGetResponse(
        sessionId,
        prompt
      )

      logger.info('Received answer from agent')
      logger.debug(`Answer length: ${response.length} characters`)

      return response
    })
  }
}
