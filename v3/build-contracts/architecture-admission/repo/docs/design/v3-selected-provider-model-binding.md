# V3 Selected Provider Model Binding Contract

## Status

- feature_id: `v3.route_selected_provider_model_binding`
- resource owner: `v3.hub.resolved_target`
- semantic owner: `routecodex-v3-runtime::selected_provider_model_binding`
- lifecycle status: implementation in progress

## Problem source

The client request model is a route selector, not a provider wire model. V3 already resolves
`provider_id + model_id + wire_model` in `V3Target10ConcreteProviderSelected`, but the request
payload retains the client model through Direct policy construction and through Relay
`ProviderReqCompat06ProviderCompat`. The late provider wire builder then silently overwrites
`body.model` with `target.wire_model`.

This produces a deceptively correct final HTTP body while model-aware provider compatibility
runs against the stale client model. It also gives the provider wire layer an illegal repair role.

## Required invariant

```text
client request.model
  -> Router request fact only
  -> Router07 opaque hit
  -> Target10 concrete provider selected { provider_id, model_id, wire_model }
  -> SelectedProviderModelBinding (single Rust semantic owner)
  -> Direct request projection OR Relay ProviderReqCompat06
  -> Provider wire validates body.model == selected wire_model
  -> transport
```

1. Virtual Router remains payload-pure. It classifies and selects; it never edits JSON.
2. Target10 freezes the selected provider model truth.
3. The adjacent shared binding block is the only semantic implementation allowed to replace a
   client route model with the selected provider `wire_model`.
4. Direct and Relay call the same binding owner before any provider-specific compatibility or
   transport encoding.
5. Provider wire is a validator, not a repair layer. Missing or mismatched model is an internal
   contract error and must fail-fast.
6. Retry/reselect always binds from the immutable attempt input to the newly selected target; it
   must not reuse the previous attempt's provider model.
7. `model_id` is the canonical configured model key; `wire_model` is the only upstream HTTP model
   value. Client aliases never enter provider wire.
8. Client model observation remains side-channel truth and must not be reconstructed from the
   provider payload.

## Direct and Relay

- Direct: Target10 -> Direct request projection calls the shared binding block -> provider wire
  validates -> transport.
- Relay: Target06/Req07 builds provider semantic protocol payload -> shared binding block ->
  ProviderReqCompat06 consumes the bound model -> ProviderReqOutbound08 validates -> transport.
- Protocol conversion may copy the already-bound model while changing protocol shape; it may not
  select, derive, alias, restore, or replace the provider model.

## Forbidden paths

- `Virtual Router` mutating request JSON.
- Provider runtime deriving model from `request.model`.
- Provider wire silently overwriting a mismatch.
- Provider-specific suffix/prefix rules in Hub/Router (`-anyint`, provider key branches, etc.).
- Direct and Relay implementing separate model-selection rules.
- Compatibility profiles reading the client route alias as provider model truth.

## Failure contract

A provider wire model mismatch is an internal pipeline contract failure at the provider wire
boundary. It is not a provider failure, must not affect provider health, and must not be switched
as if the upstream rejected the model.

## Verification

- Red/green provider-wire negative test: stale client model is rejected, never repaired.
- Direct positive test: client alias differs from selected wire model and provider request contains
  the selected wire model.
- Relay positive tests for Responses/OpenAI Chat/Anthropic/Gemini.
- Retry/reselect test: each attempt uses its own selected wire model.
- Static gate: request-model writes are allowed only in the shared binding owner; provider wire
  must contain equality validation and no `insert("model", target.wire_model)` repair.
- Live provider-request dry-run on 10000, then 5555 old-sample replay after build/install/restart.
