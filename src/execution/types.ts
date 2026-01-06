export type { QuestionContext, DisputeContext } from '../task/types.js'

export type ExecutionMode =
  | 'full-review'
  | 'dispute-resolution'
  | 'question-answering'

import type { QuestionContext, DisputeContext } from '../task/types.js'

export type ReviewConfig = {
  opencode: {
    authJson: string
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
  taskInfo: {
    requireTaskInfoInPrDesc: boolean
  }
  execution: {
    mode: ExecutionMode
    questionContext?: QuestionContext
    disputeContext?: DisputeContext
    isManuallyTriggered: boolean
    triggerCommentId?: string
    manualTriggerComments: {
      enableStartComment: boolean
      enableEndComment: boolean
    }
  }
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
