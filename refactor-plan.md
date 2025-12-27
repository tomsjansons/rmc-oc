# Multi-Task Execution Refactor Plan

## Overview

Refactor the action to detect and execute ALL pending work on every run,
regardless of which GitHub event triggered the workflow. This ensures no
questions, disputes, or reviews are lost due to workflow cancellation.

## Goals

1. **No Lost Work**: Every run scans for all pending tasks (questions, disputes,
   reviews)
2. **Single Workflow**: One workflow handles all events with
   `cancel-in-progress: true`
3. **Sequential Execution**: Tasks execute in priority order within a single
   OpenCode session
4. **Proper Tracking**: All tasks tracked via `rmcoc` blocks for idempotency
5. **Context Reuse**: Single session reduces token costs across multiple tasks
6. **Correct Exit Codes**: Auto reviews with blocking issues fail (merge gate),
   manual reviews don't

## Execution Priority

Tasks execute in this order:

1. **Priority 1: Dispute Resolution** - Developers waiting for clarification
2. **Priority 2: Question Answering** - Developers asking questions
3. **Priority 3: PR Reviews** - Full 3-pass review (auto or manual)

**Important**: PR Review only executes if explicitly requested (auto PR event or
manual @ mention review request)

## Architecture Changes

### 1. State Management Refactor

**Current**: `ReviewState` only tracks review threads

```typescript
// src/review/types.ts
type ReviewState = {
  threads: ReviewThread[]
  metadata: Record<string, unknown>
}
```

**New**: Rename to `ProcessState` and track all task types

```typescript
// src/state/types.ts (NEW FILE)
type ProcessState = {
  reviewThreads: ReviewThread[]
  questionTasks: QuestionTask[]
  manualReviewRequests: ManualReviewRequest[]
  metadata: ProcessMetadata
}

type QuestionTask = {
  id: string // comment ID
  author: string
  question: string
  status: 'PENDING' | 'ANSWERED'
  commentId: string
  fileContext?: {
    path: string
    line?: number
  }
  startedAt?: string
  completedAt?: string
}

type ManualReviewRequest = {
  id: string // comment ID
  author: string
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'DISMISSED_BY_AUTO_REVIEW'
  commentId: string
  startedAt?: string
  completedAt?: string
}

type ProcessMetadata = {
  lastUpdated: string
  prNumber: number
  passesCompleted: number[] // [1, 2, 3] for completed passes
}
```

**Files to Create/Modify**:

- Create `src/state/types.ts` - Move state-related types here
- Rename `src/github/state.ts` → `src/state/manager.ts`
- Update all imports

### 2. Task Detection System

**New File**: `src/task/detector.ts`

````typescript
import type { ProcessState } from '../state/types.js'
import type { GitHubAPI } from '../github/api.js'

export class TaskDetector {
  async detectAllTasks(
    context: GitHubContext,
    github: GitHubAPI,
    currentState: ProcessState
  ): Promise<ExecutionPlan> {
    const tasks: Task[] = []

    // Detect disputes (always check)
    const disputes = await this.detectPendingDisputes(github, currentState)
    tasks.push(...disputes)

    // Detect unanswered questions (always check)
    const questions = await this.detectPendingQuestions(github, currentState)
    tasks.push(...questions)

    // Detect review requests (only if triggered by auto or manual event)
    const reviewRequest = await this.detectReviewRequest(
      context,
      github,
      currentState
    )
    if (reviewRequest) {
      tasks.push(reviewRequest)
    }

    return {
      tasks: this.deduplicateAndPrioritize(tasks),
      triggeredBy: context.eventName
    }
  }

  private async detectPendingDisputes(
    github: GitHubAPI,
    state: ProcessState
  ): Promise<DisputeTask[]> {
    // Get all review threads with developer replies
    const threads = state.reviewThreads.filter(
      (t) => t.status === 'PENDING' || t.status === 'DISPUTED'
    )

    const disputes: DisputeTask[] = []
    for (const thread of threads) {
      const hasUnresolvedReply = await github.hasNewDeveloperReply(thread.id)
      if (hasUnresolvedReply) {
        disputes.push({
          type: 'dispute-resolution',
          priority: 1,
          threadId: thread.id
          // ... rest of dispute context
        })
      }
    }
    return disputes
  }

  private async detectPendingQuestions(
    github: GitHubAPI,
    state: ProcessState
  ): Promise<QuestionTask[]> {
    // Scan all comments for @ mentions
    const allComments = await github.getAllIssueComments()
    const botMention = '@review-my-code-bot'

    const questions: QuestionTask[] = []

    for (const comment of allComments) {
      if (!comment.body?.includes(botMention)) continue

      // Check if already answered by looking for rmcoc block
      const rmcocBlock = this.extractRmcocBlock(comment.body)

      if (rmcocBlock?.status === 'ANSWERED') continue
      if (rmcocBlock?.type === 'manual-pr-review') continue // Not a question

      // Classify intent
      const textAfterMention = comment.body.replace(botMention, '').trim()
      const intent = await this.classifyIntent(textAfterMention)

      if (intent === 'question') {
        // Check if this is a follow-up in an existing conversation
        const conversationHistory = await this.getConversationHistory(
          github,
          comment.id
        )

        questions.push({
          type: 'question-answering',
          priority: 2,
          commentId: comment.id,
          question: textAfterMention,
          author: comment.user.login,
          conversationHistory
          // ... rest of context
        })
      }
    }

    return questions
  }

  private async detectReviewRequest(
    context: GitHubContext,
    github: GitHubAPI,
    state: ProcessState
  ): Promise<ReviewTask | null> {
    // Auto review: pull_request events (opened, synchronize, ready_for_review)
    if (context.eventName === 'pull_request') {
      const action = context.payload.action
      if (['opened', 'synchronize', 'ready_for_review'].includes(action)) {
        return {
          type: 'full-review',
          priority: 3,
          isManual: false,
          triggeredBy: action
        }
      }
    }

    // Manual review: @ mention with review request intent
    if (context.eventName === 'issue_comment') {
      const comment = context.payload.comment
      const rmcocBlock = this.extractRmcocBlock(comment.body)

      // Skip if already processed
      if (
        rmcocBlock?.type === 'manual-pr-review' &&
        ['IN_PROGRESS', 'COMPLETED', 'DISMISSED_BY_AUTO_REVIEW'].includes(
          rmcocBlock.status
        )
      ) {
        return null
      }

      const textAfterMention = comment.body
        .replace('@review-my-code-bot', '')
        .trim()
      const intent = await this.classifyIntent(textAfterMention)

      if (intent === 'review-request') {
        return {
          type: 'full-review',
          priority: 3,
          isManual: true,
          triggerCommentId: comment.id,
          triggeredBy: 'manual-request'
        }
      }
    }

    return null
  }

  private async deduplicateAndPrioritize(
    tasks: Task[],
    github: GitHubAPI
  ): Promise<Task[]> {
    const seen = new Set<string>()
    const deduplicated: Task[] = []
    const dismissedManualReviews: string[] = []

    // Check for both manual and auto review
    const hasAutoReview = tasks.some(
      (t) => t.type === 'full-review' && !t.isManual
    )
    const manualReviews = tasks.filter(
      (t) => t.type === 'full-review' && t.isManual
    )

    for (const task of tasks) {
      const key = this.getTaskKey(task)

      // Special handling: dismiss manual reviews if auto review exists
      if (task.type === 'full-review' && task.isManual && hasAutoReview) {
        logger.info(`Dismissing manual review request (handled by auto review)`)

        // Update manual review comment status
        await this.dismissManualReview(github, task.triggerCommentId!)
        dismissedManualReviews.push(task.triggerCommentId!)
        continue // Skip adding to tasks
      }

      if (!seen.has(key)) {
        seen.add(key)
        deduplicated.push(task)
      }
    }

    // Sort by priority (1 = highest)
    return deduplicated.sort((a, b) => a.priority - b.priority)
  }

  private async dismissManualReview(
    github: GitHubAPI,
    commentId: string
  ): Promise<void> {
    const comment = await github.getComment(commentId)

    const rmcocData = {
      type: 'manual-pr-review',
      status: 'DISMISSED_BY_AUTO_REVIEW',
      dismissed_at: new Date().toISOString(),
      dismissed_reason:
        'This review request was handled by an automatic PR review'
    }

    // Update comment with rmcoc block
    const existingBlock = this.extractRmcocBlock(comment.body)
    let updatedBody: string

    if (existingBlock) {
      updatedBody = comment.body.replace(
        /```rmcoc\n.*?\n```/s,
        `\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
      )
    } else {
      updatedBody = `${comment.body}\n\n\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
    }

    await github.updateComment(commentId, updatedBody)

    // Post explanatory reply
    await github.replyToComment(
      commentId,
      `ℹ️ This manual review request was dismissed because an automatic PR review was triggered and handled the review.\n\n` +
        `The review results are available in the review comments above.`
    )
  }

  private getTaskKey(task: Task): string {
    switch (task.type) {
      case 'dispute-resolution':
        return `dispute-${task.threadId}`
      case 'question-answering':
        return `question-${task.commentId}`
      case 'full-review':
        return `review-${task.isManual ? task.triggerCommentId : 'auto'}`
    }
  }

  private async getConversationHistory(
    github: GitHubAPI,
    commentId: string
  ): Promise<ConversationMessage[]> {
    // Get ALL comments in chronological order (not just direct replies)
    // Developers often post follow-ups without tagging
    // Include entire conversation thread for full context

    const allComments = await github.getAllIssueComments()
    const currentComment = allComments.find((c) => c.id === commentId)
    if (!currentComment) return []

    const botUsers = ['github-actions[bot]', 'opencode-reviewer[bot]']
    const conversationMessages: ConversationMessage[] = []

    // Get all comments before current one in chronological order
    const priorComments = allComments
      .filter(
        (c) => new Date(c.created_at) < new Date(currentComment.created_at)
      )
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    // Build conversation (all dev/bot exchanges)
    for (const comment of priorComments) {
      const isBot = botUsers.includes(comment.user.login)

      // Only include messages with @ mention or bot replies
      if (comment.body.includes('@review-my-code-bot') || isBot) {
        conversationMessages.push({
          author: comment.user.login,
          body: comment.body,
          timestamp: comment.created_at,
          isBot
        })
      }
    }

    // No max depth - OpenCode compacts context automatically
    return conversationMessages
  }
}
````

### 3. Execution Orchestrator Refactor

**File**: `src/review/orchestrator.ts` → `src/execution/orchestrator.ts`

**Changes**:

1. **Rename class**: `ReviewOrchestrator` → `ExecutionOrchestrator`
2. **New main entry point**: `executeAllTasks(plan: ExecutionPlan)`
3. **Refactor existing methods** to accept task context as parameters instead of
   reading from config

````typescript
export class ExecutionOrchestrator {
  async executeAllTasks(plan: ExecutionPlan): Promise<ExecutionResult> {
    const results: TaskResult[] = []
    let hasBlockingIssues = false

    for (const task of plan.tasks) {
      logger.info(`Executing task: ${task.type} (priority ${task.priority})`)

      try {
        let result: TaskResult

        switch (task.type) {
          case 'dispute-resolution':
            result = await this.executeDisputeResolution(task)
            break
          case 'question-answering':
            result = await this.executeQuestionAnswering(task)
            break
          case 'full-review':
            result = await this.executeFullReview(task)
            hasBlockingIssues = result.blockingIssues > 0
            break
        }

        results.push(result)

        // Update state after each task
        await this.stateManager.updateTaskStatus(task, 'COMPLETED')
      } catch (error) {
        // Task failed - post error comment and fail the run
        await this.postErrorComment(task, error)
        throw new OrchestratorError(
          `Task ${task.type} failed: ${error.message}`,
          error
        )
      }
    }

    return {
      results,
      hasBlockingIssues,
      totalTasks: plan.tasks.length
    }
  }

  async executeQuestionAnswering(task: QuestionTask): Promise<TaskResult> {
    logger.group(`Answering question from ${task.author}`)

    // Update original comment with IN_PROGRESS status
    if (task.triggerCommentId) {
      await this.updateQuestionStatus(task.triggerCommentId, {
        type: 'question',
        status: 'IN_PROGRESS',
        started_at: new Date().toISOString()
      })
    }

    // Sanitize input
    const sanitizedQuestion = await this.sanitizeExternalInput(
      task.question,
      `question from ${task.author}`
    )

    // Get PR context
    const prContext = await this.github.getPRContext()

    // Build prompt with conversation history if exists
    let prompt: string
    if (task.conversationHistory && task.conversationHistory.length > 0) {
      prompt = PROMPTS.ANSWER_FOLLOWUP_QUESTION(
        sanitizedQuestion,
        task.conversationHistory,
        prContext
      )
    } else {
      prompt = PROMPTS.ANSWER_QUESTION(
        sanitizedQuestion,
        task.author,
        task.fileContext,
        prContext
      )
    }

    // Execute in OpenCode session
    const answer = await this.opencode.sendMessage(prompt)

    // Post answer as reply
    const formattedAnswer = this.formatQuestionAnswer(task, answer)
    await this.github.replyToComment(task.commentId, formattedAnswer)

    // Update original comment with ANSWERED status
    if (task.triggerCommentId) {
      await this.updateQuestionStatus(task.triggerCommentId, {
        type: 'question',
        status: 'ANSWERED',
        started_at: task.startedAt,
        completed_at: new Date().toISOString()
      })
    }

    return {
      type: 'question-answering',
      success: true,
      issuesFound: 0,
      blockingIssues: 0
    }
  }

  async executeFullReview(task: ReviewTask): Promise<TaskResult> {
    logger.group(`Executing ${task.isManual ? 'manual' : 'auto'} PR review`)

    // Update manual review request status if applicable
    if (task.isManual && task.triggerCommentId) {
      await this.updateManualReviewStatus(task.triggerCommentId, {
        type: 'manual-pr-review',
        status: 'IN_PROGRESS',
        started_at: new Date().toISOString()
      })

      if (this.config.execution.manualTriggerComments.enableStartComment) {
        await this.updateTriggerCommentWithProgress(
          task.triggerCommentId,
          'IN_PROGRESS'
        )
      }
    }

    // Load or create state
    this.processState = await this.stateManager.getOrCreateState()

    // Run full 3-pass review
    const result = await this.executeMultiPassReview()

    // Update manual review request status if applicable
    if (task.isManual && task.triggerCommentId) {
      await this.updateManualReviewStatus(task.triggerCommentId, {
        type: 'manual-pr-review',
        status: 'COMPLETED',
        started_at: task.startedAt,
        completed_at: new Date().toISOString()
      })

      if (this.config.execution.manualTriggerComments.enableEndComment) {
        await this.updateTriggerCommentWithProgress(
          task.triggerCommentId,
          'COMPLETED',
          result
        )
      }
    }

    return result
  }

  private async updateQuestionStatus(
    commentId: string,
    rmcocData: QuestionRmcocBlock
  ): Promise<void> {
    const comment = await this.github.getComment(commentId)
    const existingBlock = this.extractRmcocBlock(comment.body)

    let updatedBody: string
    if (existingBlock) {
      // Replace existing block
      updatedBody = comment.body.replace(
        /```rmcoc\n.*?\n```/s,
        `\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
      )
    } else {
      // Append new block
      updatedBody = `${comment.body}\n\n\`\`\`rmcoc\n${JSON.stringify(rmcocData, null, 2)}\n\`\`\``
    }

    await this.github.updateComment(commentId, updatedBody)
  }

  private formatQuestionAnswer(task: QuestionTask, answer: string): string {
    return `**@${task.author}** asked: "${task.question}"

${answer}

---
*Answered by @review-my-code-bot using codebase analysis*

\`\`\`rmcoc
${JSON.stringify(
  {
    reply_to_comment_id: task.commentId,
    type: 'question-answer',
    answered_at: new Date().toISOString()
  },
  null,
  2
)}
\`\`\``
  }
}
````

### 4. Main Entry Point Refactor

**File**: `src/main.ts`

**Changes**:

```typescript
export async function run(): Promise<void> {
  let openCodeServer: OpenCodeServer | null = null
  let trpcServer: TRPCServer | null = null
  let orchestrator: ExecutionOrchestrator | null = null
  let exitCode = 0

  try {
    logger.info('Starting OpenCode PR Reviewer...')

    const config = await parseInputs()
    validateConfig(config)

    logger.info('Setting up OpenCode tools...')
    await setupToolsInWorkspace()

    openCodeServer = new OpenCodeServer(config)
    await openCodeServer.start()

    const github = new GitHubAPI(config)
    const opencode = new OpenCodeClientImpl(...)
    const llmClient = new LLMClientImpl(...)

    orchestrator = new ExecutionOrchestrator(
      opencode,
      llmClient,
      github,
      config,
      workspaceRoot
    )

    trpcServer = new TRPCServer(orchestrator, github, llmClient)
    await trpcServer.start()

    // NEW: Detect all pending tasks
    const taskDetector = new TaskDetector(llmClient)
    const currentState = await orchestrator.stateManager.getOrCreateState()

    const executionPlan = await taskDetector.detectAllTasks(
      github.context,
      github,
      currentState
    )

    logger.info(`Detected ${executionPlan.tasks.length} task(s) to execute`)
    for (const task of executionPlan.tasks) {
      logger.info(`  - ${task.type} (priority ${task.priority})`)
    }

    // Execute all tasks
    const result = await orchestrator.executeAllTasks(executionPlan)

    // Determine exit code based on task types and results
    const hasAutoReview = executionPlan.tasks.some(
      t => t.type === 'full-review' && !t.isManual
    )
    const hasManualReview = executionPlan.tasks.some(
      t => t.type === 'full-review' && t.isManual
    )

    if (hasAutoReview && result.hasBlockingIssues) {
      // Auto review with blocking issues = fail (merge gate)
      core.setFailed(`Review found blocking issues`)
      exitCode = 1
    } else if (hasManualReview && result.hasBlockingIssues) {
      // Manual review with blocking issues = don't fail (just informational)
      logger.warning('Manual review found blocking issues (not failing action)')
      exitCode = 0
    }

    core.setOutput('tasks_executed', String(result.totalTasks))
    core.setOutput('has_blocking_issues', String(result.hasBlockingIssues))

    logger.info('All tasks completed successfully')

  } catch (error) {
    // Legitimate error (network, API, validation, etc.) - fail the action
    if (error instanceof Error) {
      logger.error(error)
      core.setFailed(error.message)
    }
    exitCode = 1
  } finally {
    await cleanup(orchestrator, trpcServer, openCodeServer)
    process.exit(exitCode)
  }
}
```

### 5. Input Configuration Simplification

**File**: `src/config/inputs.ts`

**Changes**:

- Remove `detectExecutionMode()` - no longer needed
- Simplify to just parse inputs and validate
- Let TaskDetector handle event detection

```typescript
export async function parseInputs(): Promise<ReviewConfig> {
  const apiKey = core.getInput('openrouter_api_key', { required: true })
  const model = core.getInput('model', { required: true })
  // ... all other inputs

  const context = github.context
  const owner = context.repo.owner
  const repo = context.repo.repo

  // Get PR number from context
  const prNumber =
    context.payload.pull_request?.number || context.payload.issue?.number

  if (!prNumber) {
    throw new Error('Cannot determine PR number from event context')
  }

  return {
    opencode: { apiKey, model, enableWeb, debugLogging },
    scoring: { problemThreshold, blockingThreshold },
    review: { timeoutMs: reviewTimeoutMinutes * 60 * 1000, maxRetries },
    github: { token: githubToken, owner, repo, prNumber },
    dispute: { enableHumanEscalation, humanReviewers },
    security: { injectionDetectionEnabled, injectionVerificationModel },
    execution: {
      manualTriggerComments: { enableStartComment, enableEndComment }
    }
  }
}
```

### 6. GitHub API Enhancements

**File**: `src/github/api.ts`

**New Methods Needed**:

```typescript
export class GitHubAPI {
  // Existing methods...

  async getAllIssueComments(): Promise<Comment[]> {
    return await this.octokit.paginate(this.octokit.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: this.prNumber,
      per_page: 100
    })
  }

  async hasNewDeveloperReply(threadId: string): Promise<boolean> {
    // Check if there are developer replies after the last bot comment
    const comments = await this.getThreadComments(threadId)
    const botUsers = ['github-actions[bot]', 'opencode-reviewer[bot]']

    const lastBotComment = comments
      .filter((c) => botUsers.includes(c.user.login))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]

    if (!lastBotComment) return false

    const developerRepliesAfter = comments.filter(
      (c) =>
        !botUsers.includes(c.user.login) &&
        new Date(c.created_at) > new Date(lastBotComment.created_at)
    )

    return developerRepliesAfter.length > 0
  }

  async getThreadComments(threadId: string): Promise<Comment[]> {
    // Get all comments in a review thread
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.octokit.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: Number(commentId),
      body
    })
  }

  async replyToComment(commentId: string, body: string): Promise<void> {
    // Same as replyToIssueComment - just alias for clarity
    await this.replyToIssueComment(commentId, body)
  }
}
```

## File Structure Refactor

### Current Structure Issues

1. State management spread across `src/github/state.ts` and review types
2. Orchestration logic mixed with review-specific code
3. No clear separation between task detection, execution, and state tracking

### Proposed New Structure

```
src/
├── config/
│   ├── constants.ts
│   └── inputs.ts (simplified)
├── state/
│   ├── types.ts (NEW - all state-related types)
│   ├── manager.ts (RENAMED from src/github/state.ts)
│   └── serializer.ts (NEW - rmcoc block parsing/generation)
├── task/
│   ├── types.ts (NEW - task-related types)
│   ├── detector.ts (NEW - task detection logic)
│   └── classifier.ts (MOVED from src/utils/intent-classifier.ts)
├── execution/
│   ├── orchestrator.ts (RENAMED from src/review/orchestrator.ts)
│   ├── prompts.ts (MOVED from src/review/prompts.ts)
│   └── types.ts (MOVED from src/review/types.ts, cleaned up)
├── github/
│   ├── api.ts (enhanced with new methods)
│   └── types.ts (GitHub-specific types)
├── opencode/
│   ├── client.ts
│   ├── llm-client.ts
│   ├── server.ts
│   └── tool/ (existing tools)
├── trpc/
│   └── (existing structure)
├── utils/
│   ├── errors.ts
│   ├── logger.ts
│   ├── security.ts
│   └── prompt-injection-detector.ts
├── setup/
│   └── tools.ts
├── main.ts (refactored entry point)
└── wait.ts
```

## rmcoc Block Schema

### For Questions

**Original Developer Comment** (updated during execution):

```json
{
  "type": "question",
  "status": "PENDING" | "IN_PROGRESS" | "ANSWERED",
  "started_at": "2025-12-27T10:00:00Z",
  "completed_at": "2025-12-27T10:05:00Z"
}
```

**Bot's Answer Comment**:

```json
{
  "type": "question-answer",
  "reply_to_comment_id": "123456",
  "answered_at": "2025-12-27T10:05:00Z"
}
```

### For Manual PR Reviews

**Original Developer Comment** (updated during execution):

```json
{
  "type": "manual-pr-review",
  "status": "PENDING" | "IN_PROGRESS" | "COMPLETED" | "DISMISSED_BY_AUTO_REVIEW",
  "started_at": "2025-12-27T10:00:00Z",
  "completed_at": "2025-12-27T10:30:00Z",
  "dismissed_by": "auto-pr-review" // if dismissed
}
```

### For Review Findings (existing schema, same usage)

**Bot's Review Comment** (initial finding):

```json
{
  "type": "review-finding",
  "status": "PENDING",
  "assessment": {
    "finding": "...",
    "assessment": "...",
    "score": 7
  },
  "created_at": "2025-12-27T10:00:00Z"
}
```

### For Dispute Resolution (CRITICAL: Always use rmcoc blocks)

**Bot's Dispute Resolution Reply** (REQUIRED - never use raw text for state):

```json
{
  "type": "dispute-resolution",
  "reply_to_thread_id": "original-finding-comment-id",
  "status": "RESOLVED" | "DISPUTED" | "ESCALATED",
  "resolution": "concession" | "maintained" | "escalated",
  "resolved_at": "2025-12-27T10:10:00Z",
  "reason": "Developer's fix addresses the issue" // human-readable explanation
}
```

**Important**: State management must ONLY use rmcoc blocks to determine dispute
status. Never parse raw comment text for status detection. This ensures:

- Idempotent state detection
- No false positives from conversational language
- Structured data for reliable querying

## Workflow Configuration

### Single Workflow

**File**: `.github/workflows/pr-review.yml`

```yaml
name: OpenCode PR Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

  issue_comment:
    types: [created]

  pull_request_review_comment:
    types: [created]

concurrency:
  group: pr-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    name: OpenCode PR Review
    if: |
      (github.event_name == 'pull_request' && !github.event.pull_request.draft) ||
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request && 
       contains(github.event.comment.body, '@review-my-code-bot')) ||
      (github.event_name == 'pull_request_review_comment' &&
       github.event.comment.in_reply_to_id != '')

    runs-on: ubuntu-latest

    permissions:
      pull-requests: write
      contents: read
      issues: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || '' }}

      - name: Checkout PR head for comment events
        if:
          github.event_name == 'issue_comment' || github.event_name ==
          'pull_request_review_comment'
        run: |
          gh pr checkout ${{ github.event.issue.number || github.event.pull_request.number }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Run OpenCode PR Reviewer
        uses: ./
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # ... rest of inputs
```

## Implementation Phases

### Phase 1: Foundation (No Breaking Changes)

**Goal**: Set up new structure without breaking existing functionality

1. Create new directory structure (`state/`, `task/`, `execution/`)
2. Create new type files with comprehensive types
3. Implement `TaskDetector` class with all detection logic
4. Implement `rmcoc` block serializer/parser
5. Add new GitHub API methods
6. **Testing**: Ensure existing functionality still works

**Files Created**:

- `src/state/types.ts`
- `src/state/serializer.ts`
- `src/task/types.ts`
- `src/task/detector.ts`
- `src/task/classifier.ts` (move from utils)

**Files Modified**:

- `src/github/api.ts` (add new methods)

**Estimated Effort**: 4-6 hours

### Phase 2: State Management Refactor

**Goal**: Migrate from ReviewState to ProcessState

1. Rename and refactor `StateManager`
2. Update state schema to track all task types
3. Migrate state loading/saving to new format
4. Update all state references throughout codebase
5. **Testing**: State persistence works correctly

**Files Renamed**:

- `src/github/state.ts` → `src/state/manager.ts`

**Files Modified**:

- `src/state/manager.ts` (comprehensive refactor)
- All files importing StateManager

**Estimated Effort**: 3-4 hours

### Phase 3: Orchestrator Refactor

**Goal**: Migrate from ReviewOrchestrator to ExecutionOrchestrator

1. Rename orchestrator file and class
2. Refactor `executeQuestionAnswering()` to accept task parameter
3. Refactor `executeDisputeResolution()` to accept task parameter
4. Refactor `executeReview()` to accept task parameter
5. Implement `executeAllTasks()` main loop
6. Add error handling and status updates
7. **Testing**: Each task type executes correctly

**Files Renamed**:

- `src/review/orchestrator.ts` → `src/execution/orchestrator.ts`
- `src/review/prompts.ts` → `src/execution/prompts.ts`
- `src/review/types.ts` → `src/execution/types.ts`

**Files Modified**:

- `src/execution/orchestrator.ts` (major refactor)
- All files importing orchestrator

**Estimated Effort**: 6-8 hours

### Phase 4: Main Entry Point

**Goal**: Wire everything together

1. Refactor `src/config/inputs.ts` (remove mode detection)
2. Refactor `src/main.ts` to use new TaskDetector + ExecutionOrchestrator
3. Implement proper exit code logic
4. Add comprehensive logging
5. **Testing**: End-to-end flow works

**Files Modified**:

- `src/config/inputs.ts`
- `src/main.ts`

**Estimated Effort**: 2-3 hours

### Phase 5: Workflow Cleanup

**Goal**: Clean up workflow files

1. Update main workflow to single file
2. Remove separate workflow files (auto-pr-review, bot-mentions,
   dispute-resolution)
3. Update documentation
4. **Testing**: Workflow triggers correctly

**Files Modified**:

- `.github/workflows/pr-review.yml`

**Files Removed**:

- `.github/workflows/auto-pr-review.yml`
- `.github/workflows/bot-mentions.yml`
- `.github/workflows/dispute-resolution.yml`

**Estimated Effort**: 1 hour

### Phase 6: Integration Testing

**Goal**: Comprehensive testing of all scenarios

1. Test multiple questions posted rapidly
2. Test multiple disputes posted rapidly
3. Test question + dispute + review in one run
4. Test manual review request dismissed by auto review
5. Test conversation history for follow-up questions
6. Test exit codes for auto vs manual reviews
7. Test error handling and failure comments
8. **Validation**: All scenarios work correctly

**Estimated Effort**: 4-5 hours

## Total Estimated Effort

**20-27 hours** of focused development time

## Risks & Mitigations

### Risk 1: Complexity Explosion

**Risk**: Refactor introduces too much complexity **Mitigation**:

- Incremental phases with testing after each
- Keep existing logic as much as possible
- Clear separation of concerns

### Risk 2: State Corruption

**Risk**: Migration breaks existing PR state **Mitigation**:

- No backwards compatibility needed (unreleased)
- Comprehensive state validation
- Fallback to empty state if parsing fails

### Risk 3: Race Conditions

**Risk**: Multiple tasks updating same state **Mitigation**:

- Sequential execution (no parallelism)
- State updates atomic per task
- Single OpenCode session maintains consistency

### Risk 4: Performance Degradation

**Risk**: Scanning all tasks on every run is slow **Mitigation**:

- Use GitHub API pagination efficiently
- Cache comment lookups
- Parallel API calls where safe
- Single session reuses context (saves tokens)

### Risk 5: Rate Limit Exhaustion

**Risk**: Many pending tasks could exhaust GitHub API or LLM rate limits
**Mitigation**:

- Initial implementation: No rate limiting (process all tasks)
- Design allows future rate limiting via task filtering in `TaskDetector`
- Future rate limit strategy options:
  - Cap total tasks per run (e.g., max 10 questions)
  - Priority-based processing (ensure disputes always processed)
  - Backoff and retry on rate limit errors
  - Queue overflow tasks for next run
- Leave extensibility point in `detectAllTasks()`:
  ```typescript
  async detectAllTasks(
    context: GitHubContext,
    github: GitHubAPI,
    currentState: ProcessState,
    options?: { maxTasks?: number } // Future: rate limiting
  ): Promise<ExecutionPlan>
  ```

## Success Criteria

1. ✅ Developer posts 3 questions rapidly → All 3 answered
2. ✅ Developer posts 2 disputes rapidly → Both resolved
3. ✅ Question asked + PR ready → Question answered first, then review
4. ✅ Manual review requested + auto review triggers → Review runs once, manual
   request marked dismissed with comment
5. ✅ Follow-up question → Previous conversation (all comments) used as context
6. ✅ Auto review with blocking issues → Exit code 1 (merge blocked)
7. ✅ Manual review with blocking issues → Exit code 0 (informational only)
8. ✅ **Cancelled auto review + question** → Both execute, exit code 1 if
   blocking issues (merge gate preserved)
9. ✅ Network error → Exit code 1, error comment posted
10. ✅ All tasks tracked via rmcoc blocks (no raw text parsing)
11. ✅ No duplicate work (proper deduplication)
12. ✅ Dispute resolution uses only rmcoc blocks for state (never raw text)

## Questions Resolved

1. **Conversation history**: ✅ Consider ALL replies/comments in the thread, not
   just direct replies. Developers often post follow-ups without tagging.

2. **Dismissed manual reviews**: ✅ Update `status` to
   `DISMISSED_BY_AUTO_REVIEW` and post a comment explaining it was handled by
   auto review.

3. **Max conversation depth**: ✅ No limit - OpenCode will compact context
   automatically.

4. **Dispute rmcoc blocks**: ✅ Always add `rmcoc` blocks to dispute resolution
   replies. Never handle raw text to decide state.

5. **Rate limiting**: ✅ No rate limiting initially, but design must allow for
   future implementation.

6. **Cancelled auto reviews**: ✅ If auto review is cancelled by @ question,
   restart it. Maintain merge gate behavior using state tracking (see "Merge
   Gate Preservation" section below).

## Merge Gate Preservation

### Problem

When an auto review is cancelled (e.g., by @ question), the restarted review
must still fail the action if blocking issues are found, even though the
triggering event is not a PR event.

### Solution: Track Auto Review Triggers in State

```typescript
type ProcessMetadata = {
  lastUpdated: string
  prNumber: number
  passesCompleted: number[]
  autoReviewTrigger?: {
    triggeredAt: string
    action: 'opened' | 'synchronize' | 'ready_for_review'
    sha: string
    cancelled: boolean
    completedAt?: string
  }
}
```

### Detection Logic

```typescript
// In TaskDetector.detectReviewRequest()

// Check for cancelled auto review
const currentSHA = await github.getCurrentSHA()
if (
  state.metadata.autoReviewTrigger &&
  !state.metadata.autoReviewTrigger.cancelled &&
  !state.metadata.autoReviewTrigger.completedAt &&
  state.metadata.autoReviewTrigger.sha === currentSHA
) {
  logger.info('Detected cancelled auto review - will restart')

  // Mark as cancelled
  state.metadata.autoReviewTrigger.cancelled = true

  // Add review task
  return {
    type: 'full-review',
    priority: 3,
    isManual: false,
    triggeredBy: state.metadata.autoReviewTrigger.action,
    resumingCancelled: true
  }
}

// Record new auto review trigger
if (context.eventName === 'pull_request') {
  const action = context.payload.action
  if (['opened', 'synchronize', 'ready_for_review'].includes(action)) {
    await state.updateMetadata({
      autoReviewTrigger: {
        triggeredAt: new Date().toISOString(),
        action,
        sha: currentSHA,
        cancelled: false
      }
    })

    return {
      type: 'full-review',
      priority: 3,
      isManual: false,
      triggeredBy: action
    }
  }
}
```

### Exit Code Logic

```typescript
// In main.ts after tasks execute

const wasAutoTriggered = await orchestrator.wasAutoReviewTriggered()

if (wasAutoTriggered && result.hasBlockingIssues) {
  // Auto review (original or restarted) with blocking issues = fail
  core.setFailed('Review found blocking issues')
  exitCode = 1
} else if (!wasAutoTriggered && result.hasBlockingIssues) {
  // Manual review with blocking issues = don't fail
  logger.warning('Manual review found blocking issues (not failing action)')
  exitCode = 0
}

// Clear auto review trigger after completion
if (result.reviewCompleted) {
  await orchestrator.clearAutoReviewTrigger()
}
```

### Example Scenario

```
Timeline:
t=0s:   PR synchronized (new commit abc123)
        → state.autoReviewTrigger = { action: 'synchronize', sha: 'abc123', cancelled: false }
        → Auto review starts

t=5s:   Developer posts @ question
        → Concurrency: run #1 cancelled
        → Run #2 starts

t=6s:   TaskDetector in run #2:
        → Detects autoReviewTrigger.cancelled = false, sha = abc123 (matches current)
        → Sets cancelled = true
        → Adds tasks: [Question (priority 2), Auto Review (priority 3)]

t=7s:   Execute question → Answer posted

t=8s:   Execute auto review → Finds 2 blocking issues

t=30s:  Review completes
        → Check: wasAutoTriggered = true (action='synchronize')
        → hasBlockingIssues = true
        → Result: exit code 1 → MERGE BLOCKED ✅
```

### Edge Cases

1. **Multiple synchronize events**: Only track latest SHA. Old reviews for
   different SHAs are abandoned.
2. **Manual + Auto together**: Both execute, only auto affects exit code.
3. **Auto completes, then new synchronize**: Old trigger cleared, new one
   recorded.
