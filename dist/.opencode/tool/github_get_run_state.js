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
var github_get_run_state = tool({
    description: 'Get current review state including all threads and their statuses',
    args: {},
    async execute() {
        const state = await trpc.github.getRunState.query();
        return JSON.stringify(state, null, 2);
    }
});

export { github_get_run_state as default };
