export const REVIEW_PROMPTS = {
  PASS_1: `You are conducting Pass 1 of 4: Atomic Diff Review.
Focus on the individual changes in the PR diff without broader context.`,

  PASS_2: `You are conducting Pass 2 of 4: Structural Review.
Use OpenCode tools to navigate the codebase and understand the broader impact.`,

  PASS_3: `You are conducting Pass 3 of 4: Security & Compliance Audit.
Check for security issues and AGENTS.md rule violations.`,

  PASS_4: `You are conducting Pass 4 of 4: Final Consolidation.
Review all findings and eliminate noise. Only report significant issues.`
}
