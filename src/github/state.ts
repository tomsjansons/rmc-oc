import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'

import type { LLMClient } from '../opencode/llm-client.js'
import type { PassResult, ReviewConfig } from '../review/types.js'
import { sanitizeDelimiters } from '../utils/security.js'

const STATE_SCHEMA_VERSION = 1
const BOT_USERS = ['opencode-reviewer[bot]', 'github-actions[bot]']

export type ReviewThread = {
  id: string
  file: string
  line: number
  status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  score: number
  assessment: {
    finding: string
    assessment: string
    score: number
  }
  original_comment: {
    author: string
    body: string
    timestamp: string
  }
  developer_replies?: Array<{
    author: string
    body: string
    timestamp: string
  }>
  escalated_at?: string
}

export type ReviewState = {
  version: number
  prNumber: number
  lastCommitSha: string
  threads: ReviewThread[]
  passes: PassResult[]
  metadata: {
    created_at: string
    updated_at: string
  }
}

export class StateManager {
  private octokit: Octokit
  private sentimentCache: Map<string, boolean>
  private currentState: ReviewState | null = null

  constructor(
    private config: ReviewConfig,
    private llmClient: LLMClient
  ) {
    this.octokit = new Octokit({
      auth: config.github.token
    })
    this.sentimentCache = new Map()
  }

  updateState(state: ReviewState): void {
    state.version = STATE_SCHEMA_VERSION
    state.metadata.updated_at = new Date().toISOString()
    this.currentState = state
  }

  async rebuildStateFromComments(): Promise<ReviewState> {
    core.info('Rebuilding state from GitHub PR comments')

    try {
      const { owner, repo, prNumber } = this.config.github

      const prData = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      })

      const lastCommitSha = prData.data.head.sha

      const reviewComments = await this.octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      })

      const threads: ReviewThread[] = []
      const commentMap = new Map<number, (typeof reviewComments.data)[0][]>()

      for (const comment of reviewComments.data) {
        const replyToId = comment.in_reply_to_id
        if (replyToId) {
          const replies = commentMap.get(replyToId) || []
          replies.push(comment)
          commentMap.set(replyToId, replies)
        }
      }

      for (const comment of reviewComments.data) {
        if (comment.in_reply_to_id) {
          continue
        }

        const commentAuthor = comment.user?.login
        if (!commentAuthor || !BOT_USERS.includes(commentAuthor)) {
          continue
        }

        const threadId = String(comment.id)
        const assessment = this.extractAssessmentFromComment(comment.body)

        if (!assessment) {
          continue
        }

        const replies = commentMap.get(comment.id) || []

        const status = this.determineThreadStatus(replies)

        const developerReplies = replies
          .filter(
            (r) =>
              r.user?.login !== 'opencode-reviewer[bot]' &&
              r.user?.login !== 'github-actions[bot]'
          )
          .map((r) => ({
            author: r.user?.login || 'unknown',
            body: r.body,
            timestamp: r.created_at
          }))

        threads.push({
          id: threadId,
          file: comment.path,
          line: comment.line || comment.original_line || 1,
          status,
          score: assessment.score,
          assessment,
          original_comment: {
            author: comment.user?.login || 'unknown',
            body: comment.body,
            timestamp: comment.created_at
          },
          developer_replies:
            developerReplies.length > 0 ? developerReplies : undefined
        })
      }

      const state: ReviewState = {
        version: STATE_SCHEMA_VERSION,
        prNumber,
        lastCommitSha,
        threads,
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      core.info(`Rebuilt state with ${threads.length} threads`)
      this.updateState(state)

      return state
    } catch (error) {
      if (error instanceof Error) {
        throw new StateError('Failed to rebuild state from comments', error)
      }
      throw error
    }
  }

  private determineThreadStatus(
    replies: Array<{ body: string; user?: { login?: string } | null }>
  ): 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED' {
    for (const reply of replies) {
      const isBot =
        reply.user?.login === 'opencode-reviewer[bot]' ||
        reply.user?.login === 'github-actions[bot]'

      if (!isBot) {
        continue
      }

      const statusFromBlock = this.extractStatusFromRmcocBlock(reply.body)
      if (statusFromBlock) {
        return statusFromBlock
      }

      if (reply.body.includes('✅ **Issue Resolved**')) {
        return 'RESOLVED'
      }

      if (reply.body.includes('🔺 **Escalated to Human Review**')) {
        return 'ESCALATED'
      }
    }

    return 'PENDING'
  }

  private extractStatusFromRmcocBlock(
    body: string
  ): 'RESOLVED' | 'ESCALATED' | null {
    const match = body.match(/```rmcoc\s*(\{[\s\S]*?\})\s*```/)
    if (!match?.[1]) {
      return null
    }

    try {
      const parsed = JSON.parse(match[1])
      if (parsed.status === 'RESOLVED') {
        return 'RESOLVED'
      }
      if (parsed.status === 'ESCALATED') {
        return 'ESCALATED'
      }
    } catch {
      return null
    }

    return null
  }

  private extractAssessmentFromComment(body: string): {
    finding: string
    assessment: string
    score: number
  } | null {
    const patterns = [
      /```rmcoc\s*(\{[\s\S]*?\})\s*```/,
      /```json\s*(\{[\s\S]*?\})\s*```/,
      /(\{\s*"finding"[\s\S]*?"score"\s*:\s*\d+\s*\})/
    ]

    for (const pattern of patterns) {
      try {
        const match = body.match(pattern)
        if (match?.[1]) {
          const sanitized = this.sanitizeJsonString(match[1])
          const parsed = JSON.parse(sanitized)
          if (
            parsed.finding &&
            parsed.assessment &&
            typeof parsed.score === 'number'
          ) {
            return parsed
          }
        }
      } catch (error) {
        core.debug(`Failed to parse JSON with pattern ${pattern}: ${error}`)
      }
    }

    return null
  }

  private sanitizeJsonString(jsonStr: string): string {
    return (
      jsonStr
        // Remove trailing commas before } or ]
        .replace(/,(\s*[}\]])/g, '$1')
        // Replace backslash-backtick with just single quote
        .replace(/\\`/g, "'")
        // Replace standalone backticks with single quotes
        .replace(/`/g, "'")
    )
  }

  private sanitizePromptInput(input: string): string {
    return sanitizeDelimiters(input)
  }

  async detectConcession(body: string): Promise<boolean> {
    const cacheKey = this.generateSentimentCacheKey(body)

    const cachedResult = this.sentimentCache.get(cacheKey)
    if (cachedResult !== undefined) {
      core.debug(`Using cached sentiment result for comment`)
      return cachedResult
    }

    try {
      const response = await this.analyzeCommentSentiment(body)
      this.sentimentCache.set(cacheKey, response)
      return response
    } catch (error) {
      core.warning(`Failed to analyze sentiment via API: ${error}`)
      const fallbackResult = this.detectConcessionFallback(body)
      this.sentimentCache.set(cacheKey, fallbackResult)
      return fallbackResult
    }
  }

  private generateSentimentCacheKey(body: string): string {
    const normalized = body.trim().toLowerCase()
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash
    }
    return `sentiment_${hash}`
  }

  private detectConcessionFallback(body: string): boolean {
    const concessionPhrases = [
      'you are correct',
      'i concede',
      "you're right",
      'fair point',
      'good catch',
      'agreed',
      'makes sense'
    ]

    const lowerBody = body.toLowerCase()
    return concessionPhrases.some((phrase) => lowerBody.includes(phrase))
  }

  private async callLLM(prompt: string): Promise<string | null> {
    return this.llmClient.complete(prompt)
  }

  private async analyzeCommentSentiment(commentBody: string): Promise<boolean> {
    const sanitizedBody = this.sanitizePromptInput(commentBody)
    const prompt = `You are analyzing a code review comment to determine if the developer is conceding to a reviewer's suggestion.

A concession means the developer:
- Agrees with the reviewer's point
- Acknowledges they were wrong or missed something
- Commits to making the suggested change
- Accepts the feedback as valid

A concession does NOT include:
- Disagreements or rebuttals
- Requests for clarification
- Alternative suggestions
- Neutral acknowledgments without commitment

Comment to analyze:
"""
${sanitizedBody}
"""

Respond with ONLY "true" if this is a concession, or "false" if it is not.`

    const content = await this.callLLM(prompt)

    if (/^true/i.test(content || '')) {
      return true
    }

    if (/^false/i.test(content || '')) {
      return false
    }

    core.debug(
      `Unexpected sentiment analysis response: ${content}, defaulting to false`
    )
    return false
  }

  async getOrCreateState(): Promise<ReviewState> {
    if (this.currentState) {
      return this.currentState
    }

    return await this.rebuildStateFromComments()
  }

  async updateThreadStatus(
    threadId: string,
    status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  ): Promise<void> {
    const state = await this.getOrCreateState()

    const thread = state.threads.find((t) => t.id === threadId)
    if (!thread) {
      throw new StateError(`Thread ${threadId} not found`)
    }

    thread.status = status
    if (status === 'ESCALATED') {
      thread.escalated_at = new Date().toISOString()
    }
    this.updateState(state)
  }

  async addThread(thread: ReviewThread): Promise<void> {
    const state = await this.getOrCreateState()

    const existingIndex = state.threads.findIndex((t) => t.id === thread.id)
    if (existingIndex >= 0) {
      state.threads[existingIndex] = thread
    } else {
      state.threads.push(thread)
    }

    this.updateState(state)
  }

  async recordPassCompletion(passResult: PassResult): Promise<void> {
    const state = await this.getOrCreateState()

    const existingIndex = state.passes.findIndex(
      (p) => p.passNumber === passResult.passNumber
    )
    if (existingIndex >= 0) {
      state.passes[existingIndex] = passResult
    } else {
      state.passes.push(passResult)
    }

    this.updateState(state)
  }

  async fetchDeveloperReplies(threadId: string): Promise<
    Array<{
      author: string
      body: string
      timestamp: string
    }>
  > {
    try {
      const { owner, repo, prNumber } = this.config.github

      const comments = await this.octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      })

      const replies = comments.data
        .filter(
          (comment) =>
            comment.in_reply_to_id === Number(threadId) &&
            comment.user?.login !== 'opencode-reviewer[bot]' &&
            comment.user?.login !== 'github-actions[bot]'
        )
        .map((comment) => ({
          author: comment.user?.login || 'unknown',
          body: comment.body,
          timestamp: comment.created_at
        }))

      return replies
    } catch (error) {
      core.warning(
        `Failed to fetch developer replies for thread ${threadId}: ${error}`
      )
      return []
    }
  }

  async classifyDeveloperReply(
    originalFinding: string,
    replyBody: string
  ): Promise<'acknowledgment' | 'dispute' | 'question' | 'out_of_scope'> {
    const sanitizedFinding = this.sanitizePromptInput(originalFinding)
    const sanitizedReply = this.sanitizePromptInput(replyBody)
    const prompt = `You are analyzing a developer's response to a code review comment to classify their intent.

Original finding: "${sanitizedFinding}"

Developer's response:
"""
${sanitizedReply}
"""

Classify the response as ONE of the following:
- "acknowledgment": Developer agrees and commits to fixing it (e.g., "good catch", "will fix", "you're right")
- "dispute": Developer disagrees with the finding (e.g., "this is intentional", "middleware handles this", "size is constrained")
- "question": Developer asks for clarification (e.g., "what do you mean?", "can you explain?", "where should I...")
- "out_of_scope": Developer acknowledges but will fix later (e.g., "will fix in next sprint", "out of scope for this PR")

Respond with ONLY one word: acknowledgment, dispute, question, or out_of_scope`

    try {
      const content = (await this.callLLM(prompt)) || ''

      if (/^acknowledgment/i.test(content)) {
        return 'acknowledgment'
      }
      if (/^dispute/i.test(content)) {
        return 'dispute'
      }
      if (/^question/i.test(content)) {
        return 'question'
      }
      if (/^out_of_scope/i.test(content)) {
        return 'out_of_scope'
      }

      core.debug(
        `Unexpected classification response: ${content}, defaulting to dispute`
      )
      return 'dispute'
    } catch (error) {
      core.warning(
        `Failed to classify developer reply via API: ${error}, using fallback`
      )
      return this.classifyDeveloperReplyFallback(replyBody)
    }
  }

  private classifyDeveloperReplyFallback(
    replyBody: string
  ): 'acknowledgment' | 'dispute' | 'question' | 'out_of_scope' {
    const lowerBody = replyBody.toLowerCase()

    const acknowledgmentPhrases = [
      'good catch',
      'will fix',
      'thanks',
      "you're right",
      'you are right',
      'agreed',
      'makes sense',
      'fair point'
    ]
    if (acknowledgmentPhrases.some((phrase) => lowerBody.includes(phrase))) {
      return 'acknowledgment'
    }

    const questionMarkers = ['what', 'why', 'how', 'can you', 'could you', '?']
    if (questionMarkers.some((marker) => lowerBody.includes(marker))) {
      return 'question'
    }

    const outOfScopePhrases = [
      'next sprint',
      'later',
      'future pr',
      'separate pr',
      'out of scope',
      'follow up'
    ]
    if (outOfScopePhrases.some((phrase) => lowerBody.includes(phrase))) {
      return 'out_of_scope'
    }

    return 'dispute'
  }

  async getThreadsWithDeveloperReplies(): Promise<ReviewThread[]> {
    const state = await this.getOrCreateState()

    const threadsWithReplies: ReviewThread[] = []

    for (const thread of state.threads) {
      if (thread.status === 'RESOLVED') {
        continue
      }

      const replies = await this.fetchDeveloperReplies(thread.id)

      if (replies.length > 0) {
        threadsWithReplies.push({
          ...thread,
          developer_replies: replies
        })
      }
    }

    return threadsWithReplies
  }

  findDuplicateThread(
    file: string,
    line: number,
    finding: string
  ): ReviewThread | null {
    if (!this.currentState) {
      return null
    }

    return (
      this.currentState.threads.find(
        (t) =>
          t.file === file &&
          t.line === line &&
          t.status !== 'RESOLVED' &&
          this.isSimilarFinding(t.assessment.finding, finding)
      ) || null
    )
  }

  private isSimilarFinding(existing: string, incoming: string): boolean {
    const normalizedExisting = this.normalizeForComparison(existing)
    const normalizedIncoming = this.normalizeForComparison(incoming)

    if (normalizedExisting === normalizedIncoming) {
      return true
    }

    const existingWords = this.getSignificantWords(existing)
    const incomingWords = this.getSignificantWords(incoming)

    if (existingWords.size === 0 || incomingWords.size === 0) {
      return false
    }

    const intersection = [...existingWords].filter((w) => incomingWords.has(w))
    const smallerSet = Math.min(existingWords.size, incomingWords.size)

    const overlapRatio = intersection.length / smallerSet

    return overlapRatio >= 0.5
  }

  private normalizeForComparison(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private getSignificantWords(text: string): Set<string> {
    const words = this.normalizeForComparison(text).split(' ')
    return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)))
  }
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'and',
  'but',
  'if',
  'or',
  'because',
  'until',
  'while',
  'this',
  'that',
  'these',
  'those'
])

export class StateError extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message)
    this.name = 'StateError'
  }
}
