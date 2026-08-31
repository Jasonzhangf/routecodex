# V3 GLM Anthropic request outbound compatibility regression

## Objective

Restore the GLM route through the canonical protocol chain while preserving every provider-supported Anthropic request field.

## Owning boundary

- Pipeline node: `ProviderReqCompat06ProviderCompat`
- Adjacent input: `V3HubReqOutbound07ProviderSemantic`
- Adjacent output: `V3ProviderReqOutbound08WirePayload`
- Standard protocol codec: `request_outbound_format.rs` plus `anthropic_codec.rs`
- Provider profile owner: `provider-compat-core`
- Config selection owner: `fwd.v3.glm-5.2` selects `glmrelay_anthropic`
- Forbidden: GLM-specific changes in the Responses-to-Chat normalization, generic Anthropic codec, response inbound/outbound, handler/SSE, or Virtual Router
- Owner feature: `v3.provider_compat_profile_loading`
- Module: `v3-provider-compat-profile-loading`
- Typed side-channel resource: `v3.provider_compat.profile_application`
- Mainline edge: `v3-provider-compat-request-01`

## Verified provider contract

- GLM Anthropic accepts standard `thinking.type` values `adaptive`, `enabled`, and `disabled`, `budget_tokens`, `display=omitted|summarized`, and `output_config.effort`.
- GLM Anthropic accepts the standard hosted declaration `web_search_20250305` and ordinary Anthropic custom tools. The hosted declaration returns a normal Anthropic `tool_use` named `web_search`.
- The probed reasoning responses contained ordinary Anthropic `text` blocks for both adaptive and enabled thinking. Request compat must not fabricate a provider reasoning block that the provider did not return.
- The captured failure was emitted by the GLM OpenAI endpoint after the wrong protocol path generated top-level `web_search_options`; it is not evidence that the standard Anthropic request is invalid.

## Mapping contract

1. Responses input first normalizes to governed Chat canonical semantics.
2. Chat request outbound uses the generic Anthropic codec to produce standard Anthropic Messages wire: `reasoning_effort`/summary become `thinking` plus `output_config`, and web search becomes `web_search_20250305`.
3. Only after that standard codec does `ProviderReqCompat06ProviderCompat` apply `chat:glm` to the selected GLM Anthropic target.
4. Because every probed standard Anthropic reasoning/tool field is accepted, the GLM Anthropic profile preserves the standard payload byte semantics and records the profile as applied. Provider-specific mutation is added only when a probe proves it necessary.
5. `fwd.v3.glm-5.2` must not select `glmrelay_openai`; otherwise the request bypasses the canonical Anthropic mapping and recreates the HTTP-200 diagnostic.
6. Existing explicitly OpenAI-protocol GLM providers retain their OpenAI compatibility behavior; they are outside this forwarder's canonical path.

## Test design

### White-box positive

- A full Responses-entry request selected to `glmrelay_anthropic/glm-5.2` reaches standard Anthropic wire before provider compat.
- The final payload contains Anthropic messages, `thinking.type=adaptive`, `output_config.effort=high`, standard hosted `web_search_20250305`, and ordinary Anthropic tool declarations; it contains no OpenAI `reasoning_effort` or `web_search_options`.
- The provider-compat core records `chat:glm` as applied for `anthropic-messages` while preserving the probed-valid standard payload.

### White-box negative

- The generic Anthropic codec remains provider-agnostic and contains no GLM branch.
- A request without `chat:glm` remains standard Anthropic passthrough.
- Existing explicitly OpenAI-protocol GLM providers retain their registered OpenAI profile behavior.
- No response compat invents thinking/reasoning content for GLM Anthropic text responses.

### Runtime black-box

- After install and one aggregate restart, replay the captured request with the GLM forwarder pinned to its Anthropic target.
- Assert the selected target URL is `/v1/messages`, the final provider body has only standard Anthropic request fields, and the provider returns non-diagnostic output with non-zero usage or a real tool call.
- Assert the forwarder has no `glmrelay_openai` target and a provider-request dry-run cannot produce `/v1/chat/completions` for `fwd.v3.glm-5.2`.

## Required gates

- `npm run test:v3-glm-anthropic-request-outbound-compat`
- `npm run verify:v3-provider-compat-module-boundary`
- `npm run test:v3-provider-compat-module-boundary-red-fixtures`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-resource-map`
- `npm run build:v3-cli`

## Runtime verification — 2026-08-19

- Installed direct V3 binary: `0.90.4601`, SHA-256 `0bf4e3b62eb04a4c23203c36a9bb14ed3df6c6eefba9a84447af1d169b4f6834`; repository and global binary hashes matched.
- One aggregate restart resolved the single managed instance containing ports 10000, 7777, and 4444; every `/health` response reported `status=ok` and `build_version=0.90.4601`.
- A 7777 provider-request dry-run with `model=glm-5.2` selected `glmrelay_anthropic`, used `POST https://glm-relayapi.top/v1/messages?beta=true`, preserved standard Anthropic `thinking.type=adaptive`, `output_config.effort=high`, `web_search_20250305`, and custom `input_schema`, and contained no Responses/OpenAI or typed compat evidence fields.
- Canonical live sample: `/Users/fanzhang/.rcc/codex-samples/openai-responses/ports/7777/openai-responses-router-glm-5.2-20260819T023703851-871975-826/`. It selected `pool:thinking → fwd.v3.glm-5.2 → glmrelay_anthropic`, completed with provider status 200, ordinary client `output_text`, and usage `input_tokens=897`, `output_tokens=323`. The first upstream attempt returned a transient plain-text content-type failure and the registered same-provider retry completed; neither attempt returned HTTP 400.
