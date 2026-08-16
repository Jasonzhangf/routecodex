# V3 Responses Reasoning Effort Forward-Compatibility Test Design

Design ID: `V3-RESPONSES-REASONING-EFFORT-FORWARD-COMPAT-20260816`

## Goal

`/v1/responses` must not fail merely because `reasoning.effort` is a non-empty
string newer than the values known to RouteCodex. Preserve the client value through
Req02 Chat canonical storage and same-protocol Responses provider wire. Do not delete,
replace, approximate, or move the payload field into MetadataCenter.

## Baseline and first divergence

- Exact sample: `openai-responses-router-deepseek-v4-flash-20260816T000815469-817406-202`.
- Input: `reasoning.effort = "definitely_invalid"`.
- First divergence: `project_responses_reasoning_to_chat_fields` used a closed enum
  allowlist at Req02 and rejected the request before target selection or transport.
- Secondary same-protocol divergence: Responses outbound used the same closed enum and
  would reject the preserved canonical value before provider wire construction.

## Owner and boundary

- Feature owner: `v3.protocol_conversion_field_parity`.
- Inbound owner: `responses_openai_codec.rs` at `V3HubReqInbound02Normalized`.
- Same-protocol outbound owner: `request_outbound_format.rs` at
  `V3ProviderReqOutbound08WirePayload`.
- Allowed: validate type/non-empty shape; preserve the normalized string in the payload
  data plane; enforce explicit target-domain intersections in Anthropic/Gemini codecs.
- Forbidden: request cleanup, silent strip, invented replacement effort, handler/SSE
  compensation, MetadataCenter mirroring, or provider-specific logic in Hub/VR.

## Lifecycle

```text
Responses reasoning.effort(non-empty string)
  -> Req02 reasoning_effort payload semantic
  -> Req03..Req07 unchanged governance
  -> Responses target: reasoning.effort exact projection
  -> provider transport
```

For a cross-protocol target lacking an exact effort-domain mapping, its owning outbound
codec remains fail-fast and the existing typed provider policy decides reselection.

## Tests

- Red/green inbound: unknown non-empty effort previously fails, then survives Req02.
- Red/green outbound: unknown canonical effort previously fails, then reaches
  same-protocol Responses `reasoning.effort` exactly.
- Reverse: null, non-string, and empty/whitespace-only effort still fail Req02.
- Cross-protocol reverse: Anthropic/Gemini retain their explicit intersection checks;
  no value is approximated or dropped.
- Live old sample: exact captured request must return a successful terminal response,
  not HTTP 500 or 400.
- Live positive control: registered `medium` effort remains HTTP 200 terminal.

## Required gates

- Focused red/green/reverse tests.
- `test:v3-protocol-conversion-field-parity` plus verifier/red fixtures.
- Module, Rust-only, architecture, resource, function-map, fmt, and diff gates.
- Full build, global install, one aggregate `routecodex restart`, all configured health
  endpoints, exact old-sample replay, valid same-entry replay, then DSH Review.
