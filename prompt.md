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

1. ✅ Implemented auth JSON support - Changed from single OpenRouter API key to
   full auth JSON, allowing all LLM providers to be used
2. ✅ Implemented PR description task info loading - PR descriptions can contain
   task info directly or link to files in the repo
3. ✅ Added require_task_info_in_pr_desc config option - Reviews fail if
   description is empty or insufficient (default: true)
4. ✅ Updated model parameter handling - Models are now passed as raw strings
   without automatic prefixing, giving users full control
