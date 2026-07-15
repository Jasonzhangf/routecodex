# V3 OpenAI Chat Codec Characterization Test Design

## Lifecycle under test

```text
V3OpenAiChatClientInput01Raw
  -> V3OpenAiChatHubRequest02Semantic
  -> V3OpenAiChatProviderWire03Payload

V3OpenAiChatProviderRaw04Response
  -> V3OpenAiChatHubResponse05Semantic
  -> V3OpenAiChatClientProjection06Semantic
```

These are characterization nodes only. They do not register Hub hooks or create a runtime edge.

## White-box matrix

| Case | Expected |
| --- | --- |
| complete request with tool call/result | exact payload preserved |
| multiple tool calls | order and IDs preserved |
| missing/duplicate tool-call ID | explicit error |
| orphan tool result | explicit error |
| JSON choices/tool calls | exact response preserved |
| SSE content/tool delta | one event preserved; no aggregation |
| malformed SSE/provider error | explicit error |
| wrong protocol axis | explicit error |
| side-channel field | explicit leak error |

## Module blackbox

- Public Rust API accepts only OpenAI Chat entry/provider protocols.
- Four stages move payload ownership without reconstructing messages.
- Tests do not import Server or Provider transport.

## Project blackbox impact

- `/v1/chat/completions` stays `not_implemented`.
- No live port, Provider request, hook registration, or continuation state changes.
- Existing Responses Direct and Anthropic Relay behavior stays unchanged.

## Required gates

- focused Rust characterization test;
- source architecture gate;
- forbidden-mutation red fixtures;
- V3 architecture/resource/module/Rust-only gates;
- Cargo fmt and Clippy;
- V3 workspace tests;
- `git diff --check`.

## Known completion boundary

Green characterization proves codec contract only. It does not prove Server exposure, Runtime integration, Provider compatibility, SSE transport behavior, or live OpenAI Chat availability.
