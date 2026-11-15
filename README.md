# OpenWorker agent workforce

An enterprise multi-agent platform built on a replaceable agent harness. The first engine is the
[OpenWorker Harness SDK](https://github.com/andrewyng/openworker); this repository is the platform around it.

Design and decisions: [docs/enterprise-agent-workforce-plan.md](docs/enterprise-agent-workforce-plan.md).
SDK validation results: [spikes/m0/RESULTS.md](spikes/m0/RESULTS.md).

## Status

Milestones 1 to 4 are in place: skeleton, registries and governance, orchestration, and the proof-of-concept scenario.
**The scenario has run end to end only with a scripted model in the tests; it has not yet run against real models.**

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
| Orchestrator: planner, plan gate, task graph, parallel execution, retry, restart recovery | `src/orchestrator/` | Done on the fake engine, including a real process kill. **Not yet run against a real model** |
| Knowledge search, evidence records, project memory | `src/memory/`, `src/tools/knowledge.ts` | Done |
| Structured results and output contracts | `src/tools/result.ts`, `src/orchestrator/contracts.ts` | Done; a result must match its contract and cite only evidence that exists in the run |
| Six agents, seven skills | `registry/` | Written and locked. **Review them: the lock is your approval** |
| Assurance, rework, fail gate, final report | `src/orchestrator/orchestrator.ts`, `report.ts` | Done on the fake engine |
| Scenario knowledge pack (simulated) | `scenarios/research-ethics-eforms/` | Done |
| Hardening: injection test set, cost report, deployment decisions | — | Not started (milestone 5) |

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

## Run the proof-of-concept scenario

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts orchestrate --scenario scenarios/research-ethics-eforms
```

This reads the objective from the scenario's `objective.md` and limits the agents to its `knowledge/` folder,
which is simulated data written for the exercise. What happens:

1. The Orchestrator proposes a plan using the Research, Solution Architecture, Security and Data agents. You approve it.
2. The planned tasks run, in parallel where the plan allows. Each result must match its agent's output contract,
   and every evidence id it cites must be a passage an agent actually read in this run; otherwise it is sent back once.
3. The Assurance agent reviews all results. It runs under a different model policy (OpenAI) than the authors (Claude).
   A plan cannot assign the Assurance agent or skip it: the platform schedules it.
4. Tasks with a critical or major finding are reworked by their authors, once, and Assurance reviews again.
5. If the final verdict is `fail`, the run is held and no report is written. A user with the approver role can
   override with a reason; both are recorded and printed in the report.
6. The Orchestrator writes the report from the results. The platform appends a traceability section it generates
   itself: the assurance verdict and findings, the evidence register, models and usage per task, and approvals.

The report is saved to `.state/reports/<run-id>.md`.

Known limits: a rework does not re-run tasks that depended on the reworked one; there is one rework round;
cost shows as unknown until prices are added to `config/models.yaml`.

## Orchestrate an objective

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts orchestrate "Assess the options for replacing the ethics forms."
```

The `orchestrator` agent proposes a task graph. The platform rejects any plan that names an agent that is
not approved, a skill the agent is not eligible for, an unknown dependency or a cycle, and tells the planner
why once before giving up. You are then shown the plan and asked to approve it; nothing runs without that.
Each task runs as its own agent instance; tasks with no dependency between them run in parallel (three at a
time by default), and each task receives the results of the tasks it depends on as labelled data.

To skip the planner and supply the task graph yourself (it passes the same checks and the same approval):

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts orchestrate --plan plan.json "Objective text"
```

```json
{ "tasks": [{ "id": "review", "agent": "assurance", "objective": "…", "skills": ["evidence-verification"], "dependsOn": [] }] }
```

If the process dies, list the runs and resume the one that was interrupted:

```bash
npm run runs
```

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts resume <run-id>
```

What happens to a task when things go wrong:

| Situation | Outcome |
|---|---|
| Provider fails with a retryable error | Fresh session on the policy's fallback model |
| Task fails, or ends without submitting a result | One more attempt (two in total) |
| Task fails after a tool that is not a read | Not repeated. Marked `needs_attention` for a person |
| Process killed while a task was running | On resume: re-issued from the start if it had only read; `needs_attention` if it had written |
| Task already completed before the kill | Kept. It is not run again |
| A dependency did not complete | Task marked `blocked`; unrelated tasks still run |

A re-issued task starts a new session, so read-only tool calls it made before the kill are made again.

## Knowledge and evidence

Put `.md` or `.txt` documents in `knowledge/` (or set `WORKFORCE_KNOWLEDGE_DIR`). They are indexed in memory
at start with SQLite full-text search and never written to. Agents whose definition allows them use:

| Tool | What it does |
|---|---|
| `knowledge.search` | Keyword search; returns document, passage anchor and a snippet |
| `knowledge.read` | Reads one passage and records it as evidence; returns the evidence id to cite |
| `evidence.get` | Looks up an evidence record; says so if the source has changed since it was read |
| `project.read` | The run's objective, completed task results and evidence so far |
| `result.submit` | Hands the task's structured result back to the platform |

An evidence record holds the document, passage, a hash of the passage text, the agent instance that read it
and when. Runs, tasks, evidence and project memory live in `.state/state.sqlite`.

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
