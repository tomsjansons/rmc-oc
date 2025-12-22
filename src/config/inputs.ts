import * as core from '@actions/core'
import * as github from '@actions/github'
import type {
  ExecutionMode,
  QuestionContext,
  ReviewConfig
} from '../review/types.js'

export function parseInputs(): ReviewConfig {
  const apiKey = core.getInput('openrouter_api_key', { required: true })
  const model =
    core.getInput('model', { required: false }) ||
    'anthropic/claude-sonnet-4-20250514'
  const enableWeb = core.getBooleanInput('enable_web', { required: false })
  const debugLogging = core.getBooleanInput('debug_logging', {
    required: false
  })

  const problemThreshold = parseNumericInput(
    'problem_score_threshold',
    5,
    1,
    10,
    'Problem score threshold must be between 1 and 10'
  )

  const blockingThresholdInput = core.getInput('blocking_score_threshold', {
    required: false
  })
  const blockingThreshold = blockingThresholdInput
    ? parseNumericInput(
        'blocking_score_threshold',
        problemThreshold,
        1,
        10,
        'Blocking score threshold must be between 1 and 10'
      )
    : problemThreshold

  const reviewTimeoutMinutes = parseNumericInput(
    'review_timeout_minutes',
    40,
    5,
    120,
    'Review timeout must be between 5 and 120 minutes'
  )

  const maxRetries = parseNumericInput(
    'max_review_retries',
    1,
    0,
    3,
    'Max review retries must be between 0 and 3'
  )

  const githubToken = core.getInput('github_token', { required: true })

  const enableHumanEscalation = core.getBooleanInput(
    'enable_human_escalation',
    {
      required: false
    }
  )

  const humanReviewersInput = core.getInput('human_reviewers', {
    required: false
  })
  const humanReviewers = humanReviewersInput
    ? humanReviewersInput.split(',').map((r) => r.trim())
    : []

  const context = github.context

  const { mode, prNumber, questionContext } = detectExecutionMode(context)

  const owner = context.repo.owner
  const repo = context.repo.repo

  if (!apiKey || apiKey.trim() === '') {
    throw new Error('OpenCode API key cannot be empty')
  }

  if (!githubToken || githubToken.trim() === '') {
    throw new Error('GitHub token cannot be empty')
  }

  return {
    opencode: {
      apiKey,
      model,
      enableWeb,
      debugLogging
    },
    scoring: {
      problemThreshold,
      blockingThreshold
    },
    review: {
      timeoutMs: reviewTimeoutMinutes * 60 * 1000,
      maxRetries
    },
    github: {
      token: githubToken,
      owner,
      repo,
      prNumber
    },
    dispute: {
      enableHumanEscalation,
      humanReviewers
    },
    execution: {
      mode,
      questionContext
    }
  }
}

function detectExecutionMode(context: typeof github.context): {
  mode: ExecutionMode
  prNumber: number
  questionContext?: QuestionContext
} {
  if (context.eventName === 'issue_comment') {
    const comment = context.payload.comment
    const issue = context.payload.issue

    if (!issue?.pull_request) {
      throw new Error(
        'Comment is not on a pull request. This action only works on PR comments.'
      )
    }

    const commentBody = comment?.body || ''
    const botMention = '@review-my-code-bot'

    if (commentBody.includes(botMention)) {
      const question = commentBody.replace(botMention, '').trim()

      if (!question) {
        throw new Error(
          `Please provide a question after ${botMention}. Example: "${botMention} Why is this function needed?"`
        )
      }

      let fileContext: QuestionContext['fileContext'] | undefined

      if (comment?.path) {
        fileContext = {
          path: comment.path,
          line: comment.line || comment.original_line
        }
      }

      core.info(`Question detected: "${question}"`)
      core.info(`Asked by: ${comment?.user?.login || 'unknown'}`)

      return {
        mode: 'question-answering',
        prNumber: issue.number,
        questionContext: {
          commentId: String(comment?.id || ''),
          question,
          author: comment?.user?.login || 'unknown',
          fileContext
        }
      }
    }

    core.info('Comment does not mention @review-my-code-bot, skipping')
    throw new Error(
      'This action was triggered by a comment but no bot mention was found. Skipping.'
    )
  }

  if (context.eventName === 'pull_request') {
    const pullRequest = context.payload.pull_request
    const prNumber = pullRequest?.number
    const action = context.payload.action

    if (!prNumber) {
      throw new Error(
        'This action can only be run on pull_request events. No PR number found in context.'
      )
    }

    const allowedActions = ['opened', 'synchronize', 'ready_for_review']
    if (action && !allowedActions.includes(action)) {
      throw new Error(
        `Skipping: pull_request action '${action}' is not supported. Supported actions: ${allowedActions.join(', ')}`
      )
    }

    if (pullRequest?.draft === true) {
      throw new Error(
        'Skipping: PR is a draft. Reviews will run when the PR is marked as ready for review.'
      )
    }

    return {
      mode: 'full-review',
      prNumber
    }
  }

  throw new Error(
    `Unsupported event: ${context.eventName}. This action supports 'pull_request' and 'issue_comment' events only.`
  )
}

function parseNumericInput(
  name: string,
  defaultValue: number,
  min: number,
  max: number,
  errorMessage: string
): number {
  const input = core.getInput(name, { required: false })
  const value = input ? parseInt(input, 10) : defaultValue

  if (Number.isNaN(value)) {
    throw new Error(`${name} must be a valid number. Received: ${input}`)
  }

  if (value < min || value > max) {
    throw new Error(errorMessage)
  }

  return value
}

export function validateConfig(config: ReviewConfig): void {
  if (!config.opencode.apiKey) {
    throw new Error('OpenCode API key is required')
  }

  if (!config.opencode.model) {
    throw new Error('Model name is required')
  }

  if (
    config.scoring.problemThreshold < 1 ||
    config.scoring.problemThreshold > 10
  ) {
    throw new Error('Problem threshold must be between 1 and 10')
  }

  if (
    config.scoring.blockingThreshold < 1 ||
    config.scoring.blockingThreshold > 10
  ) {
    throw new Error('Blocking threshold must be between 1 and 10')
  }

  if (config.scoring.blockingThreshold < config.scoring.problemThreshold) {
    throw new Error('Blocking threshold cannot be lower than problem threshold')
  }

  if (config.review.timeoutMs < 5 * 60 * 1000) {
    throw new Error('Review timeout must be at least 5 minutes')
  }

  if (config.review.maxRetries < 0 || config.review.maxRetries > 3) {
    throw new Error('Max retries must be between 0 and 3')
  }

  if (!config.github.token) {
    throw new Error('GitHub token is required')
  }

  if (!config.github.owner || !config.github.repo) {
    throw new Error('Repository owner and name are required')
  }

  if (!config.github.prNumber || config.github.prNumber < 1) {
    throw new Error('Valid PR number is required')
  }
}
