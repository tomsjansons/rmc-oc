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

please implement a new feature where info from the PR description is loaded. the
pr desc may contain information directly or may link to existing files in the
repo containing the task description.

add a new config option for the action: require-task-info-in-pr-desc - if the
description is empty or insufficient for understanding the task, it must be
conisdered as a review failure

afterwards update the neccessary documents (README and action ) with this new
feature
