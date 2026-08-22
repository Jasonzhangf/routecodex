---
title: V3 unified error-path audit
---

# V3 Unified Error-Path Audit

## Contract

Every direct and relay failure enters the typed chain in order:

`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`

The error chain is a control-plane side channel. It must not be copied into request or response business payloads.

## Audit procedure

1. Read the resource, function, mainline, module, and verification maps.
2. Search direct, relay, provider, executor, handler, SSE, and HTTP projection owners.
3. Prove each error edge has a typed carrier and one owner.
4. Reject any `mapErrorToHttp` fallback, local retry/reroute policy, direct Error06 builder call, or generic wrapper that loses source stage/kind.
5. Add a failing static fixture before changing the owner.
6. Run focused Rust/TS gates, then install, aggregate restart, and replay one direct and one relay failure.

## Forbidden bypasses

- `errorErr05 ? typed_projection : mapErrorToHttp(...)`
- `RouteErrorHub.report(..., { includeHttpResult: true })`
- provider/direct/executor local Error04/05 classification
- handler/SSE response repair or silent error-to-success conversion
- TS HTTP entry (`src/index.ts`, `dist/index.js`, or `RouteCodexHttpServer`) receiving production requests beside `rccv3`

## Evidence format

Record the exact path, owner, command, result, and remaining gap in `note.md`; do not claim closure without installed-version live evidence.
