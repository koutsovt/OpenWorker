# 9. Deployment path: local, then Railway, then self-hosted

Status: Accepted; hosted stages not yet qualified

## Context

The platform must not depend on a proprietary cloud. It should run on a laptop first and move to a host without redesign.

## Decision

Stage 1 is a Node process with SQLite files. Stage 2 is one Railway service, one replica, with the OpenWorker runtime as a child process and state on a mounted volume. Stage 3, only if needed, is Docker Compose or Kubernetes on Linux with PostgreSQL. The same code and config mechanism are used at every stage.

## Consequences

- The container image must be Debian-based (glibc); the OpenWorker runtime does not support Alpine.
- One replica only: the ledger and run store are single-writer. Scaling out requires PostgreSQL first.
- The OpenWorker runtime ignores HTTP proxy settings. A network with a mandatory outbound proxy needs the relay in `scripts/proxy-relay.ts` or a gateway.
- Railway is a commercial host; everything deployed on it is open source and portable.
- Not done: no container image has been built or run. Docker was not usable in the build environment, so this stage is a design, not a qualified deployment.
