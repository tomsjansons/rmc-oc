# Review My Code, OpenCode!

A GitHub Action that uses OpenCode to do LLM-powered code reviews. I've tried
the reivew process to behave like a real developer review. No silly diagrams and
other nonsense.

## WIP

This PR Review Agent is still very much wip and there will be rough edges but
the main review loop works!

- PR description is currently not considered
- Draft PRs with @review-my-code-bot not tested
- Escalation for human review not working
- Proably more missing/broken features
- Overall state of the code is not ideal

## Features

### Multi-Pass Review System

The agent performs **3 sequential review passes** within a single OpenCode
session, each building on the previous one:

1. **Pass 1: Atomic Diff Review**
   - Line-by-line analysis of changes
   - Syntax errors and typos
   - Code style violations
   - Local performance issues

2. **Pass 2: Structural/Layered Review**
   - Broader codebase context analysis
   - Function call chain tracing
   - Interface contract verification
   - Architectural impact assessment
   - Pattern consistency checks

3. **Pass 3: Security & Compliance Audit**
   - Access control issues
   - Data integrity risks
   - Project-specific rule enforcement (`AGENTS.md`)
   - Security sensitivity scaling (PII, Financial data)

### Intelligent Issue Scoring (1-10 Scale)

Every issue is assigned a severity score based on a detailed rubric. Only issues
at or above the configured threshold are reported.

#### Level 1-2: Pure Nit-picks

_Items with zero impact on execution, security, or reliability_

- **Score 1 (Micro-Nit)**: Extremely subjective preferences
  - Example: Suggesting `Array.from()` instead of spread operator where
    performance is irrelevant
  - Example: Preferring single quotes over double quotes when both are
    acceptable
- **Score 2 (Stylistic Nit)**: Minor inconsistencies not caught by linter but
  don't hinder readability
  - Example: Variable name `data` is generic, suggesting `userData` instead
  - Example: Inconsistent spacing that doesn't affect code clarity

#### Level 3-4: Quality & Maintenance

_Items that impact developer experience and long-term health, but aren't bugs_

- **Score 3 (Minor Improvement)**: Redundant code or slightly confusing naming
  - Example: Function is 5 lines longer than necessary due to verbose if/else
    block
  - Example: Variable could be more descriptive but meaning is still clear from
    context
- **Score 4 (Readability/Documentation)**: Missing documentation on complex
  public method or hard-to-parse exported type
  - Example: Complex regex without explanation of what each group captures
  - Example: Public API method missing JSDoc explaining parameters and return
    value

#### Level 5-6: Best Practices & Efficiency

_The default threshold - deviations from industry standards or suboptimal
patterns_

- **Score 5 (Suboptimal Pattern)**: Pattern that works but is known to be
  brittle
  - Example: Passing 6 individual arguments instead of an options object
  - Example: Using string concatenation instead of template literals for
    readability
- **Score 6 (Local Performance/Complexity)**: Unnecessarily heavy code
  - Example: Mapping over a large array twice instead of once
  - Example: Nested loop that could be replaced with a Map lookup
  - Example: Synchronous file operations in a critical path

#### Level 7-8: Logic, Edge Cases & Consistency

_Serious issues where code might fail under specific conditions or violates
rules_

- **Score 7 (Logic Risk)**: Missing edge case that could cause failures
  - Example: Handling success and error states, but UI crashes on empty array
    response
  - Example: Not validating user input before using it in a calculation
  - Example: Missing null check on optional API response field
- **Score 8 (Structural/Rule Violation)**: Direct violation of AGENTS.md or
  architectural standards
  - Example: UI component performing direct database queries instead of using
    service layer
  - Example: Violating established module boundaries or import patterns
  - Example: Breaking established error handling conventions

#### Level 9-10: Critical Failures

_Issues requiring immediate PR blocking - objective and dangerous_

- **Score 9 (Major Bug/Security Leak)**: High probability of failure or data
  exposure
  - Example: SQL injection vulnerability due to unsanitized user input
  - Example: Missing authorization check on sensitive endpoint
  - Example: Race condition in payment processing flow
  - Example: Password or token exposed in logs
- **Score 10 (Systemic Catastrophe)**: Fundamental failures with severe
  consequences
  - Example: Hardcoded production secrets or API keys committed to repository
  - Example: Using broken/deprecated encryption (MD5 for passwords)
  - Example: Logic that could cause mass data loss or corruption
  - Example: Removing critical security middleware or authentication checks

### Configurable Thresholds

- **`problem_score_threshold`** (default: 5): Minimum score for reporting issues
  - Set to 7 to focus only on logic errors and security issues
  - Set to 3 to include code quality suggestions
  - Agent remains silent on issues below threshold

- **`blocking_score_threshold`** (default: same as problem_score_threshold):
  Minimum score to fail the check
  - Separate threshold for CI/CD blocking
  - Issues at or above this score will cause the action to fail

### Stateful Review Management

The agent maintains review state across commits by storing structured data
directly in GitHub PR comments:

- **Comment-Based State Storage**: All review state is embedded in comments
  using `rmcoc` code blocks
- **Automatic State Reconstruction**: On each run, the agent rebuilds complete
  state by parsing previous review comments
- **Issue Tracking**: Remembers which issues were raised, resolved, disputed, or
  escalated
- **Fix Verification**: Automatically checks if previous issues are addressed in
  new commits
- **Cross-File Resolution**: Detects when an issue in `file_A.ts` is fixed by
  changes in `file_B.ts`
- **No External Dependencies**: State persists as long as PR comments exist

#### Comment Format with Embedded State

Every review comment includes a `rmcoc` JSON block containing structured
assessment data:

````markdown
In `src/utils/auth.ts`, the `validateToken` function doesn't handle expired
tokens.

Add expiration validation before signature check to prevent accepting expired
tokens.

---

```rmcoc
{
  "finding": "Missing token expiration check",
  "assessment": "Expired tokens could be accepted, creating security vulnerability",
  "score": 9
}
```
````

The agent parses these blocks to reconstruct:

- Thread status (PENDING, RESOLVED, DISPUTED, ESCALATED)
- Issue severity scores
- Original findings and assessments
- Developer replies and dispute history

### Intelligent Dispute Resolution

The agent engages in technical discussions with developers:

- **Developer Acknowledgment**: Resolves threads when developer commits to
  fixing
- **Developer Disputes**: Re-examines code with developer's context, concedes
  when wrong
- **Out-of-Scope Requests**: Evaluates risk of deferring fixes based on severity
- **Questions**: Provides detailed clarifications with code references
- **Human Escalation**: Optional escalation to human reviewers for unresolved
  disputes (requires `enable_human_escalation: true`)

### Security-First Approach

- **Contextual Sensitivity**: Automatically elevates security issue scores by +2
  points for repositories handling PII or Financial data
- **Prompt Injection Protection**: Built-in detection for malicious instructions
  in code comments or developer responses
- **Access Control**: Read-only workspace access with no file modification
  capabilities
- **Security Pass**: Dedicated security audit in Pass 3 focusing on:
  - Cross-user data leakage
  - Unauthorized access risks
  - Encryption and data integrity
  - Authentication/authorization issues

### Bot Mention for Reviews and Questions

Developers can interact with the bot by mentioning `@review-my-code-bot` in PR
comments. The bot intelligently detects the intent:

#### Request a Review

Trigger a full 3-pass review (works on draft PRs too):

```
@review-my-code-bot please review this PR
@review-my-code-bot can you review this?
@review-my-code-bot check this code
@review-my-code-bot ready for review
```

This bypasses the normal "Ready for Review" trigger and runs the complete review
process, useful for getting early feedback on draft PRs.

#### Ask Questions

Get answers about the codebase:

```
@review-my-code-bot Why is the UserService needed in this component?
@review-my-code-bot How does authentication work here?
@review-my-code-bot What does this function do?
```

The bot analyzes the codebase and provides detailed answers with file
references.

### Developer-Friendly Comments

All comments are formatted for easy integration with coding agents:

- **File paths included**: `src/utils/auth.ts` at the start of suggestions
- **Self-contained**: Full context without needing to read the PR
- **Concrete instructions**: Exactly what to change, not just what's wrong
- **Code examples**: Markdown code blocks showing problematic and correct
  approaches
- **No committable suggestions**: Only provides guidance, never creates
  auto-commit blocks

### Review Philosophy

The agent follows strict "Value-Add" principles:

- **Proportionality**: Suggestions match the scale of changes (no module
  rewrites for 2-line fixes)
- **Non-Obligatory Feedback**: If code is good, the agent says nothing (silence
  over noise)
- **Intellectual Honesty**: Concedes when developers provide valid
  counter-arguments
- **Contextual Awareness**: Reviews code holistically, not just diffs

## Usage

### Basic Setup

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

jobs:
  review:
    runs-on: ubuntu-latest

    permissions:
      pull-requests: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run OpenCode PR Reviewer
        uses: your-org/opencode-pr-reviewer@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Advanced Configuration

```yaml
- name: Run OpenCode PR Reviewer
  uses: your-org/opencode-pr-reviewer@v1
  with:
    # Required
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

    # Model Selection
    model: 'anthropic/claude-sonnet-4-20250514' # Default

    # Threshold Configuration
    problem_score_threshold: '7' # Only report serious issues
    blocking_score_threshold: '9' # Only block on critical issues

    # Timeout & Retries
    review_timeout_minutes: '40' # Default: 40 minutes
    max_review_retries: '1' # Default: 1 retry on timeout

    # Optional Features
    enable_web: 'true' # Enable web search for documentation
    debug_logging: 'true' # Verbose LLM activity logging

    # Human Escalation
    enable_human_escalation: 'true'
    human_reviewers: 'alice,bob' # GitHub usernames to tag

    # Security
    injection_detection_enabled: 'true' # Default
    injection_verification_model: 'openai/gpt-4o-mini'
```

### With Bot Mention Support

Add `issue_comment` trigger to enable on-demand reviews and question answering
via `@review-my-code-bot` mentions:

```yaml
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

jobs:
  review:
    if: |
      github.event_name == 'pull_request' || 
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request && 
       contains(github.event.comment.body, '@review-my-code-bot'))

    runs-on: ubuntu-latest

    permissions:
      pull-requests: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Checkout PR head for comment events
        if: github.event_name == 'issue_comment'
        run: gh pr checkout ${{ github.event.issue.number }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Run OpenCode PR Reviewer
        uses: your-org/opencode-pr-reviewer@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input                          | Description                                                                  | Required | Default                              |
| ------------------------------ | ---------------------------------------------------------------------------- | -------- | ------------------------------------ |
| `openrouter_api_key`           | OpenRouter API key for LLM access                                            | Yes      | -                                    |
| `github_token`                 | GitHub token for API access. Use PAT with repo scope to auto-resolve threads | Yes      | `${{ github.token }}`                |
| `model`                        | LLM model via OpenRouter                                                     | No       | `anthropic/claude-sonnet-4-20250514` |
| `problem_score_threshold`      | Minimum score (1-10) for reporting issues                                    | No       | `5`                                  |
| `blocking_score_threshold`     | Minimum score (1-10) to fail the check                                       | No       | Same as problem_score_threshold      |
| `review_timeout_minutes`       | Total timeout for review in minutes (5-120)                                  | No       | `40`                                 |
| `max_review_retries`           | Maximum retry attempts on timeout (0-3)                                      | No       | `1`                                  |
| `enable_web`                   | Enable web search and fetch capabilities                                     | No       | `false`                              |
| `enable_human_escalation`      | Enable escalation to human reviewers                                         | No       | `false`                              |
| `human_reviewers`              | Comma-separated GitHub usernames for escalation                              | No       | `''`                                 |
| `debug_logging`                | Enable verbose debug logging                                                 | No       | `false`                              |
| `injection_detection_enabled`  | Enable prompt injection detection                                            | No       | `true`                               |
| `injection_verification_model` | Model for LLM-based injection verification                                   | No       | `openai/gpt-4o-mini`                 |

## Outputs

| Output            | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `review_status`   | Status: `completed`, `failed`, or `has_blocking_issues`       |
| `issues_found`    | Number of issues found and reported                           |
| `blocking_issues` | Number of blocking issues (score >= blocking_score_threshold) |

## Project-Specific Rules

The agent automatically enforces rules defined in your repository's `AGENTS.md`
file:

- **Pass 1**: Code style, naming conventions, formatting standards
- **Pass 2**: Architectural rules, module boundaries, import patterns
- **Pass 3**: Security requirements, data handling policies, testing
  requirements

See [AGENTS.md](./AGENTS.md) for this repository's development contract.

## How It Works

### Review Flow

1. **State Reconstruction**: Rebuilds review state by parsing all PR review
   comments containing `rmcoc` blocks
2. **Dispute Resolution**: Evaluates developer responses to previous comments
3. **Fix Verification**: Checks if previous issues are addressed in new commits
4. **Multi-Pass Review**: Executes 3 sequential review passes
5. **State Persistence**: State is automatically persisted in review comments
   with `rmcoc` blocks

### State Management

State is stored and retrieved entirely through GitHub PR review comments using
structured `rmcoc` code blocks:

#### State Reconstruction Process

1. **Fetch All Review Comments**: Agent retrieves all review comments from the
   current PR
2. **Identify Bot Comments**: Filters for comments posted by
   `github-actions[bot]`
3. **Parse rmcoc Blocks**: Extracts JSON assessment data from each comment's
   `rmcoc` code block
4. **Build Thread State**: Reconstructs thread status by analyzing comment
   replies:
   - **PENDING**: No bot replies yet, or discussion ongoing
   - **RESOLVED**: Bot posted reply with `✅ **Issue Resolved**` marker or
     `rmcoc` block with `status: "RESOLVED"`
   - **DISPUTED**: Bot replied without conceding (maintains position)
   - **ESCALATED**: Bot posted `🔺 **Escalated to Human Review**` marker or
     `rmcoc` block with `status: "ESCALATED"`
5. **Collect Developer Replies**: Gathers all non-bot replies to track dispute
   history

#### rmcoc Block Structure

Every review comment includes:

```json
{
  "finding": "Brief one-sentence description of the issue",
  "assessment": "Detailed analysis of why this matters and the impact",
  "score": 7
}
```

Resolution and escalation replies may include:

```json
{
  "status": "RESOLVED",
  "reason": "Developer fixed the issue in commit abc123"
}
```

#### Deduplication Logic

The agent prevents duplicate comments on the same issue by:

- Comparing file path and line number
- Using fuzzy matching on finding text (50% word overlap threshold using
  significant words)
- Skipping comments for issues already reported and unresolved
- Filtering out common stop words to improve matching accuracy

### Security Sensitivity Detection

The agent automatically detects sensitive data handling by analyzing:

- **Dependencies**: Checks for `stripe`, `payment`, `passport`, `auth`, `jwt`,
  `encrypt`, `crypto`
- **README**: Looks for mentions of `PII`, `GDPR`, `HIPAA`, `financial`,
  `banking`, `healthcare`

When detected, security findings are automatically elevated by +2 points.

## Development

### Setup

```bash
pnpm install
pnpm run bundle
pnpm test
```

### Local Testing

```bash
pnpx @github/local-action . src/main.ts .env
```

See [.env.example](./.env.example) for required environment variables.

### Project Structure

- `src/main.ts`: Action entry point
- `src/review/orchestrator.ts`: Multi-pass review orchestration
- `src/review/prompts.ts`: LLM prompts and scoring rubric
- `src/github/state.ts`: Review state management
- `src/opencode/server.ts`: OpenCode server lifecycle
- `src/trpc/router.ts`: Tool implementations for agent

## License

MIT

## Contributing

Contributions welcome! Please ensure:

1. All code passes linting: `pnpm run lint`
2. Tests pass: `pnpm test`
3. Code is bundled: `pnpm run bundle`
4. No dead code or unused exports
5. Follow [AGENTS.md](./AGENTS.md) development contract

## Support

For issues or questions:

- GitHub Issues: Report bugs or request features
