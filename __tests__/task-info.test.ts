import { describe, expect, it, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LLMClient } from '../src/opencode/llm-client.js'
import { extractTaskInfo } from '../src/task/task-info.js'

describe('extractTaskInfo', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'task-info-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('basic description extraction', () => {
    it('should return description when no linked files', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'This PR adds user authentication',
        testDir,
        mockLLM,
        false
      )

      expect(result.description).toBe('This PR adds user authentication')
      expect(result.linkedFiles).toHaveLength(0)
      expect(result.isSufficient).toBe(true)
    })

    it('should return empty for empty description when not required', async () => {
      const mockLLM: LLMClient = {
        complete: async () => null
      }

      const result = await extractTaskInfo('', testDir, mockLLM, false)

      expect(result.description).toBe('')
      expect(result.isSufficient).toBe(true)
    })
  })

  describe('linked file extraction', () => {
    it('should extract content from markdown links', async () => {
      const specContent = '# Auth Spec\n\nUser must be able to login.'
      await writeFile(join(testDir, 'docs', 'spec.md'), specContent, {
        recursive: true
      }).catch(async () => {
        await mkdir(join(testDir, 'docs'), { recursive: true })
        await writeFile(join(testDir, 'docs', 'spec.md'), specContent)
      })

      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'See [spec](./docs/spec.md) for details.',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(1)
      expect(result.linkedFiles[0].path).toBe('docs/spec.md')
      expect(result.linkedFiles[0].content).toBe(specContent)
      expect(result.description).toContain('See [spec](./docs/spec.md)')
      expect(result.description).toContain(specContent)
    })

    it('should handle missing linked files gracefully', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'See [spec](./nonexistent.md) for details.',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(0)
      expect(result.description).toBe(
        'See [spec](./nonexistent.md) for details.'
      )
    })

    it('should extract multiple linked files', async () => {
      await mkdir(join(testDir, 'docs'), { recursive: true })
      await writeFile(join(testDir, 'docs', 'spec.md'), 'Spec content')
      await writeFile(join(testDir, 'docs', 'design.md'), 'Design content')

      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'See [spec](./docs/spec.md) and [design](./docs/design.md)',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(2)
      expect(result.linkedFiles.map((f) => f.path)).toContain('docs/spec.md')
      expect(result.linkedFiles.map((f) => f.path)).toContain('docs/design.md')
    })

    it('should deduplicate linked files', async () => {
      await mkdir(join(testDir, 'docs'), { recursive: true })
      await writeFile(join(testDir, 'docs', 'spec.md'), 'Spec content')

      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'See [spec](./docs/spec.md) and also [the same spec](./docs/spec.md)',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(1)
    })
  })

  describe('sufficiency validation', () => {
    it('should mark empty description as insufficient when required', async () => {
      const mockLLM: LLMClient = {
        complete: async () => null
      }

      const result = await extractTaskInfo('', testDir, mockLLM, true)

      expect(result.isSufficient).toBe(false)
      expect(result.insufficiencyReason).toBe('PR description is empty')
    })

    it('should mark very short description as insufficient when required', async () => {
      const mockLLM: LLMClient = {
        complete: async () => null
      }

      const result = await extractTaskInfo('fix', testDir, mockLLM, true)

      expect(result.isSufficient).toBe(false)
      expect(result.insufficiencyReason).toBe(
        'PR description is too short to understand the task'
      )
    })

    it('should use LLM to validate sufficiency when required', async () => {
      const mockLLM: LLMClient = {
        complete: async (prompt: string) => {
          expect(prompt).toContain('Bug fix for login')
          return 'SUFFICIENT: no\nREASON: Description only says "bug fix" without specifics'
        }
      }

      const result = await extractTaskInfo(
        'Bug fix for login issue',
        testDir,
        mockLLM,
        true
      )

      expect(result.isSufficient).toBe(false)
      expect(result.insufficiencyReason).toBe(
        'Description only says "bug fix" without specifics'
      )
    })

    it('should consider description sufficient when LLM says yes', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'This PR implements OAuth2 authentication with Google. It adds login flow, token refresh, and session management.',
        testDir,
        mockLLM,
        true
      )

      expect(result.isSufficient).toBe(true)
      expect(result.insufficiencyReason).toBeUndefined()
    })

    it('should default to sufficient when LLM fails', async () => {
      const mockLLM: LLMClient = {
        complete: async () => {
          throw new Error('LLM API failed')
        }
      }

      const result = await extractTaskInfo(
        'Some description here',
        testDir,
        mockLLM,
        true
      )

      expect(result.isSufficient).toBe(true)
    })

    it('should default to sufficient when LLM returns unexpected format', async () => {
      const mockLLM: LLMClient = {
        complete: async () => 'I cannot determine sufficiency'
      }

      const result = await extractTaskInfo(
        'Some description here',
        testDir,
        mockLLM,
        true
      )

      expect(result.isSufficient).toBe(true)
    })
  })

  describe('file path patterns', () => {
    it('should detect "see file.md" pattern', async () => {
      await writeFile(join(testDir, 'task.md'), 'Task content')

      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'See task.md for details',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(1)
      expect(result.linkedFiles[0].path).toBe('task.md')
    })

    it('should detect standalone file paths', async () => {
      await writeFile(join(testDir, 'README.md'), 'README content')

      const mockLLM: LLMClient = {
        complete: async () => 'SUFFICIENT: yes\nREASON: N/A'
      }

      const result = await extractTaskInfo(
        'Changes as described in:\nREADME.md',
        testDir,
        mockLLM,
        false
      )

      expect(result.linkedFiles).toHaveLength(1)
      expect(result.linkedFiles[0].path).toBe('README.md')
    })
  })
})
