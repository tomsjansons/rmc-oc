import * as cache from '@actions/cache'
import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReviewConfig } from '../review/types.js'

const CACHE_VERSION = 'v1'
const STATE_SCHEMA_VERSION = 1
const STATE_FILE_NAME = 'review-state.json'
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ReviewThread {
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

export interface PassResult {
  number: number
  summary: string
  completed: boolean
  has_blocking_issues: boolean
}

export interface ReviewState {
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
  private tempDir: string
  private sentimentCache: Map<string, boolean>
  private cachedState: ReviewState | null = null

  constructor(private config: ReviewConfig) {
    this.octokit = new Octokit({
      auth: config.github.token
    })
    this.tempDir = join(tmpdir(), `pr-review-${config.github.prNumber}`)
    this.sentimentCache = new Map()
  }

  private getCacheKey(): string {
    const { owner, repo, prNumber } = this.config.github
    return `${CACHE_VERSION}-pr-review-state-${owner}-${repo}-${prNumber}`
  }

  private async ensureTempDir(): Promise<void> {
    try {
      await mkdir(this.tempDir, { recursive: true })
    } catch (error) {
      core.warning(`Failed to create temp directory: ${error}`)
    }
  }

  private getStatePath(): string {
    return join(this.tempDir, STATE_FILE_NAME)
  }

  async saveState(state: ReviewState): Promise<void> {
    try {
      await this.ensureTempDir()
      const statePath = this.getStatePath()

      state.version = STATE_SCHEMA_VERSION
      state.metadata.updated_at = new Date().toISOString()

      this.cachedState = state

      const serialized = JSON.stringify(state, null, 2)
      await writeFile(statePath, serialized, 'utf-8')

      core.info(`State written to ${statePath}`)

      const cacheKey = this.getCacheKey()
      const cacheId = await cache.saveCache([this.tempDir], cacheKey)

      if (cacheId === -1) {
        core.warning(
          'Failed to save cache. State is persisted locally but will not be available across runs.'
        )
      } else {
        core.info(`State saved to GitHub Cache with key: ${cacheKey}`)
      }
    } catch (error) {
      if (error instanceof Error) {
        core.warning(`Failed to save state: ${error.message}`)
        throw new StateError('Failed to save review state', error)
      }
      throw error
    }
  }

  async restoreState(): Promise<ReviewState | null> {
    try {
      await this.ensureTempDir()
      const cacheKey = this.getCacheKey()

      core.info(`Attempting to restore cache with key: ${cacheKey}`)

      const restoredKey = await cache.restoreCache([this.tempDir], cacheKey)

      if (!restoredKey) {
        core.info('Cache miss - will rebuild state from GitHub comments')
        return null
      }

      core.info(`Cache hit with key: ${restoredKey}`)

      const statePath = this.getStatePath()
      const stateContent = await readFile(statePath, 'utf-8')
      const state = JSON.parse(stateContent) as ReviewState

      const isValid = this.validateState(state)
      if (!isValid) {
        core.warning(
          'Restored state failed validation - rebuilding from GitHub'
        )
        return null
      }

      core.info(
        `State restored successfully with ${state.threads.length} threads`
      )
      return state
    } catch (error) {
      if (error instanceof Error) {
        core.warning(`Failed to restore state: ${error.message}`)
      }
      return null
    }
  }

  private validateState(state: ReviewState): boolean {
    if (!state || typeof state !== 'object') {
      return false
    }

    if (typeof state.version !== 'number') {
      core.warning('State missing version field')
      return false
    }

    if (!this.isVersionCompatible(state.version)) {
      core.warning(
        `State version ${state.version} is incompatible with current version ${STATE_SCHEMA_VERSION}`
      )
      return false
    }

    if (state.prNumber !== this.config.github.prNumber) {
      core.warning('State PR number mismatch')
      return false
    }

    if (!Array.isArray(state.threads)) {
      return false
    }

    if (!Array.isArray(state.passes)) {
      return false
    }

    if (!state.metadata || !state.metadata.created_at) {
      return false
    }

    return true
  }

  private isVersionCompatible(version: number): boolean {
    if (version === STATE_SCHEMA_VERSION) {
      return true
    }

    return false
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

        const threadId = String(comment.id)
        const assessment = this.extractAssessmentFromComment(comment.body)

        if (!assessment.finding || assessment.score === 5) {
          continue
        }

        const replies = commentMap.get(comment.id) || []
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
          status: 'PENDING',
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
      await this.saveState(state)

      return state
    } catch (error) {
      if (error instanceof Error) {
        throw new StateError('Failed to rebuild state from comments', error)
      }
      throw error
    }
  }

  private extractAssessmentFromComment(body: string): {
    finding: string
    assessment: string
    score: number
  } {
    try {
      const jsonMatch = body.match(/```json\s*(\{[\s\S]*?\})\s*```/)
      if (jsonMatch && jsonMatch[1]) {
        const parsed = JSON.parse(jsonMatch[1])
        if (
          parsed.finding &&
          parsed.assessment &&
          typeof parsed.score === 'number'
        ) {
          return parsed
        }
      }
    } catch (error) {
      core.debug(`Failed to extract assessment from comment: ${error}`)
    }

    return {
      finding: 'Unknown issue',
      assessment: body.substring(0, 200),
      score: 5
    }
  }

  async detectConcession(body: string): Promise<boolean> {
    const cacheKey = this.generateCacheKey(body)

    if (this.sentimentCache.has(cacheKey)) {
      core.debug(`Using cached sentiment result for comment`)
      return this.sentimentCache.get(cacheKey)!
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

  private generateCacheKey(body: string): string {
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

  private async analyzeCommentSentiment(commentBody: string): Promise<boolean> {
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
${commentBody}
"""

Respond with ONLY "true" if this is a concession, or "false" if it is not.`

    const requestBody = {
      model: this.config.opencode.model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 10
    }

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.opencode.apiKey}`,
        'HTTP-Referer': 'https://github.com/opencode-pr-reviewer',
        'X-Title': 'OpenCode PR Reviewer'
      },
      body: JSON.stringify(requestBody)
    })

    if (!response.ok) {
      throw new Error(
        `OpenRouter API request failed: ${response.status} ${response.statusText}`
      )
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    const content = data.choices?.[0]?.message?.content?.trim().toLowerCase()

    if (content === 'true') {
      return true
    }

    if (content === 'false') {
      return false
    }

    core.debug(
      `Unexpected sentiment analysis response: ${content}, defaulting to false`
    )
    return false
  }

  async getOrCreateState(): Promise<ReviewState> {
    if (this.cachedState) {
      return this.cachedState
    }

    const restored = await this.restoreState()

    if (restored) {
      this.cachedState = restored
      return restored
    }

    const rebuilt = await this.rebuildStateFromComments()
    this.cachedState = rebuilt
    return rebuilt
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
    await this.saveState(state)
  }

  async addThread(thread: ReviewThread): Promise<void> {
    const state = await this.getOrCreateState()

    const existingIndex = state.threads.findIndex((t) => t.id === thread.id)
    if (existingIndex >= 0) {
      state.threads[existingIndex] = thread
    } else {
      state.threads.push(thread)
    }

    await this.saveState(state)
  }

  async recordPassCompletion(passResult: PassResult): Promise<void> {
    const state = await this.getOrCreateState()

    const existingIndex = state.passes.findIndex(
      (p) => p.number === passResult.number
    )
    if (existingIndex >= 0) {
      state.passes[existingIndex] = passResult
    } else {
      state.passes.push(passResult)
    }

    await this.saveState(state)
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
    const prompt = `You are analyzing a developer's response to a code review comment to classify their intent.

Original finding: "${originalFinding}"

Developer's response:
"""
${replyBody}
"""

Classify the response as ONE of the following:
- "acknowledgment": Developer agrees and commits to fixing it (e.g., "good catch", "will fix", "you're right")
- "dispute": Developer disagrees with the finding (e.g., "this is intentional", "middleware handles this", "size is constrained")
- "question": Developer asks for clarification (e.g., "what do you mean?", "can you explain?", "where should I...")
- "out_of_scope": Developer acknowledges but will fix later (e.g., "will fix in next sprint", "out of scope for this PR")

Respond with ONLY one word: acknowledgment, dispute, question, or out_of_scope`

    const requestBody = {
      model: this.config.opencode.model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 10
    }

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.opencode.apiKey}`,
          'HTTP-Referer': 'https://github.com/opencode-pr-reviewer',
          'X-Title': 'OpenCode PR Reviewer'
        },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        throw new Error(
          `OpenRouter API request failed: ${response.status} ${response.statusText}`
        )
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }

      const content = data.choices?.[0]?.message?.content
        ?.trim()
        .toLowerCase() as
        | 'acknowledgment'
        | 'dispute'
        | 'question'
        | 'out_of_scope'
        | undefined

      if (
        content === 'acknowledgment' ||
        content === 'dispute' ||
        content === 'question' ||
        content === 'out_of_scope'
      ) {
        return content
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
}

export class StateError extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message)
    this.name = 'StateError'
  }
}
