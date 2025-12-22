/**
 * Unit tests for configuration parser
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { validateConfig } from '../src/config/inputs.js'
import type { ReviewConfig } from '../src/review/types.js'

describe('Configuration Parser', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.resetModules()
  })

  describe('validateConfig', () => {
    it('should pass validation for valid config', () => {
      const validConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 5,
          blockingThreshold: 5,
        },
        review: {
          timeoutMs: 30 * 60 * 1000,
          maxRetries: 1
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        },
        dispute: {
          enableHumanEscalation: false,
          humanReviewers: []
        },
        execution: {
          mode: 'full-review'
        }
      }

      expect(() => validateConfig(validConfig)).not.toThrow()
    })

    it('should throw error for missing API key', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: '',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 5,
          blockingThreshold: 5,
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'OpenCode API key is required'
      )
    })

    it('should throw error for invalid problem threshold - too high', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 11,
          blockingThreshold: 11, // Invalid: > 10
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'Problem threshold must be between 1 and 10'
      )
    })

    it('should throw error for invalid problem threshold - too low', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 0,
          blockingThreshold: 0, // Invalid: < 1
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'Problem threshold must be between 1 and 10'
      )
    })

    it('should throw error for invalid PR number', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 5,
          blockingThreshold: 5,
        },
        review: {
          timeoutMs: 30 * 60 * 1000,
          maxRetries: 1
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 0 // Invalid
        },
        dispute: {
          enableHumanEscalation: false,
          humanReviewers: []
        },
        execution: {
          mode: 'full-review'
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'Valid PR number is required'
      )
    })

    it('should throw error for missing GitHub token', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: 'test-model',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 5,
          blockingThreshold: 5,
        },
        review: {
          timeoutMs: 30 * 60 * 1000,
          maxRetries: 1
        },
        github: {
          token: '',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        },
        dispute: {
          enableHumanEscalation: false,
          humanReviewers: []
        },
        execution: {
          mode: 'full-review'
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'GitHub token is required'
      )
    })

    it('should throw error for missing model', () => {
      const invalidConfig: ReviewConfig = {
        opencode: {
          apiKey: 'test-key',
          model: '',
          enableWeb: false
        },
        scoring: {
          problemThreshold: 5,
          blockingThreshold: 5,
        },
        github: {
          token: 'test-token',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 123
        }
      }

      expect(() => validateConfig(invalidConfig)).toThrow(
        'Model name is required'
      )
    })
  })
})
