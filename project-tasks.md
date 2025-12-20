# OpenCode PR Reviewer Agent - Implementation Tasks

## Project Overview

This project implements an AI-powered code review agent for GitHub Pull Requests
using the OpenCode SDK. The agent performs multi-pass reviews with contextual
awareness, stateful memory across commits, and configurable severity thresholds.

---

## Phase 1: Infrastructure & Configuration Setup

### Task 1.1: Update Action Metadata and Inputs

**Objective:** Configure the GitHub Action with proper inputs, outputs, and
metadata.

**Changes Required:**

- Update `action.yml` with proper branding, description, and inputs
- Define configuration inputs for OpenCode API key, model selection, thresholds,
  etc.
- Remove template placeholders

**Technical Details:** Required inputs in `action.yml`:

```yaml
inputs:
  opencode_api_key:
    description: 'API key for OpenCode SDK'
    required: true
  model:
    description: 'LLM model to use (e.g., google/gemini-flash-1.5)'
    required: false
    default: 'google/gemini-flash-1.5'
  problem_score_threshold:
    description: 'Minimum score (1-10) for reporting issues'
    required: false
    default: '5'
  score_elevation_threshold:
    description: 'Number of low-score issues to elevate collectively'
    required: false
    default: '5'
  enable_web:
    description: 'Enable web search and fetch capabilities'
    required: false
    default: 'false'
  github_token:
    description: 'GitHub token for API access'
    required: true
    default: ${{ github.token }}
```

**Acceptance Criteria:**

- [ ] `action.yml` contains all required inputs with proper defaults
- [ ] Action metadata (name, description, branding) is updated
- [ ] Inputs are properly typed and documented
- [ ] GitHub token is configured for API access

**Files to Modify:**

- `action.yml`

---

### Task 1.2: Initialize TypeScript Project Structure

**Objective:** Set up the TypeScript project structure with proper modules and
dependencies.

**Changes Required:**

- Install required dependencies (`@actions/cache`, `@actions/github`,
  `@octokit/rest`)
- Create module structure under `src/`
- Set up TypeScript configuration for the new modules

**Technical Details:** New directory structure:

```
src/
├── index.ts                    # Entry point
├── main.ts                     # Main action logic
├── config/
│   └── inputs.ts              # Input parsing and validation
├── opencode/
│   ├── server.ts              # OpenCode server lifecycle management
│   ├── client.ts              # OpenCode SDK client wrapper
│   └── tools.ts               # Custom tool implementations
├── github/
│   ├── api.ts                 # GitHub API wrapper
│   ├── comments.ts            # Comment management
│   └── state.ts               # State management with cache
├── review/
│   ├── orchestrator.ts        # Multi-pass review orchestrator
│   ├── prompts.ts             # System prompts for each pass
│   └── types.ts               # Type definitions
└── utils/
    ├── logger.ts              # Logging utilities
    └── errors.ts              # Error handling
```

Dependencies to add:

```json
{
  "@actions/cache": "^3.2.4",
  "@actions/github": "^6.0.0",
  "@octokit/rest": "^20.0.2",
  "opencode-sdk": "latest"
}
```

**Acceptance Criteria:**

- [ ] All dependencies are installed
- [ ] Directory structure is created
- [ ] TypeScript compiles without errors
- [ ] Module exports are properly configured

**Files to Create:**

- All files in the structure above (initially as stubs)

**Files to Modify:**

- `package.json` (add dependencies)
- `tsconfig.json` (if needed for module resolution)

---

### Task 1.3: Implement Configuration Parser

**Objective:** Parse and validate GitHub Action inputs into a typed
configuration object.

**Changes Required:**

- Create configuration types
- Implement input parsing with validation
- Handle environment variables and defaults

**Technical Details:** Configuration interface:

```typescript
export interface ReviewConfig {
  opencode: {
    apiKey: string
    model: string
    enableWeb: boolean
  }
  scoring: {
    problemThreshold: number // 1-10
    elevationThreshold: number // Number of issues to elevate
  }
  github: {
    token: string
    owner: string
    repo: string
    prNumber: number
  }
}
```

Implementation should:

- Use `@actions/core.getInput()` for all inputs
- Validate numeric thresholds are within valid ranges
- Extract PR context from GitHub event payload
- Throw descriptive errors for invalid configuration

**Acceptance Criteria:**

- [ ] Configuration is parsed from action inputs
- [ ] Validation catches invalid values with clear error messages
- [ ] PR context (owner, repo, number) is extracted from event
- [ ] Configuration object is properly typed
- [ ] Unit tests cover validation logic

**Files to Create:**

- `src/config/inputs.ts`
- `src/review/types.ts`

**Files to Modify:**

- None

---

## Phase 2: OpenCode Server Integration

### Task 2.1: Implement OpenCode Server Lifecycle Manager

**Objective:** Create a service to start, configure, and stop the OpenCode
server within the GitHub Actions runner.

**Changes Required:**

- Implement server initialization with security constraints
- Configure read-only mode (disable file_write and shell_execute)
- Handle server lifecycle (start, health check, stop)
- Manage server process cleanup on action exit

**Technical Details:** Server configuration must include:

```typescript
{
  security: {
    readOnly: true,
    disableFileWrite: true,
    disableShellExecute: true
  },
  tools: {
    enableWeb: config.opencode.enableWeb
  }
}
```

Server manager should:

- Start OpenCode server as a child process
- Wait for server to be ready (health check endpoint)
- Provide graceful shutdown on action completion or error
- Log server output for debugging
- Handle server crashes with retries

**Acceptance Criteria:**

- [ ] Server starts successfully in the runner environment
- [ ] Read-only mode is enforced (file writes are blocked)
- [ ] Server health check passes before proceeding
- [ ] Server shuts down gracefully on action completion
- [ ] Error handling covers server startup failures
- [ ] Server logs are captured for debugging

**Files to Create:**

- `src/opencode/server.ts`

**Files to Modify:**

- None

---

### Task 2.2: Implement OpenCode Client Wrapper

**Objective:** Create a client wrapper for the OpenCode SDK with custom tool
registration.

**Changes Required:**

- Initialize OpenCode SDK client
- Register custom GitHub interaction tools
- Configure agent with system prompts
- Handle SDK errors and retries

**Technical Details:** Client should provide:

```typescript
export class OpenCodeClient {
  async initialize(): Promise<void>
  async registerTools(tools: Tool[]): Promise<void>
  async executeReview(prompt: string): Promise<ReviewResult>
  async dispose(): Promise<void>
}
```

Custom tools to register:

- `github_get_run_state()` - Retrieve review state
- `github_post_review_comment()` - Post new comments with scoring
- `github_reply_to_thread()` - Reply to existing threads
- `github_resolve_thread()` - Resolve comment threads
- `submit_pass_results()` - Mark review pass completion

**Acceptance Criteria:**

- [ ] SDK client connects to the server
- [ ] Custom tools are registered successfully
- [ ] Agent can execute prompts with tool access
- [ ] Tool calls are properly handled and routed
- [ ] Error handling covers SDK failures
- [ ] Client cleanup is handled properly

**Files to Create:**

- `src/opencode/client.ts`

**Files to Modify:**

- None

---

### Task 2.3: Implement Custom GitHub Tools for OpenCode Agent

**Objective:** Create the custom tools that allow the OpenCode agent to interact
with GitHub and manage review state.

**Changes Required:**

- Implement all 5 custom GitHub tools
- Add scoring filter logic to comment tool
- Integrate state management with tools
- Add side-effect handling for state updates

**Technical Details:**

Tool implementations with signatures from project description:

1. **`github_get_run_state()`**
   - Retrieves state from GitHub Cache or rebuilds from comments
   - Returns threads with status (PENDING/RESOLVED/DISPUTED)
   - Includes developer replies in thread history

2. **`github_post_review_comment(file, line, body, assessment)`**
   - Accepts assessment JSON with score (1-10)
   - Filters comments below `problem_score_threshold`
   - Posts to GitHub PR review comments API
   - Triggers state update side-effect
   - Returns thread_id

3. **`github_reply_to_thread(thread_id, body, is_concession)`**
   - Replies to existing comment thread
   - Marks concessions for state tracking
   - Triggers state update side-effect

4. **`github_resolve_thread(thread_id, reason)`**
   - Resolves comment thread
   - Records resolution reason
   - Triggers state update side-effect

5. **`submit_pass_results(pass_number, summary, has_blocking_issues)`**
   - Marks review pass as complete
   - Stores pass summary in state
   - Signals orchestrator to continue to next pass

Each tool should:

- Have comprehensive JSDoc documentation
- Include parameter validation
- Handle GitHub API errors gracefully
- Log tool invocations for debugging

**Acceptance Criteria:**

- [ ] All 5 tools are implemented and working
- [ ] Comment filtering by score threshold works correctly
- [ ] State updates are triggered on relevant tool calls
- [ ] Tools handle GitHub API errors appropriately
- [ ] Tool documentation is clear and complete
- [ ] Unit tests cover tool logic

**Files to Create:**

- `src/opencode/tools.ts`

**Files to Modify:**

- None

---

## Phase 3: GitHub State Management

### Task 3.1: Implement GitHub Cache Integration

**Objective:** Implement state persistence using GitHub Actions cache API.

**Changes Required:**

- Create state serialization/deserialization
- Implement cache save and restore logic
- Handle cache misses and evictions
- Define state schema

**Technical Details:**

State schema:

```typescript
interface ReviewState {
  version: number // Schema version for migration support
  prNumber: number
  lastCommitSha: string
  threads: Array<{
    id: string
    file: string
    line: number
    status: 'PENDING' | 'RESOLVED' | 'DISPUTED'
    score: number
    assessment: {
      finding: string
      assessment: string
      score: number
    }
    original_comment: {
      author: string
      body: string
      timestamp: string
    }
  }>
  passes: Array<{
    number: number
    summary: string
    completed: boolean
    has_blocking_issues: boolean
  }>
  metadata: {
    created_at: string
    updated_at: string
  }
}
```

**Important:** The state stores only the agent's original review comments, NOT
developer replies. Developer responses and code changes are reconciled during
the re-review process, not stored in cached state.

Cache key format: `v1-pr-review-state-${owner}-${repo}-${prNumber}`

Implementation should:

- Use `@actions/cache` for state persistence
- Save state after each tool invocation that modifies it
- Restore state at action startup
- Handle cache eviction by rebuilding from GitHub comments
- Include cache versioning for schema changes

**Acceptance Criteria:**

- [ ] State saves successfully to GitHub Cache
- [ ] State restores correctly on subsequent runs
- [ ] Cache keys are unique per PR
- [ ] Cache misses trigger state rebuild from comments
- [ ] State schema is versioned
- [ ] Error handling covers cache failures

**Files to Create:**

- `src/github/state.ts`

**Files to Modify:**

- None

---

### Task 3.2: Implement State Rebuild from GitHub Comments

**Objective:** Rebuild review state from existing GitHub PR comments when cache
is unavailable.

**Changes Required:**

- Fetch all review comments from GitHub API (agent comments only, skip replies)
- Parse comment bodies to extract embedded assessment JSON blocks
- Reconstruct thread structure from agent's original comments
- Set all thread status to 'PENDING' (reconciliation happens during re-review)

**Technical Details:**

**CRITICAL: Comment Format Requirements**

All agent review comments MUST include an embedded JSON assessment block to
enable state reconstruction:

````markdown
[Human-readable explanation of the issue]

```json
{
  "finding": "Brief description of what was found",
  "assessment": "Detailed analysis of why this is an issue",
  "score": 7
}
```
````

[Optional: Additional context, examples, or suggestions]

````

**JSON Schema:**

- `finding` (string, required): Concise one-sentence description
- `assessment` (string, required): Detailed explanation and impact
- `score` (number, required): Severity score 1-10 per rubric

**State Rebuild Algorithm:**

1. Fetch all PR review comments via GitHub API
2. Filter to include only top-level comments (skip `in_reply_to_id`)
3. For each comment:
   - Extract JSON assessment block using regex:
     `/```json\s*(\{[\s\S]*?\})\s*```/`
   - Parse JSON to get finding, assessment, score
   - Skip comments with:
     - No valid JSON assessment
     - Default score (5)
     - Missing finding field
4. Create ReviewThread with:
   - `id`: GitHub comment ID
   - `status`: Always 'PENDING' (reconciliation in re-review)
   - `original_comment`: Store agent's comment only
   - No developer replies (those are handled during reconciliation)
5. Save reconstructed state to cache

**Fallback Behavior:**

If JSON block is missing or malformed:

- `finding`: "Unknown issue"
- `assessment`: First 200 chars of comment body
- `score`: 5 (defaults to threshold, usually excluded)

**Acceptance Criteria:**

- [x] State can be fully rebuilt from agent's GitHub comments only
- [x] JSON assessment blocks are correctly parsed from markdown code blocks
- [x] Comments without valid JSON assessment use fallback values
- [x] Comments with score=5 or missing findings are excluded (non-review
      comments)
- [x] Thread status is always 'PENDING' on rebuild
- [x] Developer replies are NOT included in rebuilt state
- [x] Rebuild validates JSON schema before accepting
- [x] State includes version field for migration support

**Files to Create:**

- None (extend `src/github/state.ts`)

**Files to Modify:**

- `src/github/state.ts`

---

### Task 3.3: Implement GitHub API Wrapper

**Objective:** Create a clean wrapper around Octokit for GitHub PR operations.

**Changes Required:**

- Initialize Octokit client with authentication
- Implement PR data fetching (diff, files, metadata)
- Implement comment CRUD operations
- Handle pagination and rate limiting

**Technical Details:**

API wrapper should provide:

```typescript
export class GitHubAPI {
  // PR data
  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PR>
  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PRFile[]>
  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string>

  // Comments
  async listReviewComments(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<Comment[]>
  async createReviewComment(params: CreateCommentParams): Promise<Comment>
  async replyToComment(commentId: number, body: string): Promise<Comment>
  async resolveThread(commentId: number): Promise<void>

  // Files
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string>
  async fileExists(owner: string, repo: string, path: string): Promise<boolean>
}
````

Implementation should:

- Handle GitHub API rate limiting with exponential backoff
- Paginate through all results for large PRs
- Provide clear error messages for API failures
- Cache frequently accessed data (PR metadata, AGENTS.md)
- Support both REST and GraphQL where appropriate

**Acceptance Criteria:**

- [ ] Can fetch PR metadata, files, and diffs
- [ ] Comment operations work correctly
- [ ] Pagination handles large PRs
- [ ] Rate limiting is handled gracefully
- [ ] Errors include helpful debugging information
- [ ] API responses are properly typed

**Files to Create:**

- `src/github/api.ts`

**Files to Modify:**

- None

---

### Task 3.4: Implement Comment Formatting with Embedded Assessment

**Objective:** Ensure all agent review comments include embedded JSON assessment
blocks for state reconstruction.

**Changes Required:**

- Create comment formatter that combines body + assessment
- Embed JSON block in markdown code fence
- Validate JSON schema before posting
- Document format requirements for future maintainers

**Technical Details:**

The `github_post_review_comment()` tool implementation must format comments as:

```typescript
function formatReviewComment(
  body: string,
  assessment: { finding: string; assessment: string; score: number }
): string {
  return `${body}

\`\`\`json
${JSON.stringify(assessment, null, 2)}
\`\`\`
`
}
```

**Example Output:**

````markdown
This function has a potential race condition when accessing shared state without
proper synchronization. Multiple concurrent calls could lead to data corruption.

Consider using a mutex or atomic operations to protect the critical section.

```json
{
  "finding": "Race condition in shared state access",
  "assessment": "Function accesses shared state without synchronization, risking
data corruption in concurrent scenarios",
  "score": 8
}
```
````

```

**Validation Requirements:**

Before posting, validate that:

1. Assessment object has all required fields (finding, assessment, score)
2. Score is a number between 1-10
3. Finding and assessment are non-empty strings
4. JSON can be successfully parsed from the formatted comment

**Acceptance Criteria:**

- [ ] Comment formatter combines body and assessment correctly
- [ ] JSON block is properly formatted in markdown code fence
- [ ] Validation rejects invalid assessments before posting
- [ ] Formatted comments can be successfully parsed during state rebuild
- [ ] Documentation includes examples of valid comment format

**Files to Create:**

- `src/github/comments.ts`

**Files to Modify:**

- None

---

## Phase 4: Review Orchestration & Multi-Pass Logic

### Task 4.1: Implement Review Pass System Prompts

**Objective:** Create the system prompts for each of the 4 review passes.

**Changes Required:**

- Create comprehensive system prompt with scoring rubric
- Define pass-specific prompts for each review phase
- Include AGENTS.md content in prompts (if exists)
- Add context about PR structure and goals

**Technical Details:**

System prompt should include:

- Complete 1-10 scoring rubric from project description
- Tool usage guidelines
- Output format requirements (assessment JSON)
- Security audit guidelines
- Proportionality rules for refactoring suggestions

Pass-specific prompts:

**Pass 1: Atomic Diff Review**

```

You are conducting Pass 1 of 4 in a multi-pass code review.

Goal: Review each changed line in isolation. Focus on:

- Syntax errors and typos
- Obvious logic errors
- Code style violations
- Local performance issues

Do NOT suggest architectural changes in this pass.

Files changed: [list] Diff: [diff content]

```

**Pass 2: Structural/Layered Review**

```

You are conducting Pass 2 of 4 in a multi-pass code review.

Goal: Understand how changes fit into the broader codebase. Use read/grep/glob
tools to:

- Trace function call chains
- Verify interface contracts
- Check for unused imports/exports
- Identify inconsistencies with similar patterns

Previous pass findings: [Pass 1 summary]

```

**Pass 3: Security & AGENTS.md Compliance**

```

You are conducting Pass 3 of 4 in a multi-pass code review.

Goal: Security audit and rule enforcement:

- Access control issues
- Data integrity risks
- AGENTS.md violations (if file exists)
- Architectural standards

Security sensitivity: [determined from package.json/README] AGENTS.md content:
[content if exists, or "Not found"]

```

**Pass 4: Consolidation & Noise Reduction**

```

You are conducting Pass 4 of 4 in a multi-pass code review.

Goal: Final review of all findings:

- Remove redundant comments
- Combine related issues
- Verify score accuracy
- Ensure proportionality of suggestions

All findings from passes 1-3: [consolidated list]

Submit only high-confidence, high-value feedback.

```

**Acceptance Criteria:**

- [ ] System prompt includes complete scoring rubric
- [ ] All 4 pass prompts are defined
- [ ] Prompts guide the agent appropriately for each phase
- [ ] AGENTS.md content is included when available
- [ ] Security sensitivity is determined from repo metadata
- [ ] Prompts are clear and actionable

**Files to Create:**

- `src/review/prompts.ts`

**Files to Modify:**

- None

---

### Task 4.2: Implement Review Orchestrator

**Objective:** Create the orchestrator that manages the 4-pass review workflow
within a single OpenCode session.

**Changes Required:**

- Implement sequential pass execution
- Manage context between passes
- Handle pass completion and transitions
- Aggregate results across passes

**Technical Details:**

Orchestrator responsibilities:

1. Initialize OpenCode session with system prompt
2. Execute Pass 1 with diff context
3. Wait for `submit_pass_results()` tool call
4. Execute Pass 2 with Pass 1 summary
5. Wait for `submit_pass_results()` tool call
6. Execute Pass 3 with security context and AGENTS.md
7. Wait for `submit_pass_results()` tool call
8. Execute Pass 4 with all previous findings
9. Wait for `submit_pass_results()` tool call
10. Generate final review summary

Context management:

- All passes run in same OpenCode session (no state resets)
- Pass summaries are accumulated and passed to subsequent passes
- OpenCode manages its own file context
- State is preserved across passes via OpenCode's internal mechanisms

Error handling:

- If a pass fails, retry once before failing the action
- If agent doesn't call `submit_pass_results()`, timeout after 10 minutes
- Log detailed information about each pass for debugging

**Acceptance Criteria:**

- [ ] All 4 passes execute sequentially
- [ ] Context flows correctly between passes
- [ ] Pass completion is detected via tool call
- [ ] Timeouts prevent infinite loops
- [ ] Errors in one pass don't crash entire review
- [ ] Final summary includes all pass results
- [ ] Detailed logging tracks progress

**Files to Create:**

- `src/review/orchestrator.ts`

**Files to Modify:**

- None

---

### Task 4.3: Implement Fix Verification on Subsequent Commits

**Objective:** When new commits are pushed to the PR, verify if previous issues
were addressed.

**Changes Required:**

- Load previous review state
- Compare new code against pending issues
- Auto-resolve threads when fixes are detected
- Re-raise issues that remain unaddressed

**Technical Details:**

Verification logic:

1. Load state from cache (contains previous issues)
2. For each PENDING or DISPUTED thread:
   - Check if the file/line still exists in new commit
   - Use OpenCode to analyze if the issue still applies
   - If fixed, call `github_resolve_thread()` with explanation
   - If still present, add follow-up comment
3. Run full 4-pass review on new changes only
4. Cross-reference new findings with old state to avoid duplicates

Agent should receive context:

```

Previous review state:

- 5 issues were raised in the last review
- 2 are marked as DISPUTED
- 3 are PENDING

Your task for this review:

1. Verify if any of the 5 previous issues are now fixed
2. Review the new changes (commits: abc123..def456)
3. Do not re-raise issues that are already tracked

````

**Acceptance Criteria:**

- [ ] Previous issues are loaded from state
- [ ] Agent verifies each previous issue
- [ ] Fixed issues are auto-resolved with explanation
- [ ] Unfixed issues are followed up
- [ ] New review doesn't duplicate existing issues
- [ ] Cross-file fixes are detected

**Files to Create:**

- None (extend `src/review/orchestrator.ts`)

**Files to Modify:**

- `src/review/orchestrator.ts`

---

## Phase 5: Main Action Implementation

### Task 5.1: Implement Main Action Entry Point

**Objective:** Tie all components together in the main action logic.

**Changes Required:**

- Parse configuration
- Initialize GitHub API client
- Start OpenCode server
- Load/restore review state
- Execute review orchestrator
- Handle cleanup and errors

**Technical Details:**

Main flow:

```typescript
export async function run(): Promise<void> {
  try {
    // 1. Parse configuration
    const config = await parseInputs()

    // 2. Initialize GitHub API
    const github = new GitHubAPI(config.github.token)

    // 3. Validate this is a PR event
    if (!github.isPullRequestEvent()) {
      core.info('Not a pull request event, skipping review')
      return
    }

    // 4. Start OpenCode server
    const server = new OpenCodeServer(config.opencode)
    await server.start()

    // 5. Initialize OpenCode client with custom tools
    const client = new OpenCodeClient(server.url)
    await client.initialize()
    await client.registerTools(createGitHubTools(github))

    // 6. Load review state
    const state = await loadOrRebuildState(github, config)

    // 7. Execute review
    const orchestrator = new ReviewOrchestrator(client, github, state, config)
    const result = await orchestrator.executeReview()

    // 8. Save state to cache
    await saveState(state, config)

    // 9. Set outputs
    core.setOutput('comments_posted', result.commentsPosted)
    core.setOutput('blocking_issues', result.hasBlockingIssues)
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  } finally {
    // Cleanup: stop OpenCode server
    await server?.stop()
  }
}
````

**Acceptance Criteria:**

- [ ] Action runs end-to-end without errors
- [ ] Configuration is parsed correctly
- [ ] OpenCode server starts and stops properly
- [ ] Review executes all 4 passes
- [ ] State is saved to cache
- [ ] Outputs are set correctly
- [ ] Cleanup runs even on errors
- [ ] Errors are reported clearly

**Files to Create:**

- None

**Files to Modify:**

- `src/main.ts`
- `src/index.ts` (call run() function)

---

### Task 5.2: Implement Logging and Debugging

**Objective:** Add comprehensive logging for debugging and monitoring.

**Changes Required:**

- Create logger utility
- Add debug logging throughout
- Include timing information
- Log tool invocations

**Technical Details:**

Logger should provide:

```typescript
export class Logger {
  debug(message: string, context?: object): void
  info(message: string, context?: object): void
  warning(message: string, context?: object): void
  error(message: string, error?: Error, context?: object): void
  startGroup(name: string): void
  endGroup(): void
}
```

Logging points:

- Action startup with configuration (sanitize API keys)
- OpenCode server lifecycle events
- Each review pass start/end with timing
- Tool invocations with parameters (sanitize sensitive data)
- GitHub API calls with response status
- State save/restore operations
- Errors with full stack traces

Use GitHub Actions log groups for organization:

```
::group::Pass 1: Atomic Diff Review
... logs ...
::endgroup::
```

**Acceptance Criteria:**

- [ ] Logger utility is implemented
- [ ] All major operations are logged
- [ ] Logs include timing information
- [ ] Sensitive data is sanitized
- [ ] Log groups organize output
- [ ] Debug logs are controlled by ACTIONS_STEP_DEBUG

**Files to Create:**

- `src/utils/logger.ts`

**Files to Modify:**

- All source files (add logging)

---

### Task 5.3: Implement Error Handling and Recovery

**Objective:** Add robust error handling and recovery mechanisms.

**Changes Required:**

- Define error types and hierarchy
- Implement retry logic for transient failures
- Add circuit breakers for external services
- Provide clear error messages

**Technical Details:**

Error types:

```typescript
export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean
  ) {
    super(message)
  }
}

export class OpenCodeServerError extends ReviewError {}
export class GitHubAPIError extends ReviewError {}
export class StateError extends ReviewError {}
export class ConfigurationError extends ReviewError {}
```

Retry logic:

- GitHub API: Retry up to 3 times with exponential backoff
- OpenCode server start: Retry once
- Tool invocations: No retries (agent should handle)
- State save: Retry up to 2 times

Error recovery:

- If OpenCode server crashes mid-review, restart and continue from last pass
- If GitHub API rate limited, wait and retry
- If state save fails, log warning but don't fail action
- If cache restore fails, rebuild from comments

User-facing error messages should:

- Explain what went wrong
- Suggest how to fix it
- Include relevant context (PR number, file, etc.)
- Avoid exposing sensitive information

**Acceptance Criteria:**

- [ ] Error types are well-defined
- [ ] Transient failures are retried appropriately
- [ ] Error messages are clear and actionable
- [ ] Errors don't leak sensitive data
- [ ] Unrecoverable errors fail fast
- [ ] Recoverable errors are handled gracefully

**Files to Create:**

- `src/utils/errors.ts`

**Files to Modify:**

- All source files (add error handling)

---

## Phase 6: Testing & Validation

### Task 6.1: Write Unit Tests

**Objective:** Achieve comprehensive unit test coverage for all modules.

**Changes Required:**

- Write unit tests for configuration parsing
- Mock GitHub API for testing
- Mock OpenCode SDK for testing
- Test state management logic
- Test scoring and filtering logic

**Technical Details:**

Test coverage targets:

- Configuration parsing: 100%
- State management: >90%
- GitHub API wrapper: >85%
- Tool implementations: >90%
- Orchestrator logic: >80%

Key test scenarios:

1. **Configuration**
   - Valid inputs parse correctly
   - Invalid inputs throw descriptive errors
   - Defaults are applied correctly
2. **State Management**
   - State saves and restores correctly
   - State rebuilds from comments accurately
   - Thread status detection is correct
3. **GitHub Tools**
   - Comment filtering by score works
   - Thread resolution updates state
   - State side-effects are triggered
4. **Orchestrator**
   - All 4 passes execute in order
   - Pass summaries flow correctly
   - Timeouts work as expected

Use Jest mocking for:

- `@actions/core` functions
- `@actions/github` API client
- `@actions/cache` functions
- OpenCode SDK client

**Acceptance Criteria:**

- [ ] All modules have unit tests
- [ ] Overall code coverage >85%
- [ ] Tests use proper mocking
- [ ] Tests are well-organized and documented
- [ ] CI runs tests automatically
- [ ] All tests pass

**Files to Create:**

- `__tests__/config/inputs.test.ts`
- `__tests__/github/api.test.ts`
- `__tests__/github/state.test.ts`
- `__tests__/opencode/tools.test.ts`
- `__tests__/review/orchestrator.test.ts`

**Files to Modify:**

- `__tests__/main.test.ts` (replace template tests)

---

### Task 6.2: Create Integration Test Workflow

**Objective:** Set up integration testing with a real OpenCode server and GitHub
API.

**Changes Required:**

- Create test workflow that triggers on test PRs
- Set up test repository with sample code
- Configure secrets for testing
- Validate end-to-end functionality

**Technical Details:**

Test workflow (`.github/workflows/integration-test.yml`):

```yaml
name: Integration Test

on:
  pull_request:
    branches: [main, test/**]

jobs:
  test-action:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run PR Review Action
        uses: ./
        with:
          opencode_api_key: ${{ secrets.OPENCODE_API_KEY_TEST }}
          model: 'google/gemini-flash-1.5'
          problem_score_threshold: 5
          github_token: ${{ secrets.GITHUB_TOKEN }}

      - name: Verify Comments Posted
        run: |
          # Use GitHub API to verify comments were posted
          # Check that state was saved to cache
```

Test scenarios:

1. First-time review of a PR
2. Updated PR with fixes to previous issues
3. PR with disputed comments
4. PR with no issues (agent stays silent)
5. PR with critical security issues (score 9-10)

**Acceptance Criteria:**

- [ ] Integration test workflow is configured
- [ ] Tests run on sample PRs
- [ ] All test scenarios pass
- [ ] Comments are posted correctly
- [ ] State persists across runs
- [ ] Tests validate action outputs

**Files to Create:**

- `.github/workflows/integration-test.yml`
- Test fixtures in a test directory

**Files to Modify:**

- None

---

### Task 6.3: Create Example Workflows and Documentation

**Objective:** Provide clear documentation and examples for users.

**Changes Required:**

- Update README with usage instructions
- Create example workflow files
- Document configuration options
- Add troubleshooting guide

**Technical Details:**

README sections:

1. **Overview**
   - What the action does
   - Key features
   - How it differs from other review tools

2. **Quick Start**
   - Minimal workflow example
   - Required secrets setup

3. **Configuration**
   - All inputs with descriptions
   - Default values
   - Examples for common scenarios

4. **Scoring Rubric**
   - Explanation of 1-10 scale
   - How to choose threshold
   - Examples of each level

5. **How It Works**
   - 4-pass review explanation
   - State management
   - Fix verification

6. **Troubleshooting**
   - Common issues and solutions
   - How to enable debug logging
   - Where to get help

Example workflows:

- Basic review (default settings)
- Strict review (high threshold, security-focused)
- Permissive review (low threshold for learning)
- Custom model and settings

**Acceptance Criteria:**

- [ ] README is comprehensive and clear
- [ ] Example workflows are provided
- [ ] All configuration options are documented
- [ ] Troubleshooting guide addresses common issues
- [ ] Documentation includes screenshots/examples
- [ ] Links to OpenCode docs are included

**Files to Create:**

- `docs/examples/basic-review.yml`
- `docs/examples/strict-review.yml`
- `docs/TROUBLESHOOTING.md`

**Files to Modify:**

- `README.md`

---

## Phase 7: Advanced Features

### Task 7.1: Implement Score Elevation for Low-Score Issues

**Objective:** Allow multiple low-score issues to be collectively elevated when
they exceed a threshold.

**Changes Required:**

- Track low-score issues during review
- Apply elevation logic when threshold is met
- Document elevated issues in comments

**Technical Details:**

Elevation logic:

1. During Pass 4 (consolidation), count issues below `problem_score_threshold`
2. If count >= `score_elevation_threshold`:
   - Create a single elevated comment summarizing all issues
   - Assign elevated score (based on collective impact)
   - Post as a regular comment (not per-line)
3. Original low-score issues are not posted individually

Example elevated comment:

```markdown
## Elevated Issues (5 minor improvements)

While individually these issues are below the threshold (score < 5),
collectively they indicate a pattern worth addressing:

1. **Inconsistent naming** (score: 3) - Variables `data`, `d`, `userData` used
   interchangeably
2. **Missing docs** (score: 4) - 3 public functions lack JSDoc
3. **Redundant code** (score: 3) - Similar logic duplicated in lines 42 and 87
4. **Verbose conditionals** (score: 3) - If/else blocks could use ternary
5. **Generic variable names** (score: 2) - Multiple uses of `temp`, `result`

Collective score: 6 (elevated from average 3)
```

**Acceptance Criteria:**

- [ ] Low-score issues are tracked during review
- [ ] Elevation threshold is respected
- [ ] Elevated comments are clear and helpful
- [ ] Elevation logic is tested
- [ ] Configuration option works correctly

**Files to Create:**

- None (extend existing files)

**Files to Modify:**

- `src/review/orchestrator.ts`
- `src/opencode/tools.ts`

---

### Task 7.2: Implement Security Sensitivity Detection

**Objective:** Automatically detect if the repository handles sensitive data and
adjust security scoring accordingly.

**Changes Required:**

- Analyze package.json for financial/PII-related dependencies
- Check README for security indicators
- Auto-promote security findings by +2 points
- Document sensitivity in review context

**Technical Details:**

Detection heuristics:

1. **Package dependencies** indicating sensitivity:
   - `stripe`, `paypal`, `braintree` → Financial
   - `passport`, `auth0`, `oauth` → Authentication/PII
   - `crypto`, `bcrypt`, `jsonwebtoken` → Security-critical
2. **README keywords**:
   - "payment", "credit card", "financial" → Financial
   - "HIPAA", "PII", "personal data", "GDPR" → PII
   - "security", "encryption", "authentication" → Security-critical

3. **File patterns**:
   - Presence of `SECURITY.md` → Security-conscious project
   - Encryption configs in repo → Sensitive data handling

Security score promotion:

- If sensitivity detected, add +2 to all security-related findings (Pass 3)
- Document sensitivity in review header:
  ```markdown
  ⚠️ This repository handles financial data. Security findings are elevated
  (+2).
  ```

**Acceptance Criteria:**

- [ ] Sensitivity is detected from package.json
- [ ] README keywords are analyzed
- [ ] Security scores are promoted correctly
- [ ] Detection is logged for transparency
- [ ] False positives are minimized

**Files to Create:**

- `src/review/security.ts`

**Files to Modify:**

- `src/review/orchestrator.ts`
- `src/review/prompts.ts`

---

### Task 7.3: Implement AGENTS.md Support

**Objective:** Load and enforce project-specific rules from `AGENTS.md` file if
present.

**Changes Required:**

- Check for AGENTS.md in repository root
- Load and parse the file
- Include content in Pass 3 prompt
- Flag violations with appropriate severity

**Technical Details:**

AGENTS.md handling:

1. Check if file exists at repository root
2. If present, fetch content via GitHub API
3. Parse for explicit rules (checkboxes, lists, headings)
4. Include full content in Pass 3 system prompt
5. Agent should identify violations and score based on rule criticality

Pass 3 prompt enhancement:

```
This repository has an AGENTS.md file with project-specific rules:

--- BEGIN AGENTS.md ---
[file content]
--- END AGENTS.md ---

You must:
1. Identify any violations of rules in AGENTS.md
2. Score violations based on the rule's importance:
   - "MUST" / "REQUIRED" rules → score 8+
   - "SHOULD" / "RECOMMENDED" rules → score 6-7
   - "MAY" / "OPTIONAL" rules → score 4-5
3. Reference the specific rule in your finding
```

Example finding:

```markdown
**AGENTS.md Rule Violation** (score: 8)

Finding: Direct database queries in UI component

Assessment: The file `UserProfile.tsx` makes direct database calls, violating
the rule "UI components MUST use the service layer for data access" (AGENTS.md,
line 42).

This breaks architectural boundaries and makes testing difficult.
```

**Acceptance Criteria:**

- [ ] AGENTS.md is detected when present
- [ ] File content is loaded correctly
- [ ] Rules are enforced in Pass 3
- [ ] Violations are scored appropriately
- [ ] Missing AGENTS.md doesn't cause errors
- [ ] Rule references are included in findings

**Files to Create:**

- None (extend existing files)

**Files to Modify:**

- `src/review/prompts.ts`
- `src/review/orchestrator.ts`
- `src/github/api.ts`

---

### Task 7.4: Implement Dispute Resolution Logic

**Objective:** Handle developer disputes of raised issues with intelligent
resolution logic.

**Changes Required:**

- Detect when developer disputes an issue
- Agent evaluates the reasoning
- Agent decides to concede or maintain position
- Escalate unresolved disputes to human reviewers

**Technical Details:**

Dispute handling flow:

1. **Detection**: Monitor for developer replies to agent comments
2. **Classification**: Determine if reply is:
   - Acknowledgment (will fix)
   - Dispute (disagrees with finding)
   - Question (needs clarification)
   - Out-of-scope (will fix later)

3. **Agent evaluation** (automated via OpenCode):
   - Re-examine the code with dispute reasoning
   - Assess if reasoning is valid
   - Consider:
     - Is the original finding still accurate?
     - Does the explanation address the concern?
     - Is the proposed alternative acceptable?
     - Does "fix later" introduce temporary risk?

4. **Resolution actions**:
   - **Concede**: Call `github_reply_to_thread(is_concession=true)` + resolve
   - **Maintain**: Explain why finding still stands
   - **Escalate**: Request human reviewer (if configured)

Example dispute scenarios:

**Scenario 1: Valid dispute (agent concedes)**

```
Agent: "This nested loop is O(n²), consider using a Map for O(n)" (score: 6)
Dev: "The array is always <10 items (config validation ensures this), so O(n²) is acceptable"
Agent: "You're correct. Given the size constraint, the performance impact is negligible. Conceding." [Resolves thread]
```

**Scenario 2: Invalid dispute (agent maintains)**

```
Agent: "Missing authorization check on this endpoint" (score: 9)
Dev: "Authorization is handled by middleware"
Agent: "I've reviewed the middleware, and it only applies to routes in /api/admin/. This endpoint at /api/user/data requires explicit checks. The finding stands."
```

**Scenario 3: Future fix risk (agent rejects)**

```
Agent: "Race condition in payment processing" (score: 9)
Dev: "Acknowledged, will fix in next sprint"
Agent: "This creates a data corruption risk in production. The PR should not merge until this is addressed, as the impact is critical."
```

State updates for disputes:

- Thread status becomes "DISPUTED"
- Dispute reasoning is stored in thread history
- If agent concedes, status becomes "RESOLVED"
- If agent maintains and dev accepts, status becomes "PENDING"
- If neither concedes, status stays "DISPUTED"

Human escalation (optional feature):

- If configured, tag a human reviewer on disputed threads
- Provide summary of agent vs. developer positions
- Human reviewer makes final call

**Acceptance Criteria:**

- [ ] Developer disputes are detected
- [ ] Agent evaluates reasoning intelligently
- [ ] Concessions are handled correctly
- [ ] Agent maintains position when appropriate
- [ ] High-risk "fix later" responses are rejected
- [ ] Dispute state is tracked correctly
- [ ] Human escalation works (if implemented)

**Files to Create:**

- `src/review/dispute.ts`

**Files to Modify:**

- `src/review/orchestrator.ts`
- `src/opencode/tools.ts`

---

## Phase 8: Polish & Release

### Task 8.1: Build and Bundle Action

**Objective:** Ensure the action is properly bundled and ready for distribution.

**Changes Required:**

- Run `npm run bundle` to package TypeScript
- Verify dist/ contains all dependencies
- Test bundled action locally
- Ensure no development dependencies in bundle

**Technical Details:**

Build verification checklist:

- [ ] `npm run bundle` completes without errors
- [ ] `dist/index.js` and `dist/index.js.map` are created
- [ ] Bundle size is reasonable (<5MB)
- [ ] All runtime dependencies are included
- [ ] DevDependencies are excluded
- [ ] Source maps are generated for debugging

Local testing:

```bash
# Use local-action to test the bundled code
npx @github/local-action . src/main.ts .env.test
```

CI verification:

- Update `check-dist` workflow to verify bundle is up-to-date
- Fail CI if source changes without rebuilding

**Acceptance Criteria:**

- [ ] Action bundles successfully
- [ ] Bundled action works when tested locally
- [ ] Bundle includes all runtime dependencies
- [ ] Bundle is committed to repository
- [ ] CI verifies bundle is current
- [ ] Source maps are available

**Files to Create:**

- None

**Files to Modify:**

- `dist/index.js` (via build)
- `dist/index.js.map` (via build)

---

### Task 8.2: Update Repository Metadata

**Objective:** Update all repository metadata for publication.

**Changes Required:**

- Update package.json with correct name, description, version
- Update action.yml branding
- Update CODEOWNERS
- Create LICENSE if needed
- Update repository URLs

**Technical Details:**

Package.json updates:

```json
{
  "name": "opencode-pr-reviewer",
  "description": "AI-powered PR review agent using OpenCode SDK",
  "version": "1.0.0",
  "author": "Your Name/Org",
  "homepage": "https://github.com/yourusername/opencode-pr-reviewer",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/yourusername/opencode-pr-reviewer.git"
  }
}
```

Action branding:

```yaml
branding:
  icon: 'check-circle'
  color: 'blue'
```

**Acceptance Criteria:**

- [ ] Package.json has correct metadata
- [ ] Action.yml branding is appropriate
- [ ] Repository URLs are updated
- [ ] CODEOWNERS is updated or removed
- [ ] LICENSE is appropriate for the project
- [ ] All template references are removed

**Files to Modify:**

- `package.json`
- `action.yml`
- `CODEOWNERS` (update or remove)
- `LICENSE`

---

### Task 8.3: Create Release and Publish

**Objective:** Create the first release and publish to GitHub Marketplace.

**Changes Required:**

- Create v1.0.0 release tag
- Write release notes
- Publish to GitHub Marketplace
- Create v1 major version tag

**Technical Details:**

Release process:

1. Ensure all tests pass
2. Ensure bundle is up-to-date
3. Run `script/release` to create tags
4. Create GitHub release with notes
5. Publish to Marketplace

Release notes template:

```markdown
# OpenCode PR Reviewer v1.0.0

## 🎉 Initial Release

AI-powered code review agent that performs multi-pass reviews with contextual
awareness.

### Features

- 🔍 **4-Pass Review System**: Atomic, structural, security, and consolidation
  passes
- 📊 **Configurable Severity Threshold**: 1-10 scoring rubric
- 💾 **Stateful Memory**: Tracks issues across commits
- 🔒 **Security-First**: Special focus on access control and data integrity
- 📝 **AGENTS.md Support**: Enforces project-specific rules
- 🤝 **Smart Dispute Resolution**: Evaluates developer responses

### Usage

See [README.md](README.md) for full documentation.

### Requirements

- OpenCode API key
- GitHub token with PR write permissions
```

Marketplace publishing:

- Complete GitHub Actions Marketplace submission
- Provide clear description and tags
- Upload icon/logo
- Link to documentation

**Acceptance Criteria:**

- [ ] v1.0.0 release is created
- [ ] v1 major tag points to v1.0.0
- [ ] Release notes are comprehensive
- [ ] Action is published to Marketplace
- [ ] Marketplace listing is complete and accurate
- [ ] Installation instructions are clear

**Files to Create:**

- None (GitHub release)

**Files to Modify:**

- None (tags only)

---

## Summary of Deliverables

### Code Deliverables

- [ ] Fully functional GitHub Action (all source files)
- [ ] Comprehensive test suite (>85% coverage)
- [ ] Example workflows and documentation
- [ ] Bundled and ready-to-use action in dist/

### Documentation Deliverables

- [ ] Updated README with usage instructions
- [ ] Configuration reference
- [ ] Troubleshooting guide
- [ ] Example workflows
- [ ] Release notes

### Infrastructure Deliverables

- [ ] CI/CD workflows (test, lint, integration tests)
- [ ] Integration test setup
- [ ] Release automation

---

## Overall Success Criteria

The OpenCode PR Reviewer Agent implementation will be considered complete when:

1. **Functionality**
   - [ ] All 4 review passes execute correctly
   - [ ] Comments are posted with accurate scoring
   - [ ] State persists across PR updates
   - [ ] Fix verification works correctly
   - [ ] Dispute resolution handles common scenarios

2. **Quality**
   - [ ] Code coverage >85%
   - [ ] All tests pass
   - [ ] No critical bugs or security issues
   - [ ] Code follows TypeScript best practices
   - [ ] Comprehensive error handling

3. **Usability**
   - [ ] Clear documentation for all features
   - [ ] Example workflows for common scenarios
   - [ ] Helpful error messages
   - [ ] Reasonable defaults for configuration

4. **Performance**
   - [ ] Reviews complete in <10 minutes for typical PRs
   - [ ] GitHub API rate limits are respected
   - [ ] OpenCode server is stable throughout review

5. **Distribution**
   - [ ] Action is published to GitHub Marketplace
   - [ ] First release (v1.0.0) is tagged
   - [ ] Installation instructions are clear

---

## Development Roadmap Estimate

Based on the task breakdown:

- **Phase 1** (Infrastructure): 2-3 days
- **Phase 2** (OpenCode Integration): 3-4 days
- **Phase 3** (State Management): 2-3 days
- **Phase 4** (Review Orchestration): 4-5 days
- **Phase 5** (Main Action): 2-3 days
- **Phase 6** (Testing): 3-4 days
- **Phase 7** (Advanced Features): 4-5 days
- **Phase 8** (Polish & Release): 1-2 days

**Total estimated time**: 21-29 days (4-6 weeks)

This estimate assumes:

- One developer working full-time
- Familiarity with TypeScript and GitHub Actions
- Access to OpenCode SDK documentation
- No major blockers or API changes

---

## Next Steps

To begin implementation:

1. Start with Phase 1, Task 1.1 (Update Action Metadata)
2. Set up the project structure (Task 1.2)
3. Implement configuration parsing (Task 1.3)
4. Proceed sequentially through phases

Each task should be completed and tested before moving to the next. Use pull
requests for code review and maintain a clean git history.
