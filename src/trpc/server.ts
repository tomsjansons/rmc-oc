import type { Server } from 'node:http'

import { createHTTPServer } from '@trpc/server/adapters/standalone'

import {
  TRPC_SERVER_HOST,
  TRPC_SERVER_PORT,
  TRPC_SERVER_URL
} from '../config/constants.js'
import type { GitHubAPI } from '../github/api.js'
import type { LLMClient } from '../opencode/llm-client.js'
import type { ReviewExecutor } from '../execution/orchestrator.js'
import { logger } from '../utils/logger.js'
import { appRouter, type TRPCContext } from './router.js'

export class TRPCServer {
  private server: Server | null = null

  constructor(
    private executor: ReviewExecutor,
    private github: GitHubAPI,
    private llmClient: LLMClient,
    private port: number = TRPC_SERVER_PORT
  ) {}

  async start(): Promise<void> {
    const context: TRPCContext = {
      executor: this.executor,
      github: this.github,
      llmClient: this.llmClient
    }

    this.server = createHTTPServer({
      router: appRouter,
      createContext: () => context
    })

    await new Promise<void>((resolve) => {
      if (!this.server) {
        throw new Error('Server not initialized')
      }
      this.server.listen(this.port, () => {
        logger.info(`tRPC server listening on ${TRPC_SERVER_HOST}:${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.info('tRPC server stopped')
          resolve()
        })
      })
      this.server = null
    }
  }

  getUrl(): string {
    return TRPC_SERVER_URL
  }
}
