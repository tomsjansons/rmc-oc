import { initTRPC } from '@trpc/server'
import superjson from 'superjson'

import type { GitHubAPI } from '../github/api.js'
import type { ReviewOrchestrator } from '../review/orchestrator.js'
import { logger } from '../utils/logger.js'
import {
  escalateDisputeSchema,
  postReviewCommentSchema,
  replyToThreadSchema,
  resolveThreadSchema,
  submitPassResultsSchema
} from './schemas.js'

export interface TRPCContext {
  orchestrator: ReviewOrchestrator
  github: GitHubAPI
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson
})

const publicProcedure = t.procedure
const router = t.router

export const appRouter = router({
  github: router({
    getRunState: publicProcedure.query(async ({ ctx }) => {
      logger.debug('tRPC: github.getRunState called')
      const state = ctx.orchestrator.getState()

      return {
        threads: state?.threads || [],
        lastCommitSha: state?.lastCommitSha || '',
        metadata: state?.metadata || {}
      }
    }),

    postReviewComment: publicProcedure
      .input(postReviewCommentSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug(
          `tRPC: github.postReviewComment called for ${input.file}:${input.line} (score: ${input.assessment.score})`
        )

        const config = ctx.orchestrator.getConfig()
        if (input.assessment.score < config.scoring.problemThreshold) {
          logger.info(
            `Comment filtered: score ${input.assessment.score} below threshold ${config.scoring.problemThreshold}`
          )
          return {
            filtered: true,
            reason: `Score ${input.assessment.score} below threshold ${config.scoring.problemThreshold}`
          }
        }

        const commentBody = `${input.body}\n\n---\n\`\`\`json\n${JSON.stringify(input.assessment, null, 2)}\n\`\`\``

        const commentId = await ctx.github.postReviewComment({
          path: input.file,
          line: input.line,
          body: commentBody
        })

        await ctx.orchestrator.addThread({
          id: commentId,
          file: input.file,
          line: input.line,
          status: 'PENDING',
          score: input.assessment.score,
          assessment: input.assessment,
          original_comment: {
            author: 'opencode-reviewer[bot]',
            body: input.body,
            timestamp: new Date().toISOString()
          }
        })

        logger.info(`Posted comment on ${input.file}:${input.line}`)

        return {
          filtered: false,
          threadId: commentId
        }
      }),

    replyToThread: publicProcedure
      .input(replyToThreadSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug(`tRPC: github.replyToThread called for ${input.threadId}`)

        await ctx.github.replyToComment(input.threadId, input.body)

        if (input.isConcession) {
          await ctx.orchestrator.updateThreadStatus(input.threadId, 'RESOLVED')
          logger.info(
            `Thread ${input.threadId} marked as RESOLVED (agent conceded)`
          )
        } else {
          await ctx.orchestrator.updateThreadStatus(input.threadId, 'DISPUTED')
          logger.info(`Thread ${input.threadId} marked as DISPUTED`)
        }

        return { success: true }
      }),

    resolveThread: publicProcedure
      .input(resolveThreadSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug(`tRPC: github.resolveThread called for ${input.threadId}`)

        await ctx.github.resolveThread(input.threadId, input.reason)
        await ctx.orchestrator.updateThreadStatus(input.threadId, 'RESOLVED')

        logger.info(`Thread ${input.threadId} resolved: ${input.reason}`)

        return { success: true }
      }),

    escalateDispute: publicProcedure
      .input(escalateDisputeSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug(
          `tRPC: github.escalateDispute called for ${input.threadId}`
        )

        const config = ctx.orchestrator.getConfig()

        if (!config.dispute.enableHumanEscalation) {
          logger.warning(
            'Human escalation is not enabled - escalation request ignored'
          )
          return {
            success: false,
            reason: 'Human escalation is not enabled in configuration'
          }
        }

        if (config.dispute.humanReviewers.length === 0) {
          logger.warning('No human reviewers configured for escalation')
          return {
            success: false,
            reason: 'No human reviewers configured'
          }
        }

        await ctx.github.escalateToHumanReviewers(
          input.threadId,
          input.agentPosition,
          input.developerPosition,
          config.dispute.humanReviewers
        )

        await ctx.orchestrator.updateThreadStatus(input.threadId, 'ESCALATED')

        logger.info(`Thread ${input.threadId} escalated to human reviewers`)

        return { success: true }
      })
  }),

  review: router({
    submitPassResults: publicProcedure
      .input(submitPassResultsSchema)
      .mutation(async ({ ctx, input }) => {
        logger.info(
          `tRPC: review.submitPassResults called for pass ${input.passNumber}`
        )

        ctx.orchestrator.recordPassCompletion({
          passNumber: input.passNumber,
          summary: input.summary,
          hasBlockingIssues: input.hasBlockingIssues
        })

        const nextPass = input.passNumber < 3 ? input.passNumber + 1 : null

        logger.info(
          `Pass ${input.passNumber} completed. Next: ${nextPass || 'done'}`
        )

        return {
          success: true,
          nextPass
        }
      })
  })
})

export type AppRouter = typeof appRouter
