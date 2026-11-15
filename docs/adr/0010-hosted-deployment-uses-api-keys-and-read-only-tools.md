# 10. Hosted deployment uses API keys and read-only tools

Status: Accepted

## Context

On a host there is no subscription sign-in, and the SDK has no OS sandbox outside Linux with OpenShell.

## Decision

Hosted deployments use API-key providers only, with keys supplied as host environment variables and named, never stored, in config. All tools remain read-only application callbacks. No shell, file-write or network tool is registered.

## Consequences

- A test asserts that no approved agent holds a tool that is not a read.
- Write-capable enterprise tools wait for a sandbox (OpenShell on Linux) and the approval flow that already exists for sensitive tools.
