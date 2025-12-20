import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals'
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockSaveCache = jest.fn<typeof import('@actions/cache').saveCache>()
const mockRestoreCache = jest.fn<typeof import('@actions/cache').restoreCache>()
const mockInfo = jest.fn()
const mockWarning = jest.fn()
const mockDebug = jest.fn()
const mockFetch = jest.fn<typeof fetch>()

const mockOctokit = {
  pulls: {
    get: jest.fn(),
    listReviewComments: jest.fn()
  }
}

global.fetch = mockFetch as any

jest.unstable_mockModule('@actions/cache', () => ({
  saveCache: mockSaveCache,
  restoreCache: mockRestoreCache
}))

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  debug: mockDebug
}))

jest.unstable_mockModule('@octokit/rest', () => ({
  Octokit: jest.fn(() => mockOctokit)
}))

const { StateManager, StateError } = await import('../src/github/state.js')
import type { ReviewConfig } from '../src/review/types.js'
import type { ReviewState } from '../src/github/state.js'

describe('StateManager', () => {
  let stateManager: StateManager
  let mockConfig: ReviewConfig
  let tempDir: string

  beforeEach(() => {
    mockConfig = {
      opencode: {
        apiKey: 'test-key',
        model: 'test-model',
        enableWeb: false
      },
      scoring: {
        problemThreshold: 5,
        elevationThreshold: 5
      },
      github: {
        token: 'test-token',
        owner: 'test-owner',
        repo: 'test-repo',
        prNumber: 123
      }
    }

    stateManager = new StateManager(mockConfig)
    tempDir = join(tmpdir(), `pr-review-${mockConfig.github.prNumber}`)

    mockSaveCache.mockClear()
    mockRestoreCache.mockClear()
    mockInfo.mockClear()
    mockWarning.mockClear()
    mockDebug.mockClear()
    mockFetch.mockClear()
    mockOctokit.pulls.get.mockClear()
    mockOctokit.pulls.listReviewComments.mockClear()
  })

  afterEach(async () => {
    try {
      await rmdir(tempDir, { recursive: true })
    } catch {
      // Ignore errors
    }
  })

  describe('getCacheKey', () => {
    it('should generate correct cache key format', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const key = (stateManager as any).getCacheKey()
      expect(key).toBe('v1-pr-review-state-test-owner-test-repo-123')
    })
  })

  describe('saveState', () => {
    it('should save state to file and cache', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      mockSaveCache.mockResolvedValue(1)

      await stateManager.saveState(state)

      const statePath = join(tempDir, 'review-state.json')
      const savedContent = await readFile(statePath, 'utf-8')
      const savedState = JSON.parse(savedContent)

      expect(savedState.version).toBe(1)
      expect(savedState.prNumber).toBe(123)
      expect(savedState.lastCommitSha).toBe('abc123')
      expect(mockSaveCache).toHaveBeenCalledWith(
        [tempDir],
        'v1-pr-review-state-test-owner-test-repo-123'
      )
    })

    it('should update metadata timestamp on save', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      }

      mockSaveCache.mockResolvedValue(1)

      await stateManager.saveState(state)

      const statePath = join(tempDir, 'review-state.json')
      const savedContent = await readFile(statePath, 'utf-8')
      const savedState = JSON.parse(savedContent)

      expect(savedState.metadata.updated_at).not.toBe(
        '2024-01-01T00:00:00.000Z'
      )
      expect(
        new Date(savedState.metadata.updated_at).getTime()
      ).toBeGreaterThan(new Date('2024-01-01T00:00:00.000Z').getTime())
    })

    it('should warn when cache save fails', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      mockSaveCache.mockResolvedValue(-1)

      await stateManager.saveState(state)

      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save cache')
      )
    })

    it('should throw StateError on write failure', async () => {
      await mkdir(tempDir, { recursive: true })
      const statePath = join(tempDir, 'review-state.json')
      await writeFile(statePath, 'invalid', 'utf-8')

      const readOnlyDir = join(tempDir, 'readonly')
      await mkdir(readOnlyDir, { recursive: true, mode: 0o444 })

      const readOnlyStateManager = new StateManager({
        ...mockConfig,
        github: { ...mockConfig.github, prNumber: 999 }
      })

      const state: ReviewState = {
        prNumber: 999,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      mockSaveCache.mockRejectedValue(new Error('Write failed'))

      await expect(readOnlyStateManager.saveState(state)).rejects.toThrow(
        StateError
      )
    })
  })

  describe('restoreState', () => {
    it('should restore state from cache', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [
          {
            id: 'thread-1',
            file: 'test.ts',
            line: 10,
            status: 'PENDING',
            score: 5,
            assessment: {
              finding: 'Test issue',
              assessment: 'Test assessment',
              score: 5
            },
            original_comment: {
              author: 'bot',
              body: 'Test comment',
              timestamp: new Date().toISOString()
            }
          }
        ],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      await mkdir(tempDir, { recursive: true })
      const statePath = join(tempDir, 'review-state.json')
      await writeFile(statePath, JSON.stringify(state), 'utf-8')

      mockRestoreCache.mockResolvedValue(
        'v1-pr-review-state-test-owner-test-repo-123'
      )

      const restored = await stateManager.restoreState()

      expect(restored).not.toBeNull()
      expect(restored?.prNumber).toBe(123)
      expect(restored?.threads.length).toBe(1)
      expect(restored?.threads[0].id).toBe('thread-1')
    })

    it('should return null on cache miss', async () => {
      mockRestoreCache.mockResolvedValue(undefined)

      const restored = await stateManager.restoreState()

      expect(restored).toBeNull()
    })

    it('should return null if state validation fails', async () => {
      const invalidState = {
        prNumber: 999,
        threads: [],
        passes: []
      }

      await mkdir(tempDir, { recursive: true })
      const statePath = join(tempDir, 'review-state.json')
      await writeFile(statePath, JSON.stringify(invalidState), 'utf-8')

      mockRestoreCache.mockResolvedValue(
        'v1-pr-review-state-test-owner-test-repo-123'
      )

      const restored = await stateManager.restoreState()

      expect(restored).toBeNull()
    })
  })

  describe('validateState', () => {
    it('should validate correct state', () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isValid = (stateManager as any).validateState(state)
      expect(isValid).toBe(true)
    })

    it('should reject state with wrong PR number', () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 999,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isValid = (stateManager as any).validateState(state)
      expect(isValid).toBe(false)
    })

    it('should reject state with missing fields', () => {
      const invalidStates = [
        null,
        {},
        { prNumber: 123 },
        { prNumber: 123, threads: 'invalid' },
        { prNumber: 123, threads: [], passes: 'invalid' },
        { prNumber: 123, threads: [], passes: [], metadata: {} }
      ]

      for (const state of invalidStates) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isValid = (stateManager as any).validateState(state)
        expect(isValid).toBe(false)
      }
    })

    it('should reject state with missing version', () => {
      const state = {
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isValid = (stateManager as any).validateState(state)
      expect(isValid).toBe(false)
    })

    it('should reject state with incompatible version', () => {
      const state: ReviewState = {
        version: 999,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isValid = (stateManager as any).validateState(state)
      expect(isValid).toBe(false)
    })
  })

  describe('version management', () => {
    it('should set version on new state', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      mockSaveCache.mockResolvedValue(1)
      await stateManager.saveState(state)

      const statePath = join(tempDir, 'review-state.json')
      const savedContent = await readFile(statePath, 'utf-8')
      const savedState = JSON.parse(savedContent)

      expect(savedState.version).toBe(1)
    })

    it('should preserve version when saving existing state', async () => {
      const state: ReviewState = {
        version: 1,
        prNumber: 123,
        lastCommitSha: 'abc123',
        threads: [],
        passes: [],
        metadata: {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }

      mockSaveCache.mockResolvedValue(1)
      await stateManager.saveState(state)

      const statePath = join(tempDir, 'review-state.json')
      const savedContent = await readFile(statePath, 'utf-8')
      const savedState = JSON.parse(savedContent)

      expect(savedState.version).toBe(1)
    })
  })

  describe('extractAssessmentFromComment', () => {
    it('should extract assessment from valid JSON block', () => {
      const comment = `
Some text before

\`\`\`json
{
  "finding": "Test finding",
  "assessment": "Test assessment",
  "score": 7
}
\`\`\`

Some text after
      `

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assessment = (stateManager as any).extractAssessmentFromComment(
        comment
      )

      expect(assessment.finding).toBe('Test finding')
      expect(assessment.assessment).toBe('Test assessment')
      expect(assessment.score).toBe(7)
    })

    it('should return default assessment for invalid JSON', () => {
      const comment = 'Just a regular comment without JSON'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assessment = (stateManager as any).extractAssessmentFromComment(
        comment
      )

      expect(assessment.finding).toBe('Unknown issue')
      expect(assessment.score).toBe(5)
      expect(assessment.assessment).toContain('Just a regular comment')
    })

    it('should return default assessment for malformed JSON block', () => {
      const comment = `
\`\`\`json
{ invalid json }
\`\`\`
      `

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assessment = (stateManager as any).extractAssessmentFromComment(
        comment
      )

      expect(assessment.finding).toBe('Unknown issue')
      expect(assessment.score).toBe(5)
    })
  })

  describe('detectConcession', () => {
    it('should detect concession via API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'true'
              }
            }
          ]
        })
      } as Response)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isConcession = await (stateManager as any).detectConcession(
        'You are absolutely right, I will fix this'
      )
      expect(isConcession).toBe(true)
      expect(mockFetch).toHaveBeenCalled()
    })

    it('should detect non-concession via API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'false'
              }
            }
          ]
        })
      } as Response)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isConcession = await (stateManager as any).detectConcession(
        'I disagree with this suggestion'
      )
      expect(isConcession).toBe(false)
    })

    it('should fallback to keyword detection on API failure', async () => {
      mockFetch.mockRejectedValue(new Error('API error'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isConcession = await (stateManager as any).detectConcession(
        'You are correct about this'
      )
      expect(isConcession).toBe(true)
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to analyze sentiment')
      )
    })

    it('should use fallback for unexpected API response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'maybe'
              }
            }
          ]
        })
      } as Response)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isConcession = await (stateManager as any).detectConcession(
        'You are correct'
      )
      expect(isConcession).toBe(false)
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected sentiment analysis response')
      )
    })

    it('should cache sentiment analysis results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'true'
              }
            }
          ]
        })
      } as Response)

      const comment = 'You are absolutely right'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result1 = await (stateManager as any).detectConcession(comment)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result2 = await (stateManager as any).detectConcession(comment)

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached sentiment result')
      )
    })

    it('should cache fallback results on API failure', async () => {
      mockFetch.mockRejectedValue(new Error('API error'))

      const comment = 'You are correct'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result1 = await (stateManager as any).detectConcession(comment)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result2 = await (stateManager as any).detectConcession(comment)

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('detectConcessionFallback', () => {
    it('should detect concession phrases', () => {
      const concessionPhrases = [
        'You are correct about this',
        'I concede the point',
        "You're right, I missed that",
        'Fair point indeed',
        'Good catch!',
        'Agreed, will fix',
        'Makes sense to me'
      ]

      for (const phrase of concessionPhrases) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isConcession = (stateManager as any).detectConcessionFallback(
          phrase
        )
        expect(isConcession).toBe(true)
      }
    })

    it('should not detect non-concession text', () => {
      const nonConcession = [
        'I disagree with this suggestion',
        'This is incorrect',
        'Not sure about this approach'
      ]

      for (const text of nonConcession) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isConcession = (stateManager as any).detectConcessionFallback(
          text
        )
        expect(isConcession).toBe(false)
      }
    })
  })

  describe('StateError', () => {
    it('should create error with message', () => {
      const error = new StateError('Test error')
      expect(error.message).toBe('Test error')
      expect(error.name).toBe('StateError')
    })

    it('should preserve cause error', () => {
      const cause = new Error('Original error')
      const error = new StateError('Wrapped error', cause)
      expect(error.cause).toBe(cause)
    })
  })
})
