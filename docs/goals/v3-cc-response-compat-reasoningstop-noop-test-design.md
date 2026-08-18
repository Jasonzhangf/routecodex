# V3 cc Response Compat Semantic Preservation Test Design

## Scope

- Feature: `v3.cc_response_compat_semantic_preservation`
- Providers: `cc`, `cc-sol`, and the `chat:minimax` response family
- Profiles: `responses:cc` and `chat:minimax`
- Owner: `provider-compat-core` response profile, consumed by V2 NAPI thin adapter and V3 `ProviderRespCompat02ProviderCompat`
- Mainline: `V3ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed`

## Lifecycle

1. Provider response enters with its configured compatibility profile.
2. `responses:cc` preserves provider response text and status verbatim; it never fabricates an empty completed response.
3. `chat:minimax` converts paired `<thinking>...</thinking>` text into a Responses reasoning item with `content` only (`reasoning_text`), preserving continuation round-trip; unmatched delimiters remain unchanged.
4. Resp03/Resp04 consume the resulting response normally; compat does not create a reasoningStop no-op.

## Positive Tests

- Pure compat: Chinese routing marker and diagnostic template remain in the `responses:cc` provider response.
- Pure compat: paired Minimax thinking tags leave no literal tag in visible output and produce a content-only reasoning item.
- V2 NAPI adapter: `responses:cc` delegates to the shared pure compat owner.
- V3 node: ProviderRespCompat02 receives and applies `responses:cc`.
- V3 module blackbox: a reasoning item with `content` only encodes to Anthropic `thinking` and can be restored on continuation.
- Config: both `cc` and `cc-sol` compile to `responses:cc`.

## Negative Tests

- Normal cc response text remains unchanged.
- A single generic deadlock sentence does not match the full diagnostic template.
- Passthrough profile never applies cc cleanup.
- Unmatched opening and closing thinking delimiters are preserved rather than silently deleted.
- Provider compat does not directly create tool calls or stopless transitions.

## Project Blackbox

- Build and install V3.
- Run V3 config check against the live config.
- Managed restart the aggregate V3 server once.
- Verify all configured listener health endpoints.
- Replay the original cc diagnostic response through the live entry when the provider reproduces it; confirm the client receives the original provider diagnostic semantics, not a fabricated empty success.

## Known Gap

- The upstream diagnostic response is provider-controlled and may not reproduce on demand. A captured provider response fixture is required before claiming live reproduction.
