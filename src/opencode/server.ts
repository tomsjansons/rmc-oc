import { spawn, type ChildProcess } from 'child_process'
import { writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '../utils/logger.js'
import { OpenCodeError } from '../utils/errors.js'
import type { ReviewConfig } from '../review/types.js'

type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

type OpenCodeConfig = {
  model: string
  tools: {
    write: boolean
    bash: boolean
    webfetch: boolean
  }
  permission: {
    edit: 'deny'
    bash: 'deny'
  }
}

export class OpenCodeServer {
  private serverProcess: ChildProcess | null = null
  private status: ServerStatus = 'stopped'
  private readonly healthCheckUrl: string
  private readonly serverPort = 4096
  private readonly maxStartupAttempts = 3
  private readonly healthCheckIntervalMs = 1000
  private readonly healthCheckTimeoutMs = 30000
  private readonly shutdownTimeoutMs = 10000
  private configFilePath: string | null = null

  constructor(private config: ReviewConfig) {
    this.healthCheckUrl = `http://127.0.0.1:${this.serverPort}`
  }

  async start(): Promise<void> {
    if (this.status === 'running') {
      logger.warning('OpenCode server is already running')
      return
    }

    if (this.status === 'starting') {
      throw new OpenCodeError('Server is already starting')
    }

    await logger.group('Starting OpenCode Server', async () => {
      for (let attempt = 1; attempt <= this.maxStartupAttempts; attempt++) {
        try {
          logger.info(
            `Server startup attempt ${attempt}/${this.maxStartupAttempts}`
          )
          await this.startServerProcess()
          await this.waitForHealthy()
          logger.info('OpenCode server started successfully')
          return
        } catch (error) {
          logger.error(
            `Startup attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`
          )

          if (this.serverProcess) {
            await this.killServerProcess()
          }

          if (attempt === this.maxStartupAttempts) {
            this.status = 'error'
            throw new OpenCodeError(
              `Failed to start OpenCode server after ${this.maxStartupAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`
            )
          }

          await this.delay(2000 * attempt)
        }
      }
    })
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') {
      logger.debug('OpenCode server is already stopped')
      return
    }

    if (this.status === 'stopping') {
      throw new OpenCodeError('Server is already stopping')
    }

    await logger.group('Stopping OpenCode Server', async () => {
      this.status = 'stopping'

      try {
        await this.killServerProcess()
        this.cleanupConfigFile()
        logger.info('OpenCode server stopped successfully')
      } catch (error) {
        logger.error(
          `Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`
        )
        throw new OpenCodeError(
          `Failed to stop OpenCode server: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        this.status = 'stopped'
        this.serverProcess = null
      }
    })
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  getStatus(): ServerStatus {
    return this.status
  }

  private async startServerProcess(): Promise<void> {
    this.status = 'starting'

    this.configFilePath = this.createConfigFile()

    logger.debug(
      `Starting OpenCode server on port ${this.serverPort} with model ${this.config.opencode.model}`
    )
    logger.debug(`Using config file: ${this.configFilePath}`)

    this.serverProcess = spawn(
      'opencode',
      ['serve', '--port', String(this.serverPort), '--hostname', '127.0.0.1'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENCODE_CONFIG: this.configFilePath
        },
        detached: false
      }
    )

    this.attachProcessHandlers()
  }

  private createConfigFile(): string {
    const tempDir = tmpdir()
    const configDir = join(tempDir, 'opencode-pr-reviewer')

    try {
      mkdirSync(configDir, { recursive: true })
    } catch (error) {
      throw new OpenCodeError(
        `Failed to create config directory: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const configPath = join(configDir, 'opencode.json')

    const config: OpenCodeConfig = {
      model: this.config.opencode.model,
      tools: {
        write: false,
        bash: false,
        webfetch: this.config.opencode.enableWeb
      },
      permission: {
        edit: 'deny',
        bash: 'deny'
      }
    }

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
      logger.debug(`Created OpenCode config file: ${configPath}`)
      return configPath
    } catch (error) {
      throw new OpenCodeError(
        `Failed to write config file: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private cleanupConfigFile(): void {
    if (!this.configFilePath) {
      return
    }

    try {
      unlinkSync(this.configFilePath)
      logger.debug(`Removed config file: ${this.configFilePath}`)
    } catch (error) {
      logger.warning(
        `Failed to remove config file: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.configFilePath = null
  }

  private attachProcessHandlers(): void {
    if (!this.serverProcess) {
      return
    }

    this.serverProcess.on('error', (error) => {
      logger.error(`OpenCode server process error: ${error.message}`)
      this.status = 'error'
    })

    this.serverProcess.on('exit', (code, signal) => {
      if (this.status !== 'stopping') {
        logger.error(
          `OpenCode server exited unexpectedly (code: ${code}, signal: ${signal})`
        )
        this.status = 'error'
      }
    })

    if (this.serverProcess.stdout) {
      this.serverProcess.stdout.on('data', (data) => {
        const output = data.toString().trim()
        if (output) {
          logger.debug(`[OpenCode STDOUT] ${output}`)
        }
      })
    }

    if (this.serverProcess.stderr) {
      this.serverProcess.stderr.on('data', (data) => {
        const output = data.toString().trim()
        if (output) {
          logger.warning(`[OpenCode STDERR] ${output}`)
        }
      })
    }
  }

  private async waitForHealthy(): Promise<void> {
    const startTime = Date.now()

    logger.info('Waiting for OpenCode server to become healthy...')

    while (Date.now() - startTime < this.healthCheckTimeoutMs) {
      if (this.status === 'error') {
        throw new OpenCodeError(
          'Server process entered error state during health check'
        )
      }

      try {
        const isHealthy = await this.checkHealth()

        if (isHealthy) {
          this.status = 'running'
          logger.info(`Server became healthy after ${Date.now() - startTime}ms`)
          return
        }
      } catch (error) {
        logger.debug(
          `Health check failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      await this.delay(this.healthCheckIntervalMs)
    }

    throw new OpenCodeError(
      `Server did not become healthy within ${this.healthCheckTimeoutMs}ms`
    )
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`${this.healthCheckUrl}/config`, {
        method: 'GET',
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      return response.ok
    } catch {
      return false
    }
  }

  private async killServerProcess(): Promise<void> {
    if (!this.serverProcess) {
      return
    }

    return new Promise((resolve, reject) => {
      if (!this.serverProcess) {
        resolve()
        return
      }

      const pid = this.serverProcess.pid

      if (!pid) {
        this.serverProcess = null
        resolve()
        return
      }

      const timeoutId = setTimeout(() => {
        if (this.serverProcess && this.serverProcess.pid) {
          logger.warning(
            `Server did not terminate gracefully, sending SIGKILL to PID ${this.serverProcess.pid}`
          )
          this.serverProcess.kill('SIGKILL')
        }
        reject(
          new OpenCodeError(
            `Server process did not terminate within ${this.shutdownTimeoutMs}ms`
          )
        )
      }, this.shutdownTimeoutMs)

      this.serverProcess.once('exit', () => {
        clearTimeout(timeoutId)
        this.serverProcess = null
        resolve()
      })

      logger.info(`Sending SIGTERM to server process (PID: ${pid})`)
      this.serverProcess.kill('SIGTERM')
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
