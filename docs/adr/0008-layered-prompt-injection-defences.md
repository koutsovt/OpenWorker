# 8. Layered prompt-injection defences

Status: Accepted

## Context

Agents read documents and each other's results. Either can contain text written to steer the reader.

## Decision

Defences are layered so that no single one has to hold. (1) Retrieved text is labelled as data and agents are instructed that it carries no instructions. (2) A pattern screen removes sentences that read as instructions from tool results and from results passed between agents, and records each removal. (3) Agents have only read tools from a fixed list; a tool outside the definition is never dispatched. (4) Policy check and human approval for anything sensitive. (5) Output contracts and citation checks. (6) Independent assurance on a different provider, scheduled by the platform.

## Consequences

- `scenarios/injection-set/` holds twelve documents; eight techniques are removed by the screen and three are pinned as known misses (spaced letters, another language, an indirect request).
- `tests/injection.test.ts` shows that a scripted model which obeys planted text still cannot call an unlisted tool, write, read outside the knowledge folder, cite unread evidence, relay instructions downstream, or plan around review.
- Not shown: how real models respond to the text that gets through. That needs a live run of the injection set.
- The screen can remove a legitimate sentence. Removals are listed in every report so a person can check.
