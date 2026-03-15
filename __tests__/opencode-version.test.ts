import { describe, expect, it } from '@jest/globals'
import packageMetadata from '../package.json' with { type: 'json' }

import { createOpenCodeServerUrl } from '../src/config/constants.js'
import {
  OPENCODE_PACKAGE_SPECIFIER,
  OPENCODE_VERSION
} from '../src/opencode/version.js'

describe('OpenCode version pinning', () => {
  it('derives the CLI package specifier from the pinned SDK version', () => {
    const sdkVersion = packageMetadata.dependencies['@opencode-ai/sdk']

    expect(sdkVersion).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
    )
    expect(OPENCODE_VERSION).toBe(sdkVersion)
    expect(OPENCODE_PACKAGE_SPECIFIER).toBe(`opencode-ai@${sdkVersion}`)
  })

  it('builds the runtime server URL from the chosen port', () => {
    expect(createOpenCodeServerUrl(4096)).toBe('http://127.0.0.1:4096')
  })
})
