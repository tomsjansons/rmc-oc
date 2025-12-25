import { OPENROUTER_API_URL } from '../config/constants.js'
import { logger } from '../utils/logger.js'

type CompletionOptions = {
  maxTokens?: number
  temperature?: number
}

export type LLMClient = {
  complete(prompt: string, options?: CompletionOptions): Promise<string | null>
}

type LLMClientConfig = {
  apiKey: string
  model: string
}

const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TEMPERATURE = 0.1

export class LLMClientImpl implements LLMClient {
  constructor(private config: LLMClientConfig) {}

  async complete(
    prompt: string,
    options?: CompletionOptions
  ): Promise<string | null> {
    const requestBody = {
      model: this.config.model,
      messages: [
        {
          role: 'user' as const,
          content: prompt
        }
      ],
      temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS
    }

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'HTTP-Referer': 'https://github.com/opencode-pr-reviewer',
          'X-Title': 'OpenCode PR Reviewer',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `OpenRouter API request failed: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string; role?: string }
          finish_reason?: string | null
          error?: { code: number; message: string }
        }>
        usage?: {
          prompt_tokens: number
          completion_tokens: number
          total_tokens: number
        }
      }

      const choice = data.choices?.[0]
      if (choice?.error) {
        throw new Error(
          `OpenRouter API error: ${choice.error.code} - ${choice.error.message}`
        )
      }

      return choice?.message?.content?.trim() ?? null
    } catch (error) {
      logger.warning(
        `LLM completion failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  }
}
