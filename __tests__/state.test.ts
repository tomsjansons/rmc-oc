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

const { StateManager, StateError } = await import('../src/state/manager.js')
import type { ReviewConfig } from '../src/review/types.js'
import type { ReviewState, ReviewThread } from '../src/state/manager.js'
import type { LLMClient } from '../src/opencode/llm-client.js'

describe('StateManager', () => {
  let stateManager: InstanceType<typeof StateManager>
  let mockConfig: ReviewConfig
  let mockLLMClient: LLMClient

  beforeEach(() => {
    mockConfig = {
      opencode: {
        apiKey: 'test-key',
        model: 'test-model',
        enableWeb: false,
        debugLogging: false
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
    } as ReviewConfig

    mockLLMClient = {
      complete: jest.fn<(prompt: string) => Promise<string | null>>()
    }

    stateManager = new StateManager(mockConfig, mockLLMClient)

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

    it('should ignore comments from non-bot users to prevent spoofing', async () => {
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
            body: '```rmcoc\n{"finding": "Spoofed issue", "assessment": "Malicious assessment", "score": 10}\n```',
            user: { login: 'malicious-user' },
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

    it('should detect RESOLVED status from rmcoc block', async () => {
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
            body: '```rmcoc\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          },
          {
            id: 1002,
            path: 'src/test.ts',
            line: 42,
            body: '✅ **Issue Resolved**\n\nThe typo has been fixed.\n\n```rmcoc\n{"status": "RESOLVED"}\n```',
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

    it('should detect ESCALATED status from rmcoc block', async () => {
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
            body: '```rmcoc\n{"finding": "Test issue", "assessment": "Test assessment", "score": 7}\n```',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          },
          {
            id: 1002,
            path: 'src/test.ts',
            line: 42,
            body: '🔺 **Escalated to Human Review**\n\nThis needs human judgment.\n\n```rmcoc\n{"status": "ESCALATED"}\n```',
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

    it('should fallback to legacy text markers for old comments', async () => {
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
  })

  describe('assessment parsing via rebuildStateFromComments', () => {
    it('should parse assessment from rmcoc block', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: `Some text before

\`\`\`rmcoc
{
  "finding": "Test finding",
  "assessment": "Test assessment",
  "score": 7
}
\`\`\`

Some text after`,
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].assessment.finding).toBe('Test finding')
      expect(state.threads[0].assessment.assessment).toBe('Test assessment')
      expect(state.threads[0].assessment.score).toBe(7)
    })

    it('should fallback to JSON block for legacy comments', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: `Some text before

\`\`\`json
{
  "finding": "Test finding",
  "assessment": "Test assessment",
  "score": 7
}
\`\`\`

Some text after`,
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].assessment.finding).toBe('Test finding')
      expect(state.threads[0].assessment.assessment).toBe('Test assessment')
      expect(state.threads[0].assessment.score).toBe(7)
    })

    it('should parse assessment from JSON without code fence', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: `Per AGENTS.md, prefer type over interface.

export type PostReviewCommentArgs = {
  path: string
  line: number
  body: string
}
{
  "finding": "Violation of AGENTS.md",
  "assessment": "The project's AGENTS.md explicitly states 'Prefer type over interface'.",
  "score": 5
}`,
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].assessment.finding).toBe('Violation of AGENTS.md')
      expect(state.threads[0].assessment.score).toBe(5)
    })

    it('should handle backticks in JSON strings', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: `Per \`AGENTS.md\`, prefer \`type\` over \`interface\`.

\`\`\`typescript
export type PostReviewCommentArgs = {
  path: string
  line: number
  body: string
}
\`\`\`

---
\`\`\`json
{
  "finding": "Violation of AGENTS.md: Preference for \`type\` over \`interface\`",
  "assessment": "The project's AGENTS.md explicitly states 'Prefer \`type\` over \`interface\`'. This interface definition should be a \`type\` alias.",
  "score": 5
}
\`\`\``,
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(1)
      expect(state.threads[0].assessment.finding).toContain(
        'Violation of AGENTS.md'
      )
      expect(state.threads[0].assessment.score).toBe(5)
    })

    it('should skip comment without valid JSON assessment', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: 'Just a regular comment without JSON',
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(0)
    })

    it('should skip comment with malformed JSON block', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })

      mockOctokit.pulls.listReviewComments.mockResolvedValue({
        data: [
          {
            id: 1001,
            path: 'src/test.ts',
            line: 42,
            body: `\`\`\`json
{ invalid json }
\`\`\``,
            user: { login: 'github-actions[bot]' },
            created_at: '2024-01-01T00:00:00.000Z',
            in_reply_to_id: undefined
          }
        ]
      })

      const state = await stateManager.rebuildStateFromComments()

      expect(state.threads).toHaveLength(0)
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
        passNumber: 1,
        completed: true,
        hasBlockingIssues: false
      })

      const state = await stateManager.getOrCreateState()
      expect(state.passes).toHaveLength(1)
      expect(state.passes[0].passNumber).toBe(1)
    })

    it('should update existing pass record', async () => {
      mockOctokit.pulls.get.mockResolvedValue({
        data: { head: { sha: 'test-sha' } }
      })
      mockOctokit.pulls.listReviewComments.mockResolvedValue({ data: [] })

      await stateManager.recordPassCompletion({
        passNumber: 1,
        completed: false,
        hasBlockingIssues: false
      })

      await stateManager.recordPassCompletion({
        passNumber: 1,
        completed: true,
        hasBlockingIssues: true
      })

      const state = await stateManager.getOrCreateState()
      expect(state.passes).toHaveLength(1)
      expect(state.passes[0].completed).toBe(true)
      expect(state.passes[0].hasBlockingIssues).toBe(true)
    })
  })

  describe('detectConcession', () => {
    it('should detect concession via API', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockResolvedValue('true')

      const isConcession = await stateManager.detectConcession(
        'You are absolutely right, I will fix this'
      )
      expect(isConcession).toBe(true)
      expect(mockLLMClient.complete).toHaveBeenCalled()
    })

    it('should detect non-concession via API', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockResolvedValue('false')

      const isConcession = await stateManager.detectConcession(
        'I disagree with this suggestion'
      )
      expect(isConcession).toBe(false)
    })

    it('should fallback to keyword detection on API failure', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockRejectedValue(
        new Error('API error')
      )

      const isConcession = await stateManager.detectConcession(
        'You are correct about this'
      )
      expect(isConcession).toBe(true)
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to analyze sentiment')
      )
    })

    it('should cache sentiment analysis results', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockResolvedValue('true')

      const comment = 'You are absolutely right'

      const result1 = await stateManager.detectConcession(comment)
      const result2 = await stateManager.detectConcession(comment)

      expect(result1).toBe(true)
      expect(result2).toBe(true)
      expect(mockLLMClient.complete).toHaveBeenCalledTimes(1)
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached sentiment result')
      )
    })
  })

  describe('classifyDeveloperReply', () => {
    it('should classify acknowledgment via API', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockResolvedValue('acknowledgment')

      const classification = await stateManager.classifyDeveloperReply(
        'Missing null check',
        'Good catch, will fix!'
      )
      expect(classification).toBe('acknowledgment')
    })

    it('should classify dispute via API', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockResolvedValue('dispute')

      const classification = await stateManager.classifyDeveloperReply(
        'Missing null check',
        'This is intentional, the middleware handles this case'
      )
      expect(classification).toBe('dispute')
    })

    it('should fallback on API failure', async () => {
      ;(mockLLMClient.complete as jest.Mock).mockRejectedValue(
        new Error('API error')
      )

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
