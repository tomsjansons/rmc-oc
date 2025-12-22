import { Octokit } from '@octokit/rest'

import type { ReviewConfig } from '../review/types.js'
import { GitHubAPIError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

function assertDiffIsString(val: unknown): asserts val is string {
  if (typeof val !== 'string') {
    throw new GitHubAPIError(
      'Unexpected response type: expected string diff data'
    )
  }
}

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

  async getPRDiff(): Promise<string> {
    try {
      logger.debug(
        `Fetching PR diff for ${this.owner}/${this.repo}#${this.prNumber}`
      )

      const response = await this.octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: this.prNumber,
          headers: {
            accept: 'application/vnd.github.v3.diff'
          }
        }
      )

      const diff = response.data

      assertDiffIsString(diff)

      logger.info(`Fetched PR diff: ${diff.length} characters`)

      return diff
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch PR diff: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getPRFiles(): Promise<string[]> {
    try {
      logger.debug(
        `Fetching PR files for ${this.owner}/${this.repo}#${this.prNumber}`
      )

      const response = await this.octokit.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        per_page: 100
      })

      const files = response.data.map((file) => file.filename)

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
}
