import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_PORT
} from '../config/constants.js'
import type { ReviewConfig } from '../review/types.js'
import { OpenCodeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

function getOpenCodeCLICommand(): { command: string; args: string[] } {
  // Use npx to run opencode-ai CLI - this works in GitHub Actions
  // without needing node_modules to be present
  return {
    command: 'npx',
    args: ['opencode-ai']
  }
}

type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

type OpenCodeConfig = {
  $schema: string
  model: string
  enabled_providers: string[]
  disabled_providers: string[]
  provider: {
    openrouter: {
      models: Record<string, object>
    }
  }
  tools: {
    write: boolean
    bash: boolean
    webfetch: boolean
  }
  permission: {
    edit: 'deny'
    bash: 'deny'
    external_directory: 'deny'
  }
}

type OpenCodeAuth = {
  openrouter: {
    type: 'api'
    key: string
  }
}

export class OpenCodeServer {
  private serverProcess: ChildProcess | null = null
  private status: ServerStatus = 'stopped'
  private readonly healthCheckUrl: string
  private readonly maxStartupAttempts = 3
  private readonly healthCheckIntervalMs = 1000
  private readonly healthCheckTimeoutMs = 30000
  private readonly shutdownTimeoutMs = 10000
  private configFilePath: string | null = null
  private authFilePath: string | null = null

  constructor(private config: ReviewConfig) {
    this.healthCheckUrl = `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`
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

    const { command, args } = getOpenCodeCLICommand()
    const serveArgs = [
      ...args,
      'serve',
      '--port',
      String(OPENCODE_SERVER_PORT),
      '--hostname',
      OPENCODE_SERVER_HOST
    ]

    logger.debug(
      `Starting OpenCode server on port ${OPENCODE_SERVER_PORT} with model ${this.config.opencode.model}`
    )
    logger.debug(`Running: ${command} ${serveArgs.join(' ')}`)
    logger.debug(`Using config file: ${this.configFilePath}`)

    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()

    const env: Record<string, string> = {
      OPENCODE_CONFIG: this.configFilePath || '',
      OPENROUTER_API_KEY: this.config.opencode.apiKey,
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
      NODE_ENV: process.env.NODE_ENV || 'production'
    }

    if (this.config.opencode.debugLogging) {
      env.DEBUG = process.env.DEBUG || '*'
      env.OPENCODE_DEBUG = 'true'
    }

    logger.info(`OpenCode environment: OPENCODE_CONFIG=${env.OPENCODE_CONFIG}`)
    logger.debug('OPENROUTER_API_KEY passed via environment variable')
    logger.debug(
      `Minimal environment: ${Object.keys(env)
        .filter((k) => k !== 'OPENROUTER_API_KEY')
        .join(', ')}`
    )

    this.serverProcess = spawn(command, serveArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: workspaceDir,
      env,
      detached: false
    })

    this.attachProcessHandlers()
  }

  private createConfigFile(): string {
    const secureConfigDir = '/tmp/opencode-secure-config'

    try {
      mkdirSync(secureConfigDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new OpenCodeError(
        `Failed to create secure config directory: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const configPath = join(secureConfigDir, 'opencode.json')
    const model = this.config.opencode.model

    const openrouterModel = `openrouter/${model}`

    const config: OpenCodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: openrouterModel,
      enabled_providers: ['openrouter'],
      disabled_providers: ['gemini', 'anthropic', 'openai', 'azure', 'bedrock'],
      provider: {
        openrouter: {
          models: {}
        }
      },
      tools: {
        write: false,
        bash: false,
        webfetch: this.config.opencode.enableWeb
      },
      permission: {
        edit: 'deny',
        bash: 'deny',
        external_directory: 'deny'
      }
    }

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      logger.info(`Created OpenCode config file: ${configPath}`)
      logger.info(`Config model: ${openrouterModel}`)
      logger.info(`Config contents: ${JSON.stringify(config, null, 2)}`)
    } catch (error) {
      throw new OpenCodeError(
        `Failed to write config file: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.createAuthFile(secureConfigDir)

    return configPath
  }

  private createAuthFile(secureConfigDir: string): void {
    const authPath = join(secureConfigDir, 'auth.json')
    this.authFilePath = authPath

    const auth: OpenCodeAuth = {
      openrouter: { type: 'api', key: this.config.opencode.apiKey }
    }

    try {
      writeFileSync(authPath, JSON.stringify(auth, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      chmodSync(authPath, 0o600)
      logger.debug(`Created OpenCode auth file: ${authPath}`)
      logger.debug(
        'Note: Auth is also passed via OPENROUTER_API_KEY env var as backup'
      )
    } catch (error) {
      throw new OpenCodeError(
        `Failed to write auth file: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private cleanupConfigFile(): void {
    if (this.configFilePath) {
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

    if (this.authFilePath) {
      try {
        unlinkSync(this.authFilePath)
        logger.debug(`Removed auth file: ${this.authFilePath}`)
      } catch (error) {
        logger.warning(
          `Failed to remove auth file: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      this.authFilePath = null
    }
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
    logger.debug('killServerProcess: Starting')

    if (!this.serverProcess) {
      logger.debug('killServerProcess: No server process to kill')
      return
    }

    return new Promise((resolve) => {
      if (!this.serverProcess) {
        logger.debug('killServerProcess: Server process is null in promise')
        resolve()
        return
      }

      const pid = this.serverProcess.pid

      if (!pid) {
        logger.debug('killServerProcess: No PID found')
        this.serverProcess = null
        resolve()
        return
      }

      logger.debug(`killServerProcess: Will kill PID ${pid}`)

      const forceKillTimeout = setTimeout(() => {
        logger.debug('killServerProcess: Force kill timeout reached')
        if (this.serverProcess && this.serverProcess.pid) {
          logger.warning(
            `Server did not terminate gracefully, sending SIGKILL to PID ${this.serverProcess.pid}`
          )
          try {
            this.serverProcess.kill('SIGKILL')
          } catch {
            logger.debug(
              'killServerProcess: SIGKILL failed (process may be dead)'
            )
          }
        }
        this.serverProcess = null
        logger.debug('killServerProcess: Resolving after force kill')
        resolve()
      }, this.shutdownTimeoutMs)

      this.serverProcess.once('exit', (code, signal) => {
        logger.debug(
          `killServerProcess: Process exited with code=${code}, signal=${signal}`
        )
        clearTimeout(forceKillTimeout)
        this.serverProcess = null
        logger.debug('killServerProcess: Resolving after exit event')
        resolve()
      })

      logger.debug('killServerProcess: Removing stdout/stderr listeners')
      if (this.serverProcess.stdout) {
        this.serverProcess.stdout.removeAllListeners()
        this.serverProcess.stdout.destroy()
      }
      if (this.serverProcess.stderr) {
        this.serverProcess.stderr.removeAllListeners()
        this.serverProcess.stderr.destroy()
      }
      logger.debug('killServerProcess: Listeners removed')

      logger.info(`Sending SIGTERM to server process (PID: ${pid})`)
      try {
        this.serverProcess.kill('SIGTERM')
        logger.debug('killServerProcess: SIGTERM sent, waiting for exit event')
      } catch {
        logger.debug('killServerProcess: SIGTERM failed (process may be dead)')
        clearTimeout(forceKillTimeout)
        this.serverProcess = null
        resolve()
      }
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
