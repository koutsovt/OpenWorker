# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An enterprise multi-agent platform built around a replaceable agent engine ("harness"). The platform owns
governance, orchestration, evidence and audit; engines only run model conversations. Design rationale lives in
`docs/enterprise-agent-workforce-plan.md` and `docs/adr/` (read the relevant ADR before changing a mechanism it covers).

## Commands

Node.js 22.18+ runs the TypeScript directly (type stripping): there is no build step, no bundler and no linter.
Imports use explicit `.ts` extensions, and `erasableSyntaxOnly` is on, so no enums, namespaces or parameter properties.

```bash
npm test                     # all tests; no API keys needed
npm run typecheck            # tsc --noEmit over src, tests and scripts
node --disable-warning=ExperimentalWarning --test tests/registry.test.ts            # one file
node --disable-warning=ExperimentalWarning --test --test-name-pattern="lock" tests/registry.test.ts   # one test
npm run registry -- check    # do approved agents, skills and tools match registry/approved.lock.yaml?
npm run registry -- lock     # regenerate the lock (this IS the approval step; see below)
npm run verify-ledger        # check the audit hash chain; optionally `-- <seq>:<hash>` or `-- <anchor-file>`
npm run anchor-ledger -- <anchor-file>   # append the ledger head to a file kept off this machine
```

Some tests start the real OpenWorker engine against a local mock HTTP provider (`tests/support/mock-provider.ts`).
In Claude Code's sandbox they are reported as *cancelled* ("Promise resolution is still pending"); run the suite
outside the sandbox to get a real result. Tests run with `--test-concurrency=1`.

CLI (`src/cli/main.ts`, via npm scripts `orchestrate`, `resume`, `assess`, `eval`, `improve`, `runs`, `usage`, `agent`, `ask`): real model
calls need `node --env-file=<private env outside the repo>`. State goes to `.state/` (`WORKFORCE_STATE_DIR`);
identities are `WORKFORCE_USER` (requester) and `WORKFORCE_APPROVER` (defaults to the requester), checked against
`config/users.yaml`. The proof-of-concept scenario: `src/cli/main.ts orchestrate --scenario scenarios/research-ethics-eforms`.

## Architecture

**Harness port.** `src/harness/port.ts` is the only seam to an engine (`AgentHarness`, `AgentSession`). Adapters:
`fake.ts` (scripted, no model calls), `openworker.ts` (OpenWorker Harness SDK, API-key providers),
`claude-code.ts` (Claude Agent SDK, local subscription only), and `routing.ts`, which presents several engines as
one and routes by provider (`api: claude-code` vs the rest). Each engine SDK may be imported only by its own adapter;
a test enforces this. `tests/harness-contract.test.ts` and `tests/harness-swap.test.ts` run the same contract and
scenario against every adapter, so a behaviour change must hold on all of them.

**Workforce (`src/runtime/workforce.ts`)** is the one place registry, policy, gateway, harness and ledger meet.
It registers every registry tool with the engine, wrapping execution with per-session call limits, side-effect
tracking and audit; supplies the engine's policy check (`Governance.mayCallTool`); and instantiates an agent per
run as `<agent>@<version>#<random>`. That instance id is the session *tag*: tools and policy look the instance up by
tag, so a tool implementation receives the `AgentInstance` (user, skills, run/task), never raw session data.

**Model gateway (`src/gateway/`).** Agents name a model *policy*, not a model. `config/models.yaml` maps aliases to
providers; exact model ids come from env vars named by `modelEnv`. `runTask` falls back to the policy's next model
only on a retryable provider failure and only if the task has made no non-read tool call, and always in a fresh
session under a new agent name (`<name>--<alias>`), because engine definitions are immutable by name. Any change to
what an engine is told must therefore change the agent name (workforce hashes digest + instructions + approvals + limits into it).

**Registry and approval (`src/registry/registry.ts`, `registry/`).** Agents (`agents/<id>/<version>.yaml`), skills
(`skills/<id>/<version>/skill.yaml` + `SKILL.md`) and tools (`tools/*.yaml`) are data. An agent or skill is usable
only if `status: approved` **and** its digest (content minus `status`) matches `approved.lock.yaml`; an agent is also
refused if any tool it uses no longer matches its locked digest. Editing any of these files makes it unusable until
`npm run registry -- lock` is run and the lock change reviewed: never regenerate the lock as a side effect of other
work without saying so. Skills are guidance text only and never grant tools.

**Governance (`src/governance/`).** `policy.ts` decides from `config/users.yaml` + `config/policies.yaml`: roles grant
run, approve and tool action classes; data classification is capped by the agent's ceiling; approving one's own
request needs `allowSelfApproval`. Tools with `risk: sensitive` pause for a human on every call (no session-wide
grants). Budgets (`config/budgets.yaml`): `task` limits use a fresh `BudgetTracker` per attempt and withhold the
output when reached; `run` limits use one tracker per run, seeded from the ledger so a resume does not reset it, and
stop further tasks from starting (marked `blocked`). Tokens and cost cannot be stopped mid-session.
`injection.ts` screens retrieved text and agent-to-agent results sentence by sentence; it is one layer of several (ADR 8).

**Orchestrator (`src/orchestrator/`).** A planner agent proposes a task graph by calling `result.submit`;
`graph.ts` validates it in code (approved agents, eligible skills, no cycles, reserved stage ids); a human approves;
then `orchestrator.ts` runs ready tasks in parallel. After the planned tasks the platform itself appends stage tasks:
`assurance` → optional `<id>-rework` (findings' tasks plus everything downstream of them) + `assurance-2` → `report`. Each stage is a row in the run store, and the next
step is derived only from stored results, which is what makes `resume` after a process kill work. Results must
match the agent's output contract (`contracts.ts`, zod) and may cite only evidence ids retrieved in this run; a
failing result is sent back once. A fail verdict holds the run until an approver overrides with a reason.
`report.ts` writes two files: the decision brief (the report task's result, capped by the `report` contract,
plus condensed traceability) and `<run-id>-appendix.md` (every task's final result, full reviews, evidence register).
The planner may return `uncovered` needs with its plan (work no catalogue agent fits); they are stored as the
run's `uncovered` decision, shown at approval, added to the report task's objective and listed in the report.

**Capability assessment (`src/orchestrator/assessment.ts`).** `assess` runs `capability-analyst` outside any
orchestrated run (id `assess-<random>`) against a knowledge folder and the registry catalogue. Its
`capability-assessment` result passes the zod contract, then `checkAssessment` (registry checks: covering agents
approved, skills eligible, new ids unused). Agents whose contract is in `PLATFORM_ONLY_CONTRACTS` are excluded
from planning. The analyst only recommends; it writes nothing (`skills.propose` would need a write role).

**Evaluation and improvement (`src/evaluation/`).** Every scenario folder has an answer key, `eval.yaml`, outside
`knowledge/` so agents never read it (a test enforces both). `eval <scenario>` runs the scenario (or grades
`--run <id>`): `run`, `ledger` and `text` checks are made in code, `judge` criteria by the `evaluator` agent
(assurance policy, id `eval-<random>`, gets the screened brief and appendix, no knowledge tools). The scorecard
(`.state/evals/<scenario>/`) records the agent and skill versions used and the lock digest; `--compare latest`
diffs it with the previous one. A candidate version is compared by locking it on a branch, never by running
unlocked definitions. `improve <run-id>` gathers the run's signals (findings, sent-back results, refused tools,
limits, failed eval checks, uncovered needs), each tied to the agent and skill versions in use, and the
`retrospective` agent drafts changes to `.state/proposals/`; `checkProposals` requires real targets and signal ids.
Both agents are platform-only and write nothing.

**State.** `src/audit/ledger.ts`: append-only, hash-chained SQLite ledger (plus a head row) for every decision;
`ledger.verify()` checks it. `src/memory/state.ts`: evidence records and project memory, sharing one SQLite file
with the run store (`src/orchestrator/store.ts`). `src/memory/knowledge.ts`: read-only knowledge folder indexed
in memory with SQLite FTS5 (no vector DB, ADR 6); reading a passage creates the evidence record that makes it citable.

## Rules of the codebase (from the README)

- Each engine SDK is imported only by its own adapter in `src/harness/`.
- No model ids or keys in code or committed config; both come from the environment.
- Agent definitions are immutable by name. Change a definition, change its name.
- Skills are guidance only; tools come solely from the agent definition.
- Agents hold no role: they cannot approve, and no tool writes to `registry/` or `config/`.
- Unknown is never shown as zero: missing usage or prices make cost "unknown", not 0.

## Status caveat

All five milestones are implemented, but end to end only against a scripted model. The Claude Code adapter has not
run against real Claude Code, OpenAI has not been run, and hosted deployment is design only (ADRs 9–11).
`registry/` agents and skills are written and locked; the lock is the owner's approval.
