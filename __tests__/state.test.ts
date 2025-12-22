import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals'

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

global.fetch = mockFetch as typeof global.fetch

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
import type { ReviewState, ReviewThread } from '../src/github/state.js'

describe('StateManager', () => {
  let stateManager: StateManager
  let mockConfig: ReviewConfig

  beforeEach(() => {
    mockConfig = {
      opencode: {
        apiKey: 'test-key',
        model: 'test-model',
        enableWeb: false
      },
      scoring: {
        problemThreshold: 5,
        blockingThreshold: 5
      },
      github: {
        token: 'test-token',
        owner: 'test-owner',
        repo: 'test-repo',
        prNumber: 123
      }
    }

    stateManager = new StateManager(mockConfig)

    mockInfo.mockClear()
    mockWarning.mockClear()
    mockDebug.mockClear()
    mockFetch.mockClear()
    mockOctokit.pulls.get.mockClear()
    mockOctokit.pulls.listReviewComments.mockClear()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('updateState', () => {
    it('should update metadata timestamp', () => {
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

      stateManager.updateState(state)

      expect(state.metadata.updated_at).not.toBe('2024-01-01T00:00:00.000Z')
      expect(new Date(state.metadata.updated_at).getTime()).toBeGreaterThan(
        new Date('2024-01-01T00:00:00.000Z').getTime()
      )
    })
  })

  describe('getOrCreateState', () => {
    it('should return cached state if available', async () => {
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

      stateManager.updateState(state)

      const result = await stateManager.getOrCreateState()

      expect(result).toBe(state)
      expect(mockOctokit.pulls.get).not.toHaveBeenCalled()
    })

    it('should rebuild state from comments if no cached state', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'new-sha-123' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: []
      })

      const result = await stateManager.getOrCreateState()

      expect(result.lastCommitSha).toBe('new-sha-123')
      expect(result.prNumber).toBe(123)
      expect(mockOctokit.pulls.get).toHaveBeenCalled()
    })
  })

  describe('rebuildStateFromComments', () => {
    it('should rebuild state from GitHub comments', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'test-sha' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.prNumber).toBe(123)
      expect(state.lastCommitSha).toBe('test-sha')
      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].file).toBe('src/test.ts')
      expect(state.threads[0].line).toBe(42)
      expect(state.threads[0].score).toBe(7)
    })

    it('should skip comments without valid assessments', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'test-sha' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: 'Just a regular comment',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(0)
    })

    it('should include developer replies in threads', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'test-sha' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          },
          {
            id: 1002,
            path: 'src/test.ts',
            line: 42,
            body: 'I disagree with this',
            user: { login: 'developer' },
            created_at: '2024-01-01T01:00:00.000Z',
            in_reply_to_id: 1001
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].developer_replies).toHaveLength(1)
      expect(state.threads[0].developer_replies?.[0].author).toBe('developer')
    })

    it('should detect RESOLVED status from bot replies', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'test-sha' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          },
          {
            id: 1002,
            path: 'src/test.ts',
            line: 42,
            body: '✅ **Issue Resolved**\n\nThe typo has been fixed.',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T01:00:00.000Z',
            in_reply_to_id: 1001
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].status).toBe('RESOLVED')
    })

    it('should detect ESCALATED status from bot replies', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: {
          head: { sha: 'test-sha' }
        }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          },
          {
            id: 1002,
            path: 'src/test.ts',
            line: 42,
            body: '🔺 **Escalated to Human Review**\n\nThis needs human judgment.',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T01:00:00.000Z',
            in_reply_to_id: 1001
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].status).toBe('ESCALATED')
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

      const assessment = (
        stateManager as unknown as {
          extractAssessmentFromComment: (body: string) => {
            finding: string
            assessment: string
            score: number
          }
        }
      ).extractAssessmentFromComment(comment)

      expect(assessment.finding).toBe('Test finding')
      expect(assessment.assessment).toBe('Test assessment')
      expect(assessment.score).toBe(7)
    })

    it('should return null for comment without JSON', () => {
      const comment = 'Just a regular comment without JSON'

      const assessment = (
        stateManager as unknown as {
          extractAssessmentFromComment: (body: string) => {
            finding: string
            assessment: string
            score: number
          } | null
        }
      ).extractAssessmentFromComment(comment)

      expect(assessment).toBeNull()
    })

    it('should return null for malformed JSON block', () => {
      const comment = `
\`\`\`json
{ invalid json }
\`\`\`
      `

      const assessment = (
        stateManager as unknown as {
          extractAssessmentFromComment: (body: string) => {
            finding: string
            assessment: string
            score: number
          } | null
        }
      ).extractAssessmentFromComment(comment)

      expect(assessment).toBeNull()
    })
  })

  describe('addThread', () => {
    it('should add a new thread to state', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      const thread: ReviewThread = {
        id: 'thread-1',
        file: 'test.ts',
        line: 10,
        status: 'PENDING',
        score: 7,
        assessment: {
          finding: 'Test finding',
          assessment: 'Test assessment',
          score: 7
        },
        original_comment: {
          author: 'bot',
          body: 'Test comment',
          timestamp: new Date().toISOString()
        }
      }

      await stateManager.addThread(thread)

      const state = await stateManager.getOrCreateState()
      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].id).toBe('thread-1')
    })

    it('should update existing thread', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      const thread: ReviewThread = {
        id: 'thread-1',
        file: 'test.ts',
        line: 10,
        status: 'PENDING',
        score: 7,
        assessment: {
          finding: 'Test finding',
          assessment: 'Test assessment',
          score: 7
        },
        original_comment: {
          author: 'bot',
          body: 'Test comment',
          timestamp: new Date().toISOString()
        }
      }

      await stateManager.addThread(thread)

      const updatedThread = { ...thread, status: 'RESOLVED' as const }
      await stateManager.addThread(updatedThread)

      const state = await stateManager.getOrCreateState()
      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].status).toBe('RESOLVED')
    })
  })

  describe('updateThreadStatus', () => {
    it('should update thread status', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      await stateManager.getOrCreateState()
      await stateManager.updateThreadStatus('1001', 'RESOLVED')

      const state = await stateManager.getOrCreateState()
      expect(state.threads[0].status).toBe('RESOLVED')
    })

    it('should throw error for non-existent thread', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      await expect(
        stateManager.updateThreadStatus('non-existent', 'RESOLVED')
      ).rejects.toThrow(StateError)
    })

    it('should set escalated_at timestamp when escalating', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: '```json\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      await stateManager.getOrCreateState()
      await stateManager.updateThreadStatus('1001', 'ESCALATED')

      const state = await stateManager.getOrCreateState()
      expect(state.threads[0].status).toBe('ESCALATED')
      expect(state.threads[0].escalated_at).toBeDefined()
    })
  })

  describe('recordPassCompletion', () => {
    it('should record pass completion', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      await stateManager.recordPassCompletion({
        number: 1,
        summary: 'Pass 1 completed',
        completed: true,
        has_blocking_issues: false
      })

      const state = await stateManager.getOrCreateState()
      expect(state.passes).toHaveLength(1)
      expect(state.passes[0].number).toBe(1)
    })

    it('should update existing pass record', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      await stateManager.recordPassCompletion({
        number: 1,
        summary: 'Pass 1 initial',
        completed: false,
        has_blocking_issues: false
      })

      await stateManager.recordPassCompletion({
        number: 1,
        summary: 'Pass 1 completed',
        completed: true,
        has_blocking_issues: true
      })

      const state = await stateManager.getOrCreateState()
      expect(state.passes).toHaveLength(1)
      expect(state.passes[0].completed).toBe(true)
      expect(state.passes[0].has_blocking_issues).toBe(true)
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

      const isConcession = await stateManager.detectConcession(
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

      const isConcession = await stateManager.detectConcession(
        'I disagree with this suggestion'
      )
      expect(isConcession).toBe(false)
    })

    it('should fallback to keyword detection on API failure', async () => {
      mockFetch.mockRejectedValue(new Error('API error'))

      const isConcession = await stateManager.detectConcession(
        'You are correct about this'
      )
      expect(isConcession).toBe(true)
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to analyze sentiment')
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

      const result1 = await stateManager.detectConcession(comment)
      const result2 = await stateManager.detectConcession(comment)

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached sentiment result')
      )
    })
  })

  describe('classifyDeveloperReply', () => {
    it('should classify acknowledgment via API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'acknowledgment'
              }
            }
          ]
        })
      } as Response)

      const classification = await stateManager.classifyDeveloperReply(
        'Missing null check',
        'Good catch, will fix!'
      )
      expect(classification).toBe('acknowledgment')
    })

    it('should classify dispute via API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'dispute'
              }
            }
          ]
        })
      } as Response)

      const classification = await stateManager.classifyDeveloperReply(
        'Missing null check',
        'This is intentional, the middleware handles this case'
      )
      expect(classification).toBe('dispute')
    })

    it('should fallback on API failure', async () => {
      mockFetch.mockRejectedValue(new Error('API error'))

      const classification = await stateManager.classifyDeveloperReply(
        'Missing null check',
        'Good catch!'
      )
      expect(classification).toBe('acknowledgment')
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
