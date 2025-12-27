# Architecture Overview

## Multi-Task Execution System

This document describes the architecture of the multi-task execution system
implemented in Phases 1-4 of the refactor.

## Core Concept

**Before:** The action operated in single-task mode - each GitHub event
triggered exactly one type of work (review, question, or dispute).

**After:** The action operates in multi-task mode - each run detects and
executes ALL pending work on the PR, regardless of which event triggered it.

### Why Multi-Task?

GitHub Actions concurrency settings can cancel in-progress runs when new events
arrive. The single-task model meant work could be lost:

- Developer posts a question → Action starts answering
- Developer pushes new code → Previous run cancelled, question never answered
- Auto review runs → Developer posts question → Review completes but question
  ignored

The multi-task system solves this by scanning for ALL pending work on every run.

## Architecture Layers

### Layer 1: Entry Point (main.ts)

```
GitHub Event → main.ts
    ↓
    Setup (OpenCode server, tRPC, clients)
    ↓
    Create ExecutionOrchestrator
    ↓
    orchestrator.execute()
    ↓
    Aggregate results & set exit code
```

**Responsibilities:**

- Initialize all services and dependencies
- Create ExecutionOrchestrator with required components
- Execute multi-task workflow
- Aggregate results for GitHub Actions outputs
- Clean up resources

**Key Change:** Replaced 200+ lines of mode-specific logic with single
orchestrator call.

### Layer 2: Execution Orchestration (ExecutionOrchestrator)

```typescript
class ExecutionOrchestrator {
  async execute(): Promise<ExecutionResult>
  private async detectAllTasks(): Promise<ExecutionPlan>
  private async executeTask(task: Task): Promise<TaskResult>
}
```

**Responsibilities:**

- Coordinate the entire multi-task workflow
- Detect all pending work via TaskDetector
- Execute tasks in priority order
- Track state via StateManager
- Aggregate and return results

**Task Execution Flow:**

1. Detect all pending tasks (disputes, questions, reviews)
2. Sort by priority (disputes=1, questions=2, reviews=3)
3. Execute each task sequentially
4. Update state as tasks complete
5. Return aggregated results

### Layer 3: Task Detection (TaskDetector)

```typescript
class TaskDetector {
  async detectAllTasks(context, githubApi, state): Promise<ExecutionPlan>
  private async detectPendingDisputes(): Promise<DisputeTask[]>
  private async detectPendingQuestions(): Promise<QuestionTask[]>
  private async detectReviewRequest(): Promise<ReviewTask[]>
}
```

**Responsibilities:**

- Scan PR for all types of pending work
- Use rmcoc blocks to determine status
- Deduplicate tasks
- Handle special cases (auto review dismisses manual)

#### Dispute Detection

Scans review thread comments for:

1. Comments with `rmcoc` blocks of type `review-finding`
2. Status is `PENDING` or `DISPUTED`
3. Developer has replied after last bot comment

**Data Source:** Review thread comments (via GitHub API)

#### Question Detection

Scans issue comments for:

1. Comments containing `@review-my-code-bot`
2. Not already answered (no `question-answer` rmcoc block)
3. Question text extracted after @ mention

**Data Source:** Issue comments (via GitHub API)

#### Review Detection

Determines if a review should run:

1. **Auto Review:** Triggered by PR events (opened, synchronize,
   ready_for_review)
2. **Manual Review:** Triggered by @ mention with review intent
3. **Cancelled Review Resumption:** Auto review that was cancelled mid-run

**Special Logic:** When auto review starts, any pending manual review is
dismissed.

### Layer 4: Task Execution (ReviewOrchestrator)

The ExecutionOrchestrator delegates actual work to ReviewOrchestrator:

```typescript
// Existing ReviewOrchestrator methods reused:
reviewOrchestrator.executeDisputeResolution(disputeContext)
reviewOrchestrator.executeQuestionAnswering()
reviewOrchestrator.executeReview()
```

**No Changes Required:** The existing ReviewOrchestrator already had methods for
each task type. We simply call them in sequence now.

### Layer 5: State Management

#### StateManager (src/state/manager.ts)

Tracks:

- Review threads and their statuses
- Question tasks (pending → in_progress → answered)
- Manual review requests
- Auto review triggers

**New Methods Added:**

```typescript
trackQuestionTask(questionId, author, question, commentId, fileContext)
markQuestionInProgress(questionId)
markQuestionAnswered(questionId)
trackManualReviewRequest(requestId, author, commentId)
markManualReviewInProgress(requestId)
markManualReviewCompleted(requestId)
dismissManualReview(requestId, dismissedBy)
```

**Current State:** Methods are stubs that log. Full implementation deferred.

#### State Serialization (src/state/serializer.ts)

Handles rmcoc blocks for state persistence:

```typescript
extractRmcocBlock(commentBody): RmcocBlock | null
addRmcocBlock(commentBody, blockType, data): string
updateRmcocBlock(commentBody, blockType, data): string
```

**Supported Block Types:**

- `question` - Marks a question comment
- `question-answer` - Marks question as answered
- `manual-pr-review` - Marks manual review request
- `review-finding` - Review issue with status
- `dispute-resolution` - Dispute outcome

### Layer 6: GitHub Integration (GitHubAPI)

**New Helper Methods:**

```typescript
getAllIssueComments(): Promise<Comment[]>
getComment(commentId): Promise<Comment>
updateComment(commentId, body): Promise<void>
getCurrentSHA(): Promise<string>
hasNewDeveloperReply(threadId): Promise<boolean>
getThreadComments(threadId): Promise<Comment[]>
```

These methods support the TaskDetector in scanning for pending work.

## Data Flow

### Complete Execution Flow

```
1. GitHub Event Arrives
    ↓
2. main.ts initializes services
    ↓
3. ExecutionOrchestrator.execute()
    ↓
4. TaskDetector.detectAllTasks()
    ├─→ detectPendingDisputes()
    │   └─→ GitHubAPI.getThreadComments()
    │       └─→ Serializer.extractRmcocBlock()
    ├─→ detectPendingQuestions()
    │   └─→ GitHubAPI.getAllIssueComments()
    │       └─→ Check for unanswered questions
    └─→ detectReviewRequest()
        └─→ Check PR event or manual request
    ↓
5. Tasks sorted by priority
    ↓
6. For each task:
    ├─→ StateManager.trackTask() [if applicable]
    ├─→ ReviewOrchestrator.executeTask()
    └─→ StateManager.markTaskComplete() [if applicable]
    ↓
7. Aggregate results
    ↓
8. Set GitHub Actions outputs
    ↓
9. Exit with appropriate code
```

## Type System

### Core Types

**Task Types** (src/task/types.ts):

```typescript
type DisputeTask = {
  type: 'dispute-resolution'
  priority: 1
  disputeContext: DisputeContext
}

type QuestionTask = {
  type: 'question-answering'
  priority: 2
  questionContext: QuestionContext
  conversationHistory: ConversationMessage[]
  isManuallyTriggered: boolean
  triggerCommentId?: string
}

type ReviewTask = {
  type: 'full-review'
  priority: 3
  isManual: boolean
  triggerCommentId?: string
  triggeredBy: 'opened' | 'synchronize' | 'ready_for_review' | 'manual-request'
  resumingCancelled?: boolean
}

type Task = DisputeTask | QuestionTask | ReviewTask
```

**Execution Types:**

```typescript
type ExecutionPlan = {
  tasks: Task[]
  triggeredBy: string
}

type TaskResult = {
  type: 'dispute-resolution' | 'question-answering' | 'full-review'
  success: boolean
  issuesFound: number
  blockingIssues: number
  error?: string
}

type ExecutionResult = {
  results: TaskResult[]
  hasBlockingIssues: boolean
  totalTasks: number
  reviewCompleted: boolean
}
```

**State Types** (src/state/types.ts):

```typescript
type ProcessState = {
  reviewThreads: ReviewThread[]
  questionTasks: QuestionTask[]
  manualReviewRequests: ManualReviewRequest[]
  metadata: ProcessMetadata
}
```

## Priority System

Tasks are executed in strict priority order:

1. **Priority 1: Disputes** - Developer engaged in active discussion
2. **Priority 2: Questions** - Developer waiting for answer
3. **Priority 3: Reviews** - Automated analysis

**Rationale:**

- Disputes are time-sensitive (developer is actively engaged)
- Questions block developer work
- Reviews are background work

## Special Cases

### Auto Review Dismisses Manual Review

When an auto review starts (PR event), any pending manual review request is
dismissed:

```
Manual review requested → Developer pushes code → Auto review runs
                                                      ↓
                                          Manual review dismissed
                                          (comment updated with reason)
```

This prevents duplicate reviews on the same commit.

### Merge Gate Preservation

If an auto review is cancelled mid-run, the next run will:

1. Detect the cancelled review via state tracking
2. Resume/restart the review
3. Preserve exit code behavior (fail on blocking issues)

This ensures the merge gate still works even if runs are cancelled.

## File Structure

```
src/
├── main.ts                    # Entry point, orchestration setup
├── task/
│   ├── orchestrator.ts        # ExecutionOrchestrator
│   ├── detector.ts            # TaskDetector
│   ├── classifier.ts          # Intent classification (moved)
│   └── types.ts               # Task type definitions
├── state/
│   ├── manager.ts             # StateManager (moved from github/)
│   ├── serializer.ts          # rmcoc block handling
│   └── types.ts               # ProcessState definitions
├── github/
│   └── api.ts                 # GitHub API client (+6 methods)
└── review/
    └── orchestrator.ts        # ReviewOrchestrator (unchanged)
```

## Testing Strategy

**Unit Tests:**

- State serializer (rmcoc block parsing)
- Intent classifier (question vs review intent)
- Individual components in isolation

**Integration Tests:**

- Full end-to-end execution (future work)
- Multi-task scenarios (future work)

**Current Coverage:**

- 85/85 tests passing
- StateManager: 32 tests
- Intent Classifier: 9 tests
- Security: 31 tests
- Config: 13 tests

## Performance Characteristics

**Time Complexity:**

- Task detection: O(n) where n = number of comments
- Task execution: O(t) where t = number of tasks
- Total: O(n + t)

**API Calls:**

- Issue comments: 1 paginated call
- Review threads: 1 paginated call per thread
- Comment updates: 1 call per update

**Concurrency:**

- Tasks execute sequentially (by design)
- Each task may spawn parallel OpenCode operations
- No rate limiting implemented (future work)

## Migration Path

### Phase 1-4 Complete ✅

- Foundation types and detection
- State management updates
- Execution orchestration
- Main.ts integration

### Future Work

**Remaining from Original Plan:**

- Full state persistence (StateManager methods are stubs)
- Comprehensive integration tests
- Performance optimization
- Rate limiting
- Error recovery strategies

**Known Issues:**

- TaskDetector/Orchestrator signature mismatch (documented)
- StateManager tracking methods are logging-only stubs
- No cleanup of very old rmcoc blocks

## Design Decisions

### 1. Sequential Task Execution

**Decision:** Execute tasks sequentially, not in parallel

**Rationale:**

- Simpler error handling
- Easier state tracking
- OpenCode session can't handle parallel operations
- Total time is acceptable (most runs have 1-2 tasks)

### 2. Priority-Based Ordering

**Decision:** Always execute disputes first, then questions, then reviews

**Rationale:**

- Disputes are developer-initiated (time-sensitive)
- Questions block developer work
- Reviews are background work

### 3. rmcoc Blocks for State

**Decision:** Use embedded JSON blocks in comments for state

**Rationale:**

- No external database required
- State is visible in GitHub UI
- Works with GitHub's comment model
- Survives action crashes

### 4. Incremental Refactor

**Decision:** Keep ReviewOrchestrator unchanged, wrap it with
ExecutionOrchestrator

**Rationale:**

- Minimize risk of breaking existing functionality
- Smaller, testable changes
- Can migrate ReviewOrchestrator internals later

### 5. Deferred State Persistence

**Decision:** StateManager methods are stubs for now

**Rationale:**

- Core orchestration working without full state persistence
- Can implement incrementally
- Existing rmcoc blocks provide minimal state tracking

## Extensibility

### Adding New Task Types

1. Define new task type in `src/task/types.ts`
2. Add detection logic to `TaskDetector`
3. Add execution method to `ReviewOrchestrator`
4. Wire up in `ExecutionOrchestrator.executeTask()`
5. Update priority constants if needed

### Adding New State Tracking

1. Define new state type in `src/state/types.ts`
2. Add rmcoc block type to serializer
3. Add tracking methods to StateManager
4. Call from ExecutionOrchestrator

## Glossary

**rmcoc block:** JSON embedded in comment via code fence (```rmcoc), used for
state persistence

**Task:** Unit of work detected and executed (dispute, question, or review)

**ExecutionPlan:** List of tasks to execute in a single run

**ProcessState:** Complete state of all work on a PR (reviews, questions, manual
requests)

**Priority:** Ordering value for tasks (1=highest, 3=lowest)

**Merge Gate:** GitHub status check that fails PR if blocking issues found
