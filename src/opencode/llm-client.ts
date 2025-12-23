import { OPENROUTER_API_URL } from '../config/constants.js'
import { logger } from '../utils/logger.js'

export type LLMClient = {
  complete(prompt: string): Promise<string | null>
}

type LLMClientConfig = {
  apiKey: string
  model: string
}

export class LLMClientImpl implements LLMClient {
  constructor(private config: LLMClientConfig) {}

  async complete(prompt: string): Promise<string | null> {
    const requestBody = {
      model: this.config.model,
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
          Authorization: `Bearer ${this.config.apiKey}`,
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

      return data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? null
    } catch (error) {
      logger.warning(
        `LLM completion failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }
  }
}
