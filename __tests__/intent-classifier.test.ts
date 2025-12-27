import { describe, expect, it } from '@jest/globals'

import type { LLMClient } from '../src/opencode/llm-client.js'
import { IntentClassifier } from '../src/task/classifier.js'

describe('IntentClassifier', () => {
  describe('classifyBotMention', () => {
    it('should classify review request via LLM', async () => {
      const mockLLM: LLMClient = {
        complete: async (prompt: string) => {
          expect(prompt).toContain('please review this PR')
          return 'review-request'
        }
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention(
        'please review this PR'
      )

      expect(intent).toBe('review-request')
    })

    it('should classify question via LLM', async () => {
      const mockLLM: LLMClient = {
        complete: async (prompt: string) => {
          expect(prompt).toContain('Why is this function needed?')
          return 'question'
        }
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention(
        'Why is this function needed?'
      )

      expect(intent).toBe('question')
    })

    it('should fallback to regex when LLM returns null', async () => {
      const mockLLM: LLMClient = {
        complete: async () => null
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention('please review this')

      expect(intent).toBe('review-request')
    })

    it('should fallback to regex when LLM fails', async () => {
      const mockLLM: LLMClient = {
        complete: async () => {
          throw new Error('LLM API failed')
        }
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention('please review')

      expect(intent).toBe('review-request')
    })

    it('should fallback to regex for unexpected LLM response', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'unexpected response'
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention('please review')

      expect(intent).toBe('review-request')
    })

    describe('fallback regex classification', () => {
      it('should detect review request patterns', async () => {
        const mockLLM: LLMClient = {
          complete: async () => null
        }

        const classifier = new IntentClassifier(mockLLM)

        const reviewPhrases = [
          'please review this PR',
          'can you review',
          'could you review this',
          'do a review',
          'run a review',
          'check this code',
          'check the changes',
          'lgtm?',
          'ready for review',
          'take a look'
        ]

        for (const phrase of reviewPhrases) {
          const intent = await classifier.classifyBotMention(phrase)
          expect(intent).toBe('review-request')
        }
      })

      it('should default to question for unknown patterns', async () => {
        const mockLLM: LLMClient = {
          complete: async () => null
        }

        const classifier = new IntentClassifier(mockLLM)

        const questionPhrases = [
          'Why is this needed?',
          'What does this do?',
          'How should I fix this?'
        ]

        for (const phrase of questionPhrases) {
          const intent = await classifier.classifyBotMention(phrase)
          expect(intent).toBe('question')
        }
      })
    })

    it('should handle LLM response with extra whitespace', async () => {
      const mockLLM: LLMClient = {
        complete: async () => '  review-request  \n'
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention('review this')

      expect(intent).toBe('review-request')
    })

    it('should handle case-insensitive LLM responses', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'REVIEW-REQUEST'
      }

      const classifier = new IntentClassifier(mockLLM)
      const intent = await classifier.classifyBotMention('review this')

      expect(intent).toBe('review-request')
    })
  })
})
