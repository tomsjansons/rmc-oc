import * as core from '@actions/core'

import { OPENCODE_SERVER_URL } from './config/constants.js'
import {
  parseInputs,
  validateConfig,
  extractApiKeyForModel
} from './config/inputs.js'
import { GitHubAPI } from './github/api.js'
import { OpenCodeClientImpl } from './opencode/client.js'
import { LLMClientImpl } from './opencode/llm-client.js'
import { OpenCodeServer } from './opencode/server.js'
import { ReviewExecutor } from './execution/orchestrator.js'
import { setupToolsInWorkspace } from './setup/tools.js'
import { StateManager } from './state/manager.js'
import { TaskOrchestrator } from './task/orchestrator.js'
import { TRPCServer } from './trpc/server.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  let openCodeServer: OpenCodeServer | null = null
  let trpcServer: TRPCServer | null = null
  let reviewExecutor: ReviewExecutor | null = null
  let exitCode = 0

  try {
    logger.info('Starting Review My Code, OpenCode!...')

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
    // LLM client for classification and sentiment analysis tasks
    // Uses injection_verification_model which is faster and doesn't have
    // reasoning token issues that can cause empty responses with reasoning models
    const verificationApiKey = extractApiKeyForModel(
      config.opencode.authJson,
      config.security.injectionVerificationModel
    )
    if (!verificationApiKey) {
      throw new Error(
        `Could not extract API key for injection verification model "${config.security.injectionVerificationModel}" from auth JSON`
      )
    }
    const classificationLlmClient = new LLMClientImpl({
      apiKey: verificationApiKey,
      model: config.security.injectionVerificationModel
    })

    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    const stateManager = new StateManager(
      config,
      classificationLlmClient,
      github.getOctokit()
    )

    reviewExecutor = new ReviewExecutor(
      opencode,
      stateManager,
      github,
      config,
      workspaceRoot
    )

    const taskOrchestrator = new TaskOrchestrator(
      config,
      github,
      reviewExecutor,
      stateManager,
      classificationLlmClient
    )

    trpcServer = new TRPCServer(reviewExecutor, github, classificationLlmClient)
    await trpcServer.start()

    logger.info('Executing multi-task workflow...')
    const executionResult = await taskOrchestrator.execute()

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
        // Only fail the action (set exit code 1) for AUTO reviews
        // Manual reviews are informational only - they don't block merges
        if (executionResult.hadAutoReview) {
          const message = `Review found ${totalIssuesFound} issue(s), including ${totalBlockingIssues} blocking issue(s). Please address the review comments before merging.`
          core.setFailed(message)
          exitCode = 1
        } else if (executionResult.hadManualReview) {
          // Manual review with blocking issues - don't fail, just warn
          const message = `Manual review found ${totalIssuesFound} issue(s), including ${totalBlockingIssues} blocking issue(s). (Not failing action - manual reviews are informational only)`
          core.warning(message)
        }
      } else if (totalIssuesFound > 0) {
        const message = `Review found ${totalIssuesFound} issue(s). Please review the comments.`
        core.warning(message)
      }
    } else {
      core.setOutput('review_status', 'tasks_executed')
      core.setOutput('issues_found', String(totalIssuesFound))
      core.setOutput('blocking_issues', String(totalBlockingIssues))

      if (executionResult.hasBlockingIssues && totalBlockingIssues > 0) {
        // Review didn't complete but we have blocking issues (e.g., PR description validation failed)
        // Fail for AUTO reviews only
        if (executionResult.hadAutoReview) {
          const message = `Review blocked: ${totalBlockingIssues} blocking issue(s) found. Please address the issues before merging.`
          core.setFailed(message)
          exitCode = 1
        }
      }
    }

    logger.info('Review My Code, OpenCode! completed')
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
    await cleanup(reviewExecutor, trpcServer, openCodeServer)
    process.exit(exitCode)
  }
}

async function cleanup(
  executor: ReviewExecutor | null,
  trpcServer: TRPCServer | null,
  openCodeServer: OpenCodeServer | null
): Promise<void> {
  logger.debug('Cleanup: Starting cleanup sequence')

  try {
    if (executor) {
      logger.debug('Cleanup: Cleaning up executor...')
      await executor.cleanup()
      logger.debug('Cleanup: Executor cleanup complete')
    }
  } catch (error) {
    logger.warning(
      `Error during executor cleanup: ${error instanceof Error ? error.message : String(error)}`
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
