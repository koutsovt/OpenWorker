# Enterprise Agent Workforce — Architecture Assessment and Implementation Plan

Status: **plan approved 15 Nov 2026. M0 to M4 are built; M5 (hardening) is next. M3 and M4 are verified with a scripted model only, not yet with real providers.** See the README for current state.
Source inspected: `andrewyng/openworker` at commit `ecb4454` (13 Nov 2026), read-only clone.
npm registry checked the same day: `@openworkerai/harness-sdk` **0.1.0-beta.4** (client), native runtime **0.1.0-beta.3**.

Evidence labels used below:

- **[src]** confirmed in source code
- **[doc]** stated in repository documentation, not independently traced in code
- **[spike]** not verified; must be proven in the M0 validation spike before we rely on it

---

## 0. Findings that shape the plan

1. **The Harness SDK is a different engine from the Desktop app.** The Desktop app runs a Python engine (`coworker/`); the SDK runs a separate Rust engine (`harness/`) driven from TypeScript or Rust. There is no Python SDK. Desktop features do not carry over automatically.
2. **The SDK is beta and moving.** Version 0.1.0-beta.x, "under active development", maintainers ask for no SDK pull requests yet. Some documented options are marked "source preview" and are not in the published package.
3. **Five things in the brief are not provided by the SDK and must be built around it:** runtime model fallback, structured output for working agents, a usable skills mechanism for SDK-defined agents, dollar cost tracking, and user identity/RBAC.
4. **Four things are provided well and should not be rebuilt:** the agent loop with durable sessions and recovery, the approval/interruption mechanism, guardrails and blocking hooks, and compliance/audit capture.
5. **Harness-native delegation does not meet "agents instantiated from approved definitions".** With standalone sub-agents, the *parent model* writes the child's system prompt. That is the opposite of a governed registry. The orchestrator should therefore be application code that creates harness sessions, not a harness sub-agent tree.
6. **No OS sandbox is available to the SDK on macOS.** OpenShell is Linux-only; the macOS Seatbelt sandbox belongs to the Desktop app. The proof of concept must stay with read-only application tools and no shell or file-write tools.

---

## 1. OpenWorker SDK capability assessment

### 1.1 Desktop app versus Harness SDK

| Capability | Desktop app (Python engine) | Harness SDK (Rust engine) |
|---|---|---|
| Agent loop, streaming, compaction | Yes | Yes [src] |
| Durable sessions, restart recovery | Yes | Yes, SQLite or PostgreSQL [src] |
| Providers | OpenAI, Anthropic, native Gemini, Vertex, Bedrock, OpenRouter, DeepSeek handling, local | Three wire formats only: OpenAI Responses, Chat Completions, Anthropic Messages [src] |
| Connectors (Slack, GitHub, email, calendar) | Yes | No. MCP or your own tools |
| Web search tool | Yes | No |
| Specialist coworkers / personas with skills | Yes | Only via hand-written coworker bundles (see 1.3) |
| Scheduled automations | Yes | Agent-level timers only (`scheduling`) |
| macOS / Windows OS sandbox | Yes | No. `direct_macos.rs` is an explicit sandbox-off profile [src] |
| OpenShell sandbox | Yes | Yes, Linux gateway required [src] |
| Approvals with reviewer model | Yes | Yes [src] |
| Guardrails, hooks, compliance capture, SIEM export | Partly | Yes [src] |
| Teams and sub-agents | Team board | Standalone sub-agents and explicit teams [src] |
| Shared service (API nodes + workers), `ows` CLI, management UI | No | Yes, experimental cloud references [doc] |

### 1.2 What the SDK provides (use as-is)

| Area | What exists | Evidence |
|---|---|---|
| Lifecycle | `Harness.start()` spawns a managed Rust child over private stdio; `shutdown()`; auto-restart options | [src] `index.ts`, `transport.ts` |
| Agent definitions | `createAgent({name, instructions, defaultModel, tools, approvals, limits, ...})`. Definitions are **immutable by name**; any change needs a new name | [src] `types.ts`, conflict error fields |
| Sessions | `newSession({model, workspace, guardrails, hooks, initialHistory})`, `resumeSession(ref)`, `state()`, `cancel()`, `close()` | [src] |
| Per-session model override | `SessionOptions.model` overrides the agent default; the session stores its resolved model | [src] |
| Turn control | `send/run/runStreamed` with `instructionAddendum`, `limits` (`maxModelCalls`, `maxOutputTokens`, `maxOutputTokensPerCall`), idempotent `submissionId` | [src] |
| Events | Journal events with cursors: model attempts, deltas, tool start/finish, approval decisions, `model_usage`, provider errors | [src] |
| Retries | Up to 3 attempts per model call inside the runtime; structured `providerError` with category and `retryable` | [src] `runtime.rs:609`, `provider.rs` |
| Tools | App callbacks via `registerTools` with JSON input schema, cancellation and progress; MCP over stdio or streamable HTTP | [src] |
| Approvals | Modes `always` (default), `only` (listed tools), `auto` (reviewer model), `never`. Responses `once`, `session`, `deny`. Durable interruptions | [src] |
| Guardrails | Rules on user input, model output, tool arguments, tool results: regex, secrets, credit card, model-based detector; block or redact; fail closed | [src] `safety.ts`, [doc] |
| Hooks | `beforeInput`, `beforeModel`, `beforeTool`, `afterTool`, `beforeOutput`, observational `onEvent`. Blocking hooks return allow/block | [doc], [src] types |
| Compliance | Opt-in capture in the execution transaction; `complianceActivity()` query; SIEM sink with at-least-once delivery | [src], [doc] |
| Observability | Optional recording DB, timeline queries, OTLP / Langfuse export, content capture off by default | [src] `observability.ts` |
| Memory | Built-in `memory_remember/read/search/update/forget`, scoped by app-owned `memoryScope`, literal text search, no vectors | [src] `assistant_tools.rs` |
| Planning | Built-in `update_plan` todo list, bookkeeping only | [src] |
| Sub-agents | Model-driven `create_sub_agent` (sync/async), max 4 active and 32 retained by default, children cannot spawn | [src] `subagents.rs`, [doc] |
| Teams | `newTeam(lead, {agentTypes, delegation:{tools, models}, maxInstances})`, board, direct messages, `spawn()` with per-child model from an app-delegated list | [src] |
| Storage | SQLite locally; PostgreSQL selectable (`storage: {type:'postgres', connectionEnv, schema}`) | [src] |

### 1.3 Limitations and blockers

| # | Limitation | Evidence | Consequence |
|---|---|---|---|
| L1 | **No runtime model fallback.** Provider code states "no silent fallback". The `fallbackModel` field is a misnomer: it is the default model when no named connection is chosen | [src] `agents/mod.rs:270` | Fallback is built in our gateway, at task level |
| L2 | **No structured output for working agents.** `json_schema` response format is wired in the provider adapters but only used by the internal action reviewer. `RunResult.finalOutput` is a string | [src] `permissions.rs:297`, `types.ts` | Use a schema-validated `submit_result` tool per task |
| L3 | **Skills are not reachable from `createAgent`.** The runtime supports bundled skills (`load_skill`, `read_skill_resource`), but SDK-defined agents compile with `skills: []`. Skills only load from hand-written coworker bundles, an "advanced interface" whose provider type is limited to `openai` or `anthropic` | [src] `agents/bundle.rs`, `skills.rs`, `types.ts` | Build our own Skills Registry; deliver skills through our own tool and `instructionAddendum` |
| L4 | **No dollar cost.** Token usage arrives as `model_usage`; it can be absent, and absent means unknown, not zero | [doc], [src] | Price table and cost ledger in the gateway |
| L5 | **Limits are per turn and output-side only.** No input-token cap, no cost cap, no wall-clock cap exposed | [src] `TurnLimits` | Budget enforcer in our code, using `session.cancel()` |
| L6 | **HTTP timeouts appear fixed** at 15 s connect and 180 s request inside the runtime | [src] `model.rs:370` | Task-level timeout in our code; cannot tune per provider |
| L7 | **No identity or RBAC.** "A session is not a user account: your application enforces ownership" | [doc] | Build identity, roles and policy decisions ourselves |
| L8 | **No sandbox on macOS for the SDK**, and the TypeScript default is `sandbox: "openshell"` | [src] `config.ts:137` | Set `sandbox: 'off'` explicitly; no shell or write tools in the PoC |
| L9 | **MCP HTTP registration has no auth field**: `{name, transport, url}` only | [src] `McpServer` type | Authenticated enterprise MCP servers need a local proxy or an app-callback wrapper |
| L10 | **DeepSeek is not a qualified provider in the SDK.** It should work as a Chat Completions endpoint, but tool calling and reasoning replay are untested there | [src] no references in `harness/` | Prove in M0 before promising it |
| L11 | **Sessions are tied to their provider.** Provider-private replay state is bound to connection and model; docs say use a fresh session when changing providers | [doc] | "Model switching" means a new session, not a mid-session swap |
| L12 | **Sub-agent prompts are model-authored**, tools are a subset of the parent's, no history inheritance | [src], [doc] | Do not use for governed specialist agents |
| L13 | **Compliance store is not tamper-proof** against a database administrator; no legal hold | [doc] | Add a hash-chained platform audit ledger |
| L14 | **Beta instability.** API still changing; `main` is ahead of npm; Alpine/musl unsupported | [doc] | Pin exact version; keep everything behind an adapter |
| L15 | **Deployment references are experimental.** A private-Kubernetes guide and Helm chart exist, but "local qualification does not cover every remote environment" | [doc] `private-kubernetes.md`, `deploy/helm` | Start with the embedded SDK in a container; qualify the shared service ourselves before relying on it |

| L16 | **The engine's model client ignores HTTP proxies** (`.no_proxy()`), found during the DeepSeek check | [src] `runtime/src/model.rs:368` | On networks with a mandatory outbound proxy, providers are unreachable without a relay or gateway in front. Matters for enterprise networks |

None of these is a hard blocker for the proof of concept. L10 is the only one that could remove a stated requirement (DeepSeek); L8 limits what the PoC may safely do.

---

## 2. Verified SDK API and integration assessment

Integration language: **TypeScript on Node 22.12+**. This is the only SDK published to a registry. Rust is available only as a pinned git dependency.

Calls the platform would depend on, all confirmed in `harness/typescript-sdk/src`:

| Platform need | SDK call |
|---|---|
| Start engine | `Harness.start({stateDir, sandbox:'off', guardrails, hooks, compliance, recording})` |
| Register provider | `harness.setModelProvider({name, api, baseUrl, credentials:{apiKeyEnv, storage:'memory'}})` |
| Check a model works | `harness.testModelProvider({provider, name})` |
| Register tools | `harness.registerTools({namespace, tools:{name:{description, inputSchema, execute}}})` |
| Connect MCP | `harness.connectMcpServer(...)`, `harness.startMcpServer(...)` |
| Define agent | `harness.createAgent({name, instructions, defaultModel, tools, approvals, limits, planning, memory, scheduling, builtinTools})` |
| Instantiate | `agent.newSession({model, guardrails, hooks, compliance})` |
| Run a task | `session.send(text, {instructionAddendum, limits, submissionId})` then `run.events()` / `run.result()` |
| Approval loop | `result.interruptions`, `session.respond(i, {decision})`, `session.resumeStreamed(checkpoint)` |
| Stop | `session.cancel()` |
| Recover | `agent.resumeSession(ref)`, `session.state()` |
| Policy hook | `hook.beforeTool({name, tools, run})` returning allow or block |
| Audit read | `session.complianceActivity({after, limit})` |

Provider mapping for the three targets:

| Target | `api` value | Status |
|---|---|---|
| Anthropic Claude API | `anthropic` | Native, prompt caching and thinking options [src] |
| OpenAI API | `responses` | Native [src] |
| DeepSeek API | `chat-completions` with custom `baseUrl` | Plausible, unqualified [spike] |

Items the M0 spike must prove before design is frozen:

1. Several sessions running concurrently in one harness process.
2. DeepSeek tool calling, usage reporting and multi-step turns through Chat Completions.
3. The `submit_result` tool pattern yields schema-valid output on all three providers.
4. A harness-level `beforeTool` hook can cover every tool, and a block is fail-closed.
5. `model_usage` events are present for all three providers.
6. Kill and restart mid-task, then `resumeSession` without re-running tool calls.
7. `instructionAddendum` size limit (documented for other guidance strings as 32,000 bytes; not stated for this field).
8. Whether session-scoped hooks and harness-scoped hooks combine as documented ("session settings add checks; they cannot replace").

---

## 3. Proposed enterprise architecture

Single Node process, modular monolith. No microservices, no message bus.

```
┌────────────────────────────────────────────────────────────────────┐
│ CLI / (later) API                         user identity + role     │
├────────────────────────────────────────────────────────────────────┤
│ Orchestrator (application code)                                    │
│   planner → task graph → scheduler → executor → consolidator       │
├───────────────┬───────────────┬───────────────┬────────────────────┤
│ Agent         │ Skills        │ Tool          │ Model Gateway      │
│ Registry      │ Registry      │ Registry      │ policy, fallback,  │
│ (definitions) │ (versioned)   │ (risk, perms) │ cost, capability   │
├───────────────┴───────────────┴───────────────┴────────────────────┤
│ Governance: policy decision point · approvals · budgets · identity │
├────────────────────────────────────────────────────────────────────┤
│ Memory & knowledge stores        │ Audit ledger (append-only)      │
├────────────────────────────────────────────────────────────────────┤
│ AgentHarness port  (our interface; the only seam to the engine)    │
├────────────────────────────────────────────────────────────────────┤
│ OpenWorker adapter            │ Fake adapter (scripted, for tests) │
└───────────────┬────────────────────────────────────────────────────┘
                │ private stdio
        OpenWorker Rust runtime ──► Anthropic / OpenAI / DeepSeek
```

Key design choices, each requiring your approval:

- **Orchestration is application code.** The Orchestrator Agent is an LLM session that *proposes* a plan as structured data. Our code validates the plan against the registries and policy, then executes it. The model never instantiates agents directly.
- **One harness session per agent instance.** Each task gets a fresh session created from an approved definition. This gives independent context, independent model choice and a clean audit boundary.
- **The harness port is small and engine-neutral.** Operations: register provider, register tool, define agent, start session, run turn, stream events, answer interruption, cancel, resume. Nothing above the port imports the OpenWorker package. A fake adapter proves replaceability and makes most tests free and deterministic.
- **Enforcement is layered.** A tool call must pass: the agent's fixed tool list (harness), our policy check (`beforeTool` hook), human approval for sensitive classes (harness approval mode), and scoping inside the tool itself.

---

## 4. Component responsibility matrix

| Capability | OpenWorker provides | We build | Deferred |
|---|---|---|---|
| Model/tool loop, streaming, compaction | ✔ | adapter mapping | |
| Session durability and recovery | ✔ | run-level recovery of the task graph | durable workflow engine |
| Provider wire protocols | ✔ (3 formats) | provider config, capability catalogue | local open-weight models (Ollama, vLLM) |
| Per-call retry | ✔ (3 attempts) | task-level retry and timeout | |
| Model fallback | ✘ | gateway fallback chains | |
| Model selection policy | ✘ (override only) | gateway policy and audit | task-adaptive routing |
| Token usage | ✔ events | cost ledger, price table | chargeback |
| Structured output | ✘ | `submit_result` tool and validation | native format if SDK adds it |
| Agent definitions | immutable store | registry, versioning, approval state | admin UI |
| Agent instantiation | `newSession` | instance identity, lifecycle | |
| Skills | bundle-only | Skills Registry, selection, delivery | marketplace, proposal UI |
| Tool execution plumbing | ✔ callbacks, MCP | Tool Registry metadata, risk classes, limits | authenticated MCP proxy |
| Tool permission enforcement | tool list, approval modes | policy decision point | Keycloak-backed RBAC, Open Policy Agent |
| Human approval | ✔ interruptions | approval UX (CLI), approver roles, records | chat or ticket-based approvals |
| Content guardrails | ✔ | rule set, injection defences | external scanner (Prisma AIRS) |
| Sandboxed execution | OpenShell (Linux) | none in PoC | OpenShell on Linux / Kubernetes |
| Multi-agent coordination | sub-agents, teams | task graph orchestrator | harness teams for ad hoc work |
| Independent assurance | reviewer model for actions only | Assurance Agent workflow | |
| Session memory | ✔ | | |
| Agent memory | ✔ literal-search store | governance over what may be written | |
| Project and enterprise knowledge | ✘ | stores and read tools | pgvector or OpenSearch |
| Audit | compliance capture, SIEM sink | platform ledger, hash chain | Wazuh, write-once object storage |
| Observability | recording, OTLP | run report | OpenTelemetry, Prometheus, Grafana, Langfuse |
| Identity | ✘ | local users and roles file | Keycloak (OIDC), workload identities |
| Secrets | env reference, memory-only | `.env` outside repo | OpenBao |

---

## 5. Agent and Skills Registry design

### 5.1 Agent definitions (files in git, reviewed by pull request)

Fields: `id`, `version`, `status` (draft, approved, retired), `owner`, `purpose`, `instructions`, `allowedTools` (qualified names), `modelPolicy` (reference into gateway policy), `approvalProfile`, `limits`, `eligibleSkills` (tags or ids), `outputContract` (JSON schema reference), `dataClassificationCeiling`.

- Harness agent name is derived as `{id}-v{version}-{digest8}`. This fits the harness rule that definitions are immutable by name, and makes the running definition traceable to a git commit.
- Only `approved` definitions can be instantiated. The loader refuses anything else.
- An **instance** is `{definition, runId, taskId, sessionRef, resolvedModel, assignedSkills, initiatingUser}`. Instances are records in the run store, never files.
- Six definitions cover the six roles. Tasks vary by prompt, skills and addendum, not by new definitions.

### 5.2 Skills (separate registry, separate lifecycle)

Layout per skill version: `skill.yaml` (metadata) plus `SKILL.md` (methodology) plus optional reference files plus `tests/`.

Metadata: `id`, `version` (semver), `status`, `owner`, `purpose`, `scope`, `inputs`, `outputs`, `qualityCriteria`, `evidenceRequirements`, `dependencies` (other skills), `applicableRoles`, `suggestedTools` (descriptive only).

Rules:

- **Skills carry no permissions.** `suggestedTools` is documentation. A skill that mentions a tool the agent lacks does not grant it. This mirrors the harness's own rule for bundled skills.
- **Discovery.** The planner receives the catalogue (id, purpose, scope) for skills eligible to each role and proposes assignments. Our code validates eligibility and resolves dependencies.
- **Delivery.** Assigned skill summaries go into the turn's `instructionAddendum` (application-owned, kept separate from user text). Full text is fetched by the agent through a `skills.load` tool restricted to the skills assigned to that instance. Every load is audited.
- **Composition.** Dependencies are resolved to an ordered set; cycles are rejected at load time.
- **Testing.** Each skill has fixture inputs and rubric checks, run against the fake adapter for structure and optionally live for quality.
- **Change control.** Agents may call `skills.propose` which writes a proposal record. Proposals have no effect until a human merges them into the registry. No tool writes to the registry directory.

Initial seven skills as listed in the brief, mapped: Solution Architecture Assessment and Hosting Architecture Review (open-source stack; replaces "Azure Architecture Review") and Integration Architecture → Solution Architecture Agent; Security Threat Modelling → Security Agent; Requirements Traceability → Architecture and Assurance; Evidence Verification → Research and Assurance; Independent Solution Assurance → Assurance.

---

## 6. Multi-model gateway design

The gateway is a library module, not a network proxy. The harness makes the actual HTTP calls; the gateway decides which provider and model a session uses and accounts for the result.

| Concern | Design |
|---|---|
| Provider abstraction | `providers.yaml`: name, wire format, base URL, credential env var name, options. Registered through the harness port at startup |
| Model catalogue | `models.yaml`: logical alias → provider and model id, context window, capabilities (tools, vision, thinking), price per million input/output/cached tokens, status. **No ids in code.** Ids are verified against provider documentation and `testModelProvider` at startup |
| Selection | Each agent definition names a model policy: default alias, allowed aliases, ordered fallbacks. A task may request a capability or tier; the gateway picks from the allowed set only |
| Controlled switching | A switch creates a new session. It is permitted only if the target is in the policy's allowed set. Otherwise it is refused and logged |
| Fallback | On a failed turn with a retryable provider category (rate limit, transient, transport) after the harness's own attempts: start a fresh session on the next approved fallback and re-issue the task. Not applied once a task has executed a side-effecting tool; that case goes to a human |
| Timeout | Wall-clock limit per task in our executor, enforced with `session.cancel()` |
| Capability check | Before instantiation: required capabilities and output-token limits against the catalogue |
| Structured output | Per-task `submit_result` tool whose input schema is the output contract; validated again in our code; one corrective re-prompt, then failure |
| Usage and cost | Sum `model_usage` events per session; cost from the price table; missing usage recorded as unknown and flagged |
| Logging | Every selection, switch, fallback and refusal written to the audit ledger with policy id and reason |

Independence rule for assurance: the Assurance Agent's policy must resolve to a different provider than the one that authored the work being reviewed, where an approved option exists.

---

## 7. Security and governance model

**Identity**

- Users: local file of users and roles for the PoC (`requester`, `approver`, `registry-admin`, `auditor`). Keycloak (OIDC) later.
- Agents: every instance has an id bound to its definition digest, run, task and initiating user. All audit records carry both the user and the agent identity.

**Authorisation**

One policy decision function: inputs are user role, agent definition, tool, tool risk class, action type (read, write, execute), data classification. Output is allow, deny or require-approval, with a reason. Policies are files in git.

Enforcement points, in order:

1. Tool not in the agent definition → the model never sees it (harness).
2. `beforeTool` hook calls the policy function; unavailable or erroring check blocks (harness fails closed).
3. Risk class `sensitive` → harness approval mode `only` routes to a human approver. Approval is recorded with approver identity. Session-wide grants are disabled for sensitive tools; each call is approved once.
4. The tool implementation applies its own scope (allowed paths, allowed datasets, row limits).
5. Guardrails redact secrets and classified patterns in tool results and model output.
6. Budget enforcer cancels on cost, token, time or call-count breach.

**Self-escalation controls**

- Definitions are immutable in the harness and sourced from git; no agent has a tool that writes to registries or policy.
- Skills cannot add tools.
- A plan that references an unapproved agent, skill, tool or model is rejected before execution.
- The orchestrator model cannot approve its own interruptions; approval responses only come from the CLI user with the `approver` role.

**Prompt injection**

- Retrieved documents and tool results are wrapped and labelled as untrusted data; agents are instructed that such content never carries instructions.
- The Research Agent has read-only tools only, so injected text has nothing to trigger.
- Tool-result guardrail rules flag instruction-like patterns; flagged content is redacted and logged.
- Agents exchange results only through validated structured outputs, not free text passed verbatim into another agent's instructions.
- The Assurance Agent checks claims against cited evidence, which catches content steered by injected material.

**Secrets**: runtime keys in an env file outside the repository, referenced by variable name, held in memory only. Claude Code subscription credentials are never read by the platform.

**Lifecycle governance**: agents and skills move draft → approved → retired by pull request with a named owner. Retired versions remain resolvable for audit replay.

**Assurance authority**: the Assurance Agent runs in its own session with fresh context, read access to artefacts and evidence, no access to the authors' reasoning, and reports directly to the orchestrator. A `fail` verdict blocks consolidation unless a human overrides, and the override is recorded.

---

## 8. Data and memory design

| Layer | PoC storage | Access | Future |
|---|---|---|---|
| 1. Session memory | Harness state (SQLite) with built-in compaction | Harness | Harness on PostgreSQL |
| 2. Agent memory | Curated role notes in the agent definition and skills. Harness `memory` tool **off** initially | Read-only | Enable harness memory with a per-role `memoryScope` and write review |
| 3. Project memory | SQLite tables: objectives, decisions, artefacts, open questions | Agents read via `project.*` tools; only orchestrator code writes | PostgreSQL (self-hosted) |
| 4. Enterprise knowledge | Read-only document folder indexed with SQLite full-text search; `knowledge.search` and `knowledge.read` return document id and passage anchor for citation | Read-only tools | PostgreSQL full-text search; pgvector only when semantic recall is shown to be needed |
| 5. Execution history | Append-only audit ledger in SQLite, each record hash-chained to the previous; references harness session and event ids rather than duplicating them | Auditor role | PostgreSQL plus write-once object storage; Wazuh or OpenSearch via the harness SIEM sink |

Agent-writable memory is switched off at first because it is a persistence channel for injected content and makes runs non-reproducible. No vector database: the PoC corpus is small and keyword search with citations is sufficient.

Evidence is a first-class record: `{id, source document, passage anchor, content hash, retrieved by, retrieved at}`. Claims in outputs reference evidence ids.

---

## 9. Proof-of-concept workflow — Research Ethics eForms Modernisation

Scenario as revised: replace Power Apps and Dataverse with a Laravel and PostgreSQL solution on **open-source hosting, run locally first and on Railway later**; retain Salesforce PRIME; evaluate target architecture, security, data migration, integration and costs.

Inputs: an objective statement and a simulated, read-only knowledge pack (current Power Apps/Dataverse description, Salesforce PRIME integration notes, sample requirements, indicative hosting costs). No connection to real systems.

| Step | Actor | Output |
|---|---|---|
| 1. Receive objective | CLI, user identity recorded | Run record |
| 2. Plan | Orchestrator Agent | Task graph (structured), validated by code |
| 3. Approve plan | Human approver | Recorded gate |
| 4. Instantiate | Orchestrator code | Sessions from approved definitions, models chosen by gateway |
| 5. Assign skills | Planner proposal, code validation | Skill set per instance |
| 6. Evidence | Research Agent | Evidence records with citations |
| 7. Parallel analysis | Solution Architecture, Security, Data Agents | Target architecture and decisions; threat model and controls; data model, migration and PRIME integration approach |
| 8. Cost view | Solution Architecture Agent | Cost estimate with stated assumptions |
| 9. Assurance | Independent Assurance Agent, different provider | Findings by severity; pass, conditional or fail |
| 10. Rework | Authors, bounded to one round | Revised outputs |
| 11. Consolidate | Orchestrator Agent | Final report with traceability to evidence |
| 12. Record | Code | Decisions, evidence, costs, model choices, approvals in the ledger; run summary |

Dependencies: 6 before 7; the three analyses in 7 run in parallel; 8 after architecture; 9 after 7 and 8.

---

## 10. Repository structure proposal

A new, separate repository. One package to begin with.

```
agent-workforce/
  config/            providers.yaml  models.yaml  policies.yaml  budgets.yaml  users.yaml
  registry/
    agents/<id>/<version>.yaml
    skills/<id>/<version>/{skill.yaml, SKILL.md, refs/, tests/}
    tools/<namespace>.<name>.yaml
  src/
    harness/         port.ts   openworker/   fake/
    gateway/
    registry/        agents  skills  tools  (loaders, validation, digests)
    orchestrator/    planner  graph  executor  consolidator
    governance/      policy  approvals  budgets  identity
    tools/           knowledge  project  evidence  skills  report
    memory/
    audit/
    assurance/
    cli/
  scenarios/research-ethics-eforms/   objective.md  knowledge/  expected/
  tests/             unit/  integration/  negative/  live/
  docs/              adr/  architecture.md
```

Only `src/harness/openworker/` may import `@openworkerai/harness-sdk`; a lint rule enforces this.

---

## 11. Development phases and milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Validation spike** | Throwaway scripts for the eight checks in section 2 | Written result per check; go/no-go on DeepSeek; design adjusted |
| **M1 Skeleton** | Repository, harness port, fake adapter, Claude Code adapter (subscription, local only, see section 15), OpenWorker adapter, config loading, audit ledger, gateway, one agent answering one prompt | One agent runs through each adapter; usage recorded; ledger verifies |
| **M2 Registries and governance** | Agent, skill and tool registries; policy function; `beforeTool` enforcement; CLI approvals; budgets | Negative tests pass: unapproved definition, tool outside allow-list, unapproved model, budget breach all blocked |
| **M3 Orchestration** | Planner, task graph, parallel execution, timeouts, retry, fallback, restart recovery, memory and evidence stores | A three-task graph with one injected provider failure completes via fallback and survives a process kill |
| **M4 Proof of concept** | Six definitions, seven skills, knowledge pack, assurance loop, final report | End-to-end run produces the report with full traceability |
| **M5 Hardening** | Injection test set, cost and usage report, open-source deployment design decisions, harness-swap test | Injection cases blocked or caught; architecture decision records written |

Deferred beyond these: deployment infrastructure, Keycloak, PostgreSQL, semantic search, event-driven messaging, OpenShell execution, harness teams, write-capable enterprise tools, web UI.

### Test coverage against section 14 of the brief

| Requirement | Test approach |
|---|---|
| Agent instantiation | Approved definition instantiates; draft, retired and tampered definitions refused |
| Agent collaboration | Downstream task receives upstream structured output; dependency order respected |
| Skill discovery and selection | Planner sees only role-eligible skills; ineligible assignment rejected |
| Skill composition | Dependencies resolved in order; cycle rejected |
| Model switching | Switch inside policy succeeds with new session; outside policy refused |
| Provider fallback | Simulated rate limit triggers approved fallback; no fallback after a side effect |
| Tool permissions | Call to unlisted tool never dispatched; policy deny returns `executed: false` |
| Approval gates | Sensitive tool pauses; deny stops it; non-approver cannot approve |
| Audit logging | Every decision type present; broken hash chain detected |
| Failure and recovery | Kill mid-run; resume completes without repeating tool calls |
| Prompt injection | Poisoned document does not change tool calls or leak instructions; assurance flags unsupported claims |
| Independent assurance | Seeded defect in an output is found; fail verdict blocks consolidation |
| Cost and limits | Token, cost, time and call caps each cancel the task |

Most of these run against the fake adapter with no API spend. A small live suite runs on demand.

---

## 12. Technical risks, assumptions and dependencies

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK breaking changes during beta | High | Medium | Exact version pin, adapter seam, fake adapter, M0 re-run on upgrade |
| DeepSeek tool calling unreliable through the harness | Medium | Medium | M0 check; otherwise limit DeepSeek to tool-free tasks or drop it |
| `submit_result` pattern inconsistent across providers | Medium | Medium | Code-side validation and one corrective retry; M0 check |
| No sandbox on macOS | Certain | Low for PoC | Read-only tools only; revisit on Linux with OpenShell |
| Concurrent sessions contend in one harness process | Low | Medium | M0 check; concurrency cap in executor |
| Fallback after partial work repeats or loses effort | Medium | Low | Task-level re-issue only; tasks kept small and idempotent |
| Cost figures drift from real prices | Medium | Low | Price table dated and owned; unknown usage flagged |
| Injection through knowledge documents | Medium | High | Section 7 defences; read-only posture; assurance |
| Subscription terms or limits change, or Claude Code adapter cannot enforce our controls | Medium | Medium | Local-only use; API-key path through OpenWorker always available; M0 checks |
| Harness abandoned or relicensed | Low | High | Port abstraction; MIT licence today |
| Container deployment of the Rust child process and its state is unproven | Low | Medium | Needs a glibc image and PostgreSQL state; qualify in M5 |

Assumptions: Node 22.12+ on macOS Apple Silicon; API keys for the three providers supplied by you; the PoC uses simulated data only; one user at a time.

Dependencies: `@openworkerai/harness-sdk` 0.1.0-beta.4 and its runtime 0.1.0-beta.3; provider accounts; a SQLite library for Node (choice to be made in M1).

---

## 13. Recommended implementation sequence

1. You review this document and settle the decisions below.
2. M0 spike in a scratch directory. This is the first point at which a dependency is installed.
3. Record M0 results and amend the design where a check fails.
4. Create the repository; build the harness port and the fake adapter before the real adapter.
5. Audit ledger and config loading.
6. Model gateway with one provider, then the other two.
7. Tool Registry with the read-only knowledge tools.
8. Agent Registry, then Skills Registry.
9. Policy function, hook enforcement, approvals, budgets, with their negative tests.
10. Task graph executor, then the planner.
11. Assurance loop.
12. Scenario content and the end-to-end run.
13. Hardening and open-source deployment design records.

---

## 14. Deployment direction — local first, then Railway, open source throughout

The platform will not depend on Azure. I have read "locally first, then Railway" as applying both to the scenario being assessed and to where this platform itself runs. Say if you meant only the scenario.

| Stage | Platform runs as | State | Notes |
|---|---|---|---|
| 1. Local | Node process on macOS | SQLite files | Phase one. Nothing else is built now |
| 2. Railway | One Node service, one replica, harness as a child process beside it | Mounted volume first; Railway PostgreSQL when needed | The repo documents a single-service Railway recipe "tested live with an earlier published SDK" [doc]. Needs a Debian-based (glibc) image, authenticated endpoints, and API-key credentials (section 15). Multi-replica behaviour is not established |
| 3. Self-hosted | Docker Compose or Kubernetes on Linux | PostgreSQL | Only if Railway is outgrown |

Railway is a commercial host, not open-source software; everything deployed on it is open source and portable. Components to add as needs appear, all open source:

| Need | Choice | Notes |
|---|---|---|
| Identity | Keycloak (OIDC) | When there is more than one user |
| Secrets | Railway variables first; OpenBao when self-hosted | |
| Policy | Policy files in git; Open Policy Agent if rules outgrow them | |
| Database | PostgreSQL | The harness supports it directly [src] |
| Search | PostgreSQL full-text, then pgvector | |
| Observability | OpenTelemetry, Grafana stack, Langfuse | The harness exports OTLP and has a Langfuse option [src] |
| Security monitoring | Wazuh or OpenSearch | Fed by the harness compliance sink [doc] |
| Tool sandbox | NVIDIA OpenShell on Linux | Not available on Railway's single-service recipe; keeps tools read-only there too |

---

## 15. Using the Anthropic subscription at runtime

This reverses the original brief ("do not use Claude subscription authentication as runtime API credentials"). What Anthropic's published terms allow, checked 15 Nov 2026 on the Claude Code "Legal and compliance" page:

- Subscription sign-in "is designed to support ordinary use of Claude Code and other native Anthropic applications". Plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
- Developers building products "should use API key authentication". Routing requests through plan credentials on behalf of others, or collecting and storing those credentials, is not permitted.

Consequences:

| Option | Works with subscription? | Assessment |
|---|---|---|
| Feed the subscription token into the OpenWorker harness | No | OpenWorker is a third-party harness, not a native Anthropic application. Outside the terms, and Anthropic says it may enforce without notice. I will not design this |
| Drive the unmodified Claude Code on your Mac (headless mode or the Agent SDK), signed in as you | Yes, for your own individual use | Fits the harness port as a second adapter. Local only |
| Anthropic API key in the OpenWorker harness | n/a (pay as you go) | Required for Railway and for any shared use |

Recommended approach: build a **Claude Code adapter** behind the harness port for local development on your subscription, alongside the OpenWorker adapter.

What that costs:

- Claude runs through Claude Code's engine, not OpenWorker's. OpenWorker's approvals, guardrails and compliance capture do not apply to those runs; our policy check, approvals and audit must hook into Claude Code's own permission and hook mechanisms instead. This is more work, but it proves the harness is replaceable from the first milestone.
- Claude Code ships built-in shell and file tools. The adapter must switch them all off and expose only our registered tools.
- Subscription usage has rate limits rather than per-token billing, so cost figures for these runs are notional.
- OpenAI and DeepSeek still need their own API keys and still run through OpenWorker. The M0 checks on OpenWorker need at least one such key.
- On Railway the subscription cannot be used; an Anthropic API key is needed from that point.

Items to confirm in M0 for this adapter: custom tools only with built-ins disabled, a blocking pre-tool hook, structured results, usage reporting, session resume, and concurrent sessions under subscription rate limits.

---

## Decisions (approved 15 Nov 2026)

| # | Decision | Outcome |
|---|---|---|
| D1 | Platform language | TypeScript on Node |
| D2 | Orchestration style | Application-owned task graph, one session per agent instance |
| D3 | Skills mechanism | Platform-owned Skills Registry |
| D4 | Beta risk | Accepted; pin `@openworkerai/harness-sdk` 0.1.0-beta.4; M0 validation spike first |
| D5 | Repository | `koutsovt/OpenWorker` |
| D6 | Model roles | Claude authors (subscription, local, via Claude Code adapter). OpenAI runs the Assurance Agent. DeepSeek is fallback only |
| D7 | Agent-writable memory | Off for the proof of concept |
| D8 | Subscription at runtime | Claude Code adapter, local only. API keys for OpenAI, DeepSeek and anything on Railway (section 15) |
| D9 | Deployment path | Local first, then Railway, for both the scenario and this platform (section 14) |
| D10 | Open-weight models | Not added |
