import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_PORT
} from '../config/constants.js'
import type { ReviewConfig } from '../execution/types.js'
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

type BashPermission =
  | 'allow'
  | 'ask'
  | 'deny'
  | Record<string, 'allow' | 'ask' | 'deny'>

type OpenCodeConfig = {
  $schema: string
  model: string
  plugin?: string[]
  provider: {
    openrouter: {
      models: Record<string, object>
    }
    openai?: {
      options: {
        reasoningEffort: string
        reasoningSummary: string
        textVerbosity: string
        include: string[]
        store: boolean
      }
      models: Record<string, unknown>
    }
  }
  tools: {
    write: boolean
    bash: boolean
    webfetch: boolean
  }
  permission: {
    edit: 'deny'
    bash: BashPermission
    external_directory: 'deny'
  }
}

type OpenCodeAuth = Record<
  string,
  | {
      type: 'api'
      key: string
    }
  | {
      type: 'oauth'
      [key: string]: unknown
    }
>

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
  private dataDir: string | null = null

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

  async restart(): Promise<void> {
    await logger.group('Restarting OpenCode Server', async () => {
      logger.info('Restarting OpenCode server due to token refresh error...')

      try {
        await this.stop()
      } catch (error) {
        logger.warning(
          `Error stopping server during restart: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      await this.delay(2000)

      await this.start()
      logger.info('OpenCode server restarted successfully')
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
      OPENCODE_SERVER_HOST,
      '--log-level',
      'DEBUG',
      '--print-logs'
    ]

    logger.debug(
      `Starting OpenCode server on port ${OPENCODE_SERVER_PORT} with model ${this.config.opencode.model}`
    )
    logger.debug(`Running: ${command} ${serveArgs.join(' ')}`)
    logger.debug(`Using config file: ${this.configFilePath}`)

    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()

    const env: Record<string, string> = {
      OPENCODE_CONFIG: this.configFilePath || '',
      XDG_DATA_HOME: this.dataDir || '',
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
    logger.info(`OpenCode environment: XDG_DATA_HOME=${env.XDG_DATA_HOME}`)
    logger.debug(
      'Auth credentials passed via auth.json file at $XDG_DATA_HOME/opencode/auth.json'
    )
    logger.debug(`Minimal environment: ${Object.keys(env).join(', ')}`)

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

    let auth: OpenCodeAuth
    try {
      auth = JSON.parse(this.config.opencode.authJson) as OpenCodeAuth
    } catch (error) {
      throw new OpenCodeError(
        `Failed to parse auth JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Let OpenCode auto-discover providers from auth.json
    // Do NOT set enabled_providers as it interferes with provider loading
    const availableProviders = Object.keys(auth)
    logger.info(
      `[DEBUG] Available providers from auth.json: ${availableProviders.join(', ')}`
    )
    logger.info(`[DEBUG] Configured model: ${model}`)

    const config: OpenCodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: model,
      plugin: ['opencode-openai-codex-auth'],
      provider: {
        openrouter: {
          models: {}
        },
        openai: {
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false
          },
          models: {
            'gpt-5.2': {
              name: 'GPT 5.2 (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                none: {
                  reasoningEffort: 'none',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                low: {
                  reasoningEffort: 'low',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                },
                xhigh: {
                  reasoningEffort: 'xhigh',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                }
              }
            },
            'gpt-5.2-codex': {
              name: 'GPT 5.2 Codex (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                low: {
                  reasoningEffort: 'low',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                },
                xhigh: {
                  reasoningEffort: 'xhigh',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                }
              }
            },
            'gpt-5.1-codex-max': {
              name: 'GPT 5.1 Codex Max (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                low: {
                  reasoningEffort: 'low',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                },
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                },
                xhigh: {
                  reasoningEffort: 'xhigh',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                }
              }
            },
            'gpt-5.1-codex': {
              name: 'GPT 5.1 Codex (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                low: {
                  reasoningEffort: 'low',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                }
              }
            },
            'gpt-5.1-codex-mini': {
              name: 'GPT 5.1 Codex Mini (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'medium'
                }
              }
            },
            'gpt-5.1': {
              name: 'GPT 5.1 (OAuth)',
              limit: {
                context: 272000,
                output: 128000
              },
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              variants: {
                none: {
                  reasoningEffort: 'none',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                low: {
                  reasoningEffort: 'low',
                  reasoningSummary: 'auto',
                  textVerbosity: 'low'
                },
                medium: {
                  reasoningEffort: 'medium',
                  reasoningSummary: 'auto',
                  textVerbosity: 'medium'
                },
                high: {
                  reasoningEffort: 'high',
                  reasoningSummary: 'detailed',
                  textVerbosity: 'high'
                }
              }
            }
          }
        }
      },
      tools: {
        write: false,
        bash: true,
        webfetch: this.config.opencode.enableWeb
      },
      permission: {
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
        external_directory: 'deny'
      }
    }

    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      logger.info(`Created OpenCode config file: ${configPath}`)
      logger.info(`Config model: ${model}`)
      logger.info(`Enabled providers: ${availableProviders.join(', ')}`)
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
    // OpenCode expects auth.json at $XDG_DATA_HOME/opencode/auth.json
    // We set XDG_DATA_HOME to our secure config dir, so auth.json goes in opencode/ subdir
    this.dataDir = secureConfigDir
    const opencodeDataDir = join(secureConfigDir, 'opencode')

    try {
      mkdirSync(opencodeDataDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new OpenCodeError(
        `Failed to create opencode data directory: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const authPath = join(opencodeDataDir, 'auth.json')
    this.authFilePath = authPath

    let auth: OpenCodeAuth
    try {
      auth = JSON.parse(this.config.opencode.authJson) as OpenCodeAuth
    } catch (error) {
      throw new OpenCodeError(
        `Failed to parse auth JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    try {
      writeFileSync(authPath, JSON.stringify(auth, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      })
      chmodSync(authPath, 0o600)
      logger.info(`Created OpenCode auth file: ${authPath}`)
      logger.info(`Configured providers: ${Object.keys(auth).join(', ')}`)
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

    this.dataDir = null
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
          // Check for critical errors that should be surfaced prominently
          if (output.includes('ERROR')) {
            logger.error(`[OpenCode ERROR] ${output}`)

            // Extract specific error types for clearer messaging
            if (output.includes('ProviderModelNotFoundError')) {
              logger.error(
                '[OpenCode ERROR] Model not found! Check that the configured model exists and is available.'
              )
              logger.error(
                '[OpenCode ERROR] Run "opencode models" to see available models.'
              )
            } else if (output.includes('ProviderInitError')) {
              logger.error(
                '[OpenCode ERROR] Provider initialization failed! Check your API keys and provider configuration.'
              )
            } else if (output.includes('AI_APICallError')) {
              logger.error(
                '[OpenCode ERROR] API call failed! This may be due to rate limiting, invalid credentials, or network issues.'
              )
            }
          } else {
            logger.warning(`[OpenCode STDERR] ${output}`)
          }
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

          // Log server configuration for debugging
          await this.logServerState()

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

  private async logServerState(): Promise<void> {
    try {
      // Log config
      const configResponse = await fetch(`${this.healthCheckUrl}/config`)
      if (configResponse.ok) {
        const config = await configResponse.json()
        logger.info(`[DEBUG] Server config: ${JSON.stringify(config)}`)
      }

      // Log providers
      const providersResponse = await fetch(
        `${this.healthCheckUrl}/config/providers`
      )
      if (providersResponse.ok) {
        const providers = await providersResponse.json()
        logger.info(`[DEBUG] Server providers: ${JSON.stringify(providers)}`)
      }

      // Log health
      const healthResponse = await fetch(`${this.healthCheckUrl}/global/health`)
      if (healthResponse.ok) {
        const health = await healthResponse.json()
        logger.info(`[DEBUG] Server health: ${JSON.stringify(health)}`)
      }

      // Log session status
      const sessionStatusResponse = await fetch(
        `${this.healthCheckUrl}/session/status`
      )
      if (sessionStatusResponse.ok) {
        const sessionStatus = await sessionStatusResponse.json()
        logger.info(`[DEBUG] Session status: ${JSON.stringify(sessionStatus)}`)
      }
      // Run opencode models CLI to see available models
      await this.logAvailableModels()
    } catch (error) {
      logger.warning(
        `[DEBUG] Failed to log server state: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async logAvailableModels(): Promise<void> {
    try {
      const { command, args } = getOpenCodeCLICommand()
      const modelsArgs = [...args, 'models']

      logger.info(`[DEBUG] Running: ${command} ${modelsArgs.join(' ')}`)

      const env: Record<string, string> = {
        OPENCODE_CONFIG: this.configFilePath || '',
        XDG_DATA_HOME: this.dataDir || '',
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        TMPDIR: process.env.TMPDIR || process.env.TEMP || '/tmp',
        NODE_ENV: process.env.NODE_ENV || 'production'
      }

      const output = execSync(`${command} ${modelsArgs.join(' ')}`, {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024
      })

      logger.info(`[DEBUG] Available models from 'opencode models':`)
      const lines = output.split('\n')
      for (const line of lines) {
        if (line.trim()) {
          logger.info(`[DEBUG]   ${line}`)
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logger.warning(`[DEBUG] Failed to run 'opencode models': ${errorMessage}`)

      if (error && typeof error === 'object' && 'stdout' in error) {
        const stdout = (error as { stdout?: string }).stdout
        if (stdout) {
          logger.info(`[DEBUG] Partial stdout: ${stdout}`)
        }
      }
      if (error && typeof error === 'object' && 'stderr' in error) {
        const stderr = (error as { stderr?: string }).stderr
        if (stderr) {
          logger.warning(`[DEBUG] stderr: ${stderr}`)
        }
      }
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
