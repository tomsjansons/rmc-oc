export interface ReviewConfig {
  opencode: {
    apiKey: string
    model: string
    enableWeb: boolean
  }
  scoring: {
    problemThreshold: number // 1-10
    elevationThreshold: number // Number of issues to elevate
  }
  github: {
    token: string
    owner: string
    repo: string
    prNumber: number
  }
}

export type ThreadStatus = 'PENDING' | 'RESOLVED' | 'DISPUTED'

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
