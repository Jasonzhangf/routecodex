# V3 cc Response Compat ReasoningStop No-op Test Design

## Scope

- Feature: `v3.cc_response_compat_reasoningstop_noop`
- Providers: `cc`, `cc-sol`
- Profile: `responses:cc`
- Owner: `provider-compat-core` response profile, consumed by V2 NAPI thin adapter and V3 `ProviderRespCompat02ProviderCompat`
- Mainline: `V3ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed`

## Lifecycle

1. Provider response enters with profile `responses:cc`.
2. Compat detects the known diagnostic template in response text.
3. Compat removes the diagnostic payload and emits an empty `completed` response with `finish_reason=stop`.
4. Resp03 stopless governance, when active, projects the existing no-input `routecodex hook run reasoningStop` no-op.
5. Resp04 stores the governed non-terminal continuation.

## Positive Tests

- Pure compat: Chinese routing marker normalizes to empty natural stop.
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
- Replay the original cc diagnostic response through the 5555 entry when the provider reproduces it; confirm client receives the reasoningStop no-op without diagnostic text.

## Known Gap

- The upstream diagnostic response is provider-controlled and may not reproduce on demand. Without a captured provider response replay at the live entry, source and controlled runtime evidence do not prove the current upstream will emit the same template.
