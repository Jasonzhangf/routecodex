# V3 Stopless Client ID And Continuation Routing Test Design

## Scope

This change locks two adjacent runtime contracts without changing continuation ownership or tool-output validation:

1. `V3HubRespChatProcess03Governed` projects every internal Stopless CLI call to the stable client call id `call_stopless_reasoning` before JSON/SSE reaches the client, while StoplessCenter retains the provider-native call id for Direct remote continuation.
2. `V3Execution11ProtocolDecision` selects same-protocol Direct only for a selected GPT-family Responses model. Non-GPT Responses targets use Relay. Existing direct/local `previous_response_id` ownership remains decided at Req03 by the continuation stores.

## Lifecycle

```text
provider-native reasoningStop/Stopless CLI call
  -> Resp03 classify and save provider-native call id
  -> client JSON/SSE projection uses call_stopless_reasoning
  -> client returns matching function_call_output
  -> Req04 consumes the stable internal pair
  -> Direct remote continuation reprojects output to the saved provider-native call id
```

```text
Req04 request + selected target
  -> Target10 contains canonical model_id/wire_model
  -> Execution11 checks entry/provider protocol and model family identity
  -> Responses + GPT => SameProtocolDirect
  -> Responses + non-GPT => HubRelay
  -> explicit previous_response_id owner resolution remains outside this decision
```

## White-Box Tests

- Positive: GPT-family Responses target selects `SameProtocolDirect`.
- Negative: non-GPT Responses target selects `HubRelay` even though provider protocol is Responses.
- Positive: provider-native random Stopless CLI call id is retained in StoplessCenter and mapped back for Direct continuation.
- Negative: ordinary `exec_command` calls that do not execute `routecodex hook run reasoningStop` retain their original call id.
- Positive: a historical random Stopless call/output pair is removed together before normal tool validation.
- Negative: a genuine unrelated orphan tool output remains an explicit `OrphanToolOutput` error.

## Module Black-Box Tests

- Direct JSON response with a provider-native random Stopless CLI call exposes only `call_stopless_reasoning` to the client.
- Direct SSE `response.output_item.added/done` and terminal response expose only `call_stopless_reasoning`.
- A second Direct turn sends the provider-native call id upstream, never the client bridge id.
- Relay request governance accepts the previously emitted random internal pair without dropping unrelated tool history.

## Project Black-Box And Live Replay

- Replay the saved OneStop request shape containing `call_Kodtle5SUr81pLSprAzvcj59`; it must no longer return `orphan tool output`.
- Send a real streaming `/v1/responses` Stopless turn and inspect the client event stream for the stable call id.
- Dry-run or controlled routing probes must show GPT Responses Direct and non-GPT Responses Relay.

## Known Boundaries

- This does not weaken normal orphan validation.
- This does not infer continuation ownership from capability flags.
- This does not move Stopless or continuation semantics into SSE transport; SSE only applies the Resp03 projection decision to each client frame.
- This does not route an unknown or mismatched continuation to another owner.
