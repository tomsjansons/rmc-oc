import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { logger } from '../utils/logger.js'

function getBundledToolsDir(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)

  return join(__dirname, '.opencode', 'tools')
}

export async function setupToolsInConfigDir(configDir: string): Promise<void> {
  const bundledToolsDir = getBundledToolsDir()
  const configToolsDir = join(configDir, 'tools')

  logger.info('Setting up OpenCode tools in config directory')
  logger.debug(`Bundled OpenCode tools dir: ${bundledToolsDir}`)
  logger.debug(`OpenCode config tools dir: ${configToolsDir}`)

  await mkdir(configToolsDir, { recursive: true })

  const files = await readdir(bundledToolsDir)
  const toolFiles = files.filter((file) => file.endsWith('.js'))

  for (const file of toolFiles) {
    const source = join(bundledToolsDir, file)
    const dest = join(configToolsDir, file)

    await copyFile(source, dest)
    logger.debug(`Copied tool: ${file}`)
  }

  logger.info(
    `Successfully copied ${toolFiles.length} tools to config directory`
  )
}
