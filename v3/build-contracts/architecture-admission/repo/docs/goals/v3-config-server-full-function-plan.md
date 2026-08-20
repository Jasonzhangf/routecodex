# V3 Config and Server Full-Function Completion Plan

## Objective

Complete the V3 Config and Server modules to the full functionality declared by the V3 contract,
while preserving the single Rust runtime lifecycle and keeping P6 Responses Direct as the current
verified migration baseline. Config must publish a complete deterministic declaration manifest;
Server must strictly validate and dispatch requests through the runtime entry boundary without
fallback, handler-local protocol semantics, or a second lifecycle.

## Current evidence and known gaps

- P1 Config declarations and P2 multi-listener Server are source and local/live verified for the
  current fixture subset.
- P6 `/v1/responses` Direct is verified through the current V3 CLI and controlled upstream, but
  P6 remains a migration source and must not be extended with Relay or continuation.
- Config currently lacks the complete Hub declaration surface required by the fixed Hub v1 contract:
  closed entry protocols, allowed execution modes, provider wire protocol, static hook-set IDs,
  continuation ownership/scope declarations, and capability compatibility validation.
- The declared routing contract includes pool-match declarations, but the current route-pool
  authoring types only express selection, targets, and feature flags.
- Server currently registers business endpoints through broad `any(...)` handlers and converts
  malformed JSON/body-read failures into synthetic JSON values. Full completion must make method,
  content-type, body-size, and JSON failures explicit typed Error-chain inputs.

## Scope

### In scope

- `config.v3.toml` as the single V3 authoring source and `V3ConfigStore` as the only file IO API.
- Multi-server and multi-port declarations, listener routing groups, endpoint declarations, and
  typed server feature settings.
- Provider declarations: generic Responses provider protocol, base URL, auth handle/key entries,
  canonical model IDs, client aliases, wire model names, capabilities, provider-local options,
  health/concurrency declarations, and strict reference validation.
- Forwarder declarations with nested target graphs, canonical model identity, aliases, priority,
  weight, round-robin, cycle checks, and declaration-only manifest output.
- Route-group pool declarations including match criteria, selection policy, required non-empty
  `default` pool, opaque target references, and deterministic ordering.
- Hub declaration projection: closed entry protocols, execution modes, provider wire protocols,
  static hook-set IDs, continuation ownership/scope policies, capability declarations, and
  impossible-combination rejection. Config must publish declarations only; it must not choose a
  request-specific route, target, continuation owner, or execution plan.
- Server listener preflight, atomic aggregate binding, strict endpoint/method dispatch, request body
  parsing, content-type validation, request size limits, `/health`, `/v1/models`, Debug endpoints,
  and the current `/v1/responses` runtime entry.
- Explicit typed errors for malformed input, unsupported method/path, unknown endpoint capability,
  listener bind failure, frame construction failure, and runtime errors.
- Deterministic manifest and server startup projections, architecture maps, source gates, red tests,
  CLI checks, and controlled local HTTP verification.

### Out of scope

- Relay implementation.
- Responses continuation save/restore implementation.
- Request/response Chat Process business governance implementation.
- Anthropic, Gemini, and OpenAI Chat provider runtime implementations.
- P6-to-Hub v1 cutover, old P6 deletion, V2 compatibility, `~/.rcc` migration, global install, or
  production replacement.
- Provider-specific family/ID/model-prefix branches.

## Design constraints

1. Runtime remains the only complete lifecycle executor.
2. Every request must enter through the typed Server -> Runtime boundary; no Server -> Provider
   shortcut and no handler-local protocol conversion.
3. Config only parses, validates, compiles, and publishes declarations. It never executes routing,
   target expansion, health policy, continuation restore, or Provider transport.
4. Server owns listener and HTTP frame concerns only. Routing, target interpretation, protocol
   conversion, health, Debug policy, and Error policy remain in their declared owners.
5. No fallback, synthetic body replacement, silent JSON/text downgrade, implicit default protocol,
   or partial-listener startup.
6. The fixed Hub v1 node topology and static hook registry are consumed as declarations only until
   H1/H2 handoff proves the corresponding Rust symbols and bindings.
7. Changes must preserve the active H1 and H2 worker claims; shared schema/map surfaces require an
   explicit handoff before modification.

## Implementation order

1. Reconcile active worker claims and record the exact Config/Server ownership boundary.
2. Add red fixtures for missing Hub declarations, missing pool-match declarations, malformed JSON,
   unsupported methods, unsupported content types, body-size overflow, and handler/provider
   shortcut attempts.
3. Extend Config authoring types and strict validation for the complete declaration surface.
4. Compile declarations into deterministic typed resources and manifest projections; validate all
   cross-references, capability combinations, default-pool floors, and static hook-set references.
5. Add Config blackbox fixtures covering full valid TOML, unknown fields, invalid references,
   duplicate aliases, forwarder cycles, missing defaults, invalid matches, and deterministic output.
6. Replace broad Server business routing with strict method/path/content-type dispatch that emits
   explicit Error-chain failures and never enters Runtime on invalid input.
7. Preserve the existing `/v1/responses` P6 Direct entry as the only currently executable business
   path; route all other declared protocols through explicit `not_implemented` runtime nodes.
8. Validate multi-listener aggregate startup, listener identity, `/health`, `/v1/models`, Debug
   projections, request-size limits, frame construction, and clean shutdown.
9. Update resource map, function map, mainline call map, verification map, Wiki, and manifests only
   after source symbols and adjacent caller/callee edges are verified.
10. Run the complete V3 gate stack and controlled CLI HTTP probes; record evidence and hand off the
    result before any Hub hook migration or P6 cutover.

## Required verification

- Config unit and negative contract tests.
- Server method/path/content-type/malformed-body/body-limit tests.
- Multi-listener startup and atomic bind-failure tests.
- `/health`, `/v1/models`, Debug, and current `/v1/responses` controlled-upstream probes.
- Red tests for fallback body synthesis, Server/provider shortcut, duplicate config IO, partial
  startup, and implicit protocol defaults.
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-static-hook-registry`
- `npm run test:v3-source-gate-red-fixtures`
- `npm run test:v3-compile-fail`
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `npm run test:v3-workspace`
- `npm run build:v3-cli`
- actual V3 CLI config check, status, multi-listener startup, health probes, malformed-input probes,
  and current Responses Direct controlled-upstream replay.

## Completion definition

- The complete supported V3 Config declaration surface parses through the unique Config Store,
  rejects invalid/unknown/ambiguous declarations explicitly, and produces a deterministic manifest.
- Every enabled listener starts atomically from one manifest; invalid methods, paths, content types,
  malformed JSON, and oversized bodies fail through typed Error nodes instead of entering Runtime or
  being converted into synthetic payloads.
- Server `/v1/responses` continues to use the existing verified P6 Runtime path; other protocols
  remain explicit `not_implemented` nodes with no hidden fallback.
- No Server/Config shortcut, second lifecycle, provider-specific branch, or duplicate Config IO
  exists, and all architecture maps point to real verified source symbols.
- This phase does not claim Relay, continuation, other protocol execution, Hub v1 cutover, P6
  deletion, global install, or production replacement.
