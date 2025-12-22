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
var github_post_review_comment = tool({
    description: 'Post a review comment on the PR. Automatically filtered if score is below problem_threshold.',
    args: {
        file: tool.schema.string().describe('File path relative to repo root'),
        line: tool.schema.number().describe('Line number in the file'),
        body: tool.schema
            .string()
            .describe('Human-readable comment explaining the issue'),
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
        const result = await trpc.github.postReviewComment.mutate(args);
        if (result.filtered) {
            return `Comment filtered: ${result.reason}`;
        }
        return `Comment posted successfully. Thread ID: ${result.threadId}`;
    }
});

export { github_post_review_comment as default };
