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

we've recently added the whole auth.json file from
~/.local/share/opencode/auth.json so it is easier to pass auth details to the
agent. this means you can use oauth as well as api keys and combine them to
enable multiple providers.

it seems that the current approach is missing something as purely passing
auth.json and enabling providers in ./opencode.json(c) does not actually enable
them, somethign is missing.

please investigate opencode setup at ~/.config/opencode/ and
~/.local/share/opencode and compare it to what we construct in the github action
and find what is missing for enabling (in this test case) openrouter api key
provider and anthropic oauth provider
