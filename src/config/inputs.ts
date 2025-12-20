import * as core from '@actions/core'
import * as github from '@actions/github'
import type { ReviewConfig } from '../review/types.js'

export function parseInputs(): ReviewConfig {
  const apiKey = core.getInput('opencode_api_key', { required: true })
  const model =
    core.getInput('model', { required: false }) || 'google/gemini-flash-1.5'
  const enableWeb = core.getBooleanInput('enable_web', { required: false })

  const problemThreshold = parseNumericInput(
    'problem_score_threshold',
    5,
    1,
    10,
    'Problem score threshold must be between 1 and 10'
  )

  const elevationThreshold = parseNumericInput(
    'score_elevation_threshold',
    5,
    1,
    100,
    'Score elevation threshold must be between 1 and 100'
  )

  const githubToken = core.getInput('github_token', { required: true })

  const context = github.context
  const prNumber = context.payload.pull_request?.number

  if (!prNumber) {
    throw new Error(
      'This action can only be run on pull_request events. No PR number found in context.'
    )
  }

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
      enableWeb
    },
    scoring: {
      problemThreshold,
      elevationThreshold
    },
    github: {
      token: githubToken,
      owner,
      repo,
      prNumber
    }
  }
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

  if (config.scoring.elevationThreshold < 1) {
    throw new Error('Elevation threshold must be at least 1')
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
