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

please review all the code in the repo and evaluate if there is any risk of
prompt injection. pay close attention to how posted comments (from the review
agent itself or by developers) are read and fed back into the agent.

also please review if there is any risk of secret exfiltration of any kind.
