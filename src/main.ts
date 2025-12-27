import * as core from '@actions/core'

import { OPENCODE_SERVER_URL } from './config/constants.js'
import { parseInputs, validateConfig } from './config/inputs.js'
import { GitHubAPI } from './github/api.js'
import { OpenCodeClientImpl } from './opencode/client.js'
import { LLMClientImpl } from './opencode/llm-client.js'
import { OpenCodeServer } from './opencode/server.js'
import { ReviewOrchestrator } from './review/orchestrator.js'
import { setupToolsInWorkspace } from './setup/tools.js'
import { StateManager } from './state/manager.js'
import { ExecutionOrchestrator } from './task/orchestrator.js'
import { TRPCServer } from './trpc/server.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  let openCodeServer: OpenCodeServer | null = null
  let trpcServer: TRPCServer | null = null
  let reviewOrchestrator: ReviewOrchestrator | null = null
  let exitCode = 0

  try {
    logger.info('Starting OpenCode PR Reviewer...')

    const config = await parseInputs()
    validateConfig(config)

    logger.info(
      `Configuration loaded: PR #${config.github.prNumber} in ${config.github.owner}/${config.github.repo}`
    )
    logger.info(
      `Model: ${config.opencode.model}, Threshold: ${config.scoring.problemThreshold}`
    )

    logger.info('Setting up OpenCode tools...')
    await setupToolsInWorkspace()

    openCodeServer = new OpenCodeServer(config)
    await openCodeServer.start()

    const github = new GitHubAPI(config)
    const opencode = new OpenCodeClientImpl(
      OPENCODE_SERVER_URL,
      config.opencode.debugLogging,
      config.review.timeoutMs
    )
    const llmClient = new LLMClientImpl({
      apiKey: config.opencode.apiKey,
      model: config.opencode.model
    })
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    reviewOrchestrator = new ReviewOrchestrator(
      opencode,
      llmClient,
      github,
      config,
      workspaceRoot
    )

    const stateManager = new StateManager(config, llmClient)

    const executionOrchestrator = new ExecutionOrchestrator(
      config,
      github,
      reviewOrchestrator,
      stateManager,
      llmClient
    )

    trpcServer = new TRPCServer(reviewOrchestrator, github, llmClient)
    await trpcServer.start()

    logger.info('Executing multi-task workflow...')
    const executionResult = await executionOrchestrator.execute()

    logger.info(
      `Execution complete: ${executionResult.totalTasks} task(s) executed`
    )

    let totalIssuesFound = 0
    let totalBlockingIssues = 0

    for (const result of executionResult.results) {
      totalIssuesFound += result.issuesFound
      totalBlockingIssues += result.blockingIssues
    }

    if (executionResult.reviewCompleted) {
      core.setOutput('review_status', 'completed')
      core.setOutput('issues_found', String(totalIssuesFound))
      core.setOutput('blocking_issues', String(totalBlockingIssues))

      if (executionResult.hasBlockingIssues) {
        const message = `Review found ${totalIssuesFound} issue(s), including ${totalBlockingIssues} blocking issue(s). Please address the review comments before merging.`
        core.setFailed(message)
        exitCode = 1
      } else if (totalIssuesFound > 0) {
        const message = `Review found ${totalIssuesFound} issue(s). Please review the comments.`
        core.warning(message)
      }
    } else {
      core.setOutput('review_status', 'tasks_executed')
      core.setOutput('issues_found', String(totalIssuesFound))
      core.setOutput('blocking_issues', String(totalBlockingIssues))
    }

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
    exitCode = 1
  } finally {
    await cleanup(reviewOrchestrator, trpcServer, openCodeServer)
    process.exit(exitCode)
  }
}

async function cleanup(
  orchestrator: ReviewOrchestrator | null,
  trpcServer: TRPCServer | null,
  openCodeServer: OpenCodeServer | null
): Promise<void> {
  logger.debug('Cleanup: Starting cleanup sequence')

  try {
    if (orchestrator) {
      logger.debug('Cleanup: Cleaning up orchestrator...')
      await orchestrator.cleanup()
      logger.debug('Cleanup: Orchestrator cleanup complete')
    }
  } catch (error) {
    logger.warning(
      `Error during orchestrator cleanup: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    if (trpcServer) {
      logger.debug('Cleanup: Stopping tRPC server...')
      await trpcServer.stop()
      logger.debug('Cleanup: tRPC server stopped')
    }
  } catch (error) {
    logger.warning(
      `Error during tRPC server cleanup: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    if (openCodeServer) {
      logger.debug('Cleanup: Stopping OpenCode server...')
      await openCodeServer.stop()
      logger.debug('Cleanup: OpenCode server stopped')
    }
  } catch (error) {
    logger.warning(
      `Error during OpenCode server cleanup: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  logger.debug('Cleanup: All cleanup complete, calling process.exit()')
}
