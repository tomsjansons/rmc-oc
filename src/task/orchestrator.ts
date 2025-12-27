import * as core from '@actions/core'

import type { GitHubAPI } from '../github/api.js'
import type { LLMClient } from '../opencode/llm-client.js'
import type { ReviewOrchestrator } from '../review/orchestrator.js'
import type { ReviewConfig } from '../review/types.js'
import type { StateManager } from '../state/manager.js'
import { logger } from '../utils/logger.js'
import { TaskDetector } from './detector.js'
import type {
  DisputeTask,
  ExecutionPlan,
  ExecutionResult,
  QuestionTask,
  ReviewTask,
  Task,
  TaskResult
} from './types.js'

export class ExecutionOrchestrator {
  private taskDetector: TaskDetector

  constructor(
    private config: ReviewConfig,
    private githubApi: GitHubAPI,
    private reviewOrchestrator: ReviewOrchestrator,
    private stateManager: StateManager,
    llmClient: LLMClient
  ) {
    this.taskDetector = new TaskDetector(llmClient)
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
          reviewCompleted: false
        }
      }

      const results: TaskResult[] = []
      let hasBlockingIssues = false
      let reviewCompleted = false

      for (const task of plan.tasks) {
        const result = await this.executeTask(task)
        results.push(result)

        if (result.blockingIssues > 0) {
          hasBlockingIssues = true
        }

        if (task.type === 'full-review' && result.success) {
          reviewCompleted = true
        }
      }

      return {
        results,
        hasBlockingIssues,
        totalTasks: results.length,
        reviewCompleted
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
      return {
        type: task.type,
        success: false,
        issuesFound: 0,
        blockingIssues: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async executeDisputeTask(task: DisputeTask): Promise<TaskResult> {
    return await logger.group(
      `Executing Dispute Resolution (thread ${task.disputeContext.threadId})`,
      async () => {
        try {
          await this.reviewOrchestrator.executeDisputeResolution(
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

          await this.reviewOrchestrator.executeQuestionAnswering()

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

  private async executeReviewTask(task: ReviewTask): Promise<TaskResult> {
    return await logger.group(
      `Executing Full Review (${task.isManual ? 'manual' : 'auto'})`,
      async () => {
        try {
          if (task.isManual && task.triggerCommentId) {
            await this.stateManager.trackManualReviewRequest(
              task.triggerCommentId,
              'unknown',
              task.triggerCommentId
            )
            await this.stateManager.markManualReviewInProgress(
              task.triggerCommentId
            )
          }

          const reviewOutput = await this.reviewOrchestrator.executeReview()

          if (task.isManual && task.triggerCommentId) {
            await this.stateManager.markManualReviewCompleted(
              task.triggerCommentId
            )
          }

          return {
            type: 'full-review',
            success: reviewOutput.status === 'completed',
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
