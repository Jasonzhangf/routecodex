# V3 cc Response Compat Semantic Preservation Test Design

## Scope

- Feature: `v3.cc_response_compat_semantic_preservation`
- Providers: `cc`, `cc-sol`
- Profile: `responses:cc`
- Owner: `provider-compat-core` response profile, consumed by V2 NAPI thin adapter and V3 `ProviderRespCompat02ProviderCompat`
- Mainline: `V3ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed`

## Lifecycle

1. Provider response enters with profile `responses:cc`.
2. Compat preserves provider response text and status verbatim.
3. Resp03/Resp04 consume the provider response normally; compat does not fabricate success, remove diagnostics, or create a reasoningStop no-op.

## Positive Tests

- Pure compat: Chinese routing marker and diagnostic template remain in the provider response.
- V2 NAPI adapter: `responses:cc` delegates to the shared pure compat owner.
- V3 node: ProviderRespCompat02 receives and applies `responses:cc`.
- V3 module blackbox: active stopless converts normalized empty stop to exactly one reasoningStop no-op.
- Config: both `cc` and `cc-sol` compile to `responses:cc`.

## Negative Tests

- Normal cc response text remains unchanged.
- A single generic deadlock sentence does not match the full diagnostic template.
- Passthrough profile never applies cc cleanup.
- Disabled stopless keeps an ordinary completed response terminal.
- Provider compat does not directly create tool calls; Resp03 remains the only reasoningStop projection owner.

## Project Blackbox

- Build and install V3.
- Run V3 config check against the live config.
- Managed restart the aggregate V3 server once.
- Verify all configured listener health endpoints.
- Replay the original cc diagnostic response through the live entry when the provider reproduces it; confirm the client receives the original provider diagnostic semantics, not a fabricated empty success.

## Known Gap

- The upstream diagnostic response is provider-controlled and may not reproduce on demand. A captured provider response fixture is required before claiming live reproduction.
