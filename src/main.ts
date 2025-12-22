import * as core from '@actions/core'

import { OPENCODE_SERVER_URL } from './config/constants.js'
import { parseInputs, validateConfig } from './config/inputs.js'
import { GitHubAPI } from './github/api.js'
import { OpenCodeClientImpl } from './opencode/client.js'
import { OpenCodeServer } from './opencode/server.js'
import { ReviewOrchestrator } from './review/orchestrator.js'
import { setupToolsInWorkspace } from './setup/tools.js'
import { TRPCServer } from './trpc/server.js'
import { logger } from './utils/logger.js'

export async function run(): Promise<void> {
  let openCodeServer: OpenCodeServer | null = null
  let trpcServer: TRPCServer | null = null
  let orchestrator: ReviewOrchestrator | null = null

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
      config.opencode.debugLogging
    )
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    orchestrator = new ReviewOrchestrator(
      opencode,
      github,
      config,
      workspaceRoot
    )

    trpcServer = new TRPCServer(orchestrator, github)
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
    } else if (config.execution.mode === 'dispute-resolution') {
      logger.info('Execution mode: Dispute Resolution Only')

      await orchestrator.executeDisputeResolution()

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
  } finally {
    if (orchestrator) {
      await orchestrator.cleanup()
    }
    if (trpcServer) {
      await trpcServer.stop()
    }
    if (openCodeServer) {
      await openCodeServer.stop()
    }
  }
}
