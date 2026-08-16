# V3 Gemini Codec Characterization Test Design

## Lifecycle under test

```text
V3GeminiClientInput01Raw
  -> V3GeminiHubRequest02Semantic
  -> V3GeminiProviderWire03Payload

V3GeminiProviderRaw04Response
  -> V3GeminiHubResponse05Semantic
  -> V3GeminiClientProjection06Semantic
```

These are characterization nodes only. They do not register Hub hooks, change Server endpoint status, or create a runtime edge.

## White-box matrix

| Case | Expected |
| --- | --- |
| complete request with contents/tools/function response | exact payload preserved |
| matching `functionCall.name` and `functionResponse.name` | exact payload preserved |
| missing or orphan function response name | explicit error |
| JSON candidates/function calls/usage metadata | exact response preserved |
| SSE candidate chunk | one event preserved; no aggregation |
| malformed provider error | explicit error |
| wrong protocol axis | explicit error |
| side-channel field | explicit leak error |

## Module blackbox

- Public Rust API accepts only Gemini entry/provider protocols.
- Four stages move payload ownership without reconstructing contents.
- Tests do not import Server or Provider transport.

## Project blackbox impact

- `/v1beta/models/:model/generateContent` stays `pending_not_implemented`.
- No live port, Provider request, hook registration, or continuation state changes.
- Existing Responses Direct, Anthropic Relay, and OpenAI Chat behavior stays unchanged.

## Required gates

- focused Rust characterization test;
- source architecture gate;
- forbidden-mutation red fixtures;
- V3 architecture/resource/module/Rust-only gates;
- Cargo fmt;
- `git diff --check`.

## Known completion boundary

Green characterization proves codec contract only. It does not prove Server exposure, Runtime integration, Provider compatibility, SSE transport behavior, or live Gemini availability.
