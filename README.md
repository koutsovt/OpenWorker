# OpenWorker agent workforce

An enterprise multi-agent platform built on a replaceable agent harness. The first engine is the
[OpenWorker Harness SDK](https://github.com/andrewyng/openworker); this repository is the platform around it.

Design and decisions: [docs/enterprise-agent-workforce-plan.md](docs/enterprise-agent-workforce-plan.md).
SDK validation results: [spikes/m0/RESULTS.md](spikes/m0/RESULTS.md).

## Status

Milestones 1 (skeleton) and 2 (registries and governance) are in place:

| Part | Where | State |
|---|---|---|
| Harness interface | `src/harness/port.ts` | Done |
| Fake adapter (scripted, no model calls) | `src/harness/fake.ts` | Done |
| OpenWorker adapter | `src/harness/openworker.ts` | Done; verified against DeepSeek with real calls; OpenAI not yet run |
| Claude Code adapter (subscription, local only) | `src/harness/claude-code.ts` | Written; logic tested with a scripted engine. **Not yet run against real Claude Code** — see below |
| Engine router | `src/harness/routing.ts` | Done |
| Audit ledger (hash-chained) | `src/audit/ledger.ts` | Done |
| Config loading | `src/config/load.ts`, `config/` | Done |
| Model gateway and task-level fallback | `src/gateway/` | Done |
| Agent, skill and tool registries with approval lock | `src/registry/registry.ts`, `registry/` | Done |
| Policy decisions, approvals, budgets | `src/governance/` | Done |
| Agent runtime (instantiation under governance) | `src/runtime/workforce.ts` | Done; one real end-to-end run on DeepSeek |
| Command line | `src/cli/main.ts` | Done |
| Orchestrator, knowledge tools, proof-of-concept scenario | — | Not started (milestones 3 and 4) |

## Run it locally

Requires Node.js 22.18 or later.

```bash
git clone https://github.com/koutsovt/OpenWorker.git
```

```bash
cd OpenWorker && npm install
```

```bash
npm test
```

The tests need no API keys. They run the same contract against the fake adapter and against the real
OpenWorker engine talking to a local mock provider.

## Check the Claude Code adapter (your machine, your subscription)

Claude runs through Claude Code on a personal subscription, for local individual use only. Sign in to
Claude Code first, make sure `ANTHROPIC_API_KEY` is not set in your shell, then run:

```bash
node --disable-warning=ExperimentalWarning scripts/claude-code-check.ts
```

It makes a few small real model calls and checks that only platform tools are offered (no shell, file or
web tools), that policy denials and approvals hold, and that sessions resume.

## Check an API-key provider

```bash
CHECK_PROVIDER=DeepSeek CHECK_MODEL=<model id> node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning scripts/provider-check.ts
```

DeepSeek passed this check on 15 Nov 2026 (see [spikes/m0/RESULTS.md](spikes/m0/RESULTS.md)). OpenAI has not been run.
The OpenWorker engine ignores HTTP proxy settings; on a network that requires a proxy, run
`scripts/proxy-relay.ts` and set `CHECK_BASE_URL` to it.

## Run a registered agent

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts run assurance --skills evidence-verification "Review this work: ..."
```

The agent is instantiated from its approved definition in `registry/agents/`, under the user in
`WORKFORCE_USER` (default `local`, defined in `config/users.yaml`). Sensitive tool calls ask for approval
at the terminal. Every step is written to the audit ledger.

## The registry

Agents, skills and tools are files under `registry/`. An agent or skill is usable only if it is marked
`approved` **and** its content matches `registry/approved.lock.yaml`. Editing an approved file, or just
flipping a draft to approved, makes it unusable until the lock is regenerated and reviewed.

```bash
npm run registry -- check
```

```bash
npm run registry -- lock
```

`lock` is the registry administrator's step after review; the lock file change is what approval means.

## Ask a model

Put keys and model ids in a private env file outside the repository:

```
CLAUDE_AUTHOR_MODEL=default
OPENAI_API_KEY=...
OPENAI_ASSURANCE_MODEL=<exact OpenAI model id>
DEEPSEEK_API_KEY=...
DEEPSEEK_FALLBACK_MODEL=<exact DeepSeek model id>
```

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts ask assurance "Summarise the risks of a big-bang data migration."
```

Model policies live in `config/models.yaml`. `assurance` uses OpenAI, and `author` uses Claude through Claude Code
(no key needed; `CLAUDE_AUTHOR_MODEL=default` picks Claude Code's default model). DeepSeek is the fallback for both.
Every model selection, fallback and usage figure is written to the audit ledger in `.state/`:

```bash
npm run verify-ledger
```

## Rules of the codebase

- Each engine SDK is imported only by its own adapter in `src/harness/`. A test enforces this.
- No model ids or keys in code or committed config; both come from the environment.
- Agent definitions are immutable by name. Change a definition, change its name.
- Skills are guidance only; they never grant a tool. Tools come solely from the agent definition.
- Agents hold no role: they cannot approve, and no tool writes to `registry/` or `config/`.
