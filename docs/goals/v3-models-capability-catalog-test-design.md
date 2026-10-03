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
  -> current listener routing_group
  -> collect_v3_route_group_catalog_model_refs
  -> build_v3_models_catalog
  -> route-group pool/forwarder target model refs
  -> build_v3_model_capability_projection
  -> JSON list projection
  -> Codex ModelInfo
  -> Codex request/tool planner
```

The catalog is a read-only client projection. It reads the compiled Manifest and the current
listener routing group, but it does not select a runtime route, resolve provider auth, mutate
provider health, restore continuation, or enter a provider request body.

## Current catalog ceiling

V3 exposes only model ids reachable from the current listener route group. Among Codex built-in ids,
only route-visible `gpt-5.5` may be projected for now. `gpt-5.6-*` entries and configured provider
model ids/aliases beginning with `gpt-5.6` are hidden until the gpt-5.6 client surface is explicitly
enabled with a separate contract and tests.

Reason: Codex bundled `gpt-5.6-*` metadata intentionally sets `tool_mode=code_mode_only` and
`use_responses_lite=true`. Exposing those ids from a `gpt-5.5`-oriented RouteCodex catalog can make
Codex switch into Responses Lite/code-mode request shapes that are not the current 5555 target.

## Catalog surfaces

`/v1/models` projects three distinct surfaces, and the route-group ceiling above applies only to the
first one:

1. **Route-group reachable visible ids.** Scoped by the current listener route group, and narrowed by
   a non-empty `expose_models` list.
2. **Direct-routing surface.** Every enabled provider model is addressable as `provider.model` and is
   always listed, because `expose_models` names are client entry names rather than provider model ids.
3. **Client entry names.** An `expose_models` name that matches no provider model is published as a
   virtual entry with `direct_route: false`. Such a name takes the same normal Virtual Router path as
   `auto`; it never pins a provider and never becomes a direct target.

A client model string that is not a listed `provider.model` is not an error: it falls back to normal
classification, which is the path `auto` and the entry names take.

## Capability classification

Selectors that change Codex request/tool planning:

- `tool_mode`
  - `gpt-5.5`: absent.
  - `gpt-5.6-*`: not exposed yet.
- `use_responses_lite`
  - `gpt-5.5`: absent/false.
  - `gpt-5.6-*`: not exposed yet.

Route-group-scoped manifest-derived client capabilities:

- `web_search` -> `supports_search_tool = true`.
- `vision` or `multimodal` -> `input_modalities = ["text", "image"]` and `supports_image_detail_original = true`.
- no `vision` / `multimodal` -> `input_modalities = ["text"]` and `supports_image_detail_original = false`.
- image-capable search metadata -> `web_search_tool_type = "text_and_image"`; otherwise `"text"`.

Non-capability / separate fields:

- `supports_streaming` is a separate transport flag, not a model capability token.
- `experimental_supported_tools` is not the search/apply-patch gate in current Codex source; V3 keeps it empty unless a future explicit Codex-recognized experimental tool contract is added.

## Positive Tests

- List bare `gpt-5.5` when the current listener route group exposes a visible or canonical
  `gpt-5.5` target.
- Config helper expands route-visible forwarders and uses the forwarder visible id instead of
  leaking child provider aliases for catalog visibility.
- Keep `gpt-5.5` out of Responses Lite / code-mode-only: no `tool_mode`, no `use_responses_lite`.
- Derive `gpt-5.5` search/image fields from route-group reachable provider capabilities when
  available; otherwise use the built-in Codex preset for `gpt-5.5` (`web_search + multimodal`).
- Preserve configured non-hidden client aliases and runtime-derived `supports_streaming` and context-window fields.
- List every enabled provider model as a `provider.model` direct entry even when `expose_models` is
  non-empty and names none of them.
- Publish an `expose_models` name that matches no provider model as a virtual entry with
  `direct_route: false`, and keep the built-in preset capability surface for a built-in entry name
  such as `gpt-5.5`.
- Keep stable Codex request-builder fields for reasoning, verbosity, parallel tools, context windows, `apply_patch_tool_type`, and built-in description.
- Return equivalent `data` and `models` arrays.

## Negative Tests

- Do not expose bare `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna` before the gpt-5.6 client surface is intentionally enabled.
- Do not expose configured provider model ids or aliases whose canonical or visible id is `gpt-5.6*`.
- Do not expose enabled provider models or aliases that are not reachable from the current listener
  route group on the routed surface. This ceiling does not apply to the `provider.model`
  direct-routing surface, which must always be listed.
- Do not suppress a `provider.model` direct entry because `expose_models` omits it, and do not turn a
  client entry name into a direct route.
- Do not expose child provider aliases from a forwarder unless that alias is itself the visible
  route target id.
- Do not invent `gpt-5.5` for a listener route group that has no reachable `gpt-5.5` target.
- Do not expose auth environment names, resolved credentials, MetadataCenter values, provider health, or runtime continuation state.
- Do not advertise model-level WebSocket preference; `prefer_websockets` remains `false`.
- Do not use a configured smaller context window to shrink a built-in bare Codex catalog entry.
- Do not project manifest `tools` / `web_search` into `experimental_supported_tools`.
- Do not repair wrong Codex tool-surface selection in Direct, Relay, Hub Pipeline, provider runtime, SSE, or continuation state.

## Red / Green lock

Red sample locked in `p6_models_endpoint_projects_manifest_catalog_with_alias_capabilities`:

- Old behavior exposed every enabled provider model in the compiled manifest even when a model was
  not reachable from the current listener route group.
- Red assertion adds `offroute-test` as an enabled provider model outside the route group and
  requires it to be absent from `/v1/models`.
- Green behavior keeps route-visible `client-test`, suppresses off-route models, and keeps
  `gpt-5.5` selectors absent when `gpt-5.5` is route-visible.

Red sample locked in `p6_models_endpoint_expose_models_publishes_entry_names_and_keeps_direct_surface`:

- Old behavior applied `expose_models` as a `visible_id` whitelist to every catalog entry, including
  the `provider.model` direct surface. A list naming only client entry names such as
  `["gpt-5.5", "auto"]` matched no provider model id, so `/v1/models` returned an empty catalog.
- Red assertion declares `expose_models = ["gpt-5.5", "auto", "client-test"]` and requires `gpt-5.5`
  and `auto` to be listed as virtual entries with `direct_route: false`, `client-test` to stay listed,
  `offroute-test`/`offroute` to stay suppressed, and `test.test`/`test.offroute` to stay listed as
  direct routes.
- Green behavior publishes the entry names, keeps the whitelist scoped to routed visible ids, and
  always lists the direct-routing surface.

Additional current positive/negative locks:

- Configured route-visible alias `client-test` with capabilities `text/tools/vision` publishes
  text+image/no-search metadata.
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
- Replay live `GET /v1/models` on 4444 and 5555 and verify:
  - `gpt-5.5` exists.
  - `gpt-5.6-*` ids are absent.
  - Models not reachable from the probed listener's route group are absent.
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
configured target exists. Runtime Target carries non-built-in requested model ids as route facts:
explicit `match.models` pools declare inbound-model to target mapping and the provider-wire hook
rewrites outbound `body.model` to the selected target `wire_model`; default/no-explicit-model paths
must find a matching configured target model (`forwarder.model` or direct provider `model` id) and
must ignore provider aliases for runtime matching, otherwise fail explicitly instead of silently
succeeding through an unrelated default model.
