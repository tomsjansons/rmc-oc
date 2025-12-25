import { z } from 'zod'

export const issueAssessmentSchema = z.object({
  finding: z.string().describe('Brief one-sentence description'),
  assessment: z.string().describe('Detailed analysis of impact'),
  score: z.number().min(1).max(10).describe('Severity score 1-10')
})

export const postReviewCommentSchema = z.object({
  file: z.string().describe('File path relative to repo root'),
  line: z.number().describe('Line number in the file'),
  body: z.string().describe('Human-readable comment body'),
  assessment: issueAssessmentSchema
})

export const replyToThreadSchema = z.object({
  threadId: z.string().describe('Thread ID to reply to'),
  body: z.string().describe('Reply message'),
  isConcession: z
    .boolean()
    .optional()
    .describe('Whether this is accepting developer explanation')
})

export const resolveThreadSchema = z.object({
  threadId: z.string().describe('Thread ID to resolve'),
  reason: z.string().describe('Reason for resolution')
})

export const submitPassResultsSchema = z.object({
  passNumber: z.number().min(1).max(3).describe('Pass number (1-3)'),
  hasBlockingIssues: z.boolean().describe('Whether blocking issues were found')
})

export const escalateDisputeSchema = z.object({
  threadId: z.string().describe('Thread ID to escalate'),
  agentPosition: z.string().describe("Summary of the agent's position"),
  developerPosition: z.string().describe("Summary of the developer's position")
})
