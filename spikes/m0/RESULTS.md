# M0 validation spike — results

Run: 15 Nov 2026, Linux x64, Node 22.23, `@openworkerai/harness-sdk` 0.1.0-beta.4 (runtime 0.1.0-beta.3).
Method: real harness, **local mock Chat Completions provider** (`mock-provider.mjs`). No API keys, no spend.
Reproduce: `npm install && node spike.mjs` in this folder.

These checks prove harness mechanics. They do not prove how real models behave.

| Check | Result | Finding |
|---|---|---|
| Start, plain turn | Pass | `sandbox: 'off'` works; local `http://127.0.0.1` provider accepted |
| Concurrent sessions | Pass | 4 sessions of 1.5 s each finished in 1.8 s in one harness process |
| Structured output via `submit_result` tool | Pass | Schema-valid arguments reach the tool handler intact |
| Invalid structured output | Pass | Schema-invalid arguments never reach the handler; the turn ends `failed` |
| `beforeTool` hook blocks | Pass | Blocked tool did not execute; the turn continued |
| Usage events | Pass | `model_usage` emitted per model call |
| Tool outside the agent definition | Pass | Not offered to the model; a call to it is rejected |
| Approval gate | Pass | `only` mode pauses; `deny` prevents execution; `once` executes |
| Rate limit | Pass | 3 attempts, then `failed` with `rate_limit`, `retryable: true`; no silent fallback |
| Per-session model and provider override | Pass | Session used the second provider and its credential |
| Immutable definitions | Pass | Changed definition under an existing name is rejected |
| `instructionAddendum` size | Measured | 8 KB accepted; 32,760 bytes rejected. Consistent with a 32,000-byte limit |
| Restart and resume | Pass | Session resumed after a graceful harness restart |

## Design consequences

1. **Hooks run more than once per tool call** (three times observed). The policy function must be pure and
   repeatable, and audit records must be de-duplicated by call id.
2. **Skill delivery must fit in 32,000 bytes per turn.** Summaries go in the addendum; full skill text is
   fetched through the `skills.load` tool, as planned.
3. **A failed turn after retries is the gateway's fallback trigger.** The harness reports a structured,
   retryable diagnostic and stops, which is what the fallback design assumes.
4. **Invalid structured output fails the turn** when the model repeats it. The executor needs its own
   corrective re-prompt or task retry.

## DeepSeek, real calls (15 Nov 2026)

Run with `scripts/provider-check.ts` through the OpenWorker adapter, model `deepseek-flash`, 9 of 9 passed:
plain turn, usage reporting, session history, multi-step tool use, schema-valid structured result built from
tool output, policy denial, and the approval gate (pause, deny, approve once).

Finding: **the engine's model client ignores HTTP proxy settings** (`reqwest` built with `.no_proxy()` in
`runtime/src/model.rs`). Behind a mandatory outbound proxy it fails with a `transport` error. The run above
went through `scripts/proxy-relay.ts`, a loopback relay. A direct run on an unproxied network is still to do.

## Not yet verified

| Item | Blocked by |
|---|---|
| OpenAI tool calling, structured output quality, usage | OpenAI API key |
| Claude Code adapter checks (custom tools only, blocking hook, usage, resume) | Must run on the Mac with the subscription |
| Hard kill mid-turn, then resume without repeating tool calls | Not yet written (no key needed) |
| macOS run of this spike | Run locally |
