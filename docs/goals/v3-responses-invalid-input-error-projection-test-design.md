# V3 Responses Invalid Input Error Projection Test Design

Design ID: `V3-RESPONSES-INVALID-INPUT-ERROR-PROJECTION-20260816`

## Goal

When `/v1/responses` Relay Req02 rejects malformed client protocol data, preserve the
fail-fast validation and project a typed client invalid-request response. Do not classify
the client defect as an internal Relay runtime failure.

## Baseline and first divergence

- Exact sample: `openai-responses-router-deepseek-v4-flash-20260816T000815469-817406-202`.
- Input fact: `reasoning.effort = "definitely_invalid"`.
- Req02 validator correctly rejects the value.
- First divergence: `project_v3_responses_relay_runtime_failure` maps
  `V3ResponsesRelayRuntimeError::InboundCanonical` into generic
  `V3ErrorSourceKind::RuntimeFailure`, HTTP 500, code `responses_relay_runtime_error`.

## Module and owner boundary

- Feature owner: `v3.hub_relay_runtime_closeout`.
- Request validator owner: `V3HubReqInbound02Normalized` / `responses_openai_codec.rs`.
- Error truth owner: `routecodex-v3-error` Error01-06 chain.
- Runtime adapter owner: `project_v3_responses_relay_runtime_failure` in
  `responses_relay_dry_run.rs`.
- Allowed change: classify only the existing typed `InboundCanonical` error before
  entering Error01; keep the validator and payload unchanged.
- Forbidden: accept/strip the invalid value, mutate request payload, add handler/SSE
  compensation, reroute providers, or turn any unrelated Runtime error into HTTP 400.

## Lifecycle contract

```text
V3HubReqInbound01ClientRaw
  -> V3HubReqInbound02Normalized validates Responses schema
  -> invalid input: V3ResponsesRelayRuntimeError::InboundCanonical
  -> V3Error01SourceRaised(kind=InvalidRequest, stage=V3HubReqInbound02Normalized)
  -> V3Error02..06
  -> client HTTP 400 invalid_request
```

Valid input continues through Req03-Req09. Non-input runtime failures remain HTTP 500.

## Whitebox tests

- Negative/client-invalid: `InboundCanonical` projects HTTP 400 and a stable
  `invalid_responses_request` code through Error01-06.
- Positive/unrelated-runtime: `StaticRegistry` remains HTTP 500
  `responses_relay_runtime_error`.
- Payload/control boundary: client body contains only client error code/message; no
  class, stage, decision, node, candidate, or error-chain control fields.

## Blackbox tests

- Client-facing: exact old sample returns HTTP 400, not 500.
- Provider-facing: invalid input stops before target/provider send.
- Positive live control: a valid `/v1/responses` request still reaches provider and
  returns its normal terminal response.

## Required gates

- Focused red/green runtime unit test.
- V3 Hub Relay runtime closeout gate and red fixtures.
- V3 architecture/resource/module/Rust-only/fmt gates.
- V3 build, global install, one aggregate `routecodex restart`, all configured port
  health checks, exact old-sample replay, and valid same-entry live replay.
- DSH Review after unchanged-source live verification.
