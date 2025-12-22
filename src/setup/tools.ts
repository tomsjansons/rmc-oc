import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { logger } from '../utils/logger.js'

export async function setupToolsInWorkspace(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)

  // When bundled, dist/index.js runs and __dirname is 'dist/'
  // Tools are at 'dist/.opencode/tool/', so we go down from __dirname
  const actionToolsDir = join(__dirname, '.opencode', 'tool')

  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd()
  const workspaceToolsDir = join(workspaceDir, '.opencode', 'tool')

  logger.info('Setting up OpenCode tools in workspace')
  logger.debug(`Action tools dir: ${actionToolsDir}`)
  logger.debug(`Workspace tools dir: ${workspaceToolsDir}`)

  await mkdir(workspaceToolsDir, { recursive: true })

  const files = await readdir(actionToolsDir)
  const toolFiles = files.filter((f) => f.endsWith('.js'))

  for (const file of toolFiles) {
    const source = join(actionToolsDir, file)
    const dest = join(workspaceToolsDir, file)

    await copyFile(source, dest)
    logger.debug(`Copied tool: ${file}`)
  }

  logger.info(`Successfully copied ${toolFiles.length} tools to workspace`)
}
