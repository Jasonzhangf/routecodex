# V3 Anthropic Relay Runtime Integration Test Design

## Lifecycle under test

```text
Server /v1/messages
  -> V3HubReqInbound01ClientRaw .. V3ProviderReqOutbound09TransportRequest
  -> controlled Responses upstream (exactly one request)
  -> V3ProviderRespInbound01Raw .. V3ServerRespOutbound06ClientFrame
```

The Runtime is the only lifecycle. Anthropic request/response differences are owned by the entry/exit
codec. The Hub request/response Chat Process remains provider-neutral. The Responses provider owns
HTTP and consumes the shared structured SSE Transport contract.

The machine-readable lifecycle is
`docs/architecture/manifests/v3.anthropic_relay.controlled_runtime.mainline.yml`. Its node and
`v3-anthropic-relay-01..03` and `v3-anthropic-relay-05..16` edge IDs must remain identical to the
mainline call map and wiki.

## Whitebox matrix

| Case | Positive contract | Negative contract |
| --- | --- | --- |
| JSON thinking + tool | Anthropic input becomes one Responses wire request; reasoning/function call becomes thinking/tool_use after Resp03 | side-channel fields fail before provider send |
| SSE thinking + tool | validated structured frames preserve event order and reach the single Resp05/Server06 exit | malformed/unsupported frames fail explicitly; no handler parser |
| Responses SSE terminal | raw SSE chunks enter `V3ProviderRespInbound01Raw`; `ProviderRespCompat02` invokes the canonical collector before `V3HubRespInbound02Normalized`, and Anthropic projection occurs only after Resp03 | EOF/`[DONE]` without a terminal response enters Error01-06; no partial success synthesis, pre-Resp01 semantic materialization, or second parser |
| Anthropic provider thinking SSE | `thinking/thinking_delta/signature_delta` and `redacted_thinking/data` normalize to Responses reasoning summary/encrypted_content | `reasoning` aliases, native+alias dual truth, cross-block delta types, `thinking_delta.text`, `redacted_thinking.signature`, and malformed signature fail in the provider event codec |
| provider 429/5xx | failure enters Error01-06 and retains Anthropic error polarity | failure cannot reach Resp01-06 success nodes |
| topology | the manifest keeps all 15 fixed Hub edges and their declared call-map bindings; runtime consumers verify actual lifecycle and response exit | missing or changed manifest edges/callees fail data mutations; request/response regressions fail real consumers |
| client payload ownership | Resp03-governed truth is projected once into Resp05 and returned only from ServerResp06 | runtime closures cannot return a payload that bypasses Resp05/ServerResp06 |

The Rust integration test runs through the existing V3 workspace consumer entry. The reduced
`verify:v3-anthropic-relay-runtime-integration` checks only the mainline manifest and call-map data.
Its three manifest/call-map mutations run in `v3/scripts/verify-red.mjs`. Runtime function spellings,
private struct literals, trace strings and prose digests are not admission checks.

## Controlled blackbox

The existing harness starts one loopback Responses upstream and invokes the built Server-owned driver.
Every fixture must capture exactly one real provider request, compare its payload, compare the
client projection, and verify the fixed node trace. Fixture identity digests are not required.

The pre-change baseline is `status=wiring_missing` with ten missing adjacent edges. A missing driver,
zero/multiple upstream captures, fixture transformer, fabricated node trace, side-channel leakage, or
provider failure projected as success must remain red.

## Completion boundary

Passing proves only Anthropic Relay controlled Runtime integration through the Server-owned
`/v1/messages` entry, single Hub v1 lifecycle, generic Responses provider transport, and controlled
upstream. It does not prove live 5555, P6 deletion, global installation, restart, release,
real-provider compatibility, or production cutover.
