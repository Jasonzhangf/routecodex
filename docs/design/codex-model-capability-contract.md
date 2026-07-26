# Codex Model Capability Contract

## Purpose

Lock the Codex-facing `/v1/models` metadata that RouteCodex exposes to the Codex client.
This endpoint is not cosmetic: Codex consumes these fields as runtime request-builder and tool-surface selectors.

Owner split:

- V2 legacy owner: `src/server/runtime/http-server/routes.ts`
- V2 feature id: `server.models_capability_contract`
- V3 owner: `v3/crates/routecodex-v3-server/src/lib.rs` with route-scope helper in `v3/crates/routecodex-v3-config/src/lib.rs`
- V3 feature id: `v3.models_capability_catalog`

V3 `/v1/models` is a read-only, listener-scoped client catalog projection from `V3Config05ManifestPublished`, the listener `routing_group`, and stable Codex built-in presets. It must not select a runtime target, resolve auth, mutate provider state, recover continuation, or enter provider request bodies.

## Codex source evidence

Source audited in `~/code/codex`:

- `codex-rs/protocol/src/openai_models.rs`
  - `ModelInfo` contains `supports_search_tool`, `use_responses_lite`, `tool_mode`, `web_search_tool_type`, `input_modalities`, `supports_image_detail_original`, `supports_parallel_tool_calls`, and `experimental_supported_tools`.
  - `ToolMode = Direct | CodeMode | CodeModeOnly`.
  - `tool_mode` is optional and skipped when omitted.
- `codex-rs/core/src/tools/mod.rs`
  - `effective_tool_mode()` uses remote `model_info.tool_mode` first. If present, it overrides local feature flags.
- `codex-rs/core/src/tools/spec_plan.rs`
  - `ToolMode::CodeModeOnly` hides ordinary direct nested tools and exposes code-mode `exec` / `wait` executors.
  - `use_responses_lite` disables hosted Responses tools and makes requests use Responses Lite `input[].type = "additional_tools"` for client-executed tools.
  - `supports_search_tool` is the standalone `tool_search` gate together with namespace-tools provider capability.
  - `experimental_supported_tools` currently gates `test_sync_tool`; it is not the `apply_patch`, `web_search`, or `tool_search` control surface.
- `codex-rs/models-manager/models.json`
  - `gpt-5.5`: `tool_mode = null`, `use_responses_lite = false`, `supports_search_tool = true`, `input_modalities = ["text", "image"]`, `web_search_tool_type = "text_and_image"`.
  - `gpt-5.6-sol|terra|luna`: `tool_mode = "code_mode_only"`, `use_responses_lite = true`, `supports_search_tool = true`, `input_modalities = ["text", "image"]`, `web_search_tool_type = "text_and_image"`.
  - RouteCodex must not expose `gpt-5.6-*` until the gpt-5.6 client surface is intentionally enabled.

Consequence: if RouteCodex advertises `gpt-5.5.tool_mode = "code_mode_only"` or `gpt-5.5.use_responses_lite = true`, Codex can send `additional_tools` with custom `exec` / `wait` instead of a first-class nested tool surface. A later JavaScript-looking `exec` payload is then a Codex code-mode executor request, not a RouteCodex `search` result converted to a script.

## Selector fields vs capability fields

### Request/tool-surface selectors

These fields change how Codex builds the next request and which tools are visible to the model:

- `tool_mode`
  - V3 `gpt-5.5`: must be absent.
  - V3 generic/provider aliases: must be absent unless the model family is intentionally a Codex code-mode-only family.
  - V3 `gpt-5.6-*`: must not be exposed by `/v1/models` yet. If it is re-enabled later, it must be a separate explicit catalog contract.
- `use_responses_lite`
  - V3 `gpt-5.5`: must be absent or false. Current V3 projection omits it.
  - V3 generic/provider aliases: must be absent or false unless intentionally using Responses Lite.
  - V3 `gpt-5.6-*`: must not be exposed by `/v1/models` yet. If it is re-enabled later, it must be a separate explicit catalog contract.

Do not fix selector mistakes in Direct, Relay, Hub Pipeline, provider runtime, SSE, or continuation stores. Fix the `/v1/models` projection owner.

### Route-group scoped capability fields

V3 must first scope the catalog to the current listener route group, matching V2's port-scoped `/v1/models` behavior:

1. Start from the current listener's `routing_group`.
2. Walk that route group's pool targets and forwarder targets.
3. For forwarders, expose the forwarder model/aliases as the visible ids; do not leak child provider aliases as separate catalog ids.
4. Expose only visible ids reachable from those targets.
5. Never expose an enabled provider model merely because it exists elsewhere in the compiled manifest.

`routecodex-v3-config::collect_v3_route_group_catalog_model_refs` owns this route-group/forwarder expansion. `routecodex-v3-server::build_v3_models_catalog` only consumes those scoped refs and projects the HTTP JSON shape.

After the route-group scope is fixed, V3 derives these client capability fields from the reachable provider model capabilities:

| Manifest capability | `/v1/models` projection | Codex effect |
| --- | --- | --- |
| `web_search` | `supports_search_tool = true` | Enables standalone/deferred `tool_search` when namespace tools are enabled. |
| `vision` or `multimodal` | `input_modalities = ["text", "image"]` | Allows image inputs for that model. |
| `vision` or `multimodal` | `supports_image_detail_original = true` | Allows original-detail `view_image` handling. |
| `vision` or `multimodal` + search metadata | `web_search_tool_type = "text_and_image"` | Allows image-capable hosted web search shape when hosted search is otherwise available. |
| no `vision`/`multimodal` | `input_modalities = ["text"]`, `supports_image_detail_original = false`, `web_search_tool_type = "text"` | Prevents Codex from assuming image support. |

`supports_streaming` is not a model capability. It remains the separate provider config field `supports_streaming` and must not appear inside `capabilities`.

`experimental_supported_tools` must not be used to advertise `apply_patch`, `web_search`, or `tool_search`. Current Codex only consumes recognized experimental tool names such as `test_sync_tool`; V3 keeps this vector empty unless a future explicit Codex-recognized experimental tool is added to the manifest contract.

## Visible model rules for V3

V3 lists the visible model ids reachable from the current listener route group. Among Codex built-in ids, only `gpt-5.5` may be projected today. `gpt-5.6-*` entries are intentionally hidden from `/v1/models`, including configured provider model ids and aliases, until the gpt-5.6 client surface is explicitly enabled.

Projection priority is explicit:

1. If the current listener route group does not reference a visible or canonical model id, do not list it.
2. If the route group references `gpt-5.5`, project the stable Codex `gpt-5.5` preset while deriving capability fields from the reachable provider model capabilities.
3. For non-built-in route-group visible ids, project provider metadata from the reachable provider model and derive capability fields from its `capabilities`.

This is not a fallback path during request execution; it is only catalog construction truth.

Runtime selector boundary: `gpt-5.5` remains the stable Codex built-in client surface and can route by capability/priority to any configured provider target. For non-built-in requested model ids, an explicitly matched route pool (`match.models`) is the inbound-model to provider-target mapping declaration; Target expands the declared targets and the standard provider-wire hook rewrites outbound `body.model` to the selected target `wire_model`. When no explicit model route matched and execution falls through the captured default plan, Target must find a matching configured target model (`forwarder.model` or direct provider `model` id) or fail explicitly with no wrong-model default success. Provider model aliases are catalog/client-display metadata and must not make runtime model matching accept an otherwise unrelated provider target.

Required V3 `gpt-5.5` selector contract:

- Listed only when the current listener route group exposes `gpt-5.5` as a visible or canonical route target.
- `tool_mode` absent.
- `use_responses_lite` absent/false.
- Search/image fields derive from route-group reachable provider capabilities when available; otherwise the built-in preset matches Codex bundled `gpt-5.5` (`web_search + multimodal`).

Required V3 `gpt-5.6-*` selector contract:

- No `gpt-5.6-*` id is exposed through `/v1/models` yet.
- No configured provider model or alias whose visible id or canonical id is `gpt-5.6*` may leak `tool_mode = code_mode_only` or `use_responses_lite = true` to Codex.
- Re-enabling gpt-5.6 requires a new explicit contract and tests.

## V2 legacy contract

V2 `server.models_capability_contract` keeps its existing port-scoped behavior and tests in `tests/server/http-server/routes.invalid-json.spec.ts`, with the same temporary ceiling: `/v1/models` exposes Codex built-ins only through route-visible `gpt-5.5` and suppresses `gpt-5.6-*` provider model ids/aliases.

V2-specific stable fields and visibility rules remain owned by `src/server/runtime/http-server/routes.ts`; V3 changes must not be implemented in V2 TS unless that feature id is explicitly claimed.

## Forbidden repairs

- Do not transform Direct request tools.
- Do not add a Relay tool state machine for this symptom.
- Do not convert `search` / `tool_search` / `web_search` into shell, JavaScript, or script payloads.
- Do not infer capability from samples, logs, provider health, continuation state, MetadataCenter, or routing results.
- Do not move client protocol fields into provider payload metadata or RouteCodex internal metadata.

## Verification

V2 gate:

```bash
npm run verify:models-capability-contract
```

V3 focused gate:

```bash
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml \
  -p routecodex-v3-server --test multi_listener_server p6_models_endpoint -- --nocapture
```

V3 project gates:

```bash
npm run verify:v3-architecture-docs
npm run verify:v3-resource-map
npm run verify:v3-module-boundaries
npm run verify:v3-rust-only
npm run verify:v3-cargo-fmt
npm run verify:v3-clippy
npm run test:v3-workspace
git diff --check
```

V3 live closeout requires global install, one managed aggregate restart, `/v1/models` probe on 5555, and a fresh Codex sample proving `gpt-5.5` no longer receives code-mode-only `additional_tools.exec/wait` as its only tool surface.
