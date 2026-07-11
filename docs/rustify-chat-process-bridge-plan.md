# Chat Process TS Bridge → Rust NAPI Migration Plan

**Date**: 2026-07-03
**Goal**: Eliminate all TS bridge files that wrap Rust NAPI. TS callers import `#[napi]` functions directly.

## Current Architecture

```
TS Caller (tool-registry.ts, request-executor-*.ts, servertool/*.ts, ...)
  └── import → TS Bridge File (native-chat-process-*.ts)
                └── readNativeFunction("someJson") → Rust NAPI lib.rs export
```

## Remaining TS Bridges

### Module A: `native-chat-process-governance-semantics.ts` (305 LOC)
**4 exports → 4 Rust exports already exist**

| TS Export | Calls Rust NAPI | Consumers |
|-----------|----------------|-----------|
| `applyRespProcessToolGovernanceWithNative` | `governResponseJson` | (unused externally — dead?) |
| `stripOrphanFunctionCallsTagWithNative` | `stripOrphanFunctionCallsTagJson` | (unused externally — dead?) |
| `normalizeApplyPatchArgumentsWithNative` | `finalizeChatResponseJson` | (unused externally — dead?) |
| `validateApplyPatchArgumentsWithNative` | `validateApplyPatchArgumentsJson` | `tool-registry.ts` |

**Strategy**: Find Rust NAPI export names, change TS callers to `callNativeJson('validateApplyPatchArgumentsJson')` directly. Delete the bridge file.

### Module B: `native-chat-process-node-result-semantics.ts` (112 LOC)
**6 exports → 4 pure TS, 2 Rust NAPI**

| TS Export | Calls Rust NAPI | Consumers |
|-----------|----------------|-----------|
| `hasRequestedToolsInSemanticsWithNative` | `hasRequestedToolsInSemanticsJson` | `request-executor.ts` / `request-executor-response-contract.ts` via `native-exports` |
| `isRequiredToolCallTurnWithNative` | `isRequiredToolCallTurnJson` | `request-executor.ts` / `request-executor-response-contract.ts` via `native-exports` |
| `isToolResultFollowupTurnWithNative` | `isToolResultFollowupTurnJson` | `request-executor.ts` / `request-executor-response-contract.ts` via `native-exports` |
| `isProviderNativeResumeContinuationWithNative` | `isProviderNativeResumeContinuationJson` | `request-executor.ts` via `native-exports` |
| `detectRetryableEmptyAssistantResponseWithNative` | `detectRetryableEmptyAssistantResponseJson` | `request-executor-response-contract.ts` |
| `isToolCallContinuationResponseWithNative` | `isToolCallContinuationResponseJson` | (unused?) |

**Strategy**: TS callers already wrap via `getNativeSemantics()` — change those wrappers to call `callNativeJson` directly. Delete bridge file.

### Module C: `native-chat-process-servertool-orchestration-semantics.ts` (1,630 LOC)
**~50 exports → 50 Rust NAPI exports already exist**

Major consumers:
- `native-servertool-core-semantics.ts` (5.5K LOC, 38 unique calls) — this is a TS **orchestration layer** that calls bridge → native
- `servertool/*.ts` shell files (10+ files, ~1-2 calls each)

**Strategy**: Two-stage:
1. **Phase C1**: Move `native-servertool-core-semantics.ts` into Rust — This is the hard part (5.5K LOC TS orchestration logic)
2. **Phase C2**: Once orchestration is in Rust, delete the bridge file. Servertool shell files call Rust NAPI directly.

### Module D: `native-servertool-core-semantics.ts` (5.5K LOC) — The Real Work
**NOT a bridge — this is a full TS orchestration module that happens to call Rust NAPI for heavy lifting.**

This is the file that:
- Imports from bridge C (servertool-orchestration)
- Plans servertool response stages, owns orchestration state machine
- Calls `buildServertoolOutcomePlanInputWithNative`, `planServertoolResponseStageGateWithNative`, etc.
- Has 4-5K LOC of pure TS orchestration logic (state machines, routing, error handling)

## Migration Phases

### Phase 1: Quick Wins (Low Risk)
**Goal**: Delete 3 small bridge files, change TS callers to direct `callNativeJson`.

| # | File | LOC | Effort | Risk |
|---|------|-----|--------|------|
| 1 | `native-chat-process-node-result-semantics.ts` | 112 | Small | Low — 6 exports, 2 consumers, both already wrap via `getNativeSemantics()` |
| 2 | `native-chat-process-governance-semantics.ts` | 305 | Small | Low — 4 exports, 1 real consumer (`tool-registry.ts`) |

### Phase 2: Servertool Bridge Inline (Medium Risk)
**Goal**: Eliminate bridge C by inlining calls into `native-servertool-core-semantics.ts`.

| # | File | LOC | Effort | Risk |
|---|------|-----|--------|------|
| 3 | `native-chat-process-servertool-orchestration-semantics.ts` | 1,630 | Medium | Medium — 50 exports, 38 unique callers in `native-servertool-core-semantics.ts` + 10 servertool shell files |

**Strategy**: Move `readNativeFunction` + validation pattern inline into `native-servertool-core-semantics.ts`. Each shell file gets a direct `callNativeJson` import.

### Phase 3: Servertool Core → Rust (High Effort)
**Goal**: Move the orchestration state machine from TS to Rust.

| # | File | LOC | Effort | Risk |
|---|------|-----|--------|------|
| 4 | `native-servertool-core-semantics.ts` | 5,500 | Large | High — full state machine migration |

**Strategy**: Only after Phase 1+2 proven. Design the Rust servertool orchestration module first, then migrate.

## Verification Gates

| Phase | Gate |
|-------|------|
| P1 | `pnpm jest` all servertool + tool-registry + request-executor tests pass |
| P2 | Same + all servertool shell tests pass |
| P3 | Same + `cargo check` 0 errors |

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| P1 | Low — simple inline | Red test before/after |
| P2 | Medium — 50 exports, must find all Rust NAPI names | Audit lib.rs first |
| P3 | High — 5.5K orchestration logic | Design Rust module first |
