# 6. Keyword search with citations, no vector database

Status: Accepted

## Context

The knowledge pack is small. What matters is that every citation points to an exact passage whose content can be checked later.

## Decision

Documents are split into passages and indexed in memory with SQLite full-text search at start. Reading a passage creates an evidence record with a hash of its text.

## Consequences

- Nothing to deploy and no index to drift from the files.
- Recall depends on shared words. Semantic search (pgvector) is added only when a run shows keyword search missing material that exists.
