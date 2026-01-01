/**
 * Task detection logic for discovering all pending work on a PR.
 *
 * This module scans for:
 * - Unanswered questions (@ mentions)
 * - Unresolved disputes (developer replies to review threads)
 * - Review requests (auto PR events or manual @ mentions)
 */

import { BOT_MENTIONS, BOT_USERS } from '../config/constants.js'
import type { GitHubAPI } from '../github/api.js'
import type { LLMClient } from '../opencode/llm-client.js'
import type { ReviewConfig } from '../execution/types.js'
import type { StateManager } from '../state/manager.js'
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
 * Check if a comment body contains a bot mention outside of code blocks
 *
 * Filters out mentions that appear in:
 * - Fenced code blocks (```)
 * - Inline code (`)
 *
 * This prevents false positives when users include bot mentions in examples
 */
function containsBotMentionOutsideCodeBlocks(body: string): boolean {
  // Remove fenced code blocks first (multi-line)
  let cleaned = body.replace(/```[\s\S]*?```/g, '')
  // Remove inline code
  cleaned = cleaned.replace(/`[^`]+`/g, '')
  return BOT_MENTIONS.some((mention) => cleaned.includes(mention))
}

/**
 * Remove all bot mentions from text and return the cleaned text
 */
function removeBotMentions(text: string): string {
  let result = text
  for (const mention of BOT_MENTIONS) {
    result = result.replace(mention, '')
  }
  return result.trim()
}

/**
 * Create a hash of question text for detecting edits
 *
 * Uses a simple hash to detect if the question text has changed
 * after being marked as answered
 */
function hashQuestionText(text: string): string {
  let hash = 0
  const normalized = text.toLowerCase().trim()
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(16)
}

/**
 * Detect if a question requires fresh analysis without conversation history.
 *
 * Questions like "summarize the PR", "what changed", "overview of changes"
 * should NOT include prior conversation history as it may contain stale
 * summaries from previous commits that would pollute the response.
 */
function requiresFreshAnalysis(question: string): boolean {
  const lowerQuestion = question.toLowerCase()

  const freshAnalysisPatterns = [
    /\bsummar(y|ize|ise)\b/,
    /\boverview\b/,
    /\bwhat('s| is| are)?\s+(changed|new|different|modified)\b/,
    /\blist\s+(the\s+)?changes\b/,
    /\bdescribe\s+(the\s+)?(changes|pr|pull\s*request)\b/,
    /\bwhat\s+does\s+this\s+pr\s+do\b/,
    /\bexplain\s+(the\s+)?(changes|pr|pull\s*request)\b/,
    /\bchangelog\b/,
    /\brelease\s+notes\b/
  ]

  return freshAnalysisPatterns.some((pattern) => pattern.test(lowerQuestion))
}

/**
 * Detects all pending tasks across a PR
 */
export class TaskDetector {
  private intentClassifier: IntentClassifier

  constructor(
    llmClient: LLMClient,
    private stateManager: StateManager
  ) {
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

    // Get the real state from StateManager - this contains review threads with disputes
    const reviewState = await this.stateManager.getOrCreateState()

    // Convert ProcessState threads to the format expected by detectPendingDisputes
    const reviewThreads = reviewState.threads.map((thread) => ({
      id: thread.id,
      file: thread.file,
      line: thread.line,
      status: thread.status
    }))

    // Always check for disputes (priority 1)
    const disputes = await this.detectPendingDisputes(githubApi, reviewThreads)
    tasks.push(...disputes)
    logger.info(`Found ${disputes.length} pending dispute(s)`)

    // Always check for questions (priority 2)
    const questions = await this.detectPendingQuestions(githubApi)
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
    reviewThreads: Array<{
      id: string
      file: string
      line: number
      status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
    }>
  ): Promise<DisputeTask[]> {
    const disputes: DisputeTask[] = []

    // Get all review threads with PENDING or DISPUTED status
    const activeThreads = reviewThreads.filter(
      (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
    )

    for (const thread of activeThreads) {
      try {
        // Check if there are new developer replies
        const hasNewReply = await githubApi.hasNewDeveloperReply(thread.id)

        if (hasNewReply) {
          // Get the thread comments to find the latest reply
          const comments = await githubApi.getThreadComments(thread.id)

          // Find latest developer reply
          const developerReplies = comments
            .filter((c) => !BOT_USERS.includes(c.user?.login || ''))
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
      } catch (error) {
        // Thread may have been deleted or is inaccessible
        // Log and continue with other threads
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        if (
          errorMessage.includes('404') ||
          errorMessage.includes('Not Found')
        ) {
          logger.warning(`Thread ${thread.id} appears to be deleted, skipping`)
        } else {
          logger.warning(`Error checking thread ${thread.id}: ${errorMessage}`)
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
    githubApi: GitHubAPI
  ): Promise<QuestionTask[]> {
    const questions: QuestionTask[] = []

    // Get all issue comments
    const allComments = await githubApi.getAllIssueComments()

    // Build a set of answered question IDs by looking for question-answer blocks
    const answeredQuestionIds = new Set<string>()
    for (const comment of allComments) {
      const rmcocBlock = extractRmcocBlock(comment.body || '')
      if (rmcocBlock?.type === 'question-answer') {
        // The bot's answer has reply_to_comment_id pointing to the original question
        const replyToId = (rmcocBlock as { reply_to_comment_id?: string })
          .reply_to_comment_id
        if (replyToId) {
          answeredQuestionIds.add(replyToId)
        }
      }
    }

    // Build a map of answered questions with their text hash for edit detection
    const answeredQuestionHashes = new Map<string, string>()
    for (const comment of allComments) {
      const rmcocBlock = extractRmcocBlock(comment.body || '')
      if (rmcocBlock?.type === 'question-answer') {
        const answerBlock = rmcocBlock as {
          reply_to_comment_id?: string
          question_hash?: string
        }
        if (answerBlock.reply_to_comment_id && answerBlock.question_hash) {
          answeredQuestionHashes.set(
            answerBlock.reply_to_comment_id,
            answerBlock.question_hash
          )
        }
      }
    }

    for (const comment of allComments) {
      // Skip comments from bots - they can't ask questions
      const commentAuthor = comment.user?.login || ''
      if (BOT_USERS.includes(commentAuthor)) {
        continue
      }

      // Use code-block-aware bot mention detection
      if (!containsBotMentionOutsideCodeBlocks(comment.body || '')) {
        continue
      }

      const commentId = String(comment.id)

      // Check rmcoc block to see if already handled
      const rmcocBlock = extractRmcocBlock(comment.body || '')

      // Skip if already answered (original comment marked as ANSWERED)
      if (rmcocBlock?.type === 'question' && rmcocBlock.status === 'ANSWERED') {
        continue
      }

      // Skip if we found a question-answer reply to this comment
      if (answeredQuestionIds.has(commentId)) {
        // Check if the question was edited after being answered
        const currentHash = hashQuestionText(
          removeBotMentions(comment.body || '')
        )
        const answeredHash = answeredQuestionHashes.get(commentId)

        // If hash matches or no hash stored, question hasn't changed - skip
        if (!answeredHash || currentHash === answeredHash) {
          continue
        }

        // Question was edited after being answered - process it as a new question
        logger.info(
          `Question ${commentId} was edited after being answered, reprocessing`
        )
      }

      // Skip if this is a manual review request (not a question)
      if (rmcocBlock?.type === 'manual-pr-review') {
        continue
      }

      // Extract question text
      const textAfterMention = removeBotMentions(comment.body || '')
      if (!textAfterMention) {
        continue
      }

      // Classify intent
      const intent =
        await this.intentClassifier.classifyBotMention(textAfterMention)

      if (intent === 'question') {
        // For summary/overview questions, don't include conversation history
        // as it may contain stale summaries from previous commits
        const needsFreshAnalysis = requiresFreshAnalysis(textAfterMention)

        let conversationHistory: ConversationMessage[] = []
        if (!needsFreshAnalysis) {
          conversationHistory = this.getConversationHistory(
            commentId,
            allComments
          )
        } else {
          logger.info(
            `Question "${textAfterMention.substring(0, 50)}..." requires fresh analysis, skipping conversation history`
          )
        }

        questions.push({
          type: 'question-answering',
          priority: 2,
          questionContext: {
            commentId,
            question: textAfterMention,
            questionHash: hashQuestionText(textAfterMention),
            author: comment.user?.login || 'unknown',
            fileContext: undefined, // Issue comments don't have file context
            requiresFreshAnalysis: needsFreshAnalysis
          },
          conversationHistory,
          isManuallyTriggered: false,
          triggerCommentId: commentId
        })
      }
    }

    return questions
  }

  /**
   * Detect if a review should be performed based on config
   *
   * Checks for:
   * - Cancelled auto reviews that need to be resumed
   * - Auto reviews (triggered by PR events)
   * - Manual review requests (@ mentions)
   */
  private async detectReviewRequestFromConfig(
    githubApi: GitHubAPI,
    config: ReviewConfig
  ): Promise<ReviewTask | null> {
    // First, check for a cancelled auto review that needs to be resumed
    // This preserves the merge gate behavior when a review was cancelled
    const currentSHA = await githubApi.getCurrentSHA()
    const pendingAutoReview =
      await this.stateManager.getPendingAutoReviewTrigger(currentSHA)

    if (pendingAutoReview) {
      logger.info(
        `Resuming cancelled auto review (${pendingAutoReview.action}) for SHA ${currentSHA}`
      )
      return {
        type: 'full-review',
        priority: 3,
        isManual: false,
        triggeredBy: pendingAutoReview.action,
        resumingCancelled: true,
        // Resumed auto reviews still affect merge gate
        affectsMergeGate: true
      }
    }

    // Check if this run is configured to do a full review
    if (config.execution.mode === 'full-review') {
      const isManual = config.execution.isManuallyTriggered
      return {
        type: 'full-review',
        priority: 3,
        isManual,
        triggerCommentId: config.execution.triggerCommentId,
        triggeredBy: isManual ? 'manual-request' : 'opened',
        // Auto reviews affect merge gate (exit code 1 on blocking issues)
        // Manual reviews are informational only (exit code 0)
        affectsMergeGate: !isManual
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
   * follow-ups without tagging). This provides the full context needed
   * for answering follow-up questions accurately.
   */
  private getConversationHistory(
    commentId: string,
    allComments: Awaited<ReturnType<GitHubAPI['getAllIssueComments']>>
  ): ConversationMessage[] {
    const currentComment = allComments.find((c) => String(c.id) === commentId)
    if (!currentComment) {
      return []
    }

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

    // Include ALL comments in conversation history for full context
    // Developers often post follow-ups without explicitly tagging the bot
    for (const comment of priorComments) {
      const isBot = BOT_USERS.includes(comment.user?.login || '')

      conversationMessages.push({
        author: comment.user?.login || 'unknown',
        body: comment.body || '',
        timestamp: comment.created_at,
        isBot
      })
    }

    return conversationMessages
  }
}
