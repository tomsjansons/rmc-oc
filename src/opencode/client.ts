import type { Event } from '@opencode-ai/sdk'
import { createOpencodeClient } from '@opencode-ai/sdk'

import { OpenCodeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
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

const MAX_REPEATED_TOOL_CALLS = 5
const LOOP_DETECTION_WINDOW = 10

type ActivityMetrics = {
  toolCalls: number
  messageUpdates: number
  busyEvents: number
  idleEvents: number
  errors: number
}

export class OpenCodeClientImpl implements OpenCodeClient {
  private currentSessionId: string | null = null
  private client: OpenCodeSDKClient
  private debugLogging: boolean
  private timeoutMs: number
  private recentToolCalls: string[] = []
  private activityMetrics: ActivityMetrics = {
    toolCalls: 0,
    messageUpdates: 0,
    busyEvents: 0,
    idleEvents: 0,
    errors: 0
  }

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
  }

  private resetLoopDetection(): void {
    this.recentToolCalls = []
  }

  private resetActivityMetrics(): void {
    this.activityMetrics = {
      toolCalls: 0,
      messageUpdates: 0,
      busyEvents: 0,
      idleEvents: 0,
      errors: 0
    }
  }

  private logActivitySummary(sessionId: string, durationMs: number): void {
    const m = this.activityMetrics
    logger.info(
      `Session ${sessionId} activity: ${m.toolCalls} tool calls, ${m.busyEvents} busy events, ${m.errors} errors (${durationMs}ms)`
    )

    if (m.toolCalls === 0) {
      logger.warning(
        `Session ${sessionId} completed with NO tool calls - model may not have done any work`
      )
    }
  }

  private detectLoop(toolCall: string): boolean {
    this.recentToolCalls.push(toolCall)

    if (this.recentToolCalls.length > LOOP_DETECTION_WINDOW) {
      this.recentToolCalls.shift()
    }

    if (this.recentToolCalls.length < MAX_REPEATED_TOOL_CALLS) {
      return false
    }

    const callCounts = new Map<string, number>()
    for (const call of this.recentToolCalls) {
      callCounts.set(call, (callCounts.get(call) || 0) + 1)
    }

    for (const [call, count] of callCounts) {
      if (count >= MAX_REPEATED_TOOL_CALLS) {
        logger.warning(
          `Loop detected: tool call "${call}" repeated ${count} times in last ${LOOP_DETECTION_WINDOW} calls`
        )
        return true
      }
    }

    const recentCalls = this.recentToolCalls.slice(-MAX_REPEATED_TOOL_CALLS)
    const uniqueCalls = new Set(recentCalls)
    if (
      uniqueCalls.size <= 2 &&
      recentCalls.length >= MAX_REPEATED_TOOL_CALLS
    ) {
      logger.warning(
        `Loop detected: only ${uniqueCalls.size} unique tool calls in last ${recentCalls.length} calls: ${[...uniqueCalls].join(', ')}`
      )
      return true
    }

    return false
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

    // Grace period to wait after idle before considering session complete
    // This handles reasoning models that may pause briefly during thinking
    const IDLE_GRACE_PERIOD_MS = 10000

    this.resetLoopDetection()
    this.resetActivityMetrics()

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

            this.logEvent(event, sessionId)

            const props = event.properties as {
              sessionID?: string
              info?: { sessionID?: string }
              status?: { type: string; attempt?: number; message?: string }
              part?: { type: string; tool?: string; state?: { status: string } }
            }

            // Extract sessionID from either top-level or nested in info (message events use info.sessionID)
            const eventSessionId = props.sessionID || props.info?.sessionID

            if (eventSessionId !== sessionId) {
              continue
            }

            if (
              event.type === 'message.part.updated' &&
              props.part?.type === 'tool'
            ) {
              this.activityMetrics.toolCalls++
              const part = props.part as {
                tool?: string
                input?: Record<string, unknown>
                state?: { status: string }
              }
              const toolName = part.tool || 'unknown'
              const toolInput = part.input
                ? JSON.stringify(part.input).substring(0, 200)
                : ''
              const toolSignature = `${toolName}:${toolInput}`

              if (this.detectLoop(toolSignature)) {
                resolved = true
                cleanup()
                reject(
                  new OpenCodeError(
                    `Loop detected: Agent is repeatedly calling the same tools with same arguments. This usually indicates the agent is stuck. Aborting session.`
                  )
                )
                return
              }
            }

            // Any non-idle status means the model is active
            if (
              event.type === 'session.status' &&
              props.status &&
              props.status.type !== 'idle'
            ) {
              sawBusy = true
              this.activityMetrics.busyEvents++
              // Cancel any pending idle grace timer since model is active again
              cancelIdleGrace()
            }

            // Message updates also indicate activity
            if (
              event.type === 'message.updated' ||
              event.type === 'message.part.updated'
            ) {
              this.activityMetrics.messageUpdates++
              cancelIdleGrace()
            }

            const isIdle =
              event.type === 'session.idle' ||
              (event.type === 'session.status' && props.status?.type === 'idle')

            if (isIdle) {
              this.activityMetrics.idleEvents++
            }

            if (isIdle && sawBusy) {
              // Don't immediately complete - wait for grace period
              // This allows reasoning models time to resume after brief pauses
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
                    this.logActivitySummary(sessionId, duration)
                    resolved = true
                    cleanup()
                    resolve()
                  }
                }, IDLE_GRACE_PERIOD_MS)
              }
            }

            if (
              event.type === 'session.status' &&
              props.status?.type === 'retry'
            ) {
              logger.warning(
                `Session ${sessionId} is retrying (attempt ${props.status.attempt}): ${props.status.message}`
              )
            }

            if (event.type === 'session.error') {
              this.activityMetrics.errors++
              const duration = Date.now() - startTime
              this.logActivitySummary(sessionId, duration)
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

  private logEvent(event: Event, targetSessionId: string): void {
    if (!this.debugLogging) {
      return
    }

    const sessionId =
      'sessionID' in event.properties
        ? event.properties.sessionID
        : 'properties' in event &&
            typeof event.properties === 'object' &&
            event.properties !== null &&
            'info' in event.properties &&
            typeof event.properties.info === 'object' &&
            event.properties.info !== null &&
            'sessionID' in event.properties.info
          ? (event.properties.info as { sessionID: string }).sessionID
          : null

    if (sessionId && sessionId !== targetSessionId) {
      return
    }

    switch (event.type) {
      case 'message.part.updated': {
        const part = event.properties.part
        const delta = event.properties.delta
        if (part.type === 'text' && delta) {
          process.stdout.write(delta)
        } else if (part.type === 'tool') {
          logger.debug(`[LLM] Tool call: ${part.tool} (${part.state.status})`)
        }
        break
      }
      case 'message.updated': {
        const msg = event.properties.info
        logger.debug(`[LLM] Message updated: ${msg.role} (${msg.id})`)
        break
      }
      case 'session.status': {
        const status = event.properties.status
        logger.debug(`[LLM] Session status: ${status.type}`)
        break
      }
      case 'session.idle': {
        logger.debug(`[LLM] Session idle`)
        break
      }
      case 'session.error': {
        const err = event.properties.error
        logger.error(
          `[LLM] Session error: ${err ? JSON.stringify(err) : 'unknown'}`
        )
        break
      }
      case 'todo.updated': {
        const todos = event.properties.todos
        logger.debug(`[LLM] Todos updated: ${todos.length} items`)
        break
      }
      default: {
        logger.debug(`[LLM] Event: ${event.type}`)
      }
    }
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
