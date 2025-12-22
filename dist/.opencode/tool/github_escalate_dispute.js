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
var github_escalate_dispute = tool({
    description: 'Escalate an unresolved dispute to human reviewers for final decision. Only available when human escalation is enabled.',
    args: {
        threadId: tool.schema.string().describe('Thread ID to escalate'),
        agentPosition: tool.schema
            .string()
            .describe("Summary of the agent's position on the issue"),
        developerPosition: tool.schema
            .string()
            .describe("Summary of the developer's counter-argument")
    },
    async execute(args) {
        await trpc.github.escalateDispute.mutate(args);
        return 'Dispute escalated to human reviewers successfully';
    }
});

export { github_escalate_dispute as default };
