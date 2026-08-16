# Function Map Audit Remediation Plan

## Goal

Upgrade the repo-wide function map audit from "partial lookup" to a parseable, queryable, gated, incrementally enforceable source of truth. Add explicit functional owner semantics, not only `owner_module`.

## Current Audit Snapshot

### Confirmed coverage

- `docs/architecture/function-map.yml` currently contains 28 feature entries.
- `docs/architecture/verification-map.yml` currently contains 28 feature entries.
- Current known additions include:
  - `server.responses_request_handler_bridge_surface`
  - `server.responses_response_handler_bridge_surface`
- `verify:responses-handler-single-bridge-surface` already exists and is wired into `package.json`.

### Confirmed gaps

1. Full-repo key-function coverage is not yet proven.
2. Current map shape answers "which file" better than "who owns the semantic responsibility".
3. Current audit still allows hidden owners outside the map.
4. Current gates do not yet explicitly fail on map parseability.

### Confirmed violations

1. `docs/architecture/function-map.yml` contains non-structural notes content that breaks standard YAML parsing.
2. When a map file is not stably parseable, machine audit falls back to grep-style inspection. This violates the goal of queryable SSOT.
3. Current `owner_module` field alone is insufficient for functional owner registry semantics.

### Confirmed risk surfaces

1. Hidden owner modules can exist in `src/`, `sharedmodule/`, or `tests/` without map registration.
2. Dead gate paths or non-existent builders can make a feature look registered while remaining unverifiable.
3. TS shell modules can still be mistaken for semantic owners if owner kind is not explicit.
4. A feature can declare `owner_module` while leaving actual semantic responsibility ambiguous.

## Target State

Every critical feature must be machine-queryable through this chain:

`feature_id -> owner_kind -> owner_module -> owner_scope -> canonical_builders -> required_tests -> required_gates`

The map must answer:

1. Which feature owns this behavior?
2. Which layer is allowed to own it?
3. Which file and symbol are authoritative?
4. Which paths may change it?
5. Which paths must not reimplement it?
6. Which minimum verification stack is mandatory?

## Owner Schema

Add explicit functional owner fields to each mapped feature:

```yaml
feature_id: ...
status: active
summary: ...
owner_kind: rust_ssot | ts_bridge | ts_entry_shell | provider_runtime | server_projection
owner_module: path/to/file
owner_scope: short semantic responsibility statement
canonical_types:
  - ...
canonical_builders:
  - ...
allowed_paths:
  - ...
forbidden_paths:
  - ...
required_tests:
  - ...
required_gates:
  - ...
migration_target: rust | ts
notes:
  - ...
```

### Owner kind rules

- `rust_ssot`
  - Semantic truth owner.
  - Default for pipeline governance, routing semantics, contract builders/parsers, error policy, servertool orchestration.
- `ts_bridge`
  - Thin host/native bridge only.
  - Must not own semantic transformation.
- `ts_entry_shell`
  - CLI/server entry dispatch only.
  - Must not own protocol or runtime semantics.
- `provider_runtime`
  - Provider-specific transport/auth/compat only.
  - Must not own Hub or router semantics.
- `server_projection`
  - Client projection / entry-protocol shell only.
  - Must not own request/response semantic governance.

## Execution Plan

### P0. Restore machine-parseable map truth

Actions:

1. Clean `function-map.yml` into valid YAML.
2. Clean `verification-map.yml` into valid YAML if needed.
3. Convert all freeform notes into parser-safe YAML scalar/list form.
4. Add `verify:architecture-function-map-parseable`.

Done definition:

- Standard YAML parser can load both map files.
- Parse gate is wired into architecture verification chain.

### P1. Add functional owner registry semantics

Actions:

1. Add `owner_kind` to every current feature.
2. Add `owner_scope` to every current feature.
3. Normalize owner taxonomy across existing 28 features.
4. Reject TS shell owners for semantic features unless explicitly whitelisted.

Done definition:

- Every current feature has explicit owner kind and owner scope.
- High-risk features no longer rely on `owner_module` alone.

### P2. Close queryability and growth gates

Actions:

1. Strengthen `verify:architecture-owner-queryability`.
2. Strengthen `verify:architecture-feature-map-growth-discipline`.
3. Strengthen `verify:architecture-forbidden-path-growth`.
4. Strengthen `verify:architecture-duplicate-owner`.
5. Ensure gates fail if owner fields are missing or semantically weak.

Done definition:

- Missing owner fields fail.
- Duplicate or conflicting owner surfaces fail.
- Forbidden-path semantic growth fails.

### P3. Run hidden-owner audit

Actions:

1. Scan `src/`, `sharedmodule/`, `tests/` for high-risk runtime/handler/bridge/projection owners not present in the map.
2. Prioritize:
  - runtime governance
  - request/response handlers
  - bridge/projection surfaces
  - manager/admin control surfaces
  - provider runtime semantic leak surfaces
3. Register missing critical features or explicitly classify them as doc-only.

Done definition:

- Repo has a reviewed missing-feature list.
- Each missing item is either registered or explicitly ruled out with boundary reason.

### P4. Enforce incremental discipline

Actions:

1. Require new critical features to add function map + verification map + owner fields together.
2. Keep pure types/constants/build glue/doc re-exports as doc-only, not fake feature registrations.
3. Update local skill/docs with owner-registry rule.

Done definition:

- New critical functionality cannot land without owner-mapped verification closure.

## Required Gates

Must exist and be runnable:

- `npm run verify:architecture-function-map-parseable`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:architecture-feature-map-growth-discipline`
- `npm run verify:architecture-forbidden-path-growth`
- `npm run verify:architecture-duplicate-owner`
- `npm run verify:function-map-compile-gate`

## Audit Findings Against Plan

### Already done

1. Base function-map / verification-map structure exists.
2. Responses request/response bridge split has been mapped.
3. Single-bridge gate already exists for `/v1/responses`.

### Not done yet

1. Parseability gate is missing.
2. Current features do not yet carry explicit `owner_kind`.
3. Current features do not yet carry explicit `owner_scope`.
4. Full hidden-owner scan has not been completed.

### Loopholes still open

1. Semantic owner ambiguity remains if `owner_module` is present but owner responsibility is not.
2. A TS shell can still look authoritative unless owner kind blocks it.
3. Map drift can hide behind non-parseable YAML.
4. Registration can still be superficial if builder/test/gate chains are incomplete.

## Anti-Patterns To Block

1. Using grep-only inspection as the lasting audit method.
2. Registering TS shell as semantic owner.
3. Using comment/notes placeholders instead of real builders and gates.
4. Leaving feature rows with file paths but without semantic responsibility.
5. Pointing gates/tests to deleted files.
6. Keeping duplicate owner surfaces alive in forbidden paths.

## Acceptance Criteria

1. Map files are parser-clean.
2. All mapped critical features have explicit functional owner semantics.
3. Owner query chain is machine-readable.
4. Missing critical features can be surfaced by scan rather than memory.
5. New critical changes require map + owner + verification closure.
