import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOpenCodeServerUrl,
  OPENCODE_SERVER_HOST
} from '../config/constants.js'
import type { ReviewConfig } from '../execution/types.js'
import { setupToolsInConfigDir } from '../setup/tools.js'
import { delay } from '../utils/async.js'
import { OpenCodeError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { OPENCODE_PACKAGE_SPECIFIER } from './version.js'

function getOpenCodeCLICommand(): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['--yes', OPENCODE_PACKAGE_SPECIFIER]
  }
}

type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

type PermissionAction = 'allow' | 'ask' | 'deny'

type BashPermission = PermissionAction | Record<string, PermissionAction>

type OpenCodeModelConfig = {
  id?: string
  name?: string
  options?: Record<string, unknown>
}

type OpenCodeConfig = {
  $schema: string
  model: string
  enabled_providers: string[]
  disabled_providers: string[]
  provider: {
    openrouter: {
      models: Record<string, OpenCodeModelConfig>
    }
  }
  permission: Record<string, PermissionAction | BashPermission>
}

export class OpenCodeServer {
  private serverProcess: ChildProcess | null = null
  private status: ServerStatus = 'stopped'
  private port: number | null = null
  private readonly maxStartupAttempts = 3
  private readonly healthCheckIntervalMs = 1000
  private readonly healthCheckTimeoutMs = 30000
  private readonly shutdownTimeoutMs = 10000
  private configDirPath: string | null = null
  private configFilePath: string | null = null

  constructor(private config: ReviewConfig) {}

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
          await this.logOpenCodeLogFiles() // Log errors on failure

          if (this.serverProcess) {
            await this.killServerProcess()
          } else {
            this.resetServerProcess()
          }
          this.cleanupConfigDirectory()

          if (attempt === this.maxStartupAttempts) {
            this.status = 'error'
            throw new OpenCodeError(
              `Failed to start OpenCode server after ${this.maxStartupAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`
            )
          }

          await delay(2000 * attempt)
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
        this.cleanupConfigDirectory()
        logger.info('OpenCode server stopped successfully')
      } catch (error) {
        logger.error(
          `Error during server shutdown: ${error instanceof Error ? error.message : String(error)}`
        )
        throw new OpenCodeError(
          `Failed to stop OpenCode server: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        this.cleanupConfigDirectory()
        this.resetServerProcess()
      }
    })
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  getStatus(): ServerStatus {
    return this.status
  }

  getUrl(): string {
    if (this.port === null) {
      throw new OpenCodeError(
        'OpenCode server URL is unavailable before startup'
      )
    }

    return createOpenCodeServerUrl(this.port)
  }

  async dumpLogs(): Promise<void> {
    await this.logOpenCodeLogFiles()
  }

  private async startServerProcess(): Promise<void> {
    this.status = 'starting'
    this.port = await this.findAvailablePort()
    this.configDirPath = this.createConfigDirectory()
    await setupToolsInConfigDir(this.configDirPath)
    this.configFilePath = this.createConfigFile(this.configDirPath)

    const { command, args } = getOpenCodeCLICommand()
    const serveArgs = [
      ...args,
      'serve',
      '--port',
      String(this.port),
      '--hostname',
      OPENCODE_SERVER_HOST
    ]

    logger.debug(
      `Starting OpenCode server on port ${this.port} with model ${this.config.opencode.model}`
    )
    logger.debug(`Running: ${command} ${serveArgs.join(' ')}`)
    logger.debug(`Using config file: ${this.configFilePath}`)
    logger.info(`OpenCode server URL: ${this.getUrl()}`)

    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()

    const env: Record<string, string> = {
      OPENCODE_CLIENT: 'server',
      OPENCODE_ENABLE_QUESTION_TOOL: '0',
      OPENCODE_CONFIG_DIR: this.configDirPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
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

    logger.info(
      `OpenCode environment: OPENCODE_CONFIG_DIR=${env.OPENCODE_CONFIG_DIR}, OPENCODE_DISABLE_PROJECT_CONFIG=${env.OPENCODE_DISABLE_PROJECT_CONFIG}`
    )
    logger.debug('OPENROUTER_API_KEY passed via environment variable')
    logger.debug(
      `Minimal environment: ${Object.keys(env)
        .filter((key) => key !== 'OPENROUTER_API_KEY')
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

  private async findAvailablePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const probeServer = createServer()

      probeServer.once('error', (error) => {
        reject(
          new OpenCodeError(
            `Failed to find available OpenCode port: ${error.message}`
          )
        )
      })

      probeServer.listen(0, OPENCODE_SERVER_HOST, () => {
        const address = probeServer.address()

        if (!address || typeof address === 'string') {
          probeServer.close(() => {
            reject(
              new OpenCodeError(
                'Failed to determine available OpenCode port from probe server'
              )
            )
          })
          return
        }

        const { port } = address

        probeServer.close((error) => {
          if (error) {
            reject(
              new OpenCodeError(
                `Failed to release probed OpenCode port ${port}: ${error.message}`
              )
            )
            return
          }

          resolve(port)
        })
      })
    })
  }

  private createConfigDirectory(): string {
    const configDirPath = mkdtempSync(join(tmpdir(), 'rmc-opencode-'))
    logger.info(`Created OpenCode config directory: ${configDirPath}`)

    return configDirPath
  }

  private createConfigFile(configDirPath: string): string {
    mkdirSync(configDirPath, { recursive: true, mode: 0o700 })

    const configPath = join(configDirPath, 'opencode.json')
    const config = this.buildConfig()

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      logger.info(`Created OpenCode config file: ${configPath}`)
      logger.info(`Config model: ${config.model}`)
      logger.info(`Config contents: ${JSON.stringify(config, null, 2)}`)

      return configPath
    } catch (error) {
      throw new OpenCodeError(
        `Failed to write config file: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private buildConfig(): OpenCodeConfig {
    const model = this.config.opencode.model
    const openrouterModel = `openrouter/${model}`
    const webPermission: PermissionAction = this.config.opencode.enableWeb
      ? 'allow'
      : 'deny'

    return {
      $schema: 'https://opencode.ai/config.json',
      model: openrouterModel,
      enabled_providers: ['openrouter'],
      disabled_providers: ['gemini', 'anthropic', 'openai', 'azure', 'bedrock'],
      provider: {
        openrouter: {
          models: {
            [model]: {
              id: model,
              name: model
            }
          }
        }
      },
      permission: {
        '*': 'allow',
        edit: 'deny',
        bash: {
          '*': 'deny',
          'git status': 'allow',
          'git diff *': 'allow',
          'git log *': 'allow',
          'git show *': 'allow',
          'git branch': 'allow',
          'git branch -a': 'allow',
          'git branch -r': 'allow',
          'git rev-parse *': 'allow',
          'git merge-base *': 'allow',
          'git ls-files *': 'allow',
          'git blame *': 'allow'
        },
        webfetch: webPermission,
        websearch: webPermission,
        question: 'deny',
        external_directory: 'deny',
        doom_loop: 'deny'
      }
    }
  }

  private cleanupConfigDirectory(): void {
    if (!this.configDirPath) {
      this.configFilePath = null
      return
    }

    try {
      rmSync(this.configDirPath, { recursive: true, force: true })
      logger.debug(`Removed OpenCode config directory: ${this.configDirPath}`)
    } catch (error) {
      logger.warning(
        `Failed to remove OpenCode config directory: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.configDirPath = null
      this.configFilePath = null
    }
  }

  private resetServerProcess(): void {
    this.serverProcess = null
    this.port = null
  }

  private attachProcessHandlers(): void {
    if (!this.serverProcess) {
      return
    }

    this.serverProcess.on('error', (error) => {
      logger.error(`OpenCode server process error: ${error.message}`)
      this.resetServerProcess()
      this.status = 'error'
    })

    this.serverProcess.on('exit', (code, signal) => {
      this.resetServerProcess()
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

      await delay(this.healthCheckIntervalMs)
    }

    throw new OpenCodeError(
      `Server did not become healthy within ${this.healthCheckTimeoutMs}ms`
    )
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`${this.getUrl()}/global/health`, {
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
      this.resetServerProcess()
      return
    }

    return new Promise((resolve) => {
      if (!this.serverProcess) {
        logger.debug('killServerProcess: Server process is null in promise')
        this.resetServerProcess()
        resolve()
        return
      }

      const pid = this.serverProcess.pid

      if (!pid) {
        logger.debug('killServerProcess: No PID found')
        this.resetServerProcess()
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
        this.resetServerProcess()
        logger.debug('killServerProcess: Resolving after force kill')
        resolve()
      }, this.shutdownTimeoutMs)

      this.serverProcess.once('exit', (code, signal) => {
        logger.debug(
          `killServerProcess: Process exited with code=${code}, signal=${signal}`
        )
        clearTimeout(forceKillTimeout)
        this.resetServerProcess()
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
        this.resetServerProcess()
        resolve()
      }
    })
  }

  private async logOpenCodeLogFiles(): Promise<void> {
    const home = process.env.HOME || homedir()
    const logDir = join(home, '.local', 'share', 'opencode', 'log')

    try {
      const files = (await readdir(logDir))
        .filter((f) => f.endsWith('.log'))
        .sort()
        .reverse()

      const file = files[0]
      if (!file) {
        return
      }

      const filePath = join(logDir, file)
      const maxLogSize = 10 * 1024 * 1024
      const stats = statSync(filePath)
      if (stats.size > maxLogSize) {
        logger.warning(
          `Log file ${file} too large (${stats.size} bytes), skipping`
        )
        return
      }

      const content = await readFile(filePath, 'utf8')
      const lines = content.split('\n')

      // Only show ERROR lines
      const errorLines = lines.filter((line) => line.includes('ERROR'))
      if (errorLines.length > 0) {
        logger.warning(
          `[OpenCode] Found ${errorLines.length} errors in log file ${file}`
        )
        for (const line of errorLines) {
          logger.error(`[OpenCode Error] ${line}`)
        }
      }
    } catch {
      // Silently ignore log reading errors
    }
  }
}
