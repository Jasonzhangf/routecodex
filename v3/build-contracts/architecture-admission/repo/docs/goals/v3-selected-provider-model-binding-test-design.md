# V3 Selected Provider Model Binding Test Design

## Lifecycle under test

`request.model -> Router facts -> Target10 selected model -> shared binding -> Direct/Relay -> provider compat -> wire validation -> transport`

## White-box

1. Binding accepts an object and writes exactly `selected.wire_model`.
2. Binding mutates only the cloned provider payload; client model observation remains in route facts and the selected target remains immutable.
3. Empty selected wire model fails.
4. Provider wire accepts an exactly bound model.
5. Provider wire rejects missing/mismatched model and never repairs it.

## Module black-box

1. Direct request projection sends selected wire model when client alias differs.
2. Relay ProviderReqCompat06 sees selected wire model before model-aware compatibility executes.
3. Responses/OpenAI Chat/Anthropic/Gemini outbound bodies preserve selected wire model.
4. Retry/reselect binds the model independently per attempt.

## Project black-box

1. Provider-request dry-run proves request alias and provider wire model are independent.
2. 5555 old sample `652302-6819` proves RouteCodex sends configured wire model; upstream-only
   aliases such as `gpt-5.5-anyint` are not injected locally.
3. Live routing switch proves each candidate attempt has its own configured model.

## Positive / negative pairs

- Positive: bound target model reaches transport. Negative: stale client model fails at wire gate.
- Positive: reselect uses new candidate model. Negative: prior attempt model cannot leak.
- Positive: protocol codec copies bound model. Negative: codec cannot select from client alias.
- Positive: upstream provider errors remain external. Negative: local binding mismatch is never
  classified as provider failure or charged to health.

## Required gates

- `cargo test -p routecodex-v3-provider-responses --test selected_model_binding_contract`
- focused runtime Direct/Relay model-binding tests
- `npm run verify:v3-selected-provider-model-binding`
- `npm run test:v3-selected-provider-model-binding-red-fixtures`
- `npm run build:v3-cli`
- global install, managed aggregate restart, 10000 then 5555 provider-request dry-run/live replay
