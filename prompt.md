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

## Completed Tasks

I got the review failure for an empty PR description. but this is not handled
the same as other tasks:

- thereis no rmcoc code block for the review to reference later
- the workflow did not exit with non-zero code to block merges

the PR description check needs to be treated the same as any other issue
comment.

the contents of the PR also need to be fed troough an llm to determine if it is
sufficient or not
