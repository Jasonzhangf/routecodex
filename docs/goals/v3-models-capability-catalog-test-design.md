# V3 `/v1/models` Capability Catalog Test Design

Feature: `v3.models_capability_catalog`

Owner: `routecodex-v3-server::build_v3_models_catalog`

Source owner files:

- `v3/crates/routecodex-v3-server/src/lib.rs`
- `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`

Reference client source:

- `~/code/codex/codex-rs/protocol/src/openai_models.rs`
- `~/code/codex/codex-rs/core/src/tools/mod.rs`
- `~/code/codex/codex-rs/core/src/tools/spec_plan.rs`
- `~/code/codex/codex-rs/models-manager/models.json`

## Lifecycle

```text
V3Config05ManifestPublished
  -> models_endpoint
  -> build_v3_models_catalog
  -> build_v3_model_capability_index
  -> build_v3_model_capability_projection
  -> JSON list projection
  -> Codex ModelInfo
  -> Codex request/tool planner
```

The catalog is a read-only client projection. It may read the compiled Manifest, but it does not
select a route, resolve provider auth, mutate provider health, restore continuation, or enter a
provider request body.

## Current catalog ceiling

V3 exposes only the bare Codex `gpt-5.5` entry for now. `gpt-5.6-*` entries and configured provider
model ids/aliases beginning with `gpt-5.6` are hidden until the gpt-5.6 client surface is explicitly
enabled with a separate contract and tests.

Reason: Codex bundled `gpt-5.6-*` metadata intentionally sets `tool_mode=code_mode_only` and
`use_responses_lite=true`. Exposing those ids from a `gpt-5.5`-oriented RouteCodex catalog can make
Codex switch into Responses Lite/code-mode request shapes that are not the current 5555 target.

## Capability classification

Selectors that change Codex request/tool planning:

- `tool_mode`
  - `gpt-5.5`: absent.
  - `gpt-5.6-*`: not exposed yet.
- `use_responses_lite`
  - `gpt-5.5`: absent/false.
  - `gpt-5.6-*`: not exposed yet.

Manifest-derived client capabilities:

- `web_search` -> `supports_search_tool = true`.
- `vision` or `multimodal` -> `input_modalities = ["text", "image"]` and `supports_image_detail_original = true`.
- no `vision` / `multimodal` -> `input_modalities = ["text"]` and `supports_image_detail_original = false`.
- image-capable search metadata -> `web_search_tool_type = "text_and_image"`; otherwise `"text"`.

Non-capability / separate fields:

- `supports_streaming` is a separate transport flag, not a model capability token.
- `experimental_supported_tools` is not the search/apply-patch gate in current Codex source; V3 keeps it empty unless a future explicit Codex-recognized experimental tool contract is added.

## Positive Tests

- List bare `gpt-5.5` even when the compiled provider catalog does not declare it.
- Keep `gpt-5.5` out of Responses Lite / code-mode-only: no `tool_mode`, no `use_responses_lite`.
- Derive `gpt-5.5` search/image fields from provider manifest capabilities when the manifest declares `gpt-5.5`; otherwise use the built-in Codex preset for `gpt-5.5` (`web_search + multimodal`).
- Preserve configured non-hidden client aliases and runtime-derived `supports_streaming` and context-window fields.
- Keep stable Codex request-builder fields for reasoning, verbosity, parallel tools, context windows, `apply_patch_tool_type`, and built-in description.
- Return equivalent `data` and `models` arrays.

## Negative Tests

- Do not expose bare `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna` before the gpt-5.6 client surface is intentionally enabled.
- Do not expose configured provider model ids or aliases whose canonical or visible id is `gpt-5.6*`.
- Do not expose auth environment names, resolved credentials, MetadataCenter values, provider health, or runtime continuation state.
- Do not advertise model-level WebSocket preference; `prefer_websockets` remains `false`.
- Do not use a configured smaller context window to shrink a built-in bare Codex catalog entry.
- Do not project manifest `tools` / `web_search` into `experimental_supported_tools`.
- Do not repair wrong Codex tool-surface selection in Direct, Relay, Hub Pipeline, provider runtime, SSE, or continuation state.

## Red / Green lock

Red sample locked in `p6_models_endpoint_projects_manifest_catalog_with_alias_capabilities`:

- Old behavior advertised `gpt-5.5.use_responses_lite = true` and `gpt-5.5.tool_mode = "code_mode_only"`.
- Red assertion requires both to be absent for `gpt-5.5`.
- Green behavior keeps `gpt-5.5.supports_search_tool = true` while removing those selectors.

Additional current positive/negative locks:

- Configured alias `client-test` with capabilities `text/tools` publishes text-only/no-search/no-image.
- Configured `gpt-5.6-sol` is suppressed entirely, so Codex cannot receive code-mode/lite selectors from this catalog.
- `experimental_supported_tools` remains `[]` for projected V3 entries.

## Verification Stack

Whitebox/module blackbox:

```bash
CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml \
  -p routecodex-v3-server --test multi_listener_server p6_models_endpoint -- --nocapture
```

Project gates:

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

Runtime closeout:

- Build and globally install the current source.
- Restart the one managed V3 aggregate instance through the approved global managed command.
- Replay live `GET /v1/models` on 5555 and verify:
  - `gpt-5.5` exists.
  - `gpt-5.6-*` ids are absent.
  - `gpt-5.5.supports_search_tool` reflects provider manifest capability truth.
  - `gpt-5.5.tool_mode` is absent/null.
  - `gpt-5.5.use_responses_lite` is absent/null/false.
- Replay a fresh Codex request through 5555 and inspect the new canonical sample under
  `~/.rcc/codex-samples/openai-responses/ports/5555/<requestId>/`.
- The fresh sample must not show `gpt-5.5` forced into code-mode-only `additional_tools.custom exec`
  / `wait` as its only tool surface.

## Known Gap

Catalog projection does not prove that every listed bare model is routable by every V3 routing
group. Route availability remains owned by Config/Virtual Router and must fail explicitly when no
configured target exists.
