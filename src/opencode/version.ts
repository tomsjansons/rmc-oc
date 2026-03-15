import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function findPackageJsonPath(startDir: string): string {
  let currentDir = startDir

  while (true) {
    const candidatePath = join(currentDir, 'package.json')

    if (existsSync(candidatePath)) {
      return candidatePath
    }

    const parentDir = dirname(currentDir)

    if (parentDir === currentDir) {
      throw new Error(
        'Could not locate package.json for OpenCode version pinning'
      )
    }

    currentDir = parentDir
  }
}

function getPinnedSdkVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageJsonPath = findPackageJsonPath(moduleDir)
  const packageJsonContent = readFileSync(packageJsonPath, 'utf8')
  const packageMetadata = JSON.parse(packageJsonContent)

  if (!isRecord(packageMetadata)) {
    throw new Error('package.json must contain a top-level object')
  }

  const dependencies = packageMetadata.dependencies

  if (!isRecord(dependencies)) {
    throw new Error('package.json must contain a dependencies object')
  }

  const version = dependencies['@opencode-ai/sdk']

  if (typeof version !== 'string') {
    throw new Error(
      'package.json must declare @opencode-ai/sdk as a dependency'
    )
  }

  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(
      `Expected @opencode-ai/sdk to be pinned to an exact version, received ${version}`
    )
  }

  return version
}

export const OPENCODE_VERSION = getPinnedSdkVersion()
export const OPENCODE_PACKAGE_SPECIFIER = `opencode-ai@${OPENCODE_VERSION}`
