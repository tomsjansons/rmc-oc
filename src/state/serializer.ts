/**
 * rmcoc block serialization and parsing utilities.
 *
 * This module handles parsing and generating rmcoc (Review My Code, OpenCode) blocks
 * which are embedded in GitHub comments to track state in a structured way.
 *
 * All state decisions MUST use rmcoc blocks - never raw text parsing.
 */

import { logger } from '../utils/logger.js'

/**
 * Supported rmcoc block types
 */
export type RmcocBlockType =
  | 'question'
  | 'question-answer'
  | 'manual-pr-review'
  | 'review-finding'
  | 'dispute-resolution'

/**
 * Base interface for all rmcoc blocks
 */
export type BaseRmcocBlock = {
  type: RmcocBlockType
}

/**
 * rmcoc block for tracking question status on developer's comment
 */
export type QuestionRmcocBlock = BaseRmcocBlock & {
  type: 'question'
  status: 'PENDING' | 'IN_PROGRESS' | 'ANSWERED'
  started_at?: string
  completed_at?: string
}

/**
 * rmcoc block for bot's answer comment
 */
export type QuestionAnswerRmcocBlock = BaseRmcocBlock & {
  type: 'question-answer'
  reply_to_comment_id: string
  answered_at: string
}

/**
 * rmcoc block for tracking manual review request status
 */
export type ManualReviewRmcocBlock = BaseRmcocBlock & {
  type: 'manual-pr-review'
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'DISMISSED_BY_AUTO_REVIEW'
  started_at?: string
  completed_at?: string
  dismissed_at?: string
  dismissed_reason?: string
}

/**
 * rmcoc block for review findings
 */
export type ReviewFindingRmcocBlock = BaseRmcocBlock & {
  type: 'review-finding'
  status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  assessment: {
    finding: string
    assessment: string
    score: number
  }
  created_at?: string
}

/**
 * rmcoc block for dispute resolution replies
 */
export type DisputeResolutionRmcocBlock = BaseRmcocBlock & {
  type: 'dispute-resolution'
  reply_to_thread_id: string
  status: 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
  resolution: 'concession' | 'maintained' | 'escalated'
  resolved_at?: string
  reason: string
}

/**
 * Union of all rmcoc block types
 */
export type RmcocBlock =
  | QuestionRmcocBlock
  | QuestionAnswerRmcocBlock
  | ManualReviewRmcocBlock
  | ReviewFindingRmcocBlock
  | DisputeResolutionRmcocBlock

/**
 * Extract rmcoc block from a comment body
 *
 * @param commentBody - The full comment body text
 * @returns Parsed rmcoc block or null if not found/invalid
 */
export function extractRmcocBlock(commentBody: string): RmcocBlock | null {
  if (!commentBody) {
    return null
  }

  // Match ```rmcoc\n{...}\n``` pattern
  const rmcocRegex = /```rmcoc\s*\n([\s\S]*?)\n```/

  const match = commentBody.match(rmcocRegex)
  if (!match || !match[1]) {
    return null
  }

  try {
    const jsonStr = match[1].trim()
    const parsed = JSON.parse(jsonStr) as RmcocBlock

    // Validate that it has a type field
    if (!parsed.type) {
      logger.warning('rmcoc block missing type field')
      return null
    }

    return parsed
  } catch (error) {
    logger.warning(
      `Failed to parse rmcoc block: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

/**
 * Add an rmcoc block to a comment body
 *
 * If the comment already has an rmcoc block, this will append a second one.
 * Use updateRmcocBlock() to replace an existing block.
 *
 * @param commentBody - The original comment body
 * @param data - The rmcoc block data to add
 * @returns Updated comment body with rmcoc block appended
 */
export function addRmcocBlock(commentBody: string, data: RmcocBlock): string {
  const rmcocBlock = `\`\`\`rmcoc\n${JSON.stringify(data, null, 2)}\n\`\`\``

  // If comment is empty, just return the block
  if (!commentBody || commentBody.trim() === '') {
    return rmcocBlock
  }

  // Append block to existing comment
  return `${commentBody}\n\n${rmcocBlock}`
}

/**
 * Update an existing rmcoc block in a comment body
 *
 * If no rmcoc block exists, this will append one.
 *
 * @param commentBody - The original comment body
 * @param data - The new rmcoc block data
 * @returns Updated comment body with rmcoc block replaced/added
 */
export function updateRmcocBlock(
  commentBody: string,
  data: RmcocBlock
): string {
  const rmcocRegex = /```rmcoc\s*\n[\s\S]*?\n```/

  const newBlock = `\`\`\`rmcoc\n${JSON.stringify(data, null, 2)}\n\`\`\``

  // If comment already has an rmcoc block, replace it
  if (rmcocRegex.test(commentBody)) {
    return commentBody.replace(rmcocRegex, newBlock)
  }

  // Otherwise, append it
  return addRmcocBlock(commentBody, data)
}

/**
 * Check if a comment body contains an rmcoc block
 *
 * @param commentBody - The comment body to check
 * @returns True if rmcoc block is present
 */
export function hasRmcocBlock(commentBody: string): boolean {
  if (!commentBody) {
    return false
  }

  return /```rmcoc\s*\n[\s\S]*?\n```/.test(commentBody)
}

/**
 * Extract all rmcoc blocks from a comment body
 *
 * Some comments may have multiple rmcoc blocks (though this is not recommended).
 * This function extracts all of them.
 *
 * @param commentBody - The comment body to parse
 * @returns Array of all rmcoc blocks found
 */
export function extractAllRmcocBlocks(commentBody: string): RmcocBlock[] {
  if (!commentBody) {
    return []
  }

  const rmcocRegex = /```rmcoc\s*\n([\s\S]*?)\n```/g
  const blocks: RmcocBlock[] = []

  let match: RegExpExecArray | null

  while ((match = rmcocRegex.exec(commentBody)) !== null) {
    if (match[1]) {
      try {
        const jsonStr = match[1].trim()
        const parsed = JSON.parse(jsonStr) as RmcocBlock

        if (parsed.type) {
          blocks.push(parsed)
        }
      } catch (error) {
        logger.warning(
          `Failed to parse rmcoc block: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }

  return blocks
}
