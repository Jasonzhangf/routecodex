# V3 Generic Anthropic Protocol Codec Characterization

## Scope

This slice characterizes the generic Anthropic protocol codec in four independent transformations:

1. Anthropic client input to Hub request semantic.
2. Hub request semantic to Anthropic provider wire payload.
3. Anthropic provider raw response to Hub response semantic.
4. Hub response semantic to Anthropic client projection.

It does not register a Hub hook, wire a Server endpoint, execute provider transport, or implement
Gemini/OpenAI Chat.

## Lifecycle contract

~~~text
V3AnthropicClientInput01Raw
  -> V3AnthropicHubRequest02Semantic
  -> V3AnthropicProviderWire03Payload

V3AnthropicProviderRaw04Response
  -> V3AnthropicHubResponse05Semantic
  -> V3AnthropicClientProjection06Semantic
~~~

The two halves are characterization surfaces, not a second Hub lifecycle. Later H6 hook
registration must call these protocol-owned transformations through the fixed Hub v1 hook slots.

## Positive matrix

- JSON request preserves Anthropic messages, tool_use, tool_result, tools, system blocks, and
  thinking/reasoning fields.
- Responses-to-Anthropic provider-wire request preserves replay-safe tool context while normalizing
  Responses builtin tool declarations (`tool_search`, `web_search`) into Anthropic-safe named tools
  and Anthropic object-shaped `tool_choice`.
- Responses-to-Anthropic provider-wire request groups consecutive Responses `function_call` /
  `custom_tool_call` items into one Anthropic assistant `tool_use` message and the immediately
  following outputs into one user `tool_result` message, so Anthropic sees valid tool-result order.
- SSE response characterization preserves transport intent without materializing or reframing an
  event stream.
- Provider response preserves text, thinking, and tool_use blocks.
- Provider error preserves the Anthropic error envelope as explicit response semantics.

## Negative matrix

- Non-Anthropic entry or provider protocol is rejected.
- Non-object payloads, non-array messages/content, and malformed provider errors are rejected.
- Nameless non-builtin Responses tool declarations are rejected before provider wire instead of
  producing Anthropic `tools[].name = null`.
- Orphan or non-immediate Responses tool outputs are rejected before provider wire instead of
  producing Anthropic `tool_result` blocks that do not directly follow their `tool_use` blocks.
- RouteCodex internal control fields (routecodex_internal, metadata_center, debug_snapshot,
  provider_protocol, resource_handle) are rejected instead of stripped.
- The characterization module cannot register Hub hooks, import Server runtime, branch on provider
  family, or implement Gemini/OpenAI Chat.

## Required gates

- npm run test:v3-anthropic-codec-characterization
- npm run verify:v3-anthropic-codec-characterization
- npm run test:v3-anthropic-codec-characterization-red-fixtures
- npm run verify:v3-module-boundaries
- npm run verify:v3-rust-only
- npm run verify:v3-resource-map
- npm run verify:v3-cargo-fmt
- git diff --check

## Completion boundary

Passing these gates proves only generic Anthropic codec characterization. It does not prove H6 hook
registration, Hub v1 runtime integration, Server exposure, provider transport, live compatibility,
global installation, or production replacement.

## Runtime regression addendum

The live V3 5555 Responses Relay path also has one adjacent runtime regression gate in
`v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`:

- Positive: Anthropic provider SSE (`message_start` -> `content_block_*` -> `message_delta` ->
  `message_stop`) is decoded after provider raw event validation, projected to Responses semantic,
  and only then enters Responses Chat Process / client SSE projection.
- Negative: EOF before `message_stop` fails as provider SSE malformed before any successful
  client projection; malformed tool-use JSON remains fail-fast, not downgraded to text.

This addendum does not change the generic codec scope above; it records the old-sample regression
needed to prove Responses Relay selected Anthropic provider SSE is no longer an unimplemented branch.
