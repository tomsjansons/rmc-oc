import { tool } from '@opencode-ai/plugin';
import { c as createTRPCClient, h as httpBatchLink, T as TRPC_SERVER_URL, S as SuperJSON } from './constants-Bo10LBJa.js';

const trpc = createTRPCClient({
    links: [
        httpBatchLink({
            url: TRPC_SERVER_URL,
            transformer: SuperJSON
        })
    ]
});
var github_resolve_thread = tool({
    description: 'Resolve a review thread when the issue is verified as fixed',
    args: {
        threadId: tool.schema.string().describe('Thread ID to resolve'),
        reason: tool.schema
            .string()
            .describe('Clear reason explaining why issue is resolved')
    },
    async execute(args) {
        await trpc.github.resolveThread.mutate(args);
        return 'Thread resolved successfully';
    }
});

export { github_resolve_thread as default };
