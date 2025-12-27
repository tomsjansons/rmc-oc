/**
 * Task detection logic for discovering all pending work on a PR.
 *
 * This module scans for:
 * - Unanswered questions (@ mentions)
 * - Unresolved disputes (developer replies to review threads)
 * - Review requests (auto PR events or manual @ mentions)
 */

import type { GitHubAPI } from '../github/api.js'
import type { LLMClient } from '../opencode/llm-client.js'
import type { ReviewConfig } from '../review/types.js'
import type { ProcessState } from '../state/types.js'
import { extractRmcocBlock, type RmcocBlock } from '../state/serializer.js'
import { logger } from '../utils/logger.js'
import { IntentClassifier } from './classifier.js'
import type {
  ConversationMessage,
  DisputeTask,
  QuestionTask,
  ReviewTask,
  Task
} from './types.js'

/**
 * Detects all pending tasks across a PR
 */
export class TaskDetector {
  private intentClassifier: IntentClassifier

  constructor(llmClient: LLMClient) {
    this.intentClassifier = new IntentClassifier(llmClient)
  }

  /**
   * Detect all pending tasks on the PR
   *
   * Scans for:
   * - Unresolved disputes (priority 1)
   * - Unanswered questions (priority 2)
   * - Review requests (priority 3)
   *
   * @param githubApi - GitHub API client
   * @param config - Review configuration
   * @returns Array of tasks to execute
   */
  async detectAllTasks(
    githubApi: GitHubAPI,
    config: ReviewConfig
  ): Promise<Task[]> {
    const tasks: Task[] = []

    logger.info('Detecting all pending tasks...')

    const emptyState: ProcessState = {
      reviewThreads: [],
      questionTasks: [],
      manualReviewRequests: [],
      metadata: {
        lastUpdated: new Date().toISOString(),
        prNumber: config.github.prNumber,
        passesCompleted: []
      }
    }

    // Always check for disputes (priority 1)
    const disputes = await this.detectPendingDisputes(githubApi, emptyState)
    tasks.push(...disputes)
    logger.info(`Found ${disputes.length} pending dispute(s)`)

    // Always check for questions (priority 2)
    const questions = await this.detectPendingQuestions(githubApi, emptyState)
    tasks.push(...questions)
    logger.info(`Found ${questions.length} pending question(s)`)

    // Check for review requests (priority 3)
    const reviewRequest = await this.detectReviewRequestFromConfig(
      githubApi,
      config
    )
    if (reviewRequest) {
      tasks.push(reviewRequest)
      logger.info(
        `Found review request: ${reviewRequest.isManual ? 'manual' : 'auto'}`
      )
    }

    // Deduplicate and prioritize
    const deduplicated = await this.deduplicateAndPrioritize(tasks, githubApi)

    return deduplicated
  }

  /**
   * Detect pending dispute resolution tasks
   *
   * Scans review threads for developer replies that haven't been addressed
   * Uses ONLY rmcoc blocks to determine state (never raw text)
   */
  private async detectPendingDisputes(
    githubApi: GitHubAPI,
    state: ProcessState
  ): Promise<DisputeTask[]> {
    const disputes: DisputeTask[] = []

    // Get all review threads with PENDING or DISPUTED status
    const activeThreads = state.reviewThreads.filter(
      (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
    )

    for (const thread of activeThreads) {
      // Check if there are new developer replies
      const hasNewReply = await githubApi.hasNewDeveloperReply(thread.id)

      if (hasNewReply) {
        // Get the thread comments to find the latest reply
        const comments = await githubApi.getThreadComments(thread.id)
        const botUsers = ['github-actions[bot]', 'opencode-reviewer[bot]']

        // Find latest developer reply
        const developerReplies = comments
          .filter((c) => !botUsers.includes(c.user?.login || ''))
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime()
          )

        const latestReply = developerReplies[0]
        if (latestReply) {
          disputes.push({
            type: 'dispute-resolution',
            priority: 1,
            disputeContext: {
              threadId: thread.id,
              replyCommentId: String(latestReply.id),
              replyBody: latestReply.body || '',
              replyAuthor: latestReply.user?.login || 'unknown',
              file: thread.file,
              line: thread.line
            }
          })
        }
      }
    }

    return disputes
  }

  /**
   * Detect pending question answering tasks
   *
   * Scans all comments for @ mentions and checks if they've been answered
   * Uses rmcoc blocks to track answered questions
   */
  private async detectPendingQuestions(
    githubApi: GitHubAPI,
    _state: ProcessState
  ): Promise<QuestionTask[]> {
    const questions: QuestionTask[] = []
    const botMention = '@review-my-code-bot'

    // Get all issue comments
    const allComments = await githubApi.getAllIssueComments()

    for (const comment of allComments) {
      if (!comment.body?.includes(botMention)) {
        continue
      }

      // Check rmcoc block to see if already handled
      const rmcocBlock = extractRmcocBlock(comment.body)

      // Skip if already answered
      if (rmcocBlock?.type === 'question' && rmcocBlock.status === 'ANSWERED') {
        continue
      }

      // Skip if this is a manual review request (not a question)
      if (rmcocBlock?.type === 'manual-pr-review') {
        continue
      }

      // Extract question text
      const textAfterMention = comment.body.replace(botMention, '').trim()
      if (!textAfterMention) {
        continue
      }

      // Classify intent
      const intent =
        await this.intentClassifier.classifyBotMention(textAfterMention)

      if (intent === 'question') {
        // Get conversation history for follow-ups
        const conversationHistory = await this.getConversationHistory(
          githubApi,
          String(comment.id),
          allComments
        )

        questions.push({
          type: 'question-answering',
          priority: 2,
          questionContext: {
            commentId: String(comment.id),
            question: textAfterMention,
            author: comment.user?.login || 'unknown',
            fileContext: undefined // Issue comments don't have file context
          },
          conversationHistory,
          isManuallyTriggered: false,
          triggerCommentId: String(comment.id)
        })
      }
    }

    return questions
  }

  /**
   * Detect if a review should be performed based on config
   *
   * Checks for:
   * - Auto reviews (triggered by PR events)
   * - Manual review requests (@ mentions)
   */
  private async detectReviewRequestFromConfig(
    _githubApi: GitHubAPI,
    config: ReviewConfig
  ): Promise<ReviewTask | null> {
    if (config.execution.mode === 'full-review') {
      return {
        type: 'full-review',
        priority: 3,
        isManual: config.execution.isManuallyTriggered,
        triggerCommentId: config.execution.triggerCommentId,
        triggeredBy: config.execution.isManuallyTriggered
          ? 'manual-request'
          : 'opened'
      }
    }

    return null
  }

  /**
   * Deduplicate tasks and handle dismissals
   *
   * If both manual and auto review are detected, dismiss manual review
   */
  private async deduplicateAndPrioritize(
    tasks: Task[],
    githubApi: GitHubAPI
  ): Promise<Task[]> {
    const seen = new Set<string>()
    const deduplicated: Task[] = []

    // Check if we have both manual and auto review
    const hasAutoReview = tasks.some(
      (t) => t.type === 'full-review' && !t.isManual
    )

    for (const task of tasks) {
      const key = this.getTaskKey(task)

      // Special handling: dismiss manual reviews if auto review exists
      if (task.type === 'full-review' && task.isManual && hasAutoReview) {
        logger.info('Dismissing manual review request (handled by auto review)')

        if (task.triggerCommentId) {
          await this.dismissManualReview(githubApi, task.triggerCommentId)
        }
        continue
      }

      if (!seen.has(key)) {
        seen.add(key)
        deduplicated.push(task)
      }
    }

    // Sort by priority (1 = highest)
    return deduplicated.sort((a, b) => a.priority - b.priority)
  }

  /**
   * Get unique key for a task (for deduplication)
   */
  private getTaskKey(task: Task): string {
    switch (task.type) {
      case 'dispute-resolution':
        return `dispute-${task.disputeContext.threadId}`
      case 'question-answering':
        return `question-${task.questionContext.commentId}`
      case 'full-review':
        return `review-${task.isManual ? task.triggerCommentId : 'auto'}`
    }
  }

  /**
   * Dismiss a manual review request
   */
  private async dismissManualReview(
    githubApi: GitHubAPI,
    commentId: string
  ): Promise<void> {
    try {
      const comment = await githubApi.getComment(commentId)

      const rmcocData: RmcocBlock = {
        type: 'manual-pr-review',
        status: 'DISMISSED_BY_AUTO_REVIEW',
        dismissed_at: new Date().toISOString(),
        dismissed_reason:
          'This review request was handled by an automatic PR review'
      }

      // Update comment with rmcoc block
      const existingBlock = extractRmcocBlock(comment.body || '')
      let updatedBody: string

      if (existingBlock) {
        updatedBody = (comment.body || '').replace(
          /```rmcoc\n[\s\S]*?\n```/,
          `\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
        )
      } else {
        updatedBody = `${comment.body}\n\n\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
      }

      await githubApi.updateComment(commentId, updatedBody)

      // Post explanatory reply
      await githubApi.replyToComment(
        commentId,
        `ℹ️ This manual review request was dismissed because an automatic PR review was triggered and handled the review.\n\n` +
          `The review results are available in the review comments above.`
      )
    } catch (error) {
      logger.warning(
        `Failed to dismiss manual review: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Get conversation history for a question
   *
   * Includes ALL comments in chronological order (developers often post
   * follow-ups without tagging)
   */
  private async getConversationHistory(
    githubApi: GitHubAPI,
    commentId: string,
    allComments: Awaited<ReturnType<GitHubAPI['getAllIssueComments']>>
  ): Promise<ConversationMessage[]> {
    const currentComment = allComments.find((c) => String(c.id) === commentId)
    if (!currentComment) {
      return []
    }

    const botUsers = ['github-actions[bot]', 'opencode-reviewer[bot]']
    const botMention = '@review-my-code-bot'
    const conversationMessages: ConversationMessage[] = []

    // Get all comments before current one
    const priorComments = allComments
      .filter(
        (c) => new Date(c.created_at) < new Date(currentComment.created_at)
      )
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )

    // Build conversation (all dev/bot exchanges)
    for (const comment of priorComments) {
      const isBot = botUsers.includes(comment.user?.login || '')

      // Include if it's a bot mention or a bot reply
      if (comment.body?.includes(botMention) || isBot) {
        conversationMessages.push({
          author: comment.user?.login || 'unknown',
          body: comment.body || '',
          timestamp: comment.created_at,
          isBot
        })
      }
    }

    return conversationMessages
  }
}
