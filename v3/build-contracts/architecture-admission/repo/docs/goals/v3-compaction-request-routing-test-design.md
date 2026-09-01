# V3 Compaction Request Routing Test Design

## Objective

Route explicitly registered client compaction requests through one ingress classifier into the highest-priority `compact` Virtual Router signal. Preserve normal payload bytes and keep the request-purpose control fact out of provider/client payloads.

## Lifecycle

```text
registered endpoint/header projection
  -> V3Server03 request-purpose classifier
  -> V3Req04 protocol context
  -> V3RouterRequestFacts / compact route signal
  -> compact pool before direct-model and every ordinary route
  -> Responses transport keeps /responses/compact only for native Codex compact
```

The typed purpose distinguishes `NativeCompaction` from `AuxiliaryCompaction`: both select the same highest-priority route, while only the native endpoint changes provider transport to `/responses/compact`.

## Whitelist

- Codex native compact: exact endpoint `/v1/responses/compact`.
- DSH auxiliary compact: exact header `x-deepseek-harness-compact: 1`.
- OpenCode/Reasonix auxiliary compact: exact header `x-routecodex-request-purpose: compaction`.
- Any other endpoint or header name is not a compaction signal; a wrong value on a registered header fails fast.

## Positive tests

1. Native Codex endpoint classifies as compaction and maps to `responses` entry protocol.
2. Each registered auxiliary header classifies as compaction on a normal endpoint.
3. Compaction wins over multimodal, longcontext, thinking, coding, web search, tools, and a dotted direct model.
4. An explicit compact pool is selected before model/direct and default tiers.
5. Native compact transport sends to `/responses/compact`; auxiliary compact keeps the normal provider endpoint.
6. Compact request payload is byte/JSON-value equivalent except the existing selected-model binding.

## Negative tests

1. Prompt text containing `compact` or `summarize` does not classify as compaction.
2. Unknown headers do not classify as compaction.
3. Conflicting/invalid values on a registered compact header fail at the ingress owner.
4. A normal request retains the existing route priority and `/responses` transport.
5. Request-purpose state never appears in provider body, client body, metadata, snapshot payload, or continuation state.
6. A native compact request cannot be relayed or sent through a non-Responses provider shape; it fails before provider send.

## Required gates

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-route-classifier`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-virtual-router`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime nodes::tests -- --nocapture`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-provider-responses transport::tests -- --nocapture`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib compaction -- --nocapture`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-cargo-fmt`
- `cargo check --manifest-path v3/Cargo.toml -p routecodex-v3-server`
- `git diff --check`

## Live acceptance

After global V3 installation and the single managed aggregate `routecodex restart`, replay one native `/v1/responses/compact`, one registered auxiliary compact request, and one ordinary control request. Evidence must show the compact pool wins, the upstream endpoint shape is correct, all configured listener health endpoints remain healthy, and no request-purpose field enters normal payloads.
