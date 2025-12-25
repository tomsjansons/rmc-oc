# Design Document: OpenCode PR Reviewer Agent

## 1. Motivation & Problem Statement

Code reviews are essential for maintaining quality, but they often become a
bottleneck or suffer from inconsistency. Existing automated tools (linters) are
too shallow, while many AI reviewers are either too "noisy" (nit-picking) or
lack the context of the entire repository to understand complex logic.

The **OpenCode PR Reviewer** aims to bridge this gap by acting as a "Senior
Developer" agent. It doesn't just look at diffs; it uses the OpenCode SDK to
explore the codebase, verify assumptions, enforce project-specific rules
(`AGENTS.md`), and maintain a stateful memory of discussions across commits.

---

## 2. General Review Principles

The agent operates under a strict "Value-Add" philosophy:

- **Contextual Awareness:** Review code as a human would—starting with
  individual diffs and expanding to the PR's impact on the whole system.
- **Proportionality:** Suggestions (especially refactors) must be proportional
  to the change. It should not suggest a rewrite of a module for a 2-line fix.
- **Non-Obligatory Feedback:** If the code is good, the agent says nothing.
  Silence is preferred over low-value noise.
- **Stateful Interaction:** The agent remembers previous suggestions and
  developer counter-arguments, allowing for an evolving technical conversation.
- **Security First:** Every PR undergoes a security audit tailored to the
  sensitivity of the application.

---

## 3. Detailed Functionality

### 3.1. The Issue Severity Rubric (problem_score_threshold)

The Agent must assign a score from **1 to 10** for every identified issue. This
score determines whether the issue is reported based on the user-defined
`problem_threshold` (Default: 5).

#### Scoring Criteria & Guidance

##### **Level 1–2: Pure Nit-picks**

_Items that have zero impact on the code’s execution, security, or reliability._

- **1 (Micro-Nit):** Extremely subjective preferences. (e.g., suggesting
  `Array.from` instead of a spread operator where performance is irrelevant).
- **2 (Stylistic Nit):** Inconsistencies that aren't caught by a linter but
  don't hinder readability. (e.g., "The variable name `data` is a bit generic
  here, maybe `userData`?").

##### **Level 3–4: Quality & Maintenance**

_Items that impact the "developer experience" and long-term health, but aren't
"bugs"._

- **3 (Minor Improvement):** Redundant code or slightly confusing naming. (e.g.,
  a function that is 5 lines longer than necessary due to a verbose if/else
  block).
- **4 (Readability/Documentation):** Missing documentation on a complex public
  method or an exported type that is difficult to parse. (e.g., "This Regex is
  complex; it would benefit from a comment explaining the groups.").

##### **Level 5–6: Best Practices & Efficiency**

_The default threshold. Issues here involve deviations from industry standards
or suboptimal patterns._

- **5 (Suboptimal Pattern):** Using a pattern that works but is known to be
  brittle. (e.g., passing 6 individual arguments instead of an options object).
- **6 (Local Performance/Complexity):** Code that is unnecessarily "heavy."
  (e.g., mapping over a large array twice instead of once, or a nested loop that
  could be a Map lookup).

##### **Level 7–8: Logic, Edge Cases & Consistency**

_Serious issues where the code might fail under specific conditions or violates
the `AGENTS.md` rules._

- **7 (Logic Risk):** A missing edge case. (e.g., "You handle the success and
  error states, but if the API returns an empty array, the UI will crash on line
  42.").
- **8 (Structural/Rule Violation):** Direct violation of `AGENTS.md` or
  architectural standards. (e.g., a UI component performing direct DB queries
  instead of using the established service layer).

##### **Level 9–10: Critical Failures (The "OMG/WTF" Category)**

_Issues that require immediate blocking of the PR. These are objective and
dangerous._

- **9 (Major Bug / Security Leak):** High probability of failure or data
  exposure. (e.g., a SQL injection risk, missing authorization check on a
  sensitive endpoint, or a race condition in a payment flow).
- **10 (Systemic Catastrophe):** Fundamental failures. (e.g., hardcoded
  production secrets, encryption using a deprecated/broken algorithm like MD5
  for passwords, or logic that could lead to mass data loss/corruption).

#### Implementation Guidance for the Agent

1.  **Threshold Enforcement:** If a user sets `problem_threshold: 7`, the Agent
    will remain silent on all naming and "clean code" suggestions (Levels 1–6),
    focusing only on logic, rules, and security.
2.  **The "Silent" Default:** If the Agent identifies multiple Level 2 issues
    but the threshold is 5, it **must not** bundle them into a single comment
    just to be "helpful." It should remain silent.
3.  **Refactor Proportionality:**
    - A Level 4 suggestion should only suggest a refactor of ~5 lines.
    - A Level 8 suggestion may justify a refactor of the entire touched
      function/module to ensure the logic risk is mitigated.
4.  **Security Sensitivity:**
    - The Agent shall automatically promote any "Security Pass" finding by **+2
      points** if the repository is identified (via `package.json` or `README`)
      as handling PII (Personally Identifiable Information) or Financial data.
5.  **Comment tool filtering** will be implemented to silence issues found and
    submitted below the score threshold.
6.  **Score elevation:** It is acceptable in rare cases for a large number (>=
    score_elevation_threshold) of low score issues to be combine and gain an
    elevated score.

### 3.2. Automated State Management

The agent maintains review state entirely through GitHub PR review comments
using structured `rmcoc` code blocks. State is automatically reconstructed on
each run by parsing previous review comments - there is no reliance on GitHub
Actions Cache which has proven unreliable.

The "run state" tool reconstructs the complete review state by:

1. Fetching all PR review comments via GitHub API
2. Filtering for bot-authored comments (`opencode-reviewer[bot]`,
   `github-actions[bot]`)
3. Extracting `rmcoc` JSON blocks from each comment
4. Building thread state by analyzing comment replies and status markers
5. Collecting developer replies to track dispute history

This state helps with the following

- **Issue Tracking:** Which issues were raised and which are "Resolved,"
  "Pending," or "Disputed."
- **Fix Verification:** On subsequent pushes, the agent automatically checks if
  the code changes addressed previous comments.
- **Cross-File Resolution:** If an issue in `file_A.ts` is fixed by a change in
  `file_B.ts`, the agent must identify this using OpenCode exploration tools and
  resolve the original thread.

The raised issues by the Revie Agent must be sufficiently addressed either by
code fixes/changes or by a resonable explanation on why the issue is not
relevant, out of scope or will be addressed in future PRs. The Review Agent must
evaluate the reasoning of this dispute and resolve the comment only if it agrees
with the rasoning. If the reasoning is flawed or the unaddressed issue poses an
elevated risk (for exampel if a followup would addrss the problem but in the
meantime it may cuase data corruption, security risk, etc ), the Review Agent
must reject the Dispute and it may not resolve the comments.

If the Agent disagress with the Dispute and the Developer does not accept the
Disagrement, the final decision should be left to a human reviewer to resolve.
If the PR does not have human reviewers, the Developer's opinion takes
precedence

### 3.3. Security Pass

The agent evaluates the PR for:

- **Access Control:** Potential for cross-user data leakage or unauthed access.
- **Data Integrity:** Proper handling of sensitive fields (encryption where
  appropriate).
- **Contextual Sensitivity:** Security rigor scales with the tool's purpose
  (e.g., high for finance, moderate for internal tools).

## 4. Technical Architecture

### 4.1. Structure & Responsibilities

The project is built with a clean separation of concerns:

- **Action Wrapper:** Handles GitHub Event triggers and environment setup.
- **State Controller:** Manages the lifecycle of the GitHub Cache and state
  persistence.
- **OpenCode Orchestrator:** Manages the OpenCode server lifecycle. It ensures a
  read-only environment.
- **Agent Brain:** Uses the OpenCode SDK to execute the multi-pass review logic.

### 4.2. Review Agent Tooling

#### 1. Repository Exploration Tools (OpenCode Built-in)

These tools leverage the OpenCode SDK to provide the agent with deep context
beyond the PR diff.

Tool description availabel at https://opencode.ai/docs/tools/

- read
- grep
- glob
- list
- todowrite
- todoread

#### 2. GitHub Interaction & State Tools

These tools are the primary interface for the agent to communicate and maintain
state.

##### Comment Format Requirements for State Reconstruction

All review comments posted by the agent **MUST** include an embedded `rmcoc`
JSON code block to enable state reconstruction. The comment format is:

````markdown
[Human-readable explanation of the issue]

---

```rmcoc
{
  "finding": "Brief description of what was found",
  "assessment": "Detailed analysis of why this is an issue",
  "score": 7
}
```
````

**JSON Schema Requirements:**

- `finding` (string, required): A concise one-sentence description of the issue
- `assessment` (string, required): Detailed explanation of why this matters and
  the impact
- `score` (number, required): Severity score from 1-10 based on the scoring
  rubric

**State Reconstruction Behavior:**

On every run, the state manager:

1. Fetches all PR review comments via GitHub API
2. Parses each bot comment to extract the `rmcoc` JSON block
3. Reconstructs the review state with:
   - Thread ID from comment ID
   - File path and line number from comment metadata
   - Assessment data from the `rmcoc` block
   - Status determined by analyzing bot replies:
     - **PENDING**: No bot replies or discussion ongoing
     - **RESOLVED**: Bot posted `✅ **Issue Resolved**` or `rmcoc` block with
       `status: "RESOLVED"`
     - **DISPUTED**: Bot replied without conceding (maintains position)
     - **ESCALATED**: Bot posted `🔺 **Escalated to Human Review**` or `rmcoc`
       block with `status: "ESCALATED"`
4. Collects all developer replies to track dispute history

**Fallback Handling:**

If a comment lacks a valid `rmcoc` block:

- Comment is ignored and not included in state reconstruction
- Only bot comments with valid `rmcoc` blocks are considered review findings

**Deduplication:**

The agent prevents duplicate comments using:

- File path and line number matching
- Fuzzy matching on finding text (50% significant word overlap threshold)
- Stop word filtering to improve matching accuracy

##### `github_get_run_state()`

- **Responsibility**: Reconstructs the current review state from existing
  comment threads by parsing `rmcoc` blocks. It identifies which issues are
  "Pending," "Resolved," "Disputed," or "Escalated."
- **Signature**:
  ```ts
  github_get_run_state(): Promise<{
    threads: Array<{
      id: string,
      file: string,
      line: number,
      status: 'PENDING' | 'RESOLVED' | 'DISPUTED' | 'ESCALATED',
      score: number,
      assessment: {
        finding: string,
        assessment: string,
        score: number
      },
      developer_replies?: Array<{author: string, body: string, timestamp: string}>
    }>,
    metadata: Record<string, any>
  }>
  ```

````

##### `github_post_review_comment()`

- **Responsibility**: Posts a new review comment on a specific file and line.
  The tool automatically embeds the assessment data as an `rmcoc` code block
  within the comment body to enable state reconstruction. The tool logic will
  filter the comment (not post it) if the `score` is below the user-defined
  `problem_score_threshold`.
- **Signature**:
  ```ts
  github_post_review_comment(
    file: string,
    line: number,
    body: string,
    assessment: {
      finding: string,
      assessment: string,
      score: number // 1-10
    }
  ): Promise<string> // Returns thread_id
  ```
- **Implementation Note**: The tool combines `body` and `assessment` into a
  formatted comment with embedded `rmcoc` block (using `---` separator) before
  posting to GitHub. The agent only provides the human-readable body and
  structured assessment data. The tool also checks for duplicate findings at the
  same location using fuzzy matching to prevent redundant comments.

##### `github_reply_to_thread()`

- **Responsibility**: Responds to an existing thread. Used to concede a point to
  a developer or provide further clarification on a disputed item.
- **Signature**:
  ```ts
  github_reply_to_thread(
    thread_id: string,
    body: string,
    is_concession: boolean
  ): Promise<void>
  ```

##### `github_resolve_thread()`

- **Responsibility**: Closes a thread once the agent verifies that the code
  change in the new commit addresses the issue, or if a developer's explanation
  is accepted.
- **Signature**:
  ```ts
  github_resolve_thread(
    thread_id: string,
    reason: string
  ): Promise<void>
  ```

#### 3. Workflow Control Tools

These tools manage the multi-pass logic and the finalization of the review
process.

##### `submit_pass_results()`

- **Responsibility**: Marks a specific review pass (1-3) as complete. This
  triggers the orchestrator to provide the prompt for the next pass or finalize
  the review.
- **Signature**:
  ```ts
  submit_pass_results(
    pass_number: number,
    summary: string,
    has_blocking_issues: boolean
  ): Promise<void>
  ```

#### 4. External Intelligence Tools (Optional)

Used for validating best practices against external documentation.

- **`web_search(query: string)`**: Searches the web for library documentation or
  CVEs.
- **`web_fetch(url: string)`**: Retrieves the content of a specific URL to
  ensure suggestions align with current third-party API standards.

---

### Tool Responsibility Summary Table

| Tool Category     | Core Responsibility         | Side Effect                                            |
| :---------------- | :-------------------------- | :----------------------------------------------------- |
| **State**         | Load/Rebuild PR context     | Parses `rmcoc` blocks from GitHub comments             |
| **Communication** | Post/Reply/Resolve comments | Filters via `problem_score_threshold`, embeds `rmcoc`  |
| **Exploration**   | Read-only file access       | None (Read-only for security)                          |
| **Workflow**      | Sequence the 3-pass review  | Updates progress in the Action log                     |

### Implementation Note on "Pseudo-Commitable Suggestions"

As per Section 5, Phase 4, the agent is restricted from using GitHub's native
"Suggestions" feature (blocks that can be committed). These tools are configured
to only output Markdown blocks and pseudo-code to prevent the AI from directly
modifying the codebase without manual oversight.

---

## 5. Technical Implementation Plan

### Phase 1: Infrastructure & Config

1.  **Project Setup:** Initialize a TypeScript-based GitHub Action.
2.  **Configuration Mapping:** Create a parser that maps GitHub Action inputs to
    the OpenCode SDK configuration.
3.  **SDK Integration:** Implement a `ManagedOpenCodeServer` class that
    starts/stops the server within the runner environment.

### Phase 2: State & Context Service

1.  **Comment Parsing Logic:** Implement state reconstruction by fetching and
    parsing all PR review comments to extract `rmcoc` blocks.
2.  **Context Aggregator:** Build a service to collect the PR diff, the
    `AGENTS.md` file, and current thread history from the GitHub API.
3.  **Deduplication Service:** Implement fuzzy matching on findings to prevent
    duplicate comments on the same issue.

### Phase 3: The Multi-Pass Review Logic

1.  **The System Prompt:** Craft a comprehensive prompt including the 1-10
    scoring rubric and security guidelines.
2.  **Execution Loop:** called within the same OpenCode session with a detailed
    prompt for each pass with additonal guidence in the initial prompt to
    indicate that there will be a total of X passes and each detaild pass
    description must have the pass number for the OpenCode agent to know how far
    along in the process it is. The Context will be managed by the OpenCode
    Agent and no state resets or reloads outside of OpenCode internal mechanisms
    will exist for these passes.
    - **Pass 1:** Atomic diff review.
    - **Pass 2:** Structural/Layered review (leveraging OpenCode to navigate the
      tree).
    - **Pass 3:** Security and AGENTS.md compliance audit.

The Phases are not isolated and the OpenCode Server will manage the context. The
passes will be handled as prompts for the OpenCode Agent and it can manage the
files in it's context as it wishes.

Each phase will be triggered once the previous pass is conpmleted and comment
submitted via the comment tool and the overall "complete pass" tool called with
the overall reivew comments. When a new pass is triggered, the existing OpenCode
session will be prompted again with the relevat pass details and goals, untill
all passes are finished and all comments ar submitted

### Phase 4: GitHub API Integration

1.  **Comment Manager:** The aggent should only add comments and pseudo code
    examples to illsutrate a certain point or show edge cases or suggest
    refactors, it should never create commitable suggestions
2.  **Thread Resolver:** Logic to detect if a previous issue is fixed and
    reply/resolve the thread.

---

## 6. Implementation Step-by-Step Guide

### Step 1: Initial Action Setup

- Create `action.yml`.
- Define inputs for `opencode_api_key`, `model`, `problem_score_threshold`, and
  `enable_web`.
- Setup a `src/index.ts` entry point.

### Step 2: OpenCode SDK Server Initialization

- Ensure the action checks out the repository.
- Launch OpenCode in a sidecar-style process.
- **Constraint:** Explicitly disable `file_write` and `shell_execute` in the
  config for security.

### Step 3: Implement the Review Logic

- Use the SDK's `Agent` class.
- Provide a toolset that allows the agent to call the GitHub API (via octokit)
  to interact with comments.
- the `System Prompt` must include the full 1-10 Scoring Guidance as a markdown
  block. The Agent will be required to output its internal "Thought" process in
  JSON format to the 'add github comment' so it can be matched against the
  required level from settings and included/discarded in the gh review as well
  as the state saved in the cache:

```json
{
  "finding": "Nested loops found in data transformation.",
  "assessment": "The array size is potentially 10k+ items, making this O(n^2).",
  "score": 6
}
```

### Step 4: Verification & Feedback Loop

- Implement the logic that feeds previous developer comments back into the LLM
  context.
- This ensures the agent respects "Disputed" comments if the developer provided
  a valid reason for a specific implementation.

---

## 7. Configuration Example (`action.yml`)

```yaml
uses: actions/opencode-reviewer@v1
with:
  model: 'google/gemini-flash-1.5'
  opencode_api_key: ${{ secrets.OPENCODE_API_KEY }}
  problem_score_threshold: 6
  score_elevation_threshold: 5
  enable_web: true
```

## 8. Additional details

- **Triggering:** Runs on:
  - "Ready for Review" or new pushes to active PRs
  - When a developer mentions `@review-my-code-bot` in a comment (triggers
    review even on draft PRs)
- **Isolation:** OpenCode runs on the runner but is abstracted for future
  containerization.
- **Memory:** State is preserved in GitHub PR comments via `rmcoc` blocks,
  reconstructed on each run to track issue resolution.
````
