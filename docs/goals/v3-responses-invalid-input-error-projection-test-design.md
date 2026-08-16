# V3 Reasoning Effort Target-Protocol Compatibility Test Design

Design ID: `V3-REASONING-EFFORT-TARGET-PROTOCOL-COMPAT-20260816`

## Goal

`/v1/responses` must not fail merely because `reasoning.effort` is a non-empty
string newer than the values known to RouteCodex. Preserve the client value through
Req02 Chat canonical storage, then map it at ProviderReqCompat/Provider12 to the closest
legal target-protocol control. The exact old sample must return HTTP 200.

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
- Target-protocol compatibility owner: `provider_req_compat_06_provider_compat.rs`,
  shared by Relay ProviderReqCompat06 and Direct `responses_direct_request_projection_hook`
  before `V3Provider12ResponsesWirePayload`.
- DeepSeek Chat profile owner: `provider-compat-core::apply_deepseek_max_request_compat`.
- Allowed: validate type/non-empty shape; preserve the source value until the concrete
  target is selected; perform an explicit lossy target-protocol projection at the registered
  Provider compatibility owner.
- Forbidden: inbound cleanup, handler/SSE compensation, MetadataCenter mirroring,
  provider policy in Hub/VR, or sending a value outside the target's official domain.

## Lifecycle

```text
Responses reasoning.effort(non-empty string)
  -> Req02 reasoning_effort payload semantic
  -> Req03..Req07 unchanged governance
  -> ProviderReqCompat06 / Direct Provider12 target compatibility projection
  -> provider transport
```

Compatibility table:

- OpenAI Responses/Chat: known `none|minimal|low|medium|high|xhigh`; `max -> xhigh`;
  unknown non-empty -> `medium`.
- Anthropic Messages: `none|minimal -> low`; shared values remain; unknown -> `medium`.
- DeepSeek official API: `xhigh|max -> max`; active lower/unknown values -> `high`;
  explicit `none` remains non-thinking.
- MiniMax Anthropic API: active effort -> `thinking.type=adaptive`; MiniMax does not
  receive unsupported `output_config.effort`.

## Tests

- Red/green inbound: unknown non-empty effort previously fails, then survives Req02.
- Red/green Provider12: unknown canonical effort previously reached upstream unchanged;
  it now reaches standard Responses as `medium` and DeepSeek as `high`.
- Reverse: null, non-string, and empty/whitespace-only effort still fail Req02.
- Cross-protocol reverse: Anthropic maps to its legal qualitative domain; MiniMax maps
  active effort to adaptive thinking without an unsupported effort field.
- Live old sample: exact captured request must return a successful terminal response,
  not HTTP 500 or 400.
- Live positive control: registered `medium` effort remains HTTP 200 terminal.

## Required gates

- Focused red/green/reverse tests.
- `test:v3-protocol-conversion-field-parity` plus verifier/red fixtures.
- Module, Rust-only, architecture, resource, function-map, fmt, and diff gates.
- Full build, global install, one aggregate `routecodex restart`, all configured health
  endpoints, exact old-sample replay, valid same-entry replay, then DSH Review.
