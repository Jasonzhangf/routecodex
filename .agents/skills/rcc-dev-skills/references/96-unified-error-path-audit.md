---
title: V3 unified error-path audit
---

# V3 Unified Error-Path Audit

## Contract

Every direct and relay failure enters the typed chain in order:

`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision` retains internal failure and recovery truth. The existing `ErrorErr06ClientProjected` symbol does not authorize a model-client error response. Follow AGENTS.md's mandatory all-entry prohibition and `docs/goals/provider-terminal-no-502-dag-20260930.md`: every upstream/internal error remains internal, including full pool exhaustion; only complete real success or an incomplete transport outcome may reach DSH Chat, Codex Responses HTTP/WebSocket, or Claude Code Messages. No HTTP error status, error body/event, or fabricated successful terminal is permitted. The old eligible-upstream-error exception is superseded.

The error chain is a control-plane side channel. It must not be copied into request or response business payloads.

## Audit procedure

1. Read the resource, function, mainline, module, and verification maps.
2. Search direct, relay, provider, executor, handler, SSE, and HTTP projection owners.
3. Prove each error edge has a typed carrier and one owner.
4. Reject any `mapErrorToHttp` fallback, local retry/reroute policy, direct Error06 builder call, or generic wrapper that loses source stage/kind.
5. Add real public-entry blackbox regressions for the affected success, recoverable-failure, and exhausted-failure paths before changing the owner; static fixtures can only supplement them.
6. Run focused Rust gates, then the applicable installed-runtime managed restart and same-entry replay. Cover all affected HTTP/SSE/WebSocket entries; a single Direct/Relay pair cannot prove the all-entry boundary.

## Forbidden bypasses

- `errorErr05 ? typed_projection : mapErrorToHttp(...)`
- `RouteErrorHub.report(..., { includeHttpResult: true })`
- provider/direct/executor local Error04/05 classification
- handler/SSE response repair or silent error-to-success conversion
- TS HTTP entry (`src/index.ts`, `dist/index.js`, or `RouteCodexHttpServer`) receiving production requests beside `rccv3`

## Evidence format

Record exact path, owner, command, result, and remaining gap in current run `notes.jsonl`; do not claim closure without installed-version live evidence.
