import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LLMClient } from '../opencode/llm-client.js'
import { logger } from '../utils/logger.js'

export type TaskInfo = {
  description: string
  linkedFiles: LinkedFileContent[]
  isSufficient: boolean
  insufficiencyReason?: string
}

export type LinkedFileContent = {
  path: string
  content: string
}

const FILE_LINK_PATTERNS = [
  /\[([^\]]+)\]\(([^)]+\.(?:md|txt|rst|adoc))\)/gi,
  /(?:see|refer to|check|read)\s+[`"]?([a-zA-Z0-9_\-./]+\.(?:md|txt|rst|adoc))[`"]?/gi,
  /(?:task|issue|spec|requirement)s?\s+(?:in|at|file)?\s*[`"]?([a-zA-Z0-9_\-./]+\.(?:md|txt|rst|adoc))[`"]?/gi,
  /^([a-zA-Z0-9_\-./]+\.(?:md|txt|rst|adoc))$/gim
]

export async function extractTaskInfo(
  prDescription: string,
  workspaceRoot: string,
  llmClient: LLMClient,
  requireTaskInfo: boolean,
  prFiles?: string[]
): Promise<TaskInfo> {
  logger.info('Extracting task info from PR description')

  const linkedFiles = await extractLinkedFileContents(
    prDescription,
    workspaceRoot
  )

  if (linkedFiles.length > 0) {
    logger.info(`Found ${linkedFiles.length} linked file(s) with task info`)
  }

  const combinedDescription = buildCombinedDescription(
    prDescription,
    linkedFiles
  )

  if (!requireTaskInfo) {
    return {
      description: combinedDescription,
      linkedFiles,
      isSufficient: true
    }
  }

  const sufficiencyResult = await evaluateDescriptionSufficiency(
    combinedDescription,
    llmClient,
    prFiles
  )

  return {
    description: combinedDescription,
    linkedFiles,
    isSufficient: sufficiencyResult.isSufficient,
    insufficiencyReason: sufficiencyResult.reason
  }
}

async function extractLinkedFileContents(
  description: string,
  workspaceRoot: string
): Promise<LinkedFileContent[]> {
  const linkedFiles: LinkedFileContent[] = []
  const foundPaths = new Set<string>()

  for (const pattern of FILE_LINK_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null

    while ((match = regex.exec(description)) !== null) {
      const filePath = match[2] || match[1]
      if (!filePath || foundPaths.has(filePath)) {
        continue
      }

      const normalizedPath = normalizeFilePath(filePath)
      if (foundPaths.has(normalizedPath)) {
        continue
      }

      foundPaths.add(normalizedPath)

      try {
        const fullPath = join(workspaceRoot, normalizedPath)
        const content = await readFile(fullPath, 'utf-8')
        linkedFiles.push({
          path: normalizedPath,
          content
        })
        logger.debug(`Loaded linked file: ${normalizedPath}`)
      } catch (error) {
        logger.debug(
          `Could not read linked file ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  return linkedFiles
}

function normalizeFilePath(filePath: string): string {
  let normalized = filePath.trim()

  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }

  return normalized
}

function buildCombinedDescription(
  prDescription: string,
  linkedFiles: LinkedFileContent[]
): string {
  if (linkedFiles.length === 0) {
    return prDescription
  }

  const parts = [prDescription]

  for (const file of linkedFiles) {
    parts.push(`\n\n---\n**Linked File: ${file.path}**\n\n${file.content}`)
  }

  return parts.join('')
}

type SufficiencyResult = {
  isSufficient: boolean
  reason?: string
}

async function evaluateDescriptionSufficiency(
  description: string,
  llmClient: LLMClient,
  prFiles?: string[]
): Promise<SufficiencyResult> {
  if (!description || description.trim().length === 0) {
    return {
      isSufficient: false,
      reason: 'PR description is empty'
    }
  }

  if (description.trim().length < 20) {
    return {
      isSufficient: false,
      reason: 'PR description is too short to understand the task'
    }
  }

  const filesContext =
    prFiles && prFiles.length > 0
      ? `\n\nFiles changed in this PR (${prFiles.length} files):\n${prFiles
          .slice(0, 50)
          .map((f) => `- ${f}`)
          .join(
            '\n'
          )}${prFiles.length > 50 ? `\n... and ${prFiles.length - 50} more files` : ''}`
      : ''

  const prompt = `You are evaluating whether a Pull Request description provides sufficient context to understand what task or change is being implemented.

A sufficient PR description should:
1. Explain WHAT is being changed or added
2. Explain WHY the change is needed (motivation/problem being solved)
3. Be specific enough for a reviewer to understand the scope
4. Be proportional to the scope of changes (larger changes need more detailed descriptions)

A description is INSUFFICIENT if:
- It's just a title with no explanation
- It only contains generic phrases like "bug fix" or "update" without specifics
- It's completely unrelated to code changes (e.g., just emojis or jokes)
- It lacks any explanation of purpose or motivation
- It's too vague given the scope of changes

Analyze this PR description:
"""
${description.substring(0, 4000)}
"""${filesContext}

Respond in this exact format (nothing else):
SUFFICIENT: yes/no
REASON: <one sentence explanation if insufficient, otherwise "N/A">

Example responses:
SUFFICIENT: yes
REASON: N/A

SUFFICIENT: no
REASON: Description only says "fix bug" without explaining what bug or why`

  try {
    const response = await llmClient.complete(prompt, {
      maxTokens: 150,
      temperature: 0
    })

    if (!response) {
      logger.warning(
        'LLM returned empty response for sufficiency check, defaulting to sufficient'
      )
      return { isSufficient: true }
    }

    const lines = response.trim().split('\n')
    const sufficientLine = lines.find((l) =>
      l.toUpperCase().startsWith('SUFFICIENT:')
    )
    const reasonLine = lines.find((l) => l.toUpperCase().startsWith('REASON:'))

    if (!sufficientLine) {
      logger.warning(
        `Unexpected sufficiency response format: "${response}", defaulting to sufficient`
      )
      return { isSufficient: true }
    }

    const isSufficient = sufficientLine.toLowerCase().includes('yes')
    const reason = reasonLine?.replace(/^REASON:\s*/i, '').trim()

    return {
      isSufficient,
      reason: isSufficient ? undefined : reason || 'Description is insufficient'
    }
  } catch (error) {
    logger.warning(
      `Sufficiency check failed: ${error instanceof Error ? error.message : String(error)}, defaulting to sufficient`
    )
    return { isSufficient: true }
  }
}
