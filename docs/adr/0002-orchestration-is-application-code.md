# 2. Orchestration is application code

Status: Accepted

## Context

With harness-native sub-agents, the parent model writes the child's system prompt and chooses its tools. That cannot meet the requirement that agents are instantiated only from approved definitions.

## Decision

A planner agent proposes a task graph as data. Code validates it against the registries, a person approves it, and code then runs each task as a fresh session created from an approved definition. Assurance, rework and the final report are stages the platform schedules itself; a plan cannot assign or skip them.

## Consequences

- The model never instantiates an agent, picks a model or grants a tool.
- Each task has its own session, context, model choice and audit boundary.
- Run state lives in SQLite and each next step is derived from stored results, so a killed process resumes where it stopped. Recovery is per task: an interrupted task that had only read is re-issued; one that had written is held for a person.
- A task built on a reworked result is redone after it, in the same single rework round.
- Limits on model calls, tokens and cost apply across a whole run and are counted from the ledger, so they survive a restart.
