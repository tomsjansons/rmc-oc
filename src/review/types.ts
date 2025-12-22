export type ExecutionMode =
  | 'full-review'
  | 'dispute-resolution'
  | 'question-answering'

export interface QuestionContext {
  commentId: string
  question: string
  author: string
  fileContext?: {
    path: string
    line?: number
  }
}

export interface ReviewConfig {
  opencode: {
    apiKey: string
    model: string
    enableWeb: boolean
    debugLogging: boolean
  }
  scoring: {
    problemThreshold: number // 1-10
    elevationThreshold: number // Number of issues to elevate
  }
  review: {
    timeoutMs: number // Total timeout for entire review in milliseconds
    maxRetries: number // Maximum number of retry attempts
  }
  github: {
    token: string
    owner: string
    repo: string
    prNumber: number
  }
  dispute: {
    enableHumanEscalation: boolean
    humanReviewers: string[] // GitHub usernames to tag on unresolved disputes
  }
  execution: {
    mode: ExecutionMode
    questionContext?: QuestionContext
  }
}

export type ThreadStatus = 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'

export interface ThreadComment {
  author: string
  body: string
  createdAt: string
}

export interface ReviewThread {
  id: string
  file: string
  line: number
  status: ThreadStatus
  history: ThreadComment[]
}

export interface IssueAssessment {
  finding: string
  assessment: string
  score: number // 1-10
}

export interface ReviewState {
  threads: ReviewThread[]
  metadata: Record<string, unknown>
}

export interface PassResult {
  passNumber: number
  summary: string
  hasBlockingIssues: boolean
}

export interface ReviewOutput {
  status: 'completed' | 'failed' | 'has_blocking_issues'
  issuesFound: number
  blockingIssues: number
}
