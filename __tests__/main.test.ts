/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * Note: These tests are limited because main.ts calls process.exit() which
 * terminates Jest workers. We test the error handling behavior by mocking
 * process.exit and verifying setFailed was called.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

// Mock process.exit to prevent Jest worker crashes
const mockExit = jest
  .spyOn(process, 'exit')
  .mockImplementation((() => {}) as () => never)

const { run } = await import('../src/main.js')

describe('main.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.GITHUB_EVENT_NAME = 'pull_request'
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
  })

  afterEach(() => {
    jest.resetAllMocks()
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_REPOSITORY
  })

  it('fails when required inputs are missing', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'opencode_auth_json') {
        return ''
      }
      if (name === 'github_token') {
        return 'test-token'
      }
      return ''
    })
    core.getBooleanInput.mockReturnValue(false)

    await run()

    expect(core.setFailed).toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('fails when model is missing', async () => {
    core.getInput.mockImplementation((name: string) => {
      if (name === 'opencode_auth_json') {
        return '{"openrouter":{"type":"api","key":"test-api-key"}}'
      }
      if (name === 'github_token') {
        return 'test-token'
      }
      if (name === 'model') {
        return ''
      }
      return ''
    })
    core.getBooleanInput.mockReturnValue(false)

    await run()

    expect(core.setFailed).toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(1)
  })
})
