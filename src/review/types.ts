export type ExecutionMode =
  | 'full-review'
  | 'dispute-resolution'
  | 'question-answering'

export type QuestionContext = {
  commentId: string
  question: string
  author: string
  fileContext?: {
    path: string
    line?: number
  }
}

export type DisputeContext = {
  threadId: string
  replyCommentId: string
  replyBody: string
  replyAuthor: string
  file: string
  line?: number
}

export type ReviewConfig = {
  opencode: {
    apiKey: string
    model: string
    enableWeb: boolean
    debugLogging: boolean
  }
  security: {
    injectionDetectionEnabled: boolean
    injectionVerificationModel: string
  }
  scoring: {
    problemThreshold: number
    blockingThreshold: number
  }
  review: {
    timeoutMs: number
    maxRetries: number
  }
  github: {
    token: string
    owner: string
    repo: string
    prNumber: number
  }
  dispute: {
    enableHumanEscalation: boolean
    humanReviewers: string[]
  }
  execution: {
    mode: ExecutionMode
    questionContext?: QuestionContext
    disputeContext?: DisputeContext
  }
}

export type ThreadStatus = 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'

export type ThreadComment = {
  author: string
  body: string
  createdAt: string
}

export type ReviewThread = {
  id: string
  file: string
  line: number
  status: ThreadStatus
  history: ThreadComment[]
}

export type IssueAssessment = {
  finding: string
  assessment: string
  score: number
}

export type ReviewState = {
  threads: ReviewThread[]
  metadata: Record<string, unknown>
}

export type PassResult = {
  passNumber: number
  completed: boolean
  hasBlockingIssues: boolean
}

export type ReviewOutput = {
  status: 'completed' | 'failed' | 'has_blocking_issues'
  issuesFound: number
  blockingIssues: number
}
