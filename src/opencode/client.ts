import { createOpencodeClient } from '@opencode-ai/sdk'

import { OpenCodeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { SessionActivityTracker } from './session-activity-tracker.js'
import type { Session } from './types.js'

export type OpenCodeClient = {
  createSession(title: string): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  sendSystemPrompt(sessionId: string, systemPrompt: string): Promise<void>
  sendPrompt(sessionId: string, prompt: string): Promise<void>
  sendPromptAndGetResponse(sessionId: string, prompt: string): Promise<string>
  getCurrentSessionId(): string | null
}

type OpenCodeSDKClient = ReturnType<typeof createOpencodeClient>

export class OpenCodeClientImpl implements OpenCodeClient {
  private currentSessionId: string | null = null
  private client: OpenCodeSDKClient
  private debugLogging: boolean
  private timeoutMs: number
  private activityTracker: SessionActivityTracker

  constructor(
    serverUrl: string,
    debugLogging: boolean = false,
    timeoutMs: number = 600000
  ) {
    this.client = createOpencodeClient({
      baseUrl: serverUrl,
      throwOnError: true
    })
    this.debugLogging = debugLogging
    this.timeoutMs = timeoutMs
    this.activityTracker = new SessionActivityTracker(debugLogging)
  }

  async createSession(title: string): Promise<Session> {
    try {
      logger.debug(`Creating OpenCode session: ${title}`)

      const response = await this.client.session.create({
        body: {
          title
        }
      })

      if (!response.data) {
        throw new OpenCodeError('Failed to create session: no data returned')
      }

      const session: Session = {
        id: response.data.id,
        title: response.data.title,
        createdAt: response.data.time.created
      }

      this.currentSessionId = session.id
      logger.info(`Created OpenCode session: ${session.id}`)

      return session
    } catch (error) {
      throw new OpenCodeError(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      logger.debug(`Deleting OpenCode session: ${sessionId}`)

      await this.client.session.delete({
        path: { id: sessionId }
      })

      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null
      }

      logger.info(`Deleted OpenCode session: ${sessionId}`)
    } catch (error) {
      throw new OpenCodeError(
        `Failed to delete session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async sendSystemPrompt(
    sessionId: string,
    systemPrompt: string
  ): Promise<void> {
    try {
      logger.debug(
        `Sending system prompt to session ${sessionId} (${systemPrompt.length} chars)`
      )

      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts: [
            {
              type: 'text',
              text: systemPrompt
            }
          ]
        }
      })

      logger.info(`System prompt injected into session ${sessionId}`)
    } catch (error) {
      throw new OpenCodeError(
        `Failed to send system prompt: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    try {
      logger.debug(
        `Sending prompt to session ${sessionId} (${prompt.length} chars)`
      )

      const completionPromise = this.waitForPromptCompletion(sessionId)

      await this.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      })

      await completionPromise

      logger.debug(`Prompt completed successfully for session ${sessionId}`)
    } catch (error) {
      throw new OpenCodeError(
        `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async waitForPromptCompletion(sessionId: string): Promise<void> {
    const startTime = Date.now()
    const abortController = new AbortController()
    let sawBusy = false

    const IDLE_GRACE_PERIOD_MS = 10000

    this.activityTracker.reset()

    return new Promise<void>((resolve, reject) => {
      let resolved = false
      let idleGraceTimerId: ReturnType<typeof setTimeout> | null = null

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          abortController.abort()
          reject(
            new OpenCodeError(
              `Timeout waiting for session ${sessionId} to complete after ${this.timeoutMs}ms`
            )
          )
        }
      }, this.timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timeoutId)
        if (idleGraceTimerId) {
          clearTimeout(idleGraceTimerId)
          idleGraceTimerId = null
        }
        abortController.abort()
      }

      const cancelIdleGrace = (): void => {
        if (idleGraceTimerId) {
          logger.debug(
            `Session ${sessionId} became active again, cancelling idle grace period`
          )
          clearTimeout(idleGraceTimerId)
          idleGraceTimerId = null
        }
      }

      const processEvents = async (): Promise<void> => {
        try {
          const eventResult = await this.client.event.subscribe({
            signal: abortController.signal
          })

          for await (const event of eventResult.stream) {
            if (resolved || abortController.signal.aborted) {
              break
            }

            const signal = this.activityTracker.handleEvent(event, sessionId)

            if (!signal.isTargetSession) {
              continue
            }

            if (signal.loopDetected) {
              resolved = true
              cleanup()
              reject(
                new OpenCodeError(
                  `Loop detected: Agent is repeatedly calling the same tools with same arguments. This usually indicates the agent is stuck. Aborting session.`
                )
              )
              return
            }

            if (signal.isBusy) {
              sawBusy = true
              cancelIdleGrace()
            }

            if (signal.isMessageUpdate) {
              cancelIdleGrace()
            }

            if (signal.isIdle && sawBusy) {
              if (!idleGraceTimerId) {
                logger.debug(
                  `Session ${sessionId} went idle, waiting ${IDLE_GRACE_PERIOD_MS}ms grace period...`
                )
                idleGraceTimerId = setTimeout(async () => {
                  if (!resolved) {
                    const duration = Date.now() - startTime
                    logger.info(
                      `Session ${sessionId} completed after ${duration}ms (idle for ${IDLE_GRACE_PERIOD_MS}ms)`
                    )
                    this.activityTracker.logActivitySummary(sessionId, duration)
                    resolved = true
                    cleanup()
                    resolve()
                  }
                }, IDLE_GRACE_PERIOD_MS)
              }
            }

            if (signal.isRetry) {
              logger.warning(
                `Session ${sessionId} is retrying (attempt ${signal.retryAttempt}): ${signal.retryMessage}`
              )
            }

            if (signal.isError) {
              const duration = Date.now() - startTime
              this.activityTracker.logActivitySummary(sessionId, duration)
              resolved = true
              cleanup()
              reject(
                new OpenCodeError(
                  `Session error: ${JSON.stringify(event.properties)}`
                )
              )
              return
            }
          }

          if (!resolved) {
            reject(new OpenCodeError('Event stream ended unexpectedly'))
          }
        } catch (error) {
          if (!resolved && !abortController.signal.aborted) {
            cleanup()
            reject(
              new OpenCodeError(
                `Error processing events: ${error instanceof Error ? error.message : String(error)}`
              )
            )
          }
        }
      }

      processEvents()
    })
  }

  async sendPromptAndGetResponse(
    sessionId: string,
    prompt: string
  ): Promise<string> {
    try {
      logger.debug(
        `Sending prompt to session ${sessionId} and awaiting response (${prompt.length} chars)`
      )

      const response = await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      })

      if (!response.data) {
        throw new OpenCodeError('Failed to send prompt: no response data')
      }

      const textParts = response.data.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n')

      logger.debug(
        `Received response from session ${sessionId} (${textParts.length} chars)`
      )

      return textParts
    } catch (error) {
      throw new OpenCodeError(
        `Failed to send prompt and get response: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId
  }
}
