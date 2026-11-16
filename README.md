# OpenWorker agent workforce

An enterprise multi-agent platform built on a replaceable agent harness. The first engine is the
[OpenWorker Harness SDK](https://github.com/andrewyng/openworker); this repository is the platform around it.

Design and decisions: [docs/enterprise-agent-workforce-plan.md](docs/enterprise-agent-workforce-plan.md).
SDK validation results: [spikes/m0/RESULTS.md](spikes/m0/RESULTS.md).

## Status

All five planned milestones are in place: skeleton, registries and governance, orchestration, the proof-of-concept scenario, and hardening.
**The scenario runs end to end on every engine, including the real OpenWorker runtime, but only with a scripted model behind it. It has not yet run against real models.**

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
| Policy decisions, approvals, budgets | `src/governance/` | Done; self-approval is a policy setting, and budgets apply per run |
| Agent runtime (instantiation under governance) | `src/runtime/workforce.ts` | Done; one real end-to-end run on DeepSeek |
| Command line | `src/cli/main.ts` | Done |
| Orchestrator: planner, plan gate, task graph, parallel execution, retry, restart recovery | `src/orchestrator/` | Done on the fake engine, including a real process kill. **Not yet run against a real model** |
| Knowledge search, evidence records, project memory | `src/memory/`, `src/tools/knowledge.ts` | Done |
| Structured results and output contracts | `src/tools/result.ts`, `src/orchestrator/contracts.ts` | Done; a result must match its contract and cite only evidence that exists in the run |
| Six agents, seven skills | `registry/` | Written and locked. **Review them: the lock is your approval** |
| Assurance, rework, fail gate, final report | `src/orchestrator/orchestrator.ts`, `report.ts` | Done on the fake engine |
| Scenario knowledge pack (simulated) | `scenarios/research-ethics-eforms/` | Done |
| Prompt-injection screen and test set | `src/governance/injection.ts`, `scenarios/injection-set/` | Done; three techniques are known to get past the screen and are stopped by other controls |
| Harness swap test | `tests/harness-swap.test.ts` | Done: same scenario, same outcome on the fake, the Claude Code adapter, the real OpenWorker runtime, and both routed |
| Cost and usage report | `src/audit/usage.ts` | Done; cost shows as unknown until prices are set |
| Architecture decision records | `docs/adr/` | Written. Hosted deployment is a design only; no container has been built |

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
   override with a reason; both are recorded and printed in the report. Approving your own run needs
   `allowSelfApproval` (see [Approvals and budgets](#approvals-and-budgets)).
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

## Cost and usage

```bash
npm run usage
```

```bash
npm run usage -- <run-id>
```

Totals come from the audit ledger: by model and by run, or by task for one run. A session with no price or with
incomplete usage is counted as unpriced, never as zero. Claude through Claude Code is on a subscription, so its
figures are marked notional. To get cost figures, add `price: { input, output }` (USD per million tokens, from the
provider's current price list) to each model in `config/models.yaml`.

## Prompt injection

Text returned by the knowledge tools, and results passed from one agent to another, are screened: a sentence that
reads as an instruction to the reader is removed, recorded in the ledger and listed in the run's report.
The screen is a pattern list and is one layer of several; see [ADR 8](docs/adr/0008-layered-prompt-injection-defences.md)
and [the injection test set](scenarios/injection-set/README.md), which says exactly what gets past it.

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

## Approvals and budgets

At the command line the requester is `WORKFORCE_USER` and the approver is `WORKFORCE_APPROVER`, which defaults
to the requester. Both must be in `config/users.yaml`, and the approver needs a role with `approve`. These names are
self-asserted until an identity provider replaces `users.yaml`.

Approving your own request (your own plan, a tool call in your own run, or an override of assurance on your own
run) is refused unless `allowSelfApproval: true` is set in `config/policies.yaml`. It is set there now because the
proof of concept has a single local user; set it to `false` once there is a second approver. Every approval in the
ledger says whether it was a self-approval.

Budgets (`maxModelCalls`, `maxTokens`, `maxCostUsd`, `maxSeconds`) apply to planning and to each execution of a
run as a whole: every task of the run is charged to one budget, including attempts on a model that failed before a
fallback, and no task starts once the budget is used up. The calls left in the budget cap each session's model-call
limit, and the time limit also covers waiting for an approval. Tokens and cost cannot be stopped partway through a
session, because engines report usage only when a turn ends. A resumed run starts a fresh budget.

## The registry

Agents, skills and tools are files under `registry/`. An agent or skill is usable only if it is marked
`approved` **and** its content matches `registry/approved.lock.yaml`. Editing an approved file, or just
flipping a draft to approved, makes it unusable until the lock is regenerated and reviewed.
Tool definitions are locked too: if a tool's file changes (its risk, action or data classification, say),
every agent that uses it is refused until the lock is regenerated.

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

This checks the hash chain and that no records were removed from the end. Someone who can edit the database could
rewrite both, so keep the ledger head somewhere else: the final report prints it as `<seq>:<hash>`, and

```bash
npm run verify-ledger -- <seq>:<hash>
```

fails if the ledger no longer contains that record.

## Rules of the codebase

- Each engine SDK is imported only by its own adapter in `src/harness/`. A test enforces this.
- No model ids or keys in code or committed config; both come from the environment.
- Agent definitions are immutable by name. Change a definition, change its name.
- Skills are guidance only; they never grant a tool. Tools come solely from the agent definition.
- Agents hold no role: they cannot approve, and no tool writes to `registry/` or `config/`.
