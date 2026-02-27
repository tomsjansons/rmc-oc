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
    const TARGET_INACTIVITY_FAIL_MS = 180000
    const INITIAL_TARGET_ACTIVITY_FAIL_MS = 120000
    const TRANSCRIPT_DUMP_COOLDOWN_MS = 60000
    const TRANSCRIPT_FETCH_TIMEOUT_MS = 5000

    this.activityTracker.reset()

    return new Promise<void>((resolve, reject) => {
      let resolved = false
      let idleGraceDeadlineMs: number | null = null
      let idleGraceStartedAtMs: number | null = null
      let activityLogTimerId: ReturnType<typeof setInterval> | null = null
      let transcriptDumpInFlight = false
      let lastTranscriptDumpAt = 0

      const summarizePart = (
        part: { type: string } & Record<string, unknown>
      ): string => {
        if (part.type === 'text') {
          const text = typeof part.text === 'string' ? part.text : ''
          const compact = text.replace(/\s+/g, ' ').trim()
          const clipped =
            compact.length > 220 ? `${compact.slice(0, 220)}...` : compact
          return clipped ? `text:${clipped}` : 'text:<empty>'
        }

        if (part.type === 'tool') {
          const tool = typeof part.tool === 'string' ? part.tool : 'unknown'
          const state =
            typeof part.state === 'object' && part.state !== null
              ? (part.state as Record<string, unknown>)
              : null
          const status =
            state && typeof state.status === 'string' ? state.status : 'unknown'
          if (status === 'completed') {
            const output =
              typeof state?.output === 'string' ? state.output : 'no output'
            const compact = output.replace(/\s+/g, ' ').trim()
            const clipped =
              compact.length > 160 ? `${compact.slice(0, 160)}...` : compact
            return `tool:${tool}:${status}:${clipped}`
          }
          if (status === 'error') {
            const error =
              typeof state?.error === 'string' ? state.error : 'unknown error'
            return `tool:${tool}:${status}:${error}`
          }
          return `tool:${tool}:${status}`
        }

        if (part.type === 'retry') {
          const attempt = typeof part.attempt === 'number' ? part.attempt : -1
          return `retry:attempt=${attempt}`
        }

        if (part.type === 'step-finish') {
          const reason =
            typeof part.reason === 'string' ? part.reason : 'unknown'
          return `step-finish:${reason}`
        }

        return part.type
      }

      const dumpRecentSessionMessages = async (
        reason: string
      ): Promise<void> => {
        const now = Date.now()
        if (transcriptDumpInFlight) {
          return
        }
        if (now - lastTranscriptDumpAt < TRANSCRIPT_DUMP_COOLDOWN_MS) {
          return
        }

        transcriptDumpInFlight = true
        lastTranscriptDumpAt = now
        logger.info(
          `Session ${sessionId} fetching transcript snapshot (${reason})`
        )

        try {
          const response = await Promise.race([
            this.client.session.messages({
              path: { id: sessionId },
              query: { limit: 6 }
            }),
            new Promise<never>((_resolve, rejectSnapshot) => {
              setTimeout(() => {
                rejectSnapshot(
                  new Error(
                    `Transcript fetch timed out after ${TRANSCRIPT_FETCH_TIMEOUT_MS}ms`
                  )
                )
              }, TRANSCRIPT_FETCH_TIMEOUT_MS)
            })
          ])

          if (!response.data || response.data.length === 0) {
            logger.warning(
              `Session ${sessionId} transcript snapshot (${reason}): no messages returned`
            )
            return
          }

          const formatted = response.data
            .map((message) => {
              const role = message.info.role
              const messageId = message.info.id
              const partsSummary = message.parts
                .slice(-3)
                .map((part) =>
                  summarizePart(
                    part as { type: string } & Record<string, unknown>
                  )
                )
                .join(' | ')
              return `${role}:${messageId} => ${partsSummary || 'no parts'}`
            })
            .join(' || ')

          logger.info(
            `Session ${sessionId} transcript snapshot (${reason}): ${formatted}`
          )
        } catch (error) {
          logger.warning(
            `Failed to fetch transcript snapshot for session ${sessionId} (${reason}): ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          transcriptDumpInFlight = false
        }
      }

      const rejectForInactivity = (reason: string): void => {
        if (resolved) {
          return
        }

        const lastTargetEventAgeMs =
          lastTargetEventAt > 0 ? Date.now() - lastTargetEventAt : -1
        const metrics = this.activityTracker.getMetricsSnapshot()
        const traceSummary = formatRecentTargetEvents()

        resolved = true
        cleanup()
        reject(
          new OpenCodeError(
            `Session ${sessionId} became inactive (${reason}). events: total=${totalEvents}, target=${targetEvents}, busySeen=${sawBusy}, idleGraceActive=${idleGraceDeadlineMs !== null}, lastTargetEventAgeMs=${lastTargetEventAgeMs}, metrics=${JSON.stringify(metrics)}, recentTargetEvents=${traceSummary}`
          )
        )
      }

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
        void dumpRecentSessionMessages(`target-stall:${source}`)
      }

      const failOnTargetInactivityIfNeeded = (source: string): void => {
        if (resolved) {
          return
        }

        const now = Date.now()
        const elapsedMs = now - startTime

        if (
          !sawBusy &&
          targetEvents <= 1 &&
          elapsedMs >= INITIAL_TARGET_ACTIVITY_FAIL_MS
        ) {
          logger.error(
            `Session ${sessionId} did not show target activity within ${INITIAL_TARGET_ACTIVITY_FAIL_MS}ms (source=${source})`
          )
          void dumpRecentSessionMessages(`initial-inactivity:${source}`)
          rejectForInactivity('no target activity after prompt submission')
          return
        }

        if (
          sawBusy &&
          idleGraceDeadlineMs === null &&
          lastTargetEventAt > 0 &&
          now - lastTargetEventAt >= TARGET_INACTIVITY_FAIL_MS
        ) {
          logger.error(
            `Session ${sessionId} had no target events for ${TARGET_INACTIVITY_FAIL_MS}ms after being busy (source=${source})`
          )
          void dumpRecentSessionMessages(`target-inactivity:${source}`)
          rejectForInactivity('target session stopped emitting events')
        }
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
        const lastTargetEventAgeMs =
          lastTargetEventAt > 0 ? Date.now() - lastTargetEventAt : -1
        logger.info(
          `Session ${sessionId} still running (${elapsedMs}ms, events total=${totalEvents}, target=${targetEvents}, busySeen=${sawBusy}, idleGraceActive=${idleGraceDeadlineMs !== null}, lastTargetEventAgeMs=${lastTargetEventAgeMs}, metrics=${JSON.stringify(metrics)})`
        )
        if (sawBusy) {
          void dumpRecentSessionMessages('heartbeat')
        }
        logTargetStallIfNeeded('heartbeat')
        failOnTargetInactivityIfNeeded('heartbeat')
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
            failOnTargetInactivityIfNeeded('event-loop')
            if (resolved) {
              return
            }

            totalEvents++

            this.logAgentConversationEvent(event, sessionId)

            const signal = this.activityTracker.handleEvent(event, sessionId)

            if (!signal.isTargetSession) {
              logTargetStallIfNeeded('non-target-event')
              failOnTargetInactivityIfNeeded('non-target-event')
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
              const becameBusy = !sawBusy
              sawBusy = true
              if (becameBusy) {
                logger.info(
                  `Session ${sessionId} became busy for the first time, dumping transcript snapshot`
                )
                void dumpRecentSessionMessages('became-busy')
              }
              cancelIdleGrace('target session became busy')
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

  private logAgentConversationEvent(event: unknown, sessionId: string): void {
    if (!this.isObjectRecord(event)) {
      return
    }

    const type = Reflect.get(event, 'type')
    if (type !== 'message.part.updated') {
      return
    }

    const properties = Reflect.get(event, 'properties')
    if (!this.isObjectRecord(properties)) {
      return
    }

    const part = Reflect.get(properties, 'part')
    if (!this.isObjectRecord(part)) {
      return
    }

    const partType = Reflect.get(part, 'type')
    const partSessionId = Reflect.get(part, 'sessionID')
    if (partType !== 'text' || partSessionId !== sessionId) {
      return
    }

    const delta = Reflect.get(properties, 'delta')
    if (typeof delta !== 'string' || delta.length === 0) {
      return
    }

    logger.info(`[agent] ${delta}`)
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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
