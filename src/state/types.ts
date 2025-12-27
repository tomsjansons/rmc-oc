/**
 * State management types for tracking all work across PR reviews, questions, and disputes.
 *
 * This module defines the ProcessState which tracks:
 * - Review threads and their statuses
 * - Question/answer tasks
 * - Manual review requests
 * - Auto review triggers for merge gate preservation
 */

/**
 * Status of a review thread indicating current state of the issue
 */
export type ThreadStatus = 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'

/**
 * A comment within a review thread
 */
export type ThreadComment = {
  author: string
  body: string
  createdAt: string
}

/**
 * Assessment data embedded in review finding comments
 */
export type IssueAssessment = {
  finding: string
  assessment: string
  score: number
}

/**
 * A review thread represents a conversation about a specific code issue
 */
export type ReviewThread = {
  id: string
  file: string
  line: number
  status: ThreadStatus
  history: ThreadComment[]
  assessment?: IssueAssessment
  score?: number
}

/**
 * A question task represents a developer's question that needs answering
 */
export type QuestionTask = {
  /** Unique identifier (comment ID) */
  id: string
  /** GitHub username who asked the question */
  author: string
  /** The question text (after @ mention) */
  question: string
  /** Status of the question */
  status: 'PENDING' | 'IN_PROGRESS' | 'ANSWERED'
  /** Comment ID where question was asked */
  commentId: string
  /** Optional file context if question is about specific code */
  fileContext?: {
    path: string
    line?: number
  }
  /** Timestamp when question answering started */
  startedAt?: string
  /** Timestamp when question was answered */
  completedAt?: string
}

/**
 * A manual review request represents a developer's @ mention requesting a PR review
 */
export type ManualReviewRequest = {
  /** Unique identifier (comment ID) */
  id: string
  /** GitHub username who requested the review */
  author: string
  /** Status of the manual review request */
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'DISMISSED_BY_AUTO_REVIEW'
  /** Comment ID where review was requested */
  commentId: string
  /** Timestamp when review started */
  startedAt?: string
  /** Timestamp when review completed */
  completedAt?: string
  /** If dismissed, what dismissed it (e.g., 'auto-pr-review') */
  dismissedBy?: string
}

/**
 * Auto review trigger tracks when an automatic PR review was triggered
 * to preserve merge gate behavior even if the review run is cancelled
 */
export type AutoReviewTrigger = {
  /** When the auto review was triggered */
  triggeredAt: string
  /** What action triggered it (opened, synchronize, ready_for_review) */
  action: 'opened' | 'synchronize' | 'ready_for_review'
  /** Git commit SHA that needs reviewing */
  sha: string
  /** Whether this review run was cancelled */
  cancelled: boolean
  /** When the review completed (if it did) */
  completedAt?: string
}

/**
 * Metadata about the overall process state
 */
export type ProcessMetadata = {
  /** Last time state was updated */
  lastUpdated: string
  /** PR number this state belongs to */
  prNumber: number
  /** Which review passes have been completed (e.g., [1, 2, 3]) */
  passesCompleted: number[]
  /** Current auto review trigger (if any) */
  autoReviewTrigger?: AutoReviewTrigger
}

/**
 * Complete process state tracking all work on a PR
 *
 * This replaces the old ReviewState and includes all types of work:
 * - Code review findings and their dispute threads
 * - Developer questions needing answers
 * - Manual review requests
 * - Auto review triggers for merge gate preservation
 */
export type ProcessState = {
  /** Review threads tracking code review findings and disputes */
  reviewThreads: ReviewThread[]
  /** Question tasks tracking @ mention questions */
  questionTasks: QuestionTask[]
  /** Manual review requests tracking @ mention review requests */
  manualReviewRequests: ManualReviewRequest[]
  /** Process-level metadata */
  metadata: ProcessMetadata
}

/**
 * Result of a single review pass
 */
export type PassResult = {
  passNumber: number
  completed: boolean
  hasBlockingIssues: boolean
}

/**
 * Final output from a review execution
 */
export type ReviewOutput = {
  status: 'completed' | 'failed' | 'has_blocking_issues'
  issuesFound: number
  blockingIssues: number
}
