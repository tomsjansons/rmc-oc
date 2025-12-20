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
  status: 'PENDING' | 'RESOLVED' | 'DISPUTED'
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

      for (const comment of reviewComments.data) {
        if (comment.in_reply_to_id) {
          continue
        }

        const threadId = String(comment.id)
        const assessment = this.extractAssessmentFromComment(comment.body)

        if (!assessment.finding || assessment.score === 5) {
          continue
        }

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
          }
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
    const restored = await this.restoreState()

    if (restored) {
      return restored
    }

    return await this.rebuildStateFromComments()
  }

  async updateThreadStatus(
    threadId: string,
    status: 'PENDING' | 'RESOLVED' | 'DISPUTED'
  ): Promise<void> {
    const state = await this.getOrCreateState()

    const thread = state.threads.find((t) => t.id === threadId)
    if (!thread) {
      throw new StateError(`Thread ${threadId} not found`)
    }

    thread.status = status
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
