import { tool } from '@opencode-ai/plugin'
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'

import { TRPC_SERVER_URL } from '../../config/constants.js'
import type { AppRouter } from '../../trpc/router.js'

const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: TRPC_SERVER_URL,
      transformer: superjson
    })
  ]
})

export default tool({
  description:
    'Mark current pass as complete and trigger next pass. Required at end of each pass.',
  args: {
    passNumber: tool.schema
      .number()
      .min(1)
      .max(3)
      .describe('Pass number that was completed (1-3)'),
    hasBlockingIssues: tool.schema
      .boolean()
      .describe('Whether blocking issues (score >= 8) were found')
  },
  async execute(args) {
    const result = await trpc.review.submitPassResults.mutate(args)

    if (!result.success) {
      return `Error: ${result.error}`
    }

    if (result.nextPass) {
      return `Pass ${args.passNumber} complete. Ready for Pass ${result.nextPass}.`
    }

    return `Pass ${args.passNumber} complete. All passes finished.`
  }
})
