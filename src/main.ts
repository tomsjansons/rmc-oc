import * as core from '@actions/core'

import { OPENCODE_SERVER_URL } from './config/constants.js'
import { parseInputs, validateConfig } from './config/inputs.js'
import { GitHubAPI } from './github/api.js'
import { OpenCodeClientImpl } from './opencode/client.js'
import { LLMClientImpl } from './opencode/llm-client.js'
import { OpenCodeServer } from './opencode/server.js'
import { ReviewOrchestrator } from './review/orchestrator.js'
import { setupToolsInWorkspace } from './setup/tools.js'
import { TRPCServer } from './trpc/server.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  let openCodeServer: OpenCodeServer | null = null
  let trpcServer: TRPCServer | null = null
  let orchestrator: ReviewOrchestrator | null = null
  let exitCode = 0

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

    orchestrator = new ReviewOrchestrator(
      opencode,
      llmClient,
      github,
      config,
      workspaceRoot
    )

    trpcServer = new TRPCServer(orchestrator, github, llmClient)
    await trpcServer.start()

    if (config.execution.mode === 'question-answering') {
      logger.info('Execution mode: Question Answering')

      const answer = await orchestrator.executeQuestionAnswering()

      const questionContext = config.execution.questionContext
      if (questionContext) {
        logger.info('Posting answer as comment reply')
        const formattedAnswer = `**@${questionContext.author}** asked: "${questionContext.question}"

${answer}

---
*Answered by @review-my-code-bot using codebase analysis*`

        await github.replyToIssueComment(
          questionContext.commentId,
          formattedAnswer
        )
        logger.info('Answer posted successfully')
      }

      core.setOutput('review_status', 'question_answered')
      core.setOutput('issues_found', '0')
      core.setOutput('blocking_issues', '0')
    } else if (config.execution.mode === 'full-review') {
      logger.info('Execution mode: Full Review')

      const result = await orchestrator.executeReview()

      core.setOutput('review_status', result.status)
      core.setOutput('issues_found', String(result.issuesFound))
      core.setOutput('blocking_issues', String(result.blockingIssues))

      if (result.issuesFound > 0) {
        const message =
          result.blockingIssues > 0
            ? `Review found ${result.issuesFound} issue(s), including ${result.blockingIssues} blocking issue(s). Please address the review comments before merging.`
            : `Review found ${result.issuesFound} issue(s). Please address the review comments before merging.`
        core.setFailed(message)
        exitCode = 1
      }
    } else if (config.execution.mode === 'dispute-resolution') {
      logger.info('Execution mode: Dispute Resolution Only')

      await orchestrator.executeDisputeResolution(
        config.execution.disputeContext
      )

      core.setOutput('review_status', 'disputes_evaluated')
      core.setOutput('issues_found', '0')
      core.setOutput('blocking_issues', '0')
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
    await cleanup(orchestrator, trpcServer, openCodeServer)
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
