# 1. Engine behind a small port

Status: Accepted

## Context

The OpenWorker Harness SDK is in beta and its API is still changing. Claude on a personal subscription can only run through Claude Code, which is a different engine. The platform must not be tied to either.

## Decision

Everything above `src/harness/port.ts` talks to an `AgentHarness` interface with nine operations. Each engine SDK is imported only by its own adapter; a test enforces this. A scripted fake adapter implements the same contract.

## Consequences

- One contract test runs against the fake, the Claude Code adapter and the real OpenWorker runtime.
- `tests/harness-swap.test.ts` runs the whole proof-of-concept scenario on each engine, and on both routed by provider, and requires identical outcomes.
- Engine features outside the port (OpenWorker guardrails, compliance capture, teams) are not used. Equivalent controls are built above the port so they hold on every engine.
- The Claude Code adapter has been tested with a scripted stand-in for the Agent SDK, not yet against real Claude Code.
