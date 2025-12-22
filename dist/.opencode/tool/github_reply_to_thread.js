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
var github_reply_to_thread = tool({
    description: 'Reply to an existing review thread. Use is_concession: true when accepting developer explanation.',
    args: {
        threadId: tool.schema.string().describe('Thread ID to reply to'),
        body: tool.schema.string().describe('Reply message'),
        isConcession: tool.schema
            .boolean()
            .optional()
            .describe('Set to true when accepting developer explanation')
    },
    async execute(args) {
        await trpc.github.replyToThread.mutate(args);
        return 'Reply posted successfully';
    }
});

export { github_reply_to_thread as default };
