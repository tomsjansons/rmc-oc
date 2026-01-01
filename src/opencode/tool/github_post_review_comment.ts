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
    'Post a review comment on the PR. Automatically filtered if score is below problem_threshold.',
  args: {
    file: tool.schema.string().describe('File path relative to repo root'),
    line: tool.schema.number().describe('Line number in the file'),
    body: tool.schema
      .string()
      .describe(
        'Human-readable comment. MUST start with **`file:line`** format (e.g., **`src/utils/auth.ts:42`**) followed by issue description'
      ),
    assessment: tool.schema
      .object({
        finding: tool.schema
          .string()
          .describe('Brief one-sentence description'),
        assessment: tool.schema
          .string()
          .describe('Detailed analysis of impact'),
        score: tool.schema
          .number()
          .min(1)
          .max(10)
          .describe('Severity score 1-10 based on rubric')
      })
      .describe('Structured assessment with score')
  },
  async execute(args) {
    const result = await trpc.github.postReviewComment.mutate(args)

    if (result.filtered) {
      return `Comment filtered: ${result.reason}`
    }

    return `Comment posted successfully. Thread ID: ${result.threadId}`
  }
})
