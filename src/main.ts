import * as core from '@actions/core'
import { parseInputs, validateConfig } from './config/inputs.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  try {
    logger.info('Starting OpenCode PR Reviewer...')

    const config = parseInputs()
    validateConfig(config)

    logger.info(
      `Configuration loaded: PR #${config.github.prNumber} in ${config.github.owner}/${config.github.repo}`
    )
    logger.info(
      `Model: ${config.opencode.model}, Threshold: ${config.scoring.problemThreshold}`
    )

    // TODO: Implement review logic in subsequent phases
    logger.warning('Review logic not yet implemented - Phase 2+')

    core.setOutput('review_status', 'completed')
    core.setOutput('issues_found', '0')
    core.setOutput('blocking_issues', '0')

    logger.info('OpenCode PR Reviewer completed')
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error)
      core.setFailed(error.message)
    } else {
      const errorMessage = 'An unknown error occurred'
      logger.error(errorMessage)
      core.setFailed(errorMessage)
    }
  }
}
