import { Octokit } from '@octokit/rest'

import type { ReviewConfig } from '../review/types.js'
import { GitHubAPIError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export interface PostReviewCommentArgs {
  path: string
  line: number
  body: string
}

export class GitHubAPI {
  private octokit: Octokit
  private owner: string
  private repo: string
  private prNumber: number

  constructor(config: ReviewConfig) {
    this.octokit = new Octokit({
      auth: config.github.token
    })
    this.owner = config.github.owner
    this.repo = config.github.repo
    this.prNumber = config.github.prNumber
  }

  async getPRFiles(): Promise<string[]> {
    try {
      logger.debug(
        `Fetching PR files for ${this.owner}/${this.repo}#${this.prNumber}`
      )

      const files = await this.octokit.paginate(
        this.octokit.pulls.listFiles,
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: this.prNumber,
          per_page: 100
        },
        (response) => response.data.map((file) => file.filename)
      )

      logger.info(`Fetched ${files.length} changed files`)

      return files
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch PR files: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async postReviewComment(args: PostReviewCommentArgs): Promise<string> {
    try {
      logger.debug(
        `Posting review comment on ${args.path}:${args.line} in PR #${this.prNumber}`
      )

      const pr = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber
      })

      const commitId = pr.data.head.sha

      const response = await this.octokit.pulls.createReviewComment({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        commit_id: commitId,
        path: args.path,
        line: args.line,
        body: args.body,
        side: 'RIGHT'
      })

      const commentId = String(response.data.id)

      logger.info(`Posted review comment: ID ${commentId}`)

      return commentId
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to post review comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async replyToComment(threadId: string, body: string): Promise<void> {
    try {
      logger.debug(`Replying to comment thread ${threadId}`)

      await this.octokit.pulls.createReplyForReviewComment({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        comment_id: Number(threadId),
        body
      })

      logger.info(`Replied to comment thread ${threadId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to reply to comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async resolveThread(threadId: string, reason: string): Promise<void> {
    try {
      logger.debug(`Resolving thread ${threadId}`)

      await this.octokit.pulls.createReplyForReviewComment({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        comment_id: Number(threadId),
        body: `✅ **Issue Resolved**\n\n${reason}`
      })

      logger.info(`Resolved thread ${threadId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to resolve thread: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async escalateToHumanReviewers(
    threadId: string,
    agentPosition: string,
    developerPosition: string,
    reviewers: string[]
  ): Promise<void> {
    try {
      logger.debug(
        `Escalating thread ${threadId} to human reviewers: ${reviewers.join(', ')}`
      )

      if (reviewers.length === 0) {
        logger.warning('No human reviewers configured for escalation')
        return
      }

      const reviewerTags = reviewers.map((r) => `@${r}`).join(' ')

      await this.octokit.pulls.createReplyForReviewComment({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        comment_id: Number(threadId),
        body: `🔺 **Escalated to Human Review**

This issue has an unresolved dispute between the review agent and the developer. Human judgment is needed.

**Review Agent's Position:**
${agentPosition}

**Developer's Position:**
${developerPosition}

${reviewerTags} - Please review this dispute and make a final decision.`
      })

      logger.info(`Escalated thread ${threadId} to ${reviewers.join(', ')}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to escalate to human reviewers: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async replyToIssueComment(commentId: string, body: string): Promise<void> {
    try {
      logger.debug(`Replying to issue comment ${commentId}`)

      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.prNumber,
        body
      })

      logger.info(`Replied to issue comment ${commentId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to reply to issue comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getPRContext(): Promise<{ files: string[] }> {
    try {
      logger.debug('Fetching PR context for question answering')

      const files = await this.getPRFiles()

      return { files }
    } catch (error) {
      logger.warning(
        `Failed to fetch PR context: ${error instanceof Error ? error.message : String(error)}`
      )
      return { files: [] }
    }
  }
}
