# Rust Migration Gates

This document defines enforceable gates for gradual Rust replacement in `llmswitch-core`.

## Gate 1: Module Blackbox Before Merge

Run module-level blackbox suites after each migrated module:

```bash
npm run verify:module-blackbox -- --module virtual-router
npm run verify:module-blackbox -- --module hub-pipeline
```

`scripts/tests/module-blackbox-gate.mjs` is the single entrypoint.

## Gate 2: Shadow Requires Module Coverage >= 95%

Before any shadow rollout, **each prepared migration module** must satisfy:

- line coverage >= 95%
- branch coverage >= 95%

Manifest:

- `config/rust-migration-modules.json`
- only modules with `preparedForShadow: true` are gated

Generic check:

```bash
npm run verify:shadow-gate -- --summary coverage/coverage-summary.json
```

Current module-ready check (virtual-router hotpath):

```bash
npm run verify:shadow-gate:virtual-router-hotpath
```

Current module-ready check (tier-selection integration):

```bash
npm run verify:shadow-gate:virtual-router-tier-selection
```

Next module baseline check (hub resp inbound SSE stream sniffer, pre-shadow):

```bash
npm run verify:shadow-gate:hub-resp-inbound-sse-stream-sniffer
```

Next module baseline check (hub req inbound context tool snapshot, pre-shadow):

```bash
npm run verify:shadow-gate:hub-req-inbound-context-tool-snapshot
```

Next module baseline check (hub chat-process media attachments, pre-shadow):

```bash
npm run verify:shadow-gate:hub-chat-process-media
```

Next module baseline check (hub chat-process continue execution, pre-shadow):

```bash
npm run verify:shadow-gate:hub-chat-process-continue-execution
```

Next module baseline check (hub chat-process pending tool sync, pre-shadow):

```bash
npm run verify:shadow-gate:hub-chat-process-pending-tool-sync
```

Next module baseline check (hub req inbound semantic lift, pre-shadow):

```bash
npm run verify:shadow-gate:hub-req-inbound-semantic-lift
```

Next module baseline check (hub resp outbound chat-process semantics bridge, pre-shadow):

```bash
npm run verify:shadow-gate:hub-resp-outbound-client-semantics
```

Next module baseline check (virtual-router tier antigravity target split, pre-shadow):

```bash
npm run verify:shadow-gate:virtual-router-tier-antigravity-target-split
```

Next module baseline check (virtual-router tier antigravity session lease, pre-shadow):

```bash
npm run verify:shadow-gate:virtual-router-tier-antigravity-session-lease
```

When a module-specific `verify:shadow-gate:*` command passes, the workflow now auto-promotes
that module in `config/rust-migration-modules.json` by setting `preparedForShadow: true`.

## Gate 3: File Size Limit

Changed TS/Rust files in `src/**` and `rust-core/**` must stay <= 500 lines.

```bash
npm run verify:file-line-limit
```

## Gate 4: llmswitch-core Rustification Audit (No TS Semantic Backflow)

Root prebuild now runs an audit that blocks:

- non-native TS LOC increase in `sharedmodule/llmswitch-core/src`
- non-native TS file count increase
- new production TS files (unless explicitly allowlisted via env)

Commands:

```bash
npm run verify:llmswitch-rustification-audit
```

Baseline snapshot:

- `sharedmodule/llmswitch-core/config/rustification-audit-baseline.json`

If baseline needs intentional refresh (rare, explicit migration step):

```bash
node scripts/ci/llmswitch-rustification-audit.mjs --write-baseline
```

## Native Hotpath Wiring

Rust quota bucket hotpath lives in:

- `rust-core/crates/router-hotpath-napi`

Runtime resolver:

- `src/router/virtual-router/engine-selection/native-router-hotpath.ts`

Optional runtime override:

- `ROUTECODEX_LLMS_ROUTER_NATIVE_PATH`
- `ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE=1` disable native load (with auto mode this now fails fast)
- `ROUTECODEX_LLMS_ROUTER_NATIVE_REQUIRE=1` fail fast when native binding is unavailable

Workspace auto-discovery (dev mode):

- `rust-core/target/{release,debug}/router_hotpath_napi.node`
- `rust-core/target/{release,debug}/librouter_hotpath_napi.(dylib|so)` (will bridge-copy to `.node`)

Native compile is now auto-triggered by `npm run build`, `npm run build:dev`, and `npm run build:ci`:

- script: `scripts/build-native-hotpath.mjs`
- opt-out env (debug only): `LLMS_NATIVE_BUILD_SKIP=1` or `ROUTECODEX_LLMS_NATIVE_BUILD_SKIP=1`

Native parity check (runs only when native binding is available):

```bash
node scripts/tests/virtual-router-native-parity.mjs
```
