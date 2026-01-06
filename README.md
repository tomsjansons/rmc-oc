# Review My Code, OpenCode!

A GitHub Action that uses OpenCode to do LLM-powered code reviews. The reivew
process should behave like a real developer review. No silly diagrams and other
nonsense. Ask follow up questions, argue in comments and fix what's broken!

> [!NOTE] This project is in no way associated with the OpenCode team

## The Idea

Traditional code review tools are either too shallow (linters that miss context)
or too noisy (AI reviewers that nit-pick everything). This agent aims to be
different:

- **Interactive**: Mention `@review-my-code-bot` (or `@rmc-bot` for short) to
  request feedback on draft PRs or ask questions about your codebase
- **Conversational**: Argue about findings in comments - explain your reasoning
  and the bot may concede, or it will explain why the issue still matters
- **Stateful**: All conversation history is preserved in PR comments, so the bot
  remembers previous discussions across commits
- **Proportional**: Suggestions match the scale of your changes - no module
  rewrites for 2-line fixes
- **Silent when appropriate**: If your code is good, the bot says nothing

## How It Works

### Interacting Like a Developer

The bot is designed to feel like chatting with a teammate:

**Request early feedback on draft PRs:**

```
@review-my-code-bot please review this
@rmc-bot can you check this code?
```

**Ask questions about the codebase:**

```
@review-my-code-bot Why is UserService injected here?
@rmc-bot How does the auth flow work?
```

**Dispute a finding:**

When the bot raises an issue, reply to the comment with your reasoning:

```
This is intentional - we need the nested loop here because the data
structure requires checking parent-child relationships. The array
is always small (<100 items) so O(n^2) is acceptable.
```

The bot will re-evaluate with your context. If your explanation is valid, it
concedes and resolves the thread. If the issue still poses a risk, it explains
why and keeps the thread open.

### Stateful Without External Dependencies

A key design goal: **no external state management**. No Redis, no databases, no
GitHub Actions cache (which proved unreliable).

Instead, all state lives in PR comments using embedded `rmcoc` code blocks:

````markdown
The `validateToken` function doesn't handle expired tokens...

---

```rmcoc
{
  "finding": "Missing token expiration check",
  "assessment": "Expired tokens could be accepted, creating security vulnerability",
  "score": 9
}
```
````

On each run, the bot:

1. Fetches all PR review comments via GitHub API
2. Parses `rmcoc` blocks to reconstruct review state
3. Tracks which issues are pending, resolved, disputed, or escalated
4. Collects developer replies to understand dispute history

This means state persists as long as the PR exists, survives action restarts,
and requires zero infrastructure.

### Multi-Pass Review

The bot performs 3 sequential passes within a single session:

1. **Atomic Diff Review**: Line-by-line analysis of changes
2. **Structural Review**: Broader codebase context, call chains, architectural
   impact
3. **Security & Compliance**: Access control, data integrity, AGENTS.md rule
   enforcement

### Issue Scoring

Every finding gets a severity score (1-10). Only issues at or above your
configured threshold are reported:

| Score | Category                | Example                                         |
| ----- | ----------------------- | ----------------------------------------------- |
| 1-2   | Nit-picks               | Subjective style preferences                    |
| 3-4   | Quality & Maintenance   | Redundant code, missing docs on complex methods |
| 5-6   | Best Practices          | Suboptimal patterns, unnecessary complexity     |
| 7-8   | Logic & Rule Violations | Missing edge cases, AGENTS.md violations        |
| 9-10  | Critical                | Security vulnerabilities, potential data loss   |

Set `problem_score_threshold: 7` to focus only on serious issues. The bot stays
silent on everything below your threshold.

### Dispute Resolution

When you disagree with a finding:

1. Reply to the comment explaining your reasoning
2. The bot re-examines with your context
3. If valid, it concedes and resolves the thread
4. If the risk remains, it explains why (with option to escalate to human
   reviewers)

The bot won't stubbornly hold its position - but it also won't rubber-stamp
dismissals of genuine security risks.

### Using as a Merge Gate

The review agent can act as a required status check to gate PR merges:

- **Pass**: Review completes with no blocking issues (clean code or all issues
  below `blocking_score_threshold`)
- **Fail**: Blocking issues found (issues at or above
  `blocking_score_threshold`)

The key insight: **disputes can unblock a failing review**. If the bot raises a
blocking issue and you argue your case in the comments, the bot re-evaluates. If
it concedes, the issue is resolved and the check passes - unblocking the merge.

This creates a workflow where:

1. PR is marked ready for review
2. Bot runs and finds a blocking issue (check fails)
3. You reply explaining why it's not actually a problem
4. Bot is triggered again, reads your explanation, concedes
5. Issue resolved, check passes, PR can merge

To set this up, add the action as a required status check in your branch
protection rules.

## Quick Start

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  review:
    if: |
      (github.event_name == 'pull_request' && !github.event.pull_request.draft) ||
      (github.event_name == 'issue_comment' && 
       github.event.issue.pull_request && 
       (contains(github.event.comment.body, '@review-my-code-bot') ||
        contains(github.event.comment.body, '@rmc-bot'))) ||
      (github.event_name == 'pull_request_review_comment' &&
       github.event.comment.in_reply_to_id != '')

    runs-on: ubuntu-latest

    permissions:
      pull-requests: write
      contents: read
      issues: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || '' }}
          fetch-depth: 0

      - name: Fetch base branch
        run: |
          git fetch origin main:refs/remotes/origin/main || \
          git fetch origin master:refs/remotes/origin/master || \
          echo "Warning: Could not fetch main or master branch"

      - name: Checkout PR head for comment events
        if:
          github.event_name == 'issue_comment' || github.event_name ==
          'pull_request_review_comment'
        run:
          gh pr checkout ${{ github.event.issue.number ||
          github.event.pull_request.number }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Reivew My Code, OpenCode!
        uses: tomsjansons/rmc-oc@latest
        with:
          opencode_auth_json: ${{ secrets.OPENCODE_AUTH_JSON }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## Configuration

### Inputs

| Input                          | Description                                    | Default                              |
| ------------------------------ | ---------------------------------------------- | ------------------------------------ |
| `openrouter_api_key`           | OpenRouter API key (required)                  | -                                    |
| `github_token`                 | GitHub token for API access (required)         | `${{ github.token }}`                |
| `model`                        | LLM model via OpenRouter                       | `anthropic/claude-sonnet-4-20250514` |
| `problem_score_threshold`      | Minimum score (1-10) for reporting issues      | `5`                                  |
| `blocking_score_threshold`     | Minimum score to fail the check                | Same as problem_score_threshold      |
| `review_timeout_minutes`       | Timeout in minutes (5-120)                     | `40`                                 |
| `max_review_retries`           | Retry attempts on timeout (0-3)                | `1`                                  |
| `enable_web`                   | Enable web search for documentation            | `false`                              |
| `enable_human_escalation`      | Enable escalation to human reviewers           | `false`                              |
| `human_reviewers`              | GitHub usernames for escalation (comma-sep)    | `''`                                 |
| `debug_logging`                | Verbose LLM activity logging                   | `false`                              |
| `require_task_info_in_pr_desc` | Require sufficient task info in PR description | `false`                              |

### Outputs

| Output            | Description                                     |
| ----------------- | ----------------------------------------------- |
| `review_status`   | `completed`, `failed`, or `has_blocking_issues` |
| `issues_found`    | Number of issues reported                       |
| `blocking_issues` | Number of issues at or above blocking threshold |

### Advanced Example

```yaml
- name: Reivew My Code, OpenCode!
  uses: tomsjansons/rmc-oc@latest
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

    # Only report serious issues
    problem_score_threshold: '7'

    # Only block CI on critical issues
    blocking_score_threshold: '9'

    # Enable documentation lookups
    enable_web: 'true'

    # Escalate unresolved disputes to humans
    enable_human_escalation: 'true'
    human_reviewers: 'alice,bob'
```

## Under the Hood

### State Reconstruction

On every run, the bot rebuilds state from PR comments:

1. **Fetch**: Get all review comments via GitHub API
2. **Filter**: Identify bot-authored comments (`github-actions[bot]`)
3. **Parse**: Extract `rmcoc` JSON blocks from each comment
4. **Build**: Reconstruct thread status from replies:
   - **PENDING**: No resolution yet
   - **RESOLVED**: Bot posted resolution marker
   - **DISPUTED**: Ongoing discussion
   - **ESCALATED**: Handed off to human reviewer
5. **Collect**: Gather developer replies for context

### Deduplication

The bot prevents duplicate comments on the same issue:

- Matches file path and line number
- Fuzzy matches finding text (50% word overlap threshold)
- Filters stop words for accurate comparison

### Security Sensitivity

The bot auto-detects repos handling sensitive data by checking:

- Dependencies: `stripe`, `passport`, `jwt`, `crypto`, etc.
- README: mentions of `PII`, `GDPR`, `HIPAA`, `financial`, etc.

When detected, security findings are elevated by +2 points.

### Project Rules

The bot enforces rules from your `AGENTS.md` file:

- **Pass 1**: Code style, naming conventions
- **Pass 2**: Architectural rules, module boundaries
- **Pass 3**: Security requirements, testing policies

### PR Description Context

The bot uses the PR description to understand the intent of changes. This helps
it review code in context and **verify that the implementation matches what was
promised**.

**Linking to task files:**

If your PR description references files in the repository, the bot will read
them for additional context:

```markdown
## Task

Implements the user authentication feature as described in
[docs/auth-spec.md](./docs/auth-spec.md).

See also: `requirements/user-stories.md`
```

The bot will automatically load linked `.md`, `.txt`, `.rst`, and `.adoc` files
and verify that the code changes cover all requirements specified in those
files.

**Task coverage verification:**

The bot performs task coverage verification across all three review passes:

- **Pass 1**: Checks that code changes align with stated task requirements
- **Pass 2**: Verifies all requirements from the task description are
  implemented
- **Pass 3**: Final check that nothing from the PR description is missing

If the PR description says "implement feature X" but the code doesn't fully
implement it, the bot will flag this as a significant issue (score 7-8).

**Examples of task coverage issues the bot catches:**

- PR says "add input validation" but no validation code was added
- PR says "fix bug X" but the fix is incomplete
- PR references a spec file listing 5 requirements, but only 3 are implemented
- Code changes are unrelated to the stated task

**Requiring task information:**

Set `require_task_info_in_pr_desc: true` to enforce that every PR has a
meaningful description. If the description is empty or insufficient (e.g., just
"fix bug"), the review will fail with a helpful message explaining what's
needed.

This is useful for teams that want to ensure:

- Every PR explains what it does and why
- Reviewers (human and bot) have sufficient context
- PRs can be understood months later when reading history
- **The implementation matches what was promised in the description**

## Current Status

This is a work in progress. Known limitations:

- Human escalation partially implemented
- Some edge cases in dispute resolution
