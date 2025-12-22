import * as core from '@actions/core'

import { OPENCODE_SERVER_URL } from './config/constants.js'
import { parseInputs, validateConfig } from './config/inputs.js'
import { GitHubAPI } from './github/api.js'
import { OpenCodeClientImpl } from './opencode/client.js'
import { ReviewOrchestrator } from './review/orchestrator.js'
import { setupToolsInWorkspace } from './setup/tools.js'
import { TRPCServer } from './trpc/server.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  let trpcServer: TRPCServer | null = null

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

    logger.info('Setting up OpenCode tools...')
    await setupToolsInWorkspace()

    const github = new GitHubAPI(config)
    const opencode = new OpenCodeClientImpl(OPENCODE_SERVER_URL)
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    const orchestrator = new ReviewOrchestrator(
      opencode,
      github,
      config,
      workspaceRoot
    )

    trpcServer = new TRPCServer(orchestrator, github)
    await trpcServer.start()

    logger.warning('Review execution not yet implemented - Phase 5')

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
  } finally {
    if (trpcServer) {
      await trpcServer.stop()
    }
  }
}
