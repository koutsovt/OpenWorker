# 3. Platform-owned registries with an approval lock

Status: Accepted

## Context

SDK-defined agents cannot load the engine's bundled skills, and the engine has no notion of an approved definition.

## Decision

Agents, skills and tools are files under `registry/`. An agent or skill is usable only if it is marked approved and its content digest matches `registry/approved.lock.yaml`. Skills are guidance only and never grant a tool. Superseded versions are marked retired and kept.

## Consequences

- Approval is a reviewed change to the lock file. Editing an approved definition makes it unusable until re-locked.
- No tool writes to `registry/` or `config/`. Agents can only file a skill proposal, which has no effect until a person merges it.
- The lock shows that content is unchanged since approval. It does not show who approved it; that is the pull-request history.
