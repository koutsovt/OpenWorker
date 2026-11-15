# 4. Structured results through a tool, checked in code

Status: Accepted

## Context

The engines return free text. Downstream agents, the assurance gate and the report need structured, checkable results.

## Decision

An agent hands its result back by calling `result.submit`. Code validates it against the output contract named in the agent definition, and checks that every evidence id it cites is a passage an agent actually read in that run. A failing result is sent back once with the reasons, then fails the task.

## Consequences

- A fabricated citation cannot enter a result, on any engine or provider.
- Agents exchange validated data, not free text pasted into each other's instructions.
- Contracts are defined in code (`src/orchestrator/contracts.ts`) and named in the registry. Changing a contract is a code change.
