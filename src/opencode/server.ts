import type { ReviewConfig } from '../review/types.js'

export class OpenCodeServer {
  constructor(private config: ReviewConfig) {}

  async start(): Promise<void> {
    // TODO: Implement server startup logic in Phase 2
    // Will use this.config.opencode settings
    throw new Error('Not implemented')
  }

  async stop(): Promise<void> {
    // TODO: Implement server shutdown logic in Phase 2
    throw new Error('Not implemented')
  }

  isRunning(): boolean {
    // TODO: Implement health check in Phase 2
    return false
  }
}
