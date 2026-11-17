# OpenWorker agent workforce

An enterprise multi-agent platform built on a replaceable agent harness. The first engine is the
[OpenWorker Harness SDK](https://github.com/andrewyng/openworker); this repository is the platform around it.

Design and decisions: [docs/enterprise-agent-workforce-plan.md](docs/enterprise-agent-workforce-plan.md).
SDK validation results: [spikes/m0/RESULTS.md](spikes/m0/RESULTS.md).

## Status

All five planned milestones are in place: skeleton, registries and governance, orchestration, the proof-of-concept scenario, and hardening.
**The scenario runs end to end on every engine with a scripted model behind it. On 17 Nov 2026 it also completed once
against real models: every agent on Claude through Claude Code, including the reviewer, so assurance independence was
reduced (no OpenAI or DeepSeek key was available). It has not yet run as designed, with OpenAI as the reviewer.**

| Part | Where | State |
|---|---|---|
| Harness interface | `src/harness/port.ts` | Done |
| Fake adapter (scripted, no model calls) | `src/harness/fake.ts` | Done |
| OpenWorker adapter | `src/harness/openworker.ts` | Done; verified against DeepSeek with real calls; OpenAI not yet run |
| Claude Code adapter (subscription, local only) | `src/harness/claude-code.ts` | Done; `scripts/claude-code-check.ts` passed 11/11 against real Claude Code on 17 Nov 2026 |
| Engine router | `src/harness/routing.ts` | Done |
| Audit ledger (hash-chained) | `src/audit/ledger.ts` | Done |
| Config loading | `src/config/load.ts`, `config/` | Done |
| Model gateway and task-level fallback | `src/gateway/` | Done |
| Agent, skill and tool registries with approval lock | `src/registry/registry.ts`, `registry/` | Done |
| Policy decisions, approvals, budgets | `src/governance/` | Done; self-approval is a policy setting, and budgets apply per run |
| Agent runtime (instantiation under governance) | `src/runtime/workforce.ts` | Done; one real end-to-end run on DeepSeek |
| Command line | `src/cli/main.ts` | Done |
| Orchestrator: planner, plan gate, task graph, parallel execution, retry, restart recovery | `src/orchestrator/` | Done on the fake engine, including a real process kill; one real run on Claude (12 tasks, one rework round with cascade) |
| Knowledge search, evidence records, project memory | `src/memory/`, `src/tools/knowledge.ts` | Done |
| Structured results and output contracts | `src/tools/result.ts`, `src/orchestrator/contracts.ts` | Done; a result must match its contract and cite only evidence that exists in the run |
| Seven agents, eight skills | `registry/` | Written and locked. **Review them: the lock is your approval** |
| Capability assessment and uncovered needs in plans | `src/orchestrator/assessment.ts`, `graph.ts` | Done on the fake engine; not yet run on a real model |
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

Claude runs through Claude Code on a personal subscription, for local individual use only. Signing in to the Claude
desktop app does not sign in the `claude` command, which is what the adapter uses: run `claude auth login` and check
`claude auth status` shows `"loggedIn": true`. Make sure `ANTHROPIC_API_KEY` is not set in your shell, then run:

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
4. Tasks with a critical or major finding are reworked by their authors, once. Tasks built on a reworked result
   are redone after it. Assurance then reviews again.
5. If the final verdict is `fail`, the run is held and no report is written. A user with the approver role can
   override with a reason; both are recorded and printed in the report. Approving your own run needs
   `allowSelfApproval` (see [Approvals and budgets](#approvals-and-budgets)).
6. The Orchestrator writes a short decision brief from the results: the answer, at most six key findings with their
   evidence, recommendations, and decisions needed. The platform rejects a brief over the set lengths and sends it
   back once. It then appends a condensed traceability section it generates itself: the verdict, independence,
   critical and major findings, the cited evidence, prompt-injection flags, usage, approvals and the ledger head.

The brief is saved to `.state/reports/<run-id>.md`. Beside it, `<run-id>-appendix.md` holds the detail: every planned
task's final result, both assurance reviews in full, the evidence register and the work log per task.

Known limits: there is one rework round; cost shows as unknown until prices are added to `config/models.yaml`.

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

The planner may also list parts of the objective that no approved agent and skill fits, rather than stretch
an agent beyond its purpose. They are shown as **NOT COVERED** before you approve, are recorded with the plan,
are passed to the report writer as open questions, and appear in the report under "Not covered by the plan".

## Assess a new kind of work

Before planning work the platform has not done before, check whether the approved agents and skills can do it:

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts assess --scenario scenarios/research-ethics-eforms
```

The `capability-analyst` agent reads the scenario's knowledge documents and is given the catalogue of approved
agents, their eligible skills and their tools. It lists what the work needs, each cited to the passage that
shows it, as covered, partly covered or a gap, and recommends the smallest change for each gap: a new skill
for an existing agent, an existing skill for another agent, or a new agent. The platform checks the result
against the registry in code (named agents are approved, named skills are eligible for them, new ids are not
taken) and sends it back once if it fails. The gap report goes to `.state/reports/assess-<id>.md`.

The analyst is read-only and is never given planned work. Nothing it recommends exists until a person writes
the YAML, the owner reviews it, and the lock is regenerated (see [The registry](#the-registry)).

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
| `project.read` | The run's objective, decisions, evidence so far and an index of completed task results; pass `artefact` to read one result in full |
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

`config/budgets.yaml` sets two kinds of limit. `task` limits (`maxSeconds`, and optionally `maxModelCalls`,
`maxTokens`, `maxCostUsd`) apply to each task attempt and to planning; a task that reaches one is stopped and its
output withheld, and the time limit also covers waiting for an approval. `run` limits (`maxModelCalls`, `maxTokens`,
`maxCostUsd`) apply across every task of one run and are counted from the audit ledger, so they hold across a restart.
When one is reached no further task starts, the tasks not started are marked `blocked`, and the run ends as failed;
tasks already running finish and keep their results. Every attempt is charged, including attempts on a model that
failed before a fallback, and the calls left in a budget cap each session's model-call limit. Tokens and cost cannot
be stopped partway through a session, because engines report usage only when a turn ends. A cost limit with no prices
set in `config/models.yaml` cannot be measured, so it counts as reached.

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

This checks the hash chain and that no records were removed from the end. Someone who can rewrite the whole file can
rebuild the chain, so record the ledger's head somewhere this machine's users cannot rewrite (another account, a
write-once bucket, a printed line) and check against it later. Either append it to an anchor file:

```bash
npm run anchor-ledger -- /path/outside/this/machine/anchors.jsonl
```

```bash
npm run verify-ledger -- /path/outside/this/machine/anchors.jsonl
```

or check the single head a final report prints, as `<seq>:<hash>`:

```bash
npm run verify-ledger -- <seq>:<hash>
```

`WORKFORCE_ANCHOR_FILE` sets a default anchor file. Either check fails if the ledger no longer holds the anchored record.

## Container

A `Dockerfile` is included for the Railway stage. **It has not been built or run.** Its build runs the full test
suite inside the image, which is the check that the OpenWorker runtime works there. Hosted use needs API-key
providers only, and there is no authenticated HTTP entry point yet, so today the image can only run the command line.

## Rules of the codebase

- Each engine SDK is imported only by its own adapter in `src/harness/`. A test enforces this.
- No model ids or keys in code or committed config; both come from the environment.
- Agent definitions are immutable by name. Change a definition, change its name.
- Skills are guidance only; they never grant a tool. Tools come solely from the agent definition.
- Agents hold no role: they cannot approve, and no tool writes to `registry/` or `config/`.
