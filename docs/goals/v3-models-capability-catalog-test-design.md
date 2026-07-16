# V3 `/v1/models` Capability Catalog Test Design

Feature: `v3.models_capability_catalog`

Owner: `routecodex-v3-server::build_v3_models_catalog`

## Lifecycle

```text
V3Config05ManifestPublished
  -> models_endpoint
  -> build_v3_models_catalog
  -> JSON list projection
  -> Codex client
```

The catalog is a read-only client projection. It may read the compiled Manifest, but it does not
select a route, resolve provider auth, mutate provider health, or enter a provider request body.

## Positive Tests

- Always list bare `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, even when the
  compiled provider catalog does not declare all four.
- Keep the stable Codex request-builder fields for reasoning, verbosity, search, image input,
  parallel tools, context window, `tool_mode`, and `use_responses_lite`.
- Preserve configured client aliases and runtime-derived `supports_streaming` and context-window
  fields.
- Return equivalent `data` and `models` arrays.

## Negative Tests

- Deduplicate a configured provider model whose visible ID equals a built-in bare Codex ID.
- Do not expose auth environment names, resolved credentials, MetadataCenter values, provider
  health, or runtime continuation state.
- Do not advertise model-level WebSocket preference; `prefer_websockets` remains `false`.
- Do not use a configured smaller context window to shrink a built-in bare Codex catalog entry.

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
- Restart the one managed V3 aggregate instance through `rccv3 server restart`.
- Replay live `GET /v1/models` on 5555 and verify the four built-ins plus configured aliases.
- Replay one JSON and one SSE `/v1/responses` control sample.
- Verify V2 ports 5520, 4444, and 10000 remain healthy.

## Known Gap

Catalog projection does not prove that every listed bare model is routable by every V3 routing
group. Route availability remains owned by Config/Virtual Router and must fail explicitly when no
configured target exists.
