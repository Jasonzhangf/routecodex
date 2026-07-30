# V3 Route Classifier Local Owner Test Design

## Objective

V3 must own its complete route-classification implementation under `v3/crates/`.
V2 is a characterization source during migration, not a runtime dependency or shared owner.
After behavior parity is proven, V2 can be removed without changing any V3 source, manifest,
build, test, or runtime dependency.

## Current Failure

V3 currently imports `route-classifier-core` from
`sharedmodule/llmswitch-core/rust-core/crates/route-classifier-core`.
That makes V3 depend on a component scheduled for removal and makes V2 edits able to change
V3 semantics without a V3-owned review or gate.

## Required V3 Contract

The V3-local crate must own:

1. Active-turn extraction for Chat and Responses input.
2. Tool-call classification, including malformed-call rejection.
3. Shell-command classification.
4. Route priority and ordered route candidates.
5. Strict current-user `web_search` intent.
6. Active-turn web-search continuation classification.
7. `web_search` as a target capability, never a route.
8. `multimodal` from the typed `hasImageAttachment` carrier only.
9. `longcontext` from the selected route-group threshold only.
10. Mandatory final `default` route tier.

## Positive Tests

- The V3-local crate passes the full V2 behavior characterization matrix.
- Fresh user input selects `thinking`; actual coding/search/thinking/other tool continuations
  select `coding`/`search`/`thinking`/`tools`.
- Long context follows the locked priority matrix and appends `default`.
- Strict web-search user intent and actual web-search continuation add
  `required_capabilities=["web_search"]` without selecting a `web_search` route.
- V3 Runtime and V3 Virtual Router compile and test against the local crate.

## Negative Tests

- No file under `v3/` may contain a dependency or import of `route-classifier-core` or the
  sharedmodule classifier path.
- Declared tools, tool schemas, descriptions, request reasoning, and historical text produce
  no route or `web_search` capability signal.
- Payload image shapes do not select `multimodal`.
- Client-provided estimated-token metadata does not select `longcontext`.
- The V2 classifier must not import or depend on the V3-local crate.
- No compatibility fallback may call the V2 classifier when V3 classification fails.

## Required Gates

- `npm run verify:v3-route-classifier-local-owner`
- `npm run test:v3-route-classifier-local-owner-red-fixtures`
- `npm run test:v3-route-classifier-semantics`
- `npm run test:route-classifier-semantics`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `npm run test:v3-p5-router-target`
- `npm run build:v3-cli`
- `git diff --check`

## Completion Rule

V3 runtime behavior is locally owned only when:

- the V3-local classifier crate contains the complete characterized semantics;
- V3 has zero source/build/map references to the shared V2 classifier;
- V2 and V3 parity tests pass independently;
- the owner gate is wired into V3 build and CI;
- the V3 function map and mainline map point only at V3-local source.
