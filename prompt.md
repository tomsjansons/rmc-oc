# Project

This is a repo of a custom Github Action. This action will implement an LLM Code rview agent based on OpenCode.

The full project description is located at ./project-description.md

The repo is created from the https://github.com/actions/typescript-action template

Please follow ./AGENTS.md

OpenCode Docs are available here https://opencode.ai/docs/

We will work on tasks within the broader poject.

# Task

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
