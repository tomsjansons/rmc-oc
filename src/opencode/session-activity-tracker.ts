import type { Event } from '@opencode-ai/sdk'

import { logger } from '../utils/logger.js'

const MAX_REPEATED_TOOL_CALLS = 5
const LOOP_DETECTION_WINDOW = 10

type ActivityMetrics = {
  toolCalls: number
  messageUpdates: number
  busyEvents: number
  idleEvents: number
  errors: number
}

type EventProperties = {
  sessionID?: string
  info?: { sessionID?: string; role?: string; id?: string }
  status?: { type: string; attempt?: number; message?: string }
  part?: {
    type: string
    tool?: string
    state?: { status: string }
    input?: Record<string, unknown>
  }
  delta?: string
  error?: unknown
  todos?: unknown[]
}

type ActivitySignal = {
  isTargetSession: boolean
  isBusy: boolean
  isIdle: boolean
  isMessageUpdate: boolean
  isRetry: boolean
  retryAttempt?: number
  retryMessage?: string
  isError: boolean
  errorPayload?: unknown
  loopDetected: boolean
}

export class SessionActivityTracker {
  private debugLogging: boolean
  private recentToolCalls: string[] = []
  private activityMetrics: ActivityMetrics = {
    toolCalls: 0,
    messageUpdates: 0,
    busyEvents: 0,
    idleEvents: 0,
    errors: 0
  }

  constructor(debugLogging: boolean) {
    this.debugLogging = debugLogging
  }

  reset(): void {
    this.recentToolCalls = []
    this.activityMetrics = {
      toolCalls: 0,
      messageUpdates: 0,
      busyEvents: 0,
      idleEvents: 0,
      errors: 0
    }
  }

  logActivitySummary(sessionId: string, durationMs: number): void {
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

  handleEvent(event: Event, targetSessionId: string): ActivitySignal {
    const props = event.properties as EventProperties
    const eventSessionId = this.extractSessionId(props)
    const isTargetSession = eventSessionId === targetSessionId

    this.logEvent(event, targetSessionId)

    if (!isTargetSession) {
      return {
        isTargetSession: false,
        isBusy: false,
        isIdle: false,
        isMessageUpdate: false,
        isRetry: false,
        isError: false,
        loopDetected: false
      }
    }

    let loopDetected = false

    if (event.type === 'message.part.updated' && props.part?.type === 'tool') {
      this.activityMetrics.toolCalls++
      const toolSignature = this.buildToolSignature(props.part)
      loopDetected = this.detectLoop(toolSignature)
    }

    const isBusy =
      event.type === 'session.status' &&
      props.status?.type !== undefined &&
      props.status.type !== 'idle'

    if (isBusy) {
      this.activityMetrics.busyEvents++
    }

    const isMessageUpdate =
      event.type === 'message.updated' || event.type === 'message.part.updated'

    if (isMessageUpdate) {
      this.activityMetrics.messageUpdates++
    }

    const isIdle =
      event.type === 'session.idle' ||
      (event.type === 'session.status' && props.status?.type === 'idle')

    if (isIdle) {
      this.activityMetrics.idleEvents++
    }

    const isRetry =
      event.type === 'session.status' && props.status?.type === 'retry'

    const isError = event.type === 'session.error'

    if (isError) {
      this.activityMetrics.errors++
    }

    return {
      isTargetSession: true,
      isBusy,
      isIdle,
      isMessageUpdate,
      isRetry,
      retryAttempt: props.status?.attempt,
      retryMessage: props.status?.message,
      isError,
      errorPayload: props.error,
      loopDetected
    }
  }

  private buildToolSignature(part: EventProperties['part']): string {
    const toolName = part?.tool || 'unknown'
    const toolInput = part?.input
      ? JSON.stringify(part.input).substring(0, 200)
      : ''
    return `${toolName}:${toolInput}`
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

  private extractSessionId(props: EventProperties): string | null {
    if (props.sessionID) {
      return props.sessionID
    }

    if (props.info?.sessionID) {
      return props.info.sessionID
    }

    return null
  }

  private logEvent(event: Event, targetSessionId: string): void {
    if (!this.debugLogging) {
      return
    }

    const sessionId = this.extractSessionId(event.properties as EventProperties)

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
}
