# V3 Stopless Default-Enabled Test Design

## Scope

- Feature: `v3.config_interpreter_contract` + `v3.servertool_hook_skeleton_lifecycle`
- Symptom: `5520` accepted a provider natural stop as terminal because absent `stopless_center` authoring compiled to an absent manifest key and runtime interpreted absence as disabled.
- Unique default owner: `V3Config02AuthoringParsed -> V3Config04ResourceRegistryBuilt -> V3Config05ManifestPublished` in `routecodex-v3-config`.
- Runtime precedence: `server.features.stopless_center > manifest.features.stopless_center`; runtime must consume the compiled manifest without inventing another default.

## Lifecycle

1. Config authoring omits or explicitly sets `[features].stopless_center`.
2. Config04 materializes the global default as `true` only when the key is absent.
3. Config05 publishes the deterministic feature truth.
4. Relay Req04 applies a server override when present, otherwise the compiled global value.
5. Runtime activation requires an explicit StoplessControl handle whose scope contains non-placeholder session and conversation identities; an omitted handle is inactive.
6. With valid client session scope, enabled Req04 injects stopless guidance and exactly one internal `reasoningStop` declaration.
7. An activated natural stop without canonical completion evidence becomes client `requires_action` with `call_stopless_reasoning`.

## Positive Tests

- Omitted global feature compiles to `manifest.features["stopless_center"] == true`.
- Explicit global `false` remains false.
- Server `false` overrides compiled global true.
- Server `true` overrides explicit global false.
- Runtime consumes those compiled global/server values without a second default or fallback.
- Omitted feature plus valid session scope injects exactly one `reasoningStop` declaration and projects an evidence-free natural stop as `requires_action`.

## Negative Tests

- `responses_direct_stopless_center` remains absent/false by default; this change does not enable Direct stopless.
- Explicit global false injects no guidance/tool and leaves natural stop completed.
- Missing StoplessControl handle or invalid client session scope remains inactive even when the compiled global default is true, injects no guidance/tool, writes no StoplessCenter state, and projects no no-op.

## Black-Box Closure

1. Build and globally install V3.
2. Validate the unchanged live config.
3. Restart the aggregate server exactly once with `restart`; never use `start`, `stop`, or broad process kill.
4. Verify `10000`, `5520`, and `5555` health.
5. Dry-run or capture a real `5520` provider request from omitted-feature config and prove stopless guidance plus exactly one `reasoningStop` declaration.
6. Replay the same `5520` entry/session semantics and prove an evidence-free natural stop produces `stopless_activation=true` and client `requires_action`, not silent completed stop.
7. Preserve explicit-false and missing-session-scope negative evidence.

## Required Gates

- Focused `routecodex-v3-config` default/override tests.
- `hub_relay_stopless_center_semantics`.
- Existing missing-session-scope integration test.
- Stopless resource-control and state-machine docs gates plus red fixtures.
- V3 architecture/resource/module/Rust-only gates.
- Rust format and scoped diff check.
- Codex review with explicit PASS before commit.
