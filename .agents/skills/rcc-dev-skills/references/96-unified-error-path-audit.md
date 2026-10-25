---
title: V3 unified error-path audit
---

# V3 Unified Error-Path Audit

## Contract

Every Provider/control-plane failure enters the typed chain in order:

`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision` retains internal Provider failure and recovery truth. This chain never authorizes a Provider HTTP/error response to cross the client boundary: reselect an eligible Provider; if all are exhausted, terminate only the affected transport without an error payload or fabricated success. Separately, a Provider business response is not semantically judged: preserve model/tool errors and unknown-but-representable values in the target protocol. Do not map a compatibility schema mismatch in such business content to `502 network_error`, cooldown, or client disconnect.

The error chain is a control-plane side channel, never request/response business payload. The project `AGENTS.md` owns the complete Provider-error versus business-response contract; this reference owns only the audit steps below.

## Audit procedure

1. Read the affected resource, function, mainline, module and verification bindings.
2. Follow their mapped error edges through the affected owners; inspect all entries only for an explicitly all-entry audit or a shared boundary change.
3. Prove each error edge has a typed carrier and one owner.
4. Reject any `mapErrorToHttp` fallback, local retry/reroute policy, direct Error06 builder call, or generic wrapper that loses source stage/kind.
5. Add real public-entry blackbox regressions for the affected success, recoverable-failure, and exhausted-failure paths before changing the owner; static fixtures can only supplement them.
6. Reuse the main skill's mapped gate and applicable runtime acceptance results. Cover every affected HTTP/SSE/WebSocket entry; a single Direct/Relay pair cannot prove an explicitly all-entry boundary. Do not restart or rerun unchanged checks solely for this audit.

## Forbidden bypasses

- `errorErr05 ? typed_projection : mapErrorToHttp(...)`
- `RouteErrorHub.report(..., { includeHttpResult: true })`
- provider/direct/executor local Error04/05 classification
- handler/SSE response repair or silent error-to-success conversion
- TS HTTP entry (`src/index.ts`, `dist/index.js`, or `RouteCodexHttpServer`) receiving production requests beside `rccv3`

## Evidence format

Record exact path, owner, command, result, and remaining gap in current run `notes.jsonl`; do not claim closure without installed-version live evidence.
