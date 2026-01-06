import * as core from '@actions/core'

import type { GitHubAPI } from '../github/api.js'
import type { LLMClient } from '../opencode/llm-client.js'
import type { ReviewExecutor } from '../execution/orchestrator.js'
import type { ReviewConfig } from '../execution/types.js'
import type { StateManager } from '../state/manager.js'
import { logger } from '../utils/logger.js'
import { TaskDetector } from './detector.js'
import { extractTaskInfo, type TaskInfo } from './task-info.js'
import type {
  DisputeTask,
  ExecutionPlan,
  ExecutionResult,
  QuestionTask,
  ReviewTask,
  Task,
  TaskResult
} from './types.js'

export class TaskOrchestrator {
  private taskDetector: TaskDetector
  private workspaceRoot: string

  constructor(
    private config: ReviewConfig,
    private githubApi: GitHubAPI,
    private reviewExecutor: ReviewExecutor,
    private stateManager: StateManager,
    private llmClient: LLMClient
  ) {
    this.taskDetector = new TaskDetector(llmClient, stateManager)
    this.workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()
  }

  async execute(): Promise<ExecutionResult> {
    return await logger.group('Multi-Task Execution', async () => {
      const plan = await this.detectAllTasks()

      core.info(
        `Detected ${plan.tasks.length} tasks to execute: ${this.summarizeTasks(plan)}`
      )

      if (plan.tasks.length === 0) {
        core.info('No tasks to execute')
        return {
          results: [],
          hasBlockingIssues: false,
          totalTasks: 0,
          reviewCompleted: false,
          hadAutoReview: false,
          hadManualReview: false
        }
      }

      const results: TaskResult[] = []
      let hasBlockingIssues = false
      let reviewCompleted = false
      let hadAutoReview = false
      let hadManualReview = false

      for (const task of plan.tasks) {
        const result = await this.executeTask(task)
        results.push(result)

        if (result.blockingIssues > 0) {
          hasBlockingIssues = true
        }

        if (task.type === 'full-review' && result.success) {
          reviewCompleted = true
          // Use affectsMergeGate to determine if this was an auto review
          // This handles both fresh auto reviews and resumed cancelled ones
          if (task.affectsMergeGate) {
            hadAutoReview = true
          } else {
            hadManualReview = true
          }
        }
      }

      return {
        results,
        hasBlockingIssues,
        totalTasks: results.length,
        reviewCompleted,
        hadAutoReview,
        hadManualReview
      }
    })
  }

  private async detectAllTasks(): Promise<ExecutionPlan> {
    const triggerEvent = this.config.execution.mode

    const tasks = await this.taskDetector.detectAllTasks(
      this.githubApi,
      this.config
    )

    return {
      tasks,
      triggeredBy: triggerEvent
    }
  }

  private async executeTask(task: Task): Promise<TaskResult> {
    try {
      switch (task.type) {
        case 'dispute-resolution':
          return await this.executeDisputeTask(task)
        case 'question-answering':
          return await this.executeQuestionTask(task)
        case 'full-review':
          return await this.executeReviewTask(task)
      }
    } catch (error) {
      core.error(`Task execution failed: ${error}`)

      const state = this.reviewExecutor.getState()
      const blockingThreshold = this.config.scoring.blockingThreshold

      let issuesFound = 0
      let blockingIssues = 0

      if (state) {
        const activeThreads = state.threads.filter(
          (t) => t.status !== 'RESOLVED'
        )
        issuesFound = activeThreads.length
        blockingIssues = activeThreads.filter(
          (t) => t.score >= blockingThreshold
        ).length
      }

      return {
        type: task.type,
        success: false,
        issuesFound,
        blockingIssues,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async executeDisputeTask(task: DisputeTask): Promise<TaskResult> {
    return await logger.group(
      `Executing Dispute Resolution (thread ${task.disputeContext.threadId})`,
      async () => {
        try {
          await this.reviewExecutor.executeDisputeResolution(
            task.disputeContext
          )

          return {
            type: 'dispute-resolution',
            success: true,
            issuesFound: 0,
            blockingIssues: 0
          }
        } catch (error) {
          throw new Error(
            `Dispute resolution failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  }

  private async executeQuestionTask(task: QuestionTask): Promise<TaskResult> {
    return await logger.group(
      `Executing Question Answering (comment ${task.questionContext.commentId})`,
      async () => {
        try {
          await this.stateManager.trackQuestionTask(
            task.questionContext.commentId,
            task.questionContext.author,
            task.questionContext.question,
            task.questionContext.commentId,
            task.questionContext.fileContext
          )

          await this.stateManager.markQuestionInProgress(
            task.questionContext.commentId
          )

          // Pass the question context and conversation history to the orchestrator
          const answer = await this.reviewExecutor.executeQuestionAnswering(
            task.questionContext,
            task.conversationHistory
          )

          // Post the answer as a reply to the original comment
          const formattedAnswer = this.formatQuestionAnswer(
            task.questionContext,
            answer
          )
          await this.githubApi.replyToIssueComment(
            task.questionContext.commentId,
            formattedAnswer
          )

          core.info(
            `Posted answer to question ${task.questionContext.commentId}`
          )

          await this.stateManager.markQuestionAnswered(
            task.questionContext.commentId
          )

          return {
            type: 'question-answering',
            success: true,
            issuesFound: 0,
            blockingIssues: 0
          }
        } catch (error) {
          throw new Error(
            `Question answering failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  }

  private formatQuestionAnswer(
    context: QuestionTask['questionContext'],
    answer: string
  ): string {
    const rmcocBlock = {
      type: 'question-answer',
      reply_to_comment_id: context.commentId,
      question_hash: context.questionHash,
      answered_at: new Date().toISOString()
    }

    return `${answer}

---
*Answered by review-my-code-bot*

\`\`\`rmcoc
${JSON.stringify(rmcocBlock, null, 2)}
\`\`\``
  }

  private async executeReviewTask(task: ReviewTask): Promise<TaskResult> {
    return await logger.group(
      `Executing Full Review (${task.isManual ? 'manual' : 'auto'})`,
      async () => {
        try {
          // Load and validate task info from PR description
          const taskInfo = await this.loadAndValidateTaskInfo()

          if (task.isManual && task.triggerCommentId) {
            await this.stateManager.trackManualReviewRequest(
              task.triggerCommentId,
              'unknown',
              task.triggerCommentId
            )
            await this.stateManager.markManualReviewInProgress(
              task.triggerCommentId
            )

            // Post visible start comment if enabled
            if (
              this.config.execution.manualTriggerComments.enableStartComment
            ) {
              await this.githubApi.replyToIssueComment(
                task.triggerCommentId,
                "🔍 **Review started.** I'm analyzing this PR now..."
              )
            }
          }

          // For auto reviews, record the trigger so it can be resumed if cancelled
          if (!task.isManual && task.triggeredBy !== 'manual-request') {
            const prInfo = await this.githubApi.getPRInfo()
            await this.stateManager.recordAutoReviewTrigger(
              task.triggeredBy as 'opened' | 'synchronize' | 'ready_for_review',
              prInfo.head.sha
            )
          }

          const reviewOutput = await this.reviewExecutor.executeReview(taskInfo)

          if (task.isManual && task.triggerCommentId) {
            await this.stateManager.markManualReviewCompleted(
              task.triggerCommentId
            )

            // Post visible end comment if enabled
            if (this.config.execution.manualTriggerComments.enableEndComment) {
              const endMessage = this.formatManualReviewEndComment(reviewOutput)
              await this.githubApi.replyToIssueComment(
                task.triggerCommentId,
                endMessage
              )
            }
          }

          // For auto reviews, clear the trigger since review completed
          if (!task.isManual && task.triggeredBy !== 'manual-request') {
            await this.stateManager.clearAutoReviewTrigger()
          }

          // A review is successful if it completed, regardless of whether it found
          // blocking issues. The status 'has_blocking_issues' means the review ran
          // successfully but found problems - that's still a successful execution.
          // Only 'failed' status indicates the review itself failed to run.
          const reviewSucceeded =
            reviewOutput.status === 'completed' ||
            reviewOutput.status === 'has_blocking_issues'

          return {
            type: 'full-review',
            success: reviewSucceeded,
            issuesFound: reviewOutput.issuesFound,
            blockingIssues: reviewOutput.blockingIssues
          }
        } catch (error) {
          throw new Error(
            `Review execution failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  }

  private formatManualReviewEndComment(reviewOutput: {
    status: string
    issuesFound: number
    blockingIssues: number
  }): string {
    if (reviewOutput.issuesFound === 0) {
      return '✅ **Review complete.** No issues found!'
    }

    if (reviewOutput.blockingIssues > 0) {
      return (
        `⚠️ **Review complete.** Found ${reviewOutput.issuesFound} issue(s), ` +
        `including ${reviewOutput.blockingIssues} blocking issue(s). ` +
        `Please review the comments above.`
      )
    }

    return (
      `📝 **Review complete.** Found ${reviewOutput.issuesFound} issue(s). ` +
      `Please review the comments above.`
    )
  }

  private async loadAndValidateTaskInfo(): Promise<TaskInfo | undefined> {
    const prDescription = await this.githubApi.getPRDescription()
    const requireTaskInfo = this.config.taskInfo.requireTaskInfoInPrDesc

    if (!requireTaskInfo && !prDescription.trim()) {
      logger.debug('PR description is empty, but task info not required')
      return undefined
    }

    const prFiles = await this.githubApi.getPRFiles()

    const taskInfo = await extractTaskInfo(
      prDescription,
      this.workspaceRoot,
      this.llmClient,
      requireTaskInfo,
      prFiles
    )

    if (requireTaskInfo && !taskInfo.isSufficient) {
      const reason =
        taskInfo.insufficiencyReason || 'PR description is insufficient'

      logger.error(`Task info validation failed: ${reason}`)

      await this.postPRDescriptionValidationFailure(reason)

      throw new Error(`Task info validation failed: ${reason}`)
    }

    if (taskInfo.description.trim()) {
      logger.info('Task info loaded from PR description')
      if (taskInfo.linkedFiles.length > 0) {
        logger.info(
          `Included content from ${taskInfo.linkedFiles.length} linked file(s): ${taskInfo.linkedFiles.map((f) => f.path).join(', ')}`
        )
      }
    }

    return taskInfo
  }

  private async postPRDescriptionValidationFailure(
    reason: string
  ): Promise<void> {
    const commentBody = `❌ **Review blocked: Insufficient task information**

${reason}

Please update your PR description to include:
- **What** is being changed or added
- **Why** the change is needed (motivation/problem being solved)

You can also link to task specification files in the repository (e.g., \`[Task spec](./docs/task.md)\`).

Once the description is updated, trigger a new review.`

    const assessment = {
      finding: 'PR description is insufficient',
      assessment: reason,
      score: 10
    }

    const rmcocBlock = `\`\`\`rmcoc\n${JSON.stringify(assessment, null, 2)}\n\`\`\``
    const fullComment = `${commentBody}\n\n---\n\n${rmcocBlock}`

    const commentId = await this.githubApi.postIssueComment(fullComment)

    await this.reviewExecutor.addThread({
      id: commentId,
      file: 'PR_DESCRIPTION',
      line: 0,
      status: 'PENDING',
      score: 10,
      assessment,
      original_comment: {
        author: 'opencode-reviewer[bot]',
        body: commentBody,
        timestamp: new Date().toISOString()
      }
    })

    logger.info('Posted PR description validation failure as blocking issue')
  }

  private summarizeTasks(plan: ExecutionPlan): string {
    const counts = {
      disputes: 0,
      questions: 0,
      reviews: 0
    }

    for (const task of plan.tasks) {
      switch (task.type) {
        case 'dispute-resolution':
          counts.disputes++
          break
        case 'question-answering':
          counts.questions++
          break
        case 'full-review':
          counts.reviews++
          break
      }
    }

    const parts: string[] = []
    if (counts.disputes > 0) {
      parts.push(`${counts.disputes} dispute${counts.disputes > 1 ? 's' : ''}`)
    }
    if (counts.questions > 0) {
      parts.push(
        `${counts.questions} question${counts.questions > 1 ? 's' : ''}`
      )
    }
    if (counts.reviews > 0) {
      parts.push(`${counts.reviews} review${counts.reviews > 1 ? 's' : ''}`)
    }

    return parts.join(', ')
  }
}
