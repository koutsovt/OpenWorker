# 11. Identity, secrets and policy: files now, open-source services later

Status: Proposed

## Context

The proof of concept has one user. A shared deployment needs real identity, secret storage and possibly richer policy.

## Decision

Keep users, roles and policy as files in git for now. When there is more than one user: Keycloak (OpenID Connect) for identity; host environment variables, then OpenBao when self-hosted, for secrets; Open Policy Agent only if the rules outgrow the policy file. Observability through OpenTelemetry to the Grafana stack.

## Consequences

- Nothing here is built. The decision is which component fills each gap, so the seams are kept: one `Governance` class decides, and keys are only ever referenced by environment variable name.
- Endpoints must be authenticated before any hosted use; today there is only a command line.
