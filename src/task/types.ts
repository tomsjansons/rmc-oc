/**
 * Task execution types for multi-task workflow orchestration.
 *
 * This module defines the execution tasks that can be detected and executed:
 * - Dispute resolution tasks (developer replies to review threads)
 * - Question answering tasks (developer @ mentions with questions)
 * - Review tasks (full PR reviews, manual or automatic)
 */

/**
 * Context for a question that needs answering
 */
export type QuestionContext = {
  /** Comment ID where the question was asked */
  commentId: string
  /** The question text (after @ mention is removed) */
  question: string
  /** Hash of question text for detecting edits after answer */
  questionHash?: string
  /** GitHub username who asked the question */
  author: string
  /** Optional file/line context if question is about specific code */
  fileContext?: {
    path: string
    line?: number
  }
}

/**
 * Context for a dispute/reply to a review thread
 */
export type DisputeContext = {
  /** ID of the original review thread comment */
  threadId: string
  /** ID of the developer's reply comment */
  replyCommentId: string
  /** Body of the developer's reply */
  replyBody: string
  /** GitHub username who replied */
  replyAuthor: string
  /** File the thread is about */
  file: string
  /** Line number in the file */
  line?: number
}

/**
 * A message in a conversation thread between developer and bot
 */
export type ConversationMessage = {
  /** GitHub username of the author */
  author: string
  /** Message body */
  body: string
  /** When the message was posted */
  timestamp: string
  /** Whether this message is from the bot */
  isBot: boolean
}

/**
 * A dispute resolution task - respond to developer's reply to a review thread
 */
export type DisputeTask = {
  type: 'dispute-resolution'
  priority: 1
  disputeContext: DisputeContext
}

/**
 * A question answering task - answer a developer's @ mention question
 */
export type QuestionTask = {
  type: 'question-answering'
  priority: 2
  questionContext: QuestionContext
  /** Full conversation history for follow-up questions */
  conversationHistory: ConversationMessage[]
  /** Whether this was the triggering event (vs discovered pending work) */
  isManuallyTriggered: boolean
  /** Comment ID that triggered this (if manual) */
  triggerCommentId?: string
}

/**
 * A full PR review task - run complete 3-pass review
 */
export type ReviewTask = {
  type: 'full-review'
  priority: 3
  /** Whether this was manually requested via @ mention */
  isManual: boolean
  /** Comment ID of manual review request (if manual) */
  triggerCommentId?: string
  /** What triggered this review */
  triggeredBy: 'opened' | 'synchronize' | 'ready_for_review' | 'manual-request'
  /** Whether this is resuming a cancelled auto review */
  resumingCancelled?: boolean
  /**
   * Whether this should affect the merge gate (exit code).
   * True for auto reviews and resumed auto reviews.
   * False for manual reviews (informational only).
   */
  affectsMergeGate: boolean
}

/**
 * Union of all possible task types
 */
export type Task = DisputeTask | QuestionTask | ReviewTask

/**
 * Plan for executing multiple tasks in a single run
 */
export type ExecutionPlan = {
  /** All tasks to execute, sorted by priority */
  tasks: Task[]
  /** Which GitHub event triggered this execution */
  triggeredBy: string
}

/**
 * Result from executing a single task
 */
export type TaskResult = {
  /** Type of task that was executed */
  type: 'dispute-resolution' | 'question-answering' | 'full-review'
  /** Whether the task completed successfully */
  success: boolean
  /** Number of issues found (for reviews only) */
  issuesFound: number
  /** Number of blocking issues found (for reviews only) */
  blockingIssues: number
  /** Error message if task failed */
  error?: string
}

/**
 * Result from executing all tasks in a run
 */
export type ExecutionResult = {
  /** Results from each task executed */
  results: TaskResult[]
  /** Whether any review found blocking issues */
  hasBlockingIssues: boolean
  /** Total number of tasks executed */
  totalTasks: number
  /** Whether a review was completed */
  reviewCompleted: boolean
  /** Whether an auto review (PR event triggered) was executed */
  hadAutoReview: boolean
  /** Whether a manual review (@ mention triggered) was executed */
  hadManualReview: boolean
}
