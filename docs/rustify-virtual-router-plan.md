# VR Rustification Plan

**Date**: 2026-07-03

## Current State (Audit Summary)

### Rust side (266K LOC total, router-hotpath-napi)
- `virtual_router_engine/` core: **37.7K LOC** — routing, selection, bootstrap, health, load balancer, provider registry/ingress, classifier, forwarder, instructions, state store. COMPLETE.
- NAPI proxy: all VR runtime methods bridged. COMPLETE.
- `virtual_router_stop_message_actions.rs`, `virtual_router_stop_message_instruction.rs`, `vr_route_04_selection_boundary.rs`: COMPLETE.

### TS side remaining (~3,500 LOC)

#### Phase 1: Hit Log + Host Effects (787 LOC) — Pure TS, zero native calls
- `src/runtime/virtual-router-hit-log.ts` (529 LOC): Pure formatting/logic, zero native
- `src/runtime/virtual-router-host-effects.ts` (258 LOC): Orchestration shell; calls TS wrappers that delegate to native bridge
  - `parseRoutingInstructionKindsWithNative` → TS wrapper, no native
  - `parseResolvedStopMessageInstructionWithNative` → TS wrapper, no native
  - `resolveStopMessageScope` → TS wrapper, no native
  - No `callNativeJson` / `loadNativeRouterHotpathBindingForInternalUse` direct calls

#### Phase 2: VR Runtime TS wrappers (1,087 LOC) — Load native, delegate all
- `native-virtual-router-runtime.ts` (327 LOC): `VirtualRouterEngine` class — thin TS shell around native proxy. 2 native call sites.
- `native-virtual-router-engine-proxy.ts` (42 LOC): Proxy interface + factory
- `native-virtual-router-routing-state.ts` (375 LOC): Types + `resolveStopMessageScope`
- `native-virtual-router-routing-instructions-semantics.ts` (205 LOC): `parseRoutingInstructionKindsWithNative`
- `native-virtual-router-stop-message-semantics.ts` (78 LOC): `parseResolvedStopMessageInstructionWithNative`
- `native-virtual-router-bootstrap-config.ts` (38 LOC): Config type guard
- `native-virtual-router-bootstrap-providers.ts` (65 LOC): Bootstrap logic (2 native calls)

#### Phase 3: Chat Process TS (2,047 LOC) — Pure TS, never calls native
- `native-chat-process-servertool-orchestration-semantics.ts` (1,630 LOC): Largest single TS VR file
- `native-chat-process-governance-semantics.ts` (305 LOC)
- `native-chat-process-node-result-semantics.ts` (112 LOC)
- These load `loadNativeRouterHotpathBindingForInternalUse` but **never** call it

#### Phase 4: VR Contract Types (782 LOC) — Pure type definitions
- `virtual-router-contracts.ts`: Pure TS types, not runtime code

#### Phase 5: Config Builder (597 LOC) — Config authoring, not runtime
- `src/config/virtual-router-builder.ts` (516 LOC): Builds config JSON from user YAML
- `src/config/virtual-router-types.ts` (81 LOC): Config types

---

## Rustification Phases

### Phase 1: Hit Log + Host Effects → TS-only cleanup
**Purpose**: Confirm no functional change; document as stable TS-only.

| File | LOC | Action |
|------|-----|--------|
| `virtual-router-hit-log.ts` | 529 | Review dead code; add red test for formatting contract |
| `virtual-router-host-effects.ts` | 258 | Review orchestration logic; confirm native delegation is correct |

**Verification**: `pnpm jest tests/sharedmodule/virtual-router-hit-log.spec.ts` passes.

### Phase 2: VR Runtime TS → Pure NAPI Rust
**Purpose**: Migrate `VirtualRouterEngine` class from TS shell to pure Rust NAPI. Remove TS abstraction.

**Steps**:
1. Rust `napi_proxy.rs`: expose all proxy methods as top-level `#[napi]` functions
2. Rust `lib.rs`: add `#[napi]` wrappers for missing proxy methods
3. Create `virtual_router_hit_log.rs` in Rust for formatting (`createVirtualRouterHitRecord`, `formatVirtualRouterHit`)
4. Migrate `virtual-router-host-effects.ts` → `virtual_router_host_effects.rs`
5. Keep TS thin wrappers for type projection only

**Files to rustify**:
| File | LOC | Rust target |
|------|-----|-------------|
| `native-virtual-router-runtime.ts` | 327 | `napi_proxy.rs` (augment existing) |
| `native-virtual-router-engine-proxy.ts` | 42 | Absorb into Rust proxy |
| `virtual-router-hit-log.ts` | 529 | `virtual_router_hit_log.rs` |
| `virtual-router-host-effects.ts` | 258 | `virtual_router_host_effects.rs` |
| `native-virtual-router-routing-state.ts` | 375 | `routing_state_store.rs` (augment) |
| `native-virtual-router-bootstrap-*.ts` | 103 | `provider_bootstrap.rs` / `config_bootstrap.rs` |

**Risk**: Medium — VR runtime is hotpath. Full test suite must green before/after.

### Phase 3: Chat Process TS → Rust bridge
**Purpose**: Migrate chat process governance logic (2,047 LOC) to Rust.

**Steps**:
1. Audit `native-chat-process-servertool-orchestration-semantics.ts` for actual native call sites
2. If genuinely TS-only (confirmed), migrate to `chat_servertool_orchestration.rs`
3. Add `#[napi]` export
4. Replace TS in `lib.rs`

**Risk**: High — 1,630 LOC single file. Need audit first. If clean, full migration.

### Phase 4: Contract types → Rust type generation
**Purpose**: Generate Rust `#[napi]` types from VR contract types.

**Steps**:
1. Migrate `virtual-router-contracts.ts` → `virtual_router_contracts.rs`
2. Generate `serde` + `#[napi]` derive for all structs/enums
3. Replace TS type imports

**Risk**: Low — types only.

### Phase 5: Config Builder → Rust schema-derived
**Purpose**: Replace TS config builder with Rust-validated JSON schema.

**Steps**:
1. Define VR config schema in Rust as `VirtualRouterConfigSchema`
2. Generate TS types from Rust schema
3. Rewrite `virtual-router-builder.ts` to consume Rust-validated config JSON
4. Deprecate old TS builder

**Risk**: Medium — config loading is authoring, not hotpath. Shadow-test against existing config JSON.

---

## Verification Gates

| Phase | Gate |
|-------|------|
| All | `pnpm jest` VR-related tests pass |
| P2+ | `pnpm build:rust` compiles |
| P3 | `pnpm run verify:hardcode` < baseline |
| P1 | `tests/sharedmodule/virtual-router-hit-log.spec.ts` |

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| P1 | Low | Red test before cleanup |
| P2 | Medium (hotpath) | Full VR test suite green before/after |
| P3 | High (1,630 LOC) | Audit native call sites first |
| P4 | Low | Generate from Rust schema |
| P5 | Medium | Shadow-test against existing config JSON |
