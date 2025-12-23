import { tool } from '@opencode-ai/plugin';
import { c as createTRPCClient, h as httpBatchLink, S as SuperJSON, T as TRPC_SERVER_URL } from './constants-Bo10LBJa.js';

const trpc = createTRPCClient({
    links: [
        httpBatchLink({
            url: TRPC_SERVER_URL,
            transformer: SuperJSON
        })
    ]
});
var submit_pass_results = tool({
    description: 'Mark current pass as complete and trigger next pass. Required at end of each pass.',
    args: {
        passNumber: tool.schema
            .number()
            .min(1)
            .max(4)
            .describe('Pass number that was completed (1-4)'),
        hasBlockingIssues: tool.schema
            .boolean()
            .describe('Whether blocking issues (score >= 8) were found')
    },
    async execute(args) {
        const result = await trpc.review.submitPassResults.mutate(args);
        if (!result.success) {
            return `Error: ${result.error}`;
        }
        if (result.nextPass) {
            return `Pass ${args.passNumber} complete. Ready for Pass ${result.nextPass}.`;
        }
        return `Pass ${args.passNumber} complete. All passes finished.`;
    }
});

export { submit_pass_results as default };
