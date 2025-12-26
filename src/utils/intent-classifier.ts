import * as core from '@actions/core'

import type { LLMClient } from '../opencode/llm-client.js'

export type BotMentionIntent = 'review-request' | 'question'

export class IntentClassifier {
  constructor(private llmClient: LLMClient) {}

  async classifyBotMention(text: string): Promise<BotMentionIntent> {
    const prompt = `You are a classifier that determines the intent of GitHub PR comments that mention a code review bot.

Given the user's message, classify it as one of these intents:
- "review-request": The user wants a full code review of the PR
- "question": The user is asking a question about the code, PR, or wants clarification

IMPORTANT: Respond with ONLY the intent name, nothing else. No explanation, no punctuation.

Examples:
User: "please review this PR"
Response: review-request

User: "can you review?"
Response: review-request

User: "Why is this function needed?"
Response: question

User: "What does this code do?"
Response: question

User: "check the code"
Response: review-request

User: "run a review"
Response: review-request

User: "what's the purpose of this change?"
Response: question

Now classify this message:
User: "${text}"
Response:`

    try {
      core.debug(
        `Classifying bot mention intent: "${text.substring(0, 50)}..."`
      )

      const response = await this.llmClient.complete(prompt, {
        maxTokens: 10,
        temperature: 0
      })

      core.info(`LLM classification response: "${response}"`)

      if (!response) {
        core.warning(
          'LLM returned null for intent classification, falling back to regex'
        )
        return this.fallbackClassification(text)
      }

      const normalized = response.toLowerCase().trim()
      core.debug(`Normalized response: "${normalized}"`)

      if (
        normalized.includes('review-request') ||
        normalized === 'review-request'
      ) {
        core.info(`Intent classified as: review-request`)
        return 'review-request'
      }

      if (normalized.includes('question') || normalized === 'question') {
        core.info(`Intent classified as: question`)
        return 'question'
      }

      core.warning(
        `Unexpected classification response: "${response}", falling back to regex`
      )
      return this.fallbackClassification(text)
    } catch (error) {
      core.warning(
        `Intent classification failed: ${error instanceof Error ? error.message : String(error)}, falling back to regex`
      )
      return this.fallbackClassification(text)
    }
  }

  private fallbackClassification(text: string): BotMentionIntent {
    core.info('Using fallback regex classification')

    const reviewKeywords = [
      /\b(?:please\s+)?review(?:\s+this)?(?:\s+pr)?/i,
      /\b(?:can|could)\s+you\s+review/i,
      /\bdo\s+a\s+review/i,
      /\brun\s+(?:a\s+)?review/i,
      /\bcheck\s+(?:this\s+)?(?:the\s+)?(?:pr|code|changes)/i,
      /\blgtm\?/i,
      /\bready\s+for\s+review/i,
      /\btake\s+a\s+look/i
    ]

    const isReviewRequest = reviewKeywords.some((pattern) => pattern.test(text))
    const result = isReviewRequest ? 'review-request' : 'question'
    core.info(`Fallback classification result: ${result}`)
    return result
  }
}
