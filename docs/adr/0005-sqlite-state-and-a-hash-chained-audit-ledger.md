# 5. SQLite state and a hash-chained audit ledger

Status: Accepted

## Context

The proof of concept runs for one user on one machine. The engine's own compliance store is not tamper-evident against whoever controls the database.

## Decision

Runs, tasks, evidence and project memory are in one SQLite file. Every decision is appended to a separate ledger in which each record carries the hash of the previous one. Reports, the usage report and recovery all read from these, not from model output.

## Consequences

- An edit, deletion or reordering in the ledger is detected by `npm run verify-ledger`.
- The head (latest seq and hash) is kept in its own table, written with each record, so records deleted from the end are detected.
- Someone who can rewrite the whole file can rebuild the chain. `anchor-ledger` writes the head to a file of your choosing and `verify-ledger` checks against it (or against one `<seq>:<hash>`, which the final report prints); the protection is only as good as where that is kept, which is an operating decision, not code.
- Single-writer by design. Moving to PostgreSQL is needed before more than one process writes.
