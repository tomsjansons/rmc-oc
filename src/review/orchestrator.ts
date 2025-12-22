import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { GitHubAPI } from '../github/api.js'
import {
  type ReviewState,
  type ReviewThread,
  StateManager
} from '../github/state.js'
import type { OpenCodeClient } from '../opencode/client.js'
import { OrchestratorError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { REVIEW_PROMPTS, buildSecuritySensitivity } from './prompts.js'
import type { PassResult, ReviewConfig, ReviewOutput } from './types.js'

type PassNumber = 1 | 2 | 3 | 4

export class ReviewOrchestrator {
  private stateManager: StateManager
  private passResults: PassResult[] = []
  private reviewState: ReviewState | null = null
  private currentSessionId: string | null = null

  constructor(
    private opencode: OpenCodeClient,
    private github: GitHubAPI,
    private config: ReviewConfig,
    private workspaceRoot: string
  ) {
    this.stateManager = new StateManager(config)
  }

  async executeReview(): Promise<ReviewOutput> {
    return await logger.group('Executing Multi-Pass Review', async () => {
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

          this.reviewState = await this.stateManager.getOrCreateState()
          logger.info(
            `Loaded review state with ${this.reviewState.threads.length} existing threads`
          )

          const hasExistingIssues = this.reviewState.threads.some(
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
    const files = await this.github.getPRFiles()
    const securitySensitivity = await this.detectSecuritySensitivity()

    logger.info(`Fetched ${files.length} changed files`)
    logger.info(
      'Starting 3-pass review in single OpenCode session (context preserved across all passes)'
    )

    await this.executePass(1, REVIEW_PROMPTS.PASS_1(files))
    await this.executePass(2, REVIEW_PROMPTS.PASS_2())
    await this.executePass(3, REVIEW_PROMPTS.PASS_3(securitySensitivity))

    logger.info('All 3 passes completed in single session')
  }

  private async executeFixVerification(): Promise<void> {
    await logger.group('Fix Verification', async () => {
      if (!this.reviewState) {
        throw new OrchestratorError('Review state not loaded')
      }

      const previousIssues = this.formatPreviousIssues()
      const newCommits = await this.getNewCommitsSummary()

      const prompt = REVIEW_PROMPTS.FIX_VERIFICATION(previousIssues, newCommits)

      logger.info(
        `Verifying ${this.reviewState.threads.filter((t) => t.status !== 'RESOLVED').length} unresolved issues`
      )

      await this.sendPromptToOpenCode(prompt)
    })
  }

  async executeDisputeResolution(): Promise<void> {
    await logger.group('Dispute Resolution', async () => {
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

        const classification = await this.stateManager.classifyDeveloperReply(
          thread.assessment.finding,
          latestReply.body
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
            latestReply.body,
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
            latestReply.body,
            classification,
            this.config.dispute.enableHumanEscalation
          )
        }

        await this.sendPromptToOpenCode(prompt)
      }
    })
  }

  private async executePass(
    passNumber: PassNumber,
    prompt: string
  ): Promise<void> {
    await logger.group(`Pass ${passNumber} of 4`, async () => {
      const startTime = Date.now()

      logger.info(`Starting pass ${passNumber}`)
      logger.debug(`Pass ${passNumber} prompt length: ${prompt.length} chars`)

      await this.sendPromptToOpenCode(prompt)

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

  recordPassCompletion(result: PassResult): void {
    logger.info(
      `Pass ${result.passNumber} completed: ${result.hasBlockingIssues ? 'HAS BLOCKING ISSUES' : 'no blocking issues'}`
    )
    logger.debug(`Pass ${result.passNumber} summary: ${result.summary}`)

    const existingIndex = this.passResults.findIndex(
      (p) => p.passNumber === result.passNumber
    )

    if (existingIndex >= 0) {
      this.passResults[existingIndex] = result
    } else {
      this.passResults.push(result)
    }

    if (this.reviewState) {
      this.stateManager
        .recordPassCompletion({
          number: result.passNumber,
          summary: result.summary,
          completed: true,
          has_blocking_issues: result.hasBlockingIssues
        })
        .catch((error) => {
          logger.warning(`Failed to record pass completion: ${error}`)
        })
    }
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
    if (!this.reviewState) {
      return 'No previous issues'
    }

    const pendingCount = this.reviewState.threads.filter(
      (t) => t.status === 'PENDING'
    ).length
    const disputedCount = this.reviewState.threads.filter(
      (t) => t.status === 'DISPUTED'
    ).length

    const issueList = this.reviewState.threads
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
    if (!this.reviewState) {
      return 'No commit history available'
    }

    try {
      const files = await this.github.getPRFiles()

      return `New commits since last review:
- Last reviewed commit: ${this.reviewState.lastCommitSha.substring(0, 7)}
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
- Last reviewed commit: ${this.reviewState.lastCommitSha.substring(0, 7)}
- Unable to fetch file list - use OpenCode tools to explore`
    }
  }

  private buildReviewOutput(): ReviewOutput {
    if (!this.reviewState) {
      return {
        status: 'failed',
        issuesFound: 0,
        blockingIssues: 0
      }
    }

    const activeThreads = this.reviewState.threads.filter(
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

  async updateThreadStatus(
    threadId: string,
    status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  ): Promise<void> {
    await this.stateManager.updateThreadStatus(threadId, status)

    if (this.reviewState) {
      const thread = this.reviewState.threads.find((t) => t.id === threadId)
      if (thread) {
        thread.status = status
      }
    }
  }

  async addThread(thread: ReviewThread): Promise<void> {
    await this.stateManager.addThread(thread)

    if (this.reviewState) {
      const existingIndex = this.reviewState.threads.findIndex(
        (t) => t.id === thread.id
      )
      if (existingIndex >= 0) {
        this.reviewState.threads[existingIndex] = thread
      } else {
        this.reviewState.threads.push(thread)
      }
    }
  }

  getState(): ReviewState | null {
    return this.reviewState
  }

  getConfig(): ReviewConfig {
    return this.config
  }

  async getThreadsRequiringVerification(): Promise<ReviewThread[]> {
    if (!this.reviewState) {
      return []
    }

    return this.reviewState.threads.filter(
      (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
    )
  }

  async getResolvedThreadsCount(): Promise<number> {
    if (!this.reviewState) {
      return 0
    }

    return this.reviewState.threads.filter((t) => t.status === 'RESOLVED')
      .length
  }

  async executeQuestionAnswering(): Promise<string> {
    return await logger.group('Answering Developer Question', async () => {
      const questionContext = this.config.execution.questionContext

      if (!questionContext) {
        throw new OrchestratorError('No question context provided')
      }

      logger.info(
        `Question from ${questionContext.author}: "${questionContext.question}"`
      )

      if (questionContext.fileContext) {
        logger.info(
          `Context: ${questionContext.fileContext.path}${questionContext.fileContext.line ? `:${questionContext.fileContext.line}` : ''}`
        )
      }

      const prContext = await this.github.getPRContext()

      const sessionId = await this.ensureSession()

      logger.info('Injecting question-answering system prompt')
      await this.opencode.sendSystemPrompt(
        sessionId,
        REVIEW_PROMPTS.QUESTION_ANSWERING_SYSTEM
      )

      const prompt = REVIEW_PROMPTS.ANSWER_QUESTION(
        questionContext.question,
        questionContext.author,
        questionContext.fileContext,
        prContext.files.length > 0 ? prContext : undefined
      )

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
