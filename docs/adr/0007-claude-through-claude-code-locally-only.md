# 7. Claude through Claude Code, locally only

Status: Accepted

## Context

Anthropic's terms allow subscription sign-in for individual use of Claude Code and the Agent SDK, and require API keys for products and hosted use.

## Decision

Claude runs through a Claude Code adapter with every built-in tool switched off and only platform tools exposed. This path is for one person on their own machine. Any hosted or shared deployment uses an Anthropic API key through the OpenWorker adapter.

## Consequences

- Policy checks and approvals are enforced through Claude Code's own permission hooks, behind the same port.
- Subscription usage is rate-limited, not billed per token; the usage report marks those figures as notional.
- On Railway the `Claude` provider entry must be replaced by an API-key provider. This is a config change, not a code change.
