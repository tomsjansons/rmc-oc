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
      logger.info(
        `Waiting for OpenCode session ${sessionId} to finish current prompt`
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
    let totalEvents = 0
    let targetEvents = 0
    let lastTargetEventAt = 0
    let lastTargetStallLogAt = 0

    const IDLE_GRACE_PERIOD_MS = 10000
    const ACTIVITY_LOG_INTERVAL_MS = 30000
    const TARGET_STALL_WARNING_MS = 60000
    const TARGET_STALL_LOG_COOLDOWN_MS = 60000

    this.activityTracker.reset()

    return new Promise<void>((resolve, reject) => {
      let resolved = false
      let idleGraceDeadlineMs: number | null = null
      let idleGraceStartedAtMs: number | null = null
      let activityLogTimerId: ReturnType<typeof setInterval> | null = null

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          const metrics = this.activityTracker.getMetricsSnapshot()
          const traces = this.activityTracker.getRecentEventTrace(12)
          const lastTargetEventAgeMs =
            lastTargetEventAt > 0 ? Date.now() - lastTargetEventAt : -1
          const traceSummary =
            traces.length > 0
              ? traces
                  .map(
                    (trace) =>
                      `${trace.eventType}${trace.detail ? `(${trace.detail})` : ''}`
                  )
                  .join(' -> ')
              : 'none'
          resolved = true
          abortController.abort()
          reject(
            new OpenCodeError(
              `Timeout waiting for session ${sessionId} to complete after ${this.timeoutMs}ms (events: total=${totalEvents}, target=${targetEvents}, busySeen=${sawBusy}, idleGraceActive=${idleGraceDeadlineMs !== null}, lastTargetEventAgeMs=${lastTargetEventAgeMs}, metrics=${JSON.stringify(metrics)}, recentEvents=${traceSummary})`
            )
          )
        }
      }, this.timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timeoutId)
        if (activityLogTimerId) {
          clearInterval(activityLogTimerId)
          activityLogTimerId = null
        }
        idleGraceDeadlineMs = null
        abortController.abort()
      }

      const finishSessionAsCompleted = (): void => {
        if (resolved) {
          return
        }

        const duration = Date.now() - startTime
        logger.info(
          `Session ${sessionId} completed after ${duration}ms (idle for ${IDLE_GRACE_PERIOD_MS}ms)`
        )
        this.activityTracker.logActivitySummary(sessionId, duration)
        resolved = true
        cleanup()
        resolve()
      }

      const formatRecentTargetEvents = (): string => {
        const traces = this.activityTracker.getRecentEventTrace(5)
        if (traces.length === 0) {
          return 'none'
        }

        return traces
          .map(
            (trace) =>
              `${trace.eventType}${trace.detail ? `(${trace.detail})` : ''}`
          )
          .join(' -> ')
      }

      const logTargetStallIfNeeded = (source: string): void => {
        if (resolved || targetEvents === 0 || lastTargetEventAt === 0) {
          return
        }

        const now = Date.now()
        const ageMs = now - lastTargetEventAt
        if (ageMs < TARGET_STALL_WARNING_MS) {
          return
        }

        if (now - lastTargetStallLogAt < TARGET_STALL_LOG_COOLDOWN_MS) {
          return
        }

        lastTargetStallLogAt = now
        logger.warning(
          `Session ${sessionId} target events stalled for ${ageMs}ms while stream is active (source=${source}, totalEvents=${totalEvents}, targetEvents=${targetEvents}, recentTargetEvents=${formatRecentTargetEvents()})`
        )
      }

      const tryCompleteFromIdleGrace = (): void => {
        if (
          idleGraceDeadlineMs !== null &&
          Date.now() >= idleGraceDeadlineMs &&
          !resolved
        ) {
          logger.info(
            `Session ${sessionId} idle grace expired after ${Date.now() - (idleGraceStartedAtMs || Date.now())}ms; completing prompt`
          )
          finishSessionAsCompleted()
        }
      }

      activityLogTimerId = setInterval(() => {
        if (resolved) {
          return
        }
        const elapsedMs = Date.now() - startTime
        const metrics = this.activityTracker.getMetricsSnapshot()
        logger.info(
          `Session ${sessionId} still running (${elapsedMs}ms, events total=${totalEvents}, target=${targetEvents}, busySeen=${sawBusy}, idleGraceActive=${idleGraceDeadlineMs !== null}, metrics=${JSON.stringify(metrics)})`
        )
        logTargetStallIfNeeded('heartbeat')
        tryCompleteFromIdleGrace()
      }, ACTIVITY_LOG_INTERVAL_MS)

      const cancelIdleGrace = (reason: string): void => {
        if (idleGraceDeadlineMs !== null) {
          const remainingMs = idleGraceDeadlineMs - Date.now()
          logger.info(
            `Session ${sessionId} cancelled idle grace (${reason}, remaining=${remainingMs}ms)`
          )
          idleGraceDeadlineMs = null
          idleGraceStartedAtMs = null
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

            tryCompleteFromIdleGrace()
            logTargetStallIfNeeded('event-loop')
            if (resolved) {
              return
            }

            totalEvents++

            const signal = this.activityTracker.handleEvent(event, sessionId)

            if (!signal.isTargetSession) {
              logTargetStallIfNeeded('non-target-event')
              continue
            }

            targetEvents++
            lastTargetEventAt = Date.now()

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
              cancelIdleGrace('target session became busy')
            }

            if (signal.isMessageUpdate) {
              cancelIdleGrace('target session emitted message update')
            }

            if (signal.isIdle && sawBusy) {
              if (idleGraceDeadlineMs === null) {
                idleGraceStartedAtMs = Date.now()
                idleGraceDeadlineMs =
                  idleGraceStartedAtMs + IDLE_GRACE_PERIOD_MS
                logger.info(
                  `Session ${sessionId} went idle, starting ${IDLE_GRACE_PERIOD_MS}ms grace period (deadline=${new Date(idleGraceDeadlineMs).toISOString()})`
                )
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

          tryCompleteFromIdleGrace()

          if (!resolved) {
            logger.warning(
              `Event stream ended before session ${sessionId} reached completion state`
            )
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
