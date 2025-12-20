import type { ReviewConfig } from '../review/types.js'

export class GitHubAPI {
  constructor(private config: ReviewConfig) {}
  async getPRDiff(): Promise<string> {
    // TODO: Implement in Phase 2
    // Will use this.config.github settings
    throw new Error('Not implemented')
  }

  async getPRFiles(): Promise<string[]> {
    // TODO: Implement in Phase 2
    throw new Error('Not implemented')
  }
}
