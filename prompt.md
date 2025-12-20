# Project

This is a repo of a custom Github Action. This action will implement an LLM Code
rview agent based on OpenCode.

The full project description is located at ./project-description.md

The repo is created from the https://github.com/actions/typescript-action
template

Please follow ./AGENTS.md

OpenCode Docs are available here https://opencode.ai/docs/

We will work on tasks within the broader poject.

# Task

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
    history: Array<{
      author: string
      body: string
      timestamp: string
      is_concession?: boolean
    }>
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

Cache key format: `pr-review-state-${owner}-${repo}-${prNumber}`

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
