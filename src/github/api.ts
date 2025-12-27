import { Octokit } from '@octokit/rest'
import type { RestEndpointMethodTypes } from '@octokit/rest'

import type { ReviewConfig } from '../review/types.js'
import { GitHubAPIError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

type IssueComment =
  RestEndpointMethodTypes['issues']['listComments']['response']['data'][0]
type ReviewComment =
  RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][0]

export type PostReviewCommentArgs = {
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
      const isUnprocessableEntity =
        error instanceof Error &&
        (error.message.includes('422') ||
          error.message.includes('Unprocessable Entity'))

      if (isUnprocessableEntity) {
        logger.warning(
          `Line ${args.line} not in PR diff for ${args.path}, falling back to PR-level comment`
        )
        return this.postPRLevelComment(args)
      }

      throw new GitHubAPIError(
        `Failed to post review comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async postPRLevelComment(
    args: PostReviewCommentArgs
  ): Promise<string> {
    try {
      const bodyWithLocation = `📍 **Location:** \`${args.path}:${args.line}\`\n\n${args.body}`

      const response = await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.prNumber,
        body: bodyWithLocation
      })

      const commentId = String(response.data.id)

      logger.info(`Posted PR-level comment: ID ${commentId}`)

      return commentId
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to post PR-level comment: ${error instanceof Error ? error.message : String(error)}`
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
        body: `✅ **Issue Resolved**\n\n${reason}\n\n\`\`\`rmcoc\n{"status": "RESOLVED"}\n\`\`\``
      })

      await this.resolveReviewThread(threadId)

      logger.info(`Resolved thread ${threadId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to resolve thread: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async resolveReviewThread(commentId: string): Promise<void> {
    try {
      const threadId = await this.getReviewThreadId(commentId)

      if (!threadId) {
        logger.warning(
          `Could not find thread ID for comment ${commentId}, thread will remain unresolved`
        )
        return
      }

      await this.octokit.graphql(
        `mutation ResolveThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread {
              isResolved
            }
          }
        }`,
        { threadId }
      )

      logger.debug(`GraphQL: Resolved review thread ${threadId}`)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      if (errorMessage.includes('Resource not accessible by integration')) {
        logger.debug(
          `Cannot auto-resolve thread via GraphQL - requires a PAT with elevated permissions. ` +
            `The thread has been marked as resolved via comment.`
        )
      } else {
        logger.warning(
          `Failed to resolve review thread via GraphQL: ${errorMessage}`
        )
      }
    }
  }

  private async getReviewThreadId(commentId: string): Promise<string | null> {
    try {
      const result = await this.octokit.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string
                comments: {
                  nodes: Array<{
                    databaseId: number
                  }>
                }
              }>
            }
          }
        }
      }>(
        `query GetThreadId($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  comments(first: 1) {
                    nodes {
                      databaseId
                    }
                  }
                }
              }
            }
          }
        }`,
        {
          owner: this.owner,
          repo: this.repo,
          prNumber: this.prNumber
        }
      )

      const threads = result.repository.pullRequest.reviewThreads.nodes
      for (const thread of threads) {
        const firstComment = thread.comments.nodes[0]
        if (firstComment && String(firstComment.databaseId) === commentId) {
          return thread.id
        }
      }

      return null
    } catch (error) {
      logger.warning(
        `Failed to get review thread ID: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
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

${reviewerTags} - Please review this dispute and make a final decision.

\`\`\`rmcoc
{"status": "ESCALATED"}
\`\`\``
      })

      logger.info(`Escalated thread ${threadId} to ${reviewers.join(', ')}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to escalate to human reviewers: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async postIssueComment(body: string): Promise<void> {
    try {
      logger.debug('Posting issue comment')

      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.prNumber,
        body
      })

      logger.info('Posted issue comment')
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to post issue comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async updateIssueComment(commentId: string, body: string): Promise<void> {
    try {
      logger.debug(`Updating issue comment ${commentId}`)

      await this.octokit.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: Number(commentId),
        body
      })

      logger.info(`Updated issue comment ${commentId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to update issue comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getIssueComment(commentId: string): Promise<string> {
    try {
      logger.debug(`Fetching issue comment ${commentId}`)

      const response = await this.octokit.issues.getComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: Number(commentId)
      })

      return response.data.body || ''
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to get issue comment: ${error instanceof Error ? error.message : String(error)}`
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

  async getAllIssueComments(): Promise<IssueComment[]> {
    try {
      logger.debug('Fetching all issue comments')

      const comments = await this.octokit.paginate(
        this.octokit.issues.listComments,
        {
          owner: this.owner,
          repo: this.repo,
          issue_number: this.prNumber,
          per_page: 100
        }
      )

      logger.info(`Fetched ${comments.length} issue comments`)

      return comments
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch issue comments: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getComment(commentId: string): Promise<IssueComment> {
    try {
      logger.debug(`Fetching comment ${commentId}`)

      const response = await this.octokit.issues.getComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: Number(commentId)
      })

      return response.data
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    try {
      logger.debug(`Updating comment ${commentId}`)

      await this.octokit.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: Number(commentId),
        body
      })

      logger.info(`Updated comment ${commentId}`)
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to update comment: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getCurrentSHA(): Promise<string> {
    try {
      logger.debug('Fetching current PR SHA')

      const pr = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber
      })

      const sha = pr.data.head.sha

      logger.debug(`Current SHA: ${sha}`)

      return sha
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch current SHA: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async hasNewDeveloperReply(threadId: string): Promise<boolean> {
    try {
      logger.debug(`Checking for new developer replies in thread ${threadId}`)

      const comments = await this.getThreadComments(threadId)
      const botUsers = ['github-actions[bot]', 'opencode-reviewer[bot]']

      const lastBotComment = comments
        .filter((c) => botUsers.includes(c.user?.login || ''))
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )[0]

      if (!lastBotComment) {
        return false
      }

      const hasNewReply = comments.some(
        (c) =>
          !botUsers.includes(c.user?.login || '') &&
          new Date(c.created_at) > new Date(lastBotComment.created_at)
      )

      logger.debug(`Thread ${threadId} has new developer reply: ${hasNewReply}`)

      return hasNewReply
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to check for new developer replies: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async getThreadComments(threadId: string): Promise<ReviewComment[]> {
    try {
      logger.debug(`Fetching comments for thread ${threadId}`)

      const comments = await this.octokit.paginate(
        this.octokit.pulls.listReviewComments,
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: this.prNumber,
          per_page: 100
        }
      )

      const threadComments = comments.filter(
        (c) =>
          String(c.id) === threadId ||
          String(c.in_reply_to_id) === threadId ||
          c.in_reply_to_id === Number(threadId)
      )

      logger.debug(
        `Found ${threadComments.length} comments in thread ${threadId}`
      )

      return threadComments
    } catch (error) {
      throw new GitHubAPIError(
        `Failed to fetch thread comments: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
