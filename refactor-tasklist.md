# Multi-Task Execution Refactor - Task List

## Overview

This document provides a detailed breakdown of all tasks required for the
multi-task execution refactor. Each task includes specific deliverables, success
criteria, and clear scope boundaries.

**Total Estimated Time**: 20-27 hours across 6 phases

---

## Phase 1: Foundation (4-6 hours)

**Goal**: Set up new structure and core components without breaking existing
functionality

### Task 1.1: Create State Type Definitions

**File**: `src/state/types.ts` (NEW)

**In Scope**:

- Create `ProcessState` type (replaces `ReviewState`)
  - `reviewThreads: ReviewThread[]`
  - `questionTasks: QuestionTask[]`
  - `manualReviewRequests: ManualReviewRequest[]`
  - `metadata: ProcessMetadata`
- Create `QuestionTask` type with all required fields
- Create `ManualReviewRequest` type with all required fields
- Create `ProcessMetadata` type including `autoReviewTrigger`
- Create `ThreadStatus` type (existing, but move here)
- Create `ReviewThread` type (existing, but move here)
- Export all types

**Out of Scope**:

- State manager implementation (Task 2.1)
- Actual state persistence (Task 2.2)
- Migrating existing code to use new types (Phase 2)

**Success Criteria**:

- [ ] File `src/state/types.ts` created
- [ ] All types compile without errors
- [ ] Types include comprehensive JSDoc comments
- [ ] `ProcessState` includes all three task type arrays
- [ ] `ProcessMetadata.autoReviewTrigger` includes all required fields
      (triggeredAt, action, sha, cancelled, completedAt)

**Deliverables**:

```typescript
// src/state/types.ts
export type ProcessState = { ... }
export type QuestionTask = { ... }
export type ManualReviewRequest = { ... }
export type ProcessMetadata = { ... }
export type ReviewThread = { ... }
export type ThreadStatus = 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED'
```

**Estimated Time**: 1 hour

---

### Task 1.2: Create Task Type Definitions

**File**: `src/task/types.ts` (NEW)

**In Scope**:

- Create `Task` union type (DisputeTask | QuestionTask | ReviewTask)
- Create `DisputeTask` type with all context
- Create `QuestionTask` type (execution version, different from state version)
- Create `ReviewTask` type with manual/auto distinction
- Create `ExecutionPlan` type
- Create `TaskResult` type
- Create `ExecutionResult` type
- Create `ConversationMessage` type for question history

**Out of Scope**:

- Task detection logic (Task 1.4)
- Task execution logic (Phase 3)

**Success Criteria**:

- [ ] File `src/task/types.ts` created
- [ ] All task types include `priority` field
- [ ] `ReviewTask` distinguishes between manual and auto triggers
- [ ] `QuestionTask` includes `conversationHistory` field
- [ ] `ExecutionPlan` includes both tasks array and trigger metadata
- [ ] Types compile without errors

**Deliverables**:

```typescript
// src/task/types.ts
export type Task = DisputeTask | QuestionTask | ReviewTask
export type DisputeTask = { type: 'dispute-resolution', priority: 1, ... }
export type QuestionTask = { type: 'question-answering', priority: 2, ... }
export type ReviewTask = { type: 'full-review', priority: 3, ... }
export type ExecutionPlan = { tasks: Task[], triggeredBy: string }
export type TaskResult = { ... }
export type ExecutionResult = { ... }
export type ConversationMessage = { ... }
```

**Estimated Time**: 1 hour

---

### Task 1.3: Create rmcoc Block Serializer

**File**: `src/state/serializer.ts` (NEW)

**In Scope**:

- Create `extractRmcocBlock(commentBody: string)` function
- Create `addRmcocBlock(commentBody: string, data: object)` function
- Create `updateRmcocBlock(commentBody: string, data: object)` function
- Support for all rmcoc block types:
  - `question`
  - `question-answer`
  - `manual-pr-review`
  - `review-finding`
  - `dispute-resolution`
- Regex-based parsing (safe, no eval)
- JSON schema validation for extracted blocks

**Out of Scope**:

- State persistence (Task 2.2)
- GitHub API integration (Task 1.5)
- Comment updating logic (Phase 3)

**Success Criteria**:

- [ ] File `src/state/serializer.ts` created
- [ ] `extractRmcocBlock()` safely parses all valid rmcoc formats
- [ ] `addRmcocBlock()` appends block if none exists
- [ ] `updateRmcocBlock()` replaces existing block
- [ ] Handles malformed JSON gracefully (returns null, logs warning)
- [ ] Handles missing rmcoc block gracefully (returns null)
- [ ] Unit tests pass for all block types

**Deliverables**:

```typescript
// src/state/serializer.ts
export function extractRmcocBlock(body: string): RmcocBlock | null
export function addRmcocBlock(body: string, data: RmcocBlock): string
export function updateRmcocBlock(body: string, data: RmcocBlock): string
export type RmcocBlock = QuestionRmcoc | ManualReviewRmcoc | ...
```

**Estimated Time**: 1.5 hours

---

### Task 1.4: Create Task Detector

**File**: `src/task/detector.ts` (NEW)

**In Scope**:

- Create `TaskDetector` class
- Implement `detectAllTasks()` main method
- Implement `detectPendingDisputes()` method
  - Scan review threads for unresolved developer replies
  - Use rmcoc blocks to determine dispute status
  - Never use raw text parsing
- Implement `detectPendingQuestions()` method
  - Scan all issue comments for @ mentions
  - Check rmcoc blocks to filter already answered questions
  - Classify intent (question vs review-request)
  - Build conversation history for each question
- Implement `detectReviewRequest()` method
  - Detect auto review from pull_request events
  - Detect manual review from issue_comment events
  - Track auto review triggers in state
  - Detect cancelled auto reviews
- Implement `deduplicateAndPrioritize()` method
  - Dismiss manual reviews if auto review exists
  - Remove duplicate tasks
  - Sort by priority
- Implement `getConversationHistory()` helper
  - Include ALL comments in chronological order
  - Filter for bot mentions and bot replies
  - No max depth limit

**Out of Scope**:

- Task execution (Phase 3)
- State management (Phase 2)
- GitHub API implementation (Task 1.5 adds methods only)

**Success Criteria**:

- [ ] File `src/task/detector.ts` created
- [ ] `detectAllTasks()` returns ExecutionPlan with all pending work
- [ ] Dispute detection uses only rmcoc blocks (no text parsing)
- [ ] Question detection filters answered questions via rmcoc blocks
- [ ] Conversation history includes all comments (no tagging required)
- [ ] Manual reviews dismissed when auto review present
- [ ] Cancelled auto reviews detected and restarted
- [ ] Tasks properly prioritized (disputes=1, questions=2, reviews=3)
- [ ] Compiles without errors

**Deliverables**:

```typescript
// src/task/detector.ts
export class TaskDetector {
  async detectAllTasks(
    context: GitHubContext,
    github: GitHubAPI,
    currentState: ProcessState
  ): Promise<ExecutionPlan>

  private async detectPendingDisputes(...): Promise<DisputeTask[]>
  private async detectPendingQuestions(...): Promise<QuestionTask[]>
  private async detectReviewRequest(...): Promise<ReviewTask | null>
  private async deduplicateAndPrioritize(...): Promise<Task[]>
  private async getConversationHistory(...): Promise<ConversationMessage[]>
  private async dismissManualReview(...): Promise<void>
}
```

**Estimated Time**: 2-2.5 hours

---

### Task 1.5: Add GitHub API Methods

**File**: `src/github/api.ts` (MODIFY)

**In Scope**:

- Add `getAllIssueComments()` method
- Add `getComment(commentId: string)` method
- Add `updateComment(commentId: string, body: string)` method
- Add `replyToComment(commentId: string, body: string)` method (alias)
- Add `getCurrentSHA()` method
- Add `hasNewDeveloperReply(threadId: string)` method
- Add `getThreadComments(threadId: string)` method
- Proper error handling for all methods
- Use pagination where applicable

**Out of Scope**:

- State management (Phase 2)
- Task detection (Task 1.4)
- Orchestrator integration (Phase 3)

**Success Criteria**:

- [ ] All new methods added to GitHubAPI class
- [ ] `getAllIssueComments()` uses pagination
- [ ] `getCurrentSHA()` returns current commit SHA
- [ ] `hasNewDeveloperReply()` correctly detects new developer comments
- [ ] All methods handle errors gracefully
- [ ] Methods follow existing code style
- [ ] Compiles without errors
- [ ] No breaking changes to existing methods

**Deliverables**:

```typescript
// src/github/api.ts (additions)
async getAllIssueComments(): Promise<Comment[]>
async getComment(commentId: string): Promise<Comment>
async updateComment(commentId: string, body: string): Promise<void>
async replyToComment(commentId: string, body: string): Promise<void>
async getCurrentSHA(): Promise<string>
async hasNewDeveloperReply(threadId: string): Promise<boolean>
async getThreadComments(threadId: string): Promise<Comment[]>
```

**Estimated Time**: 1 hour

---

### Task 1.6: Move Intent Classifier

**File**: `src/task/classifier.ts` (MOVE from `src/utils/intent-classifier.ts`)

**In Scope**:

- Move `IntentClassifier` class to new location
- Update all imports throughout codebase
- No functional changes
- Update file references in comments/docs

**Out of Scope**:

- Changing classifier logic
- Adding new classification types

**Success Criteria**:

- [ ] File `src/task/classifier.ts` created
- [ ] Original file `src/utils/intent-classifier.ts` removed
- [ ] All imports updated
- [ ] Compiles without errors
- [ ] Existing tests still pass
- [ ] No functionality changed

**Deliverables**:

- `src/task/classifier.ts` (moved)
- Updated imports in all affected files

**Estimated Time**: 30 minutes

---

### Phase 1 Completion Checklist

- [ ] All 6 tasks completed
- [ ] All new files created in correct locations
- [ ] Compiles without errors
- [ ] Existing tests still pass
- [ ] No breaking changes to existing functionality
- [ ] Code follows existing style guidelines

**Phase 1 Total Time**: 4-6 hours

---

## Phase 2: State Management Refactor (3-4 hours)

**Goal**: Migrate from ReviewState to ProcessState

### Task 2.1: Rename and Refactor State Manager

**Files**:

- `src/github/state.ts` → `src/state/manager.ts` (RENAME/MOVE)
- Update all imports

**In Scope**:

- Move file to new location
- Rename class `StateManager` → `ProcessStateManager` (or keep StateManager)
- Update state schema from `ReviewState` to `ProcessState`
- Update all method signatures to use new types
- Add methods for question task management:
  - `addQuestionTask()`
  - `updateQuestionStatus()`
  - `getUnansweredQuestions()`
- Add methods for manual review request management:
  - `addManualReviewRequest()`
  - `updateManualReviewStatus()`
  - `dismissManualReview()`
- Add methods for auto review trigger tracking:
  - `setAutoReviewTrigger()`
  - `getAutoReviewTrigger()`
  - `clearAutoReviewTrigger()`
  - `markAutoReviewCancelled()`
- Update `getOrCreateState()` to return `ProcessState`
- Update `rebuildStateFromComments()` to parse all rmcoc types
- Use `serializer.ts` functions for rmcoc block parsing

**Out of Scope**:

- Orchestrator integration (Phase 3)
- Task detection (completed in Phase 1)
- Changing dispute resolution logic

**Success Criteria**:

- [ ] File moved to `src/state/manager.ts`
- [ ] All imports updated throughout codebase
- [ ] Class handles `ProcessState` instead of `ReviewState`
- [ ] New methods for questions and manual reviews implemented
- [ ] Auto review trigger tracking implemented
- [ ] `rebuildStateFromComments()` parses all rmcoc block types
- [ ] Uses serializer functions (no duplicate parsing logic)
- [ ] Compiles without errors
- [ ] State persistence works correctly

**Deliverables**:

```typescript
// src/state/manager.ts
export class StateManager {
  async getOrCreateState(): Promise<ProcessState>
  async updateState(state: ProcessState): Promise<void>
  async rebuildStateFromComments(): Promise<ProcessState>

  // Question management
  async addQuestionTask(task: QuestionTask): Promise<void>
  async updateQuestionStatus(commentId: string, status: string): Promise<void>
  async getUnansweredQuestions(): Promise<QuestionTask[]>

  // Manual review management
  async addManualReviewRequest(request: ManualReviewRequest): Promise<void>
  async updateManualReviewStatus(
    commentId: string,
    status: string
  ): Promise<void>
  async dismissManualReview(commentId: string): Promise<void>

  // Auto review trigger tracking
  async setAutoReviewTrigger(trigger: AutoReviewTrigger): Promise<void>
  async getAutoReviewTrigger(): Promise<AutoReviewTrigger | null>
  async clearAutoReviewTrigger(): Promise<void>
  async markAutoReviewCancelled(): Promise<void>

  // Existing methods (updated signatures)
  async getThreadsWithDeveloperReplies(): Promise<ReviewThread[]>
  // ... other existing methods
}
```

**Estimated Time**: 2-2.5 hours

---

### Task 2.2: Update State Persistence

**File**: `src/state/manager.ts` (MODIFY)

**In Scope**:

- Update state serialization to handle new ProcessState format
- Update state deserialization to handle new ProcessState format
- Ensure all three task type arrays are persisted
- Ensure metadata (including autoReviewTrigger) is persisted
- Handle migration from any in-flight old format (if needed)
- Add validation for loaded state

**Out of Scope**:

- Backwards compatibility (action is unreleased)
- State format migration utilities

**Success Criteria**:

- [ ] State saves all ProcessState fields correctly
- [ ] State loads all ProcessState fields correctly
- [ ] autoReviewTrigger persists across runs
- [ ] questionTasks persist across runs
- [ ] manualReviewRequests persist across runs
- [ ] Invalid state falls back to empty state (with warning)
- [ ] State validation catches malformed data

**Deliverables**:

- Updated serialization/deserialization logic in StateManager
- State validation function

**Estimated Time**: 1 hour

---

### Task 2.3: Update All State References

**Files**: All files importing StateManager

**In Scope**:

- Update all imports of StateManager to new path
- Update all references to `ReviewState` → `ProcessState`
- Update method calls to use new signatures
- Ensure no compilation errors

**Out of Scope**:

- Functional changes to consuming code
- Orchestrator refactor (Phase 3)

**Success Criteria**:

- [ ] All imports updated
- [ ] All type references updated
- [ ] Compiles without errors
- [ ] Existing tests pass
- [ ] No runtime errors

**Deliverables**:

- Updated imports and type references in:
  - `src/main.ts`
  - `src/review/orchestrator.ts`
  - `src/trpc/router.ts`
  - Any other files using StateManager

**Estimated Time**: 30 minutes - 1 hour

---

### Phase 2 Completion Checklist

- [ ] All 3 tasks completed
- [ ] StateManager renamed and moved
- [ ] ProcessState fully implemented
- [ ] State persistence works for all task types
- [ ] All imports updated
- [ ] Compiles without errors
- [ ] Existing functionality preserved

**Phase 2 Total Time**: 3-4 hours

---

## Phase 3: Orchestrator Refactor (6-8 hours)

**Goal**: Transform ReviewOrchestrator into ExecutionOrchestrator with
multi-task support

### Task 3.1: Rename Orchestrator Files

**Files**:

- `src/review/orchestrator.ts` → `src/execution/orchestrator.ts` (RENAME/MOVE)
- `src/review/prompts.ts` → `src/execution/prompts.ts` (MOVE)
- `src/review/types.ts` → `src/execution/types.ts` (MOVE, merge with task types)
- Update all imports

**In Scope**:

- Move files to new location
- Update all imports throughout codebase
- Merge execution-related types into consolidated file
- Remove duplicate types

**Out of Scope**:

- Functional changes (next tasks)
- Method refactoring (next tasks)

**Success Criteria**:

- [ ] All files moved to `src/execution/` directory
- [ ] All imports updated
- [ ] Types consolidated without duplication
- [ ] Compiles without errors
- [ ] Existing functionality preserved

**Deliverables**:

- `src/execution/orchestrator.ts`
- `src/execution/prompts.ts`
- `src/execution/types.ts`
- Updated imports in all files

**Estimated Time**: 30 minutes

---

### Task 3.2: Implement Main Execution Loop

**File**: `src/execution/orchestrator.ts` (MODIFY)

**In Scope**:

- Rename class `ReviewOrchestrator` → `ExecutionOrchestrator`
- Add new main entry point: `executeAllTasks(plan: ExecutionPlan)`
- Implement task execution loop:
  - Iterate through tasks in priority order
  - Execute each task based on type
  - Update state after each task
  - Handle errors with failure comments
  - Track auto review trigger status
- Add `wasAutoReviewTriggered()` method
- Add `clearAutoReviewTrigger()` method
- Add error handling with failure comments
- Preserve single OpenCode session across all tasks

**Out of Scope**:

- Individual task execution methods (next tasks)
- Prompt changes (Task 3.6)

**Success Criteria**:

- [ ] Class renamed to `ExecutionOrchestrator`
- [ ] `executeAllTasks()` method implemented
- [ ] Loop executes tasks sequentially
- [ ] State updated after each task
- [ ] Errors caught and commented
- [ ] Auto review trigger tracked correctly
- [ ] Single session maintained
- [ ] Compiles without errors

**Deliverables**:

```typescript
// src/execution/orchestrator.ts
export class ExecutionOrchestrator {
  async executeAllTasks(plan: ExecutionPlan): Promise<ExecutionResult> {
    // Loop through tasks
    // Execute each
    // Handle errors
    // Update state
    // Return results
  }

  async wasAutoReviewTriggered(): Promise<boolean>
  async clearAutoReviewTrigger(): Promise<void>

  // Existing methods to be refactored in next tasks
  async executeQuestionAnswering(...): Promise<TaskResult>
  async executeDisputeResolution(...): Promise<TaskResult>
  async executeFullReview(...): Promise<TaskResult>
}
```

**Estimated Time**: 1.5-2 hours

---

### Task 3.3: Refactor Question Answering Execution

**File**: `src/execution/orchestrator.ts` (MODIFY)

**In Scope**:

- Refactor `executeQuestionAnswering()` to accept `QuestionTask` parameter
- Remove dependency on `config.execution.questionContext`
- Implement status updates via rmcoc blocks:
  - Update original comment with IN_PROGRESS
  - Post answer as reply with rmcoc block
  - Update original comment with ANSWERED
- Use conversation history from task
- Format answer with proper attribution
- Handle start/end comment updates for manual triggers

**Out of Scope**:

- Prompt changes (Task 3.6)
- State management (completed in Phase 2)

**Success Criteria**:

- [ ] Method accepts QuestionTask parameter
- [ ] No dependency on config for question context
- [ ] rmcoc blocks added/updated correctly
- [ ] Conversation history used for context
- [ ] Answer formatted with attribution
- [ ] Start/end comments work for manual triggers
- [ ] Compiles without errors
- [ ] Integration with executeAllTasks() works

**Deliverables**:

```typescript
async executeQuestionAnswering(task: QuestionTask): Promise<TaskResult> {
  // Update status to IN_PROGRESS
  // Sanitize input
  // Build prompt with conversation history
  // Execute in session
  // Post answer with rmcoc block
  // Update status to ANSWERED
  // Return result
}

private async updateQuestionStatus(
  commentId: string,
  rmcocData: QuestionRmcocBlock
): Promise<void>

private formatQuestionAnswer(
  task: QuestionTask,
  answer: string
): string
```

**Estimated Time**: 1.5-2 hours

---

### Task 3.4: Refactor Dispute Resolution Execution

**File**: `src/execution/orchestrator.ts` (MODIFY)

**In Scope**:

- Refactor `executeDisputeResolution()` to accept `DisputeTask` parameter
- Remove dependency on `config.execution.disputeContext`
- Ensure ALL dispute replies include rmcoc blocks
- Never use raw text for state determination
- Update state via rmcoc blocks only
- Format dispute resolution replies with structured data

**Out of Scope**:

- Changing core dispute resolution logic
- Prompt changes (Task 3.6)

**Success Criteria**:

- [ ] Method accepts DisputeTask parameter (or null for batch mode)
- [ ] No dependency on config for dispute context
- [ ] All dispute replies have rmcoc blocks
- [ ] State updates only via rmcoc blocks
- [ ] No raw text parsing for status
- [ ] Compiles without errors
- [ ] Integration with executeAllTasks() works

**Deliverables**:

```typescript
async executeDisputeResolution(task?: DisputeTask): Promise<TaskResult> {
  if (task) {
    // Handle single dispute
    return await this.handleSingleDispute(task)
  } else {
    // Handle batch disputes (existing logic)
    return await this.handleBatchDisputes()
  }
}

private async handleSingleDispute(task: DisputeTask): Promise<TaskResult> {
  // Sanitize input
  // Classify reply
  // Generate response
  // Post reply with rmcoc block
  // Update thread status via rmcoc block
  // Return result
}

private formatDisputeReply(
  resolution: 'RESOLVED' | 'DISPUTED' | 'ESCALATED',
  reason: string,
  reply: string
): string {
  // Include rmcoc block in reply
}
```

**Estimated Time**: 1.5-2 hours

---

### Task 3.5: Refactor Full Review Execution

**File**: `src/execution/orchestrator.ts` (MODIFY)

**In Scope**:

- Refactor `executeReview()` → `executeFullReview()` to accept `ReviewTask`
  parameter
- Remove dependency on
  `config.execution.mode/isManuallyTriggered/triggerCommentId`
- Track whether review was auto-triggered
- Update manual review request status via rmcoc blocks
- Handle start/end comment updates for manual reviews
- Preserve existing 3-pass review logic
- Mark manual review as DISMISSED_BY_AUTO_REVIEW if auto review ran

**Out of Scope**:

- Changing core review logic
- Changing pass structure
- Prompt changes (Task 3.6)

**Success Criteria**:

- [ ] Method accepts ReviewTask parameter
- [ ] No dependency on config for execution context
- [ ] Auto review triggers tracked in state
- [ ] Manual review status updated via rmcoc blocks
- [ ] Start/end comments work correctly
- [ ] 3-pass review logic preserved
- [ ] Compiles without errors
- [ ] Integration with executeAllTasks() works

**Deliverables**:

```typescript
async executeFullReview(task: ReviewTask): Promise<TaskResult> {
  // Update manual review status if applicable (IN_PROGRESS)
  // Add start comment if manual and enabled
  // Load/create state
  // Run 3-pass review
  // Build output
  // Update manual review status (COMPLETED)
  // Add end comment if manual and enabled
  // Return result
}

private async updateManualReviewStatus(
  commentId: string,
  rmcocData: ManualReviewRmcocBlock
): Promise<void>

private async updateTriggerCommentWithProgress(
  commentId: string,
  status: 'IN_PROGRESS' | 'COMPLETED',
  result?: ReviewOutput
): Promise<void>
```

**Estimated Time**: 1.5-2 hours

---

### Task 3.6: Update Prompts

**File**: `src/execution/prompts.ts` (MODIFY)

**In Scope**:

- Add prompt for follow-up questions with conversation history
  - `ANSWER_FOLLOWUP_QUESTION(question, history, context)`
- Update existing prompts if needed for new context structure
- Ensure all prompts accept task-specific parameters (not config)

**Out of Scope**:

- Changing core prompt logic
- Adding new prompt types beyond follow-up questions

**Success Criteria**:

- [ ] New prompt for follow-up questions implemented
- [ ] Prompt includes conversation history formatting
- [ ] All prompts accept explicit parameters
- [ ] No dependencies on config structure
- [ ] Prompts compile without errors

**Deliverables**:

```typescript
// src/execution/prompts.ts
export const PROMPTS = {
  // Existing prompts...

  ANSWER_FOLLOWUP_QUESTION(
    question: string,
    conversationHistory: ConversationMessage[],
    prContext: { files: string[] }
  ): string
}
```

**Estimated Time**: 30 minutes - 1 hour

---

### Task 3.7: Add Error Comment Posting

**File**: `src/execution/orchestrator.ts` (MODIFY)

**In Scope**:

- Implement `postErrorComment()` method
- Post comment when task fails with error details
- Include task type and error message
- Tag relevant users if applicable
- Format as clear error notification

**Out of Scope**:

- Retry logic (exists at higher level)
- Error recovery strategies

**Success Criteria**:

- [ ] Method implemented
- [ ] Error comments posted on task failure
- [ ] Comments include task type and error details
- [ ] Comments are user-friendly
- [ ] Works for all task types

**Deliverables**:

```typescript
private async postErrorComment(
  task: Task,
  error: Error
): Promise<void> {
  // Format error message
  // Determine where to post (PR or specific comment)
  // Post comment
  // Log error
}
```

**Estimated Time**: 30 minutes

---

### Phase 3 Completion Checklist

- [ ] All 7 tasks completed
- [ ] Orchestrator renamed and moved
- [ ] Main execution loop implemented
- [ ] All task execution methods refactored
- [ ] rmcoc blocks used for all status updates
- [ ] Error handling implemented
- [ ] Compiles without errors
- [ ] Integration between components works

**Phase 3 Total Time**: 6-8 hours

---

## Phase 4: Main Entry Point (2-3 hours)

**Goal**: Wire all components together and implement exit code logic

### Task 4.1: Simplify Input Configuration

**File**: `src/config/inputs.ts` (MODIFY)

**In Scope**:

- Remove `detectExecutionMode()` function entirely
- Simplify `parseInputs()` to just parse and validate inputs
- Extract PR number from context
- Remove execution mode detection logic
- Remove all mode-related types and logic
- Update ReviewConfig type to remove
  execution.mode/questionContext/disputeContext

**Out of Scope**:

- Changing input parameter parsing
- Validation logic changes
- Adding new inputs

**Success Criteria**:

- [ ] `detectExecutionMode()` removed
- [ ] `parseInputs()` simplified
- [ ] No mode detection logic
- [ ] PR number extracted correctly
- [ ] ReviewConfig updated to new structure
- [ ] Compiles without errors
- [ ] All inputs still parsed correctly

**Deliverables**:

```typescript
// src/config/inputs.ts
export async function parseInputs(): Promise<ReviewConfig> {
  // Parse all inputs
  // Validate
  // Extract PR number from context
  // Return config (no execution mode)
}

// Remove: detectExecutionMode()
```

**Estimated Time**: 1 hour

---

### Task 4.2: Refactor Main Entry Point

**File**: `src/main.ts` (MODIFY)

**In Scope**:

- Remove old if/else mode execution blocks
- Create `TaskDetector` instance
- Call `detectAllTasks()` to get execution plan
- Pass plan to `orchestrator.executeAllTasks()`
- Implement exit code logic:
  - Check `wasAutoReviewTriggered()`
  - Auto review with blocking issues → exit code 1
  - Manual review with blocking issues → exit code 0
  - Legitimate errors → exit code 1
- Update output variables:
  - `tasks_executed`
  - `has_blocking_issues`
  - Remove mode-specific outputs
- Maintain proper cleanup in finally block

**Out of Scope**:

- Orchestrator implementation (Phase 3)
- Task detection implementation (Phase 1)
- Config parsing (Task 4.1)

**Success Criteria**:

- [ ] Old mode-based execution removed
- [ ] TaskDetector integration works
- [ ] ExecutionPlan passed to orchestrator
- [ ] Exit code logic correct for all scenarios
- [ ] Auto review merge gate preserved
- [ ] Manual review doesn't fail action
- [ ] Error handling works correctly
- [ ] Output variables set correctly
- [ ] Cleanup still works
- [ ] Compiles without errors

**Deliverables**:

```typescript
// src/main.ts
export async function run(): Promise<void> {
  try {
    // Setup (existing)

    // NEW: Task detection
    const taskDetector = new TaskDetector(llmClient)
    const currentState = await orchestrator.stateManager.getOrCreateState()

    const executionPlan = await taskDetector.detectAllTasks(
      github.context,
      github,
      currentState
    )

    // NEW: Execute all tasks
    const result = await orchestrator.executeAllTasks(executionPlan)

    // NEW: Exit code logic
    const wasAutoTriggered = await orchestrator.wasAutoReviewTriggered()

    if (wasAutoTriggered && result.hasBlockingIssues) {
      core.setFailed('Review found blocking issues')
      exitCode = 1
    } else if (!wasAutoTriggered && result.hasBlockingIssues) {
      logger.warning('Manual review found blocking issues (not failing action)')
      exitCode = 0
    }

    // Clear trigger
    if (result.reviewCompleted) {
      await orchestrator.clearAutoReviewTrigger()
    }

    core.setOutput('tasks_executed', String(result.totalTasks))
    core.setOutput('has_blocking_issues', String(result.hasBlockingIssues))
  } catch (error) {
    // Error handling (existing)
    exitCode = 1
  } finally {
    // Cleanup (existing)
    process.exit(exitCode)
  }
}
```

**Estimated Time**: 1-1.5 hours

---

### Task 4.3: Update Type Imports

**Files**: All files with updated imports

**In Scope**:

- Update all imports to new file locations
- Ensure all type references are correct
- Remove unused imports
- Fix any circular dependency issues

**Out of Scope**:

- Functional changes
- Adding new functionality

**Success Criteria**:

- [ ] All imports updated
- [ ] No unused imports
- [ ] No circular dependencies
- [ ] Compiles without errors
- [ ] No runtime import errors

**Deliverables**:

- Updated imports in all affected files

**Estimated Time**: 30 minutes

---

### Phase 4 Completion Checklist

- [ ] All 3 tasks completed
- [ ] Input configuration simplified
- [ ] Main entry point refactored
- [ ] Task detection integrated
- [ ] Exit code logic correct
- [ ] All imports updated
- [ ] Compiles without errors
- [ ] Application runs end-to-end

**Phase 4 Total Time**: 2-3 hours

---

## Phase 5: Workflow Cleanup (1 hour)

**Goal**: Update workflow files to single consolidated workflow

### Task 5.1: Update Main Workflow

**File**: `.github/workflows/pr-review.yml` (MODIFY)

**In Scope**:

- Restore single workflow structure
- Remove deprecation notice
- Add all three event triggers:
  - `pull_request` (opened, synchronize, ready_for_review)
  - `issue_comment` (created)
  - `pull_request_review_comment` (created)
- Set concurrency:
  - Group by PR number
  - `cancel-in-progress: true`
- Ensure proper checkout for all event types
- Use single action configuration

**Out of Scope**:

- Changing action inputs
- Adding new workflows

**Success Criteria**:

- [ ] Workflow handles all three event types
- [ ] Concurrency configured correctly
- [ ] Checkout works for all events
- [ ] Workflow triggers on correct events
- [ ] YAML is valid
- [ ] Workflow can be enabled

**Deliverables**:

```yaml
# .github/workflows/pr-review.yml
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

    # ... rest of job configuration
```

**Estimated Time**: 30 minutes

---

### Task 5.2: Remove Separate Workflows

**Files**:

- `.github/workflows/auto-pr-review.yml` (DELETE)
- `.github/workflows/bot-mentions.yml` (DELETE)
- `.github/workflows/dispute-resolution.yml` (DELETE)

**In Scope**:

- Delete the three separate workflow files
- Verify they're not referenced elsewhere

**Out of Scope**:

- Modifying main workflow (Task 5.1)

**Success Criteria**:

- [ ] Three workflow files deleted
- [ ] No references to deleted files remain
- [ ] Git shows files as deleted

**Deliverables**:

- Deleted files

**Estimated Time**: 5 minutes

---

### Task 5.3: Update Workflow Documentation

**File**: `README.md` or workflow comments (MODIFY)

**In Scope**:

- Update documentation to reflect single workflow
- Explain multi-task execution behavior
- Document concurrency strategy
- Update any workflow-related examples

**Out of Scope**:

- Full README rewrite
- Code documentation (in code comments)

**Success Criteria**:

- [ ] Documentation updated
- [ ] Workflow behavior explained
- [ ] Concurrency strategy documented
- [ ] Examples accurate

**Deliverables**:

- Updated documentation

**Estimated Time**: 25 minutes

---

### Phase 5 Completion Checklist

- [ ] All 3 tasks completed
- [ ] Single workflow configured
- [ ] Separate workflows removed
- [ ] Documentation updated
- [ ] Workflows validated

**Phase 5 Total Time**: 1 hour

---

## Phase 6: Integration Testing (4-5 hours)

**Goal**: Comprehensive testing of all scenarios and edge cases

### Task 6.1: Test Multiple Questions

**Scenario**: Developer posts 3 questions in rapid succession

**In Scope**:

- Trigger 3 question comments quickly
- Verify all 3 detected
- Verify all 3 answered
- Verify conversation history works
- Verify rmcoc blocks added correctly

**Out of Scope**:

- Performance testing
- Load testing

**Success Criteria**:

- [ ] All 3 questions detected in single run
- [ ] All 3 questions answered
- [ ] Answers include proper attribution
- [ ] rmcoc blocks present on all comments
- [ ] Conversation history works for follow-ups
- [ ] No errors in logs

**Test Steps**:

1. Create test PR
2. Post 3 @ mention questions quickly
3. Verify workflow runs once
4. Verify all 3 questions answered
5. Verify rmcoc blocks present
6. Post follow-up question
7. Verify conversation history included

**Estimated Time**: 1 hour

---

### Task 6.2: Test Multiple Disputes

**Scenario**: Developer replies to 2 review threads quickly

**In Scope**:

- Create review with 2 findings
- Post replies to both
- Verify both disputes detected
- Verify both resolved
- Verify rmcoc blocks used for all state

**Out of Scope**:

- Testing dispute escalation (separate test)

**Success Criteria**:

- [ ] Both disputes detected
- [ ] Both disputes resolved
- [ ] All replies have rmcoc blocks
- [ ] State determined only via rmcoc blocks
- [ ] No raw text parsing used
- [ ] Thread statuses updated correctly

**Test Steps**:

1. Create PR with 2 review findings
2. Reply to both threads as developer
3. Verify workflow runs
4. Verify both disputes handled
5. Verify rmcoc blocks in all replies
6. Verify thread status updated

**Estimated Time**: 45 minutes

---

### Task 6.3: Test Question + Dispute + Review

**Scenario**: Question asked while disputes pending and PR ready for review

**In Scope**:

- Create scenario with all three task types
- Verify all detected
- Verify execution order (disputes → question → review)
- Verify all complete successfully
- Verify single OpenCode session used

**Out of Scope**:

- Testing each task type in isolation (previous tests)

**Success Criteria**:

- [ ] All 3 task types detected
- [ ] Execution order correct (priority-based)
- [ ] All tasks complete
- [ ] Single session maintained
- [ ] State updated after each task
- [ ] Exit code correct based on review results

**Test Steps**:

1. Create PR with review findings
2. Developer replies to findings
3. Developer posts @ question
4. Push new changes (auto review trigger)
5. Verify all tasks detected
6. Verify execution order
7. Verify all complete

**Estimated Time**: 1 hour

---

### Task 6.4: Test Manual Review Dismissed by Auto

**Scenario**: Manual review requested, then auto review triggered

**In Scope**:

- Request manual review via @ mention
- Trigger auto review (synchronize)
- Verify manual review dismissed
- Verify comment posted explaining dismissal
- Verify rmcoc block shows DISMISSED_BY_AUTO_REVIEW

**Out of Scope**:

- Testing manual review completion (separate test)

**Success Criteria**:

- [ ] Manual review detected
- [ ] Auto review detected
- [ ] Manual review dismissed
- [ ] rmcoc block shows DISMISSED_BY_AUTO_REVIEW
- [ ] Explanatory comment posted
- [ ] Only one review executed
- [ ] Review results posted

**Test Steps**:

1. Post @ mention requesting review
2. Push new changes (trigger auto review)
3. Verify manual review dismissed
4. Verify dismissal comment posted
5. Verify rmcoc block correct
6. Verify single review executed

**Estimated Time**: 30 minutes

---

### Task 6.5: Test Cancelled Auto Review

**Scenario**: Auto review started, cancelled by @ question, restarted

**In Scope**:

- Start auto review (synchronize)
- Quickly post @ question (cancels review)
- Verify question answered
- Verify auto review restarted
- Verify merge gate preserved if blocking issues found

**Out of Scope**:

- Testing non-cancelled auto reviews

**Success Criteria**:

- [ ] Auto review trigger recorded in state
- [ ] Question cancels auto review
- [ ] Question answered first
- [ ] Auto review restarted
- [ ] Auto review marked as resumed
- [ ] Exit code 1 if blocking issues (merge gate preserved)
- [ ] State cleared after completion

**Test Steps**:

1. Push changes to trigger auto review
2. Immediately post @ question
3. Verify run cancelled
4. Verify new run starts
5. Verify question answered
6. Verify auto review runs
7. Verify exit code correct
8. Verify state shows auto trigger was used

**Estimated Time**: 45 minutes

---

### Task 6.6: Test Exit Codes

**Scenario**: Verify exit codes correct for all scenarios

**In Scope**:

- Auto review with no issues → exit 0
- Auto review with non-blocking issues → exit 0
- Auto review with blocking issues → exit 1
- Manual review with blocking issues → exit 0
- Cancelled auto review restarted with blocking issues → exit 1
- Network/API error → exit 1

**Out of Scope**:

- Testing review logic itself

**Success Criteria**:

- [ ] All exit codes correct
- [ ] Merge gate works for auto reviews
- [ ] Manual reviews don't block merge
- [ ] Cancelled reviews preserve merge gate
- [ ] Errors fail appropriately

**Test Steps**:

1. Test each scenario
2. Verify exit code
3. Verify GitHub Actions status (success/failure)

**Estimated Time**: 30 minutes

---

### Task 6.7: Test Error Handling

**Scenario**: Various error conditions

**In Scope**:

- Network timeout during question answering
- API error during review
- Invalid rmcoc block in comment
- Malformed comment body
- Verify error comments posted
- Verify action fails with exit 1

**Out of Scope**:

- Testing all possible errors exhaustively

**Success Criteria**:

- [ ] Errors caught and handled
- [ ] Error comments posted
- [ ] Action fails with exit 1
- [ ] Error messages are clear
- [ ] State remains consistent

**Test Steps**:

1. Simulate various errors
2. Verify error handling
3. Verify error comments
4. Verify exit codes
5. Verify state consistency

**Estimated Time**: 45 minutes

---

### Phase 6 Completion Checklist

- [ ] All 7 test scenarios passed
- [ ] All success criteria met
- [ ] No regressions found
- [ ] Edge cases handled
- [ ] Error handling works
- [ ] Exit codes correct
- [ ] Merge gate preserved

**Phase 6 Total Time**: 4-5 hours

---

## Overall Success Criteria

### Functional Requirements

- [ ] **FR1**: All pending questions detected and answered on every run
- [ ] **FR2**: All pending disputes detected and resolved on every run
- [ ] **FR3**: Auto review triggered when appropriate
- [ ] **FR4**: Manual reviews dismissed when auto review runs
- [ ] **FR5**: Conversation history included for follow-up questions
- [ ] **FR6**: All state tracked via rmcoc blocks (no raw text parsing)
- [ ] **FR7**: Exit code 1 for auto reviews with blocking issues
- [ ] **FR8**: Exit code 0 for manual reviews with blocking issues
- [ ] **FR9**: Cancelled auto reviews restarted and merge gate preserved
- [ ] **FR10**: Single OpenCode session reused across all tasks

### Non-Functional Requirements

- [ ] **NFR1**: Code compiles without errors
- [ ] **NFR2**: All existing tests pass
- [ ] **NFR3**: Code follows existing style guidelines
- [ ] **NFR4**: No breaking changes to action inputs
- [ ] **NFR5**: Proper error handling throughout
- [ ] **NFR6**: Comprehensive logging for debugging
- [ ] **NFR7**: State management is atomic and consistent
- [ ] **NFR8**: No circular dependencies introduced

### Documentation Requirements

- [ ] **DR1**: All new types have JSDoc comments
- [ ] **DR2**: All new methods have JSDoc comments
- [ ] **DR3**: refactor-plan.md complete and accurate
- [ ] **DR4**: This tasklist reflects actual implementation
- [ ] **DR5**: README updated with new workflow behavior
- [ ] **DR6**: Workflow YAML has explanatory comments

---

## Out of Scope for Entire Refactor

### Explicitly Not Included

1. **Performance Optimizations**: No focus on speed improvements beyond
   maintaining current performance
2. **New Features**: No new functionality beyond multi-task execution
3. **UI Changes**: No changes to comment formatting or visual presentation
   (beyond rmcoc blocks)
4. **Testing Framework Changes**: No changes to test infrastructure
5. **CI/CD Changes**: No changes to build/deployment process (beyond workflow
   updates)
6. **Backwards Compatibility**: No support for old rmcoc block formats (action
   unreleased)
7. **Rate Limiting Implementation**: Design supports it, but not implemented
8. **Parallel Task Execution**: All tasks execute sequentially
9. **Task Queueing**: If run fails, tasks retry on next run (no persistent
   queue)
10. **Metrics/Analytics**: No tracking or reporting of task statistics
11. **Retry Logic**: No automatic task retry on failure (run-level retry exists)
12. **Custom Task Priorities**: Priorities are fixed (disputes=1, questions=2,
    reviews=3)

---

## Risk Register

### High Priority Risks

1. **State Corruption**
   - Mitigation: Comprehensive validation, fallback to empty state
   - Owner: Phase 2
2. **Merge Gate Bypass**
   - Mitigation: Careful exit code logic, extensive testing
   - Owner: Phase 4, Task 6.6

3. **Lost Tasks**
   - Mitigation: rmcoc block tracking, deduplication logic
   - Owner: Phase 1, Task 1.4

### Medium Priority Risks

4. **Performance Degradation**
   - Mitigation: Single session, efficient API calls
   - Owner: All phases

5. **Race Conditions**
   - Mitigation: Sequential execution, atomic updates
   - Owner: Phase 3

6. **Circular Dependencies**
   - Mitigation: Clear separation of concerns, careful imports
   - Owner: All phases

### Low Priority Risks

7. **Incomplete Documentation**
   - Mitigation: JSDoc on all new code
   - Owner: All phases

8. **Test Coverage Gaps**
   - Mitigation: Comprehensive Phase 6 testing
   - Owner: Phase 6

---

## Dependency Graph

```
Phase 1 (Foundation)
  ├─ Task 1.1: State Types ────┐
  ├─ Task 1.2: Task Types ─────┤
  ├─ Task 1.3: Serializer ─────┤
  ├─ Task 1.4: Detector ───────┤ (depends on 1.1, 1.2, 1.3, 1.5)
  ├─ Task 1.5: GitHub API ─────┤
  └─ Task 1.6: Move Classifier ┘
                               │
Phase 2 (State Management) <───┘
  ├─ Task 2.1: Refactor StateManager (depends on 1.1, 1.3)
  ├─ Task 2.2: State Persistence (depends on 2.1)
  └─ Task 2.3: Update References (depends on 2.1)
                               │
Phase 3 (Orchestrator) <───────┘
  ├─ Task 3.1: Rename Files
  ├─ Task 3.2: Execution Loop (depends on 1.2, 2.1)
  ├─ Task 3.3: Question Exec (depends on 3.2, 1.3)
  ├─ Task 3.4: Dispute Exec (depends on 3.2, 1.3)
  ├─ Task 3.5: Review Exec (depends on 3.2, 1.3)
  ├─ Task 3.6: Update Prompts
  └─ Task 3.7: Error Comments
                               │
Phase 4 (Main Entry) <─────────┘
  ├─ Task 4.1: Simplify Inputs
  ├─ Task 4.2: Refactor Main (depends on 1.4, 3.2)
  └─ Task 4.3: Update Imports (depends on all)
                               │
Phase 5 (Workflows) <──────────┘
  ├─ Task 5.1: Update Workflow
  ├─ Task 5.2: Remove Old Workflows
  └─ Task 5.3: Update Docs
                               │
Phase 6 (Testing) <────────────┘
  ├─ Task 6.1: Test Questions
  ├─ Task 6.2: Test Disputes
  ├─ Task 6.3: Test All Tasks
  ├─ Task 6.4: Test Dismissal
  ├─ Task 6.5: Test Cancelled
  ├─ Task 6.6: Test Exit Codes
  └─ Task 6.7: Test Errors
```

---

## Estimated Timeline

**Sequential Development** (one developer):

- Phase 1: 4-6 hours (Day 1)
- Phase 2: 3-4 hours (Day 1-2)
- Phase 3: 6-8 hours (Day 2-3)
- Phase 4: 2-3 hours (Day 3)
- Phase 5: 1 hour (Day 3)
- Phase 6: 4-5 hours (Day 3-4)

**Total**: 20-27 hours (3-4 working days)

**Parallel Development** (two developers):

- Developer A: Phases 1, 2, 4, 5 (10-14 hours)
- Developer B: Phase 3, 6 (10-13 hours)
- **Total**: ~2 working days

---

## Notes

- All tasks should be completed in order within each phase
- Each task includes specific success criteria for validation
- Phase completion checklists ensure quality gates are met
- Out of scope items clearly defined to prevent scope creep
- Risk mitigation strategies assigned to specific phases
- Dependencies mapped to prevent blocking issues

This tasklist should be updated as implementation progresses to reflect actual
completion status and any discovered issues or changes.
