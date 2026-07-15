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

## Whitebox matrix

| Case | Positive contract | Negative contract |
| --- | --- | --- |
| JSON thinking + tool | Anthropic input becomes one Responses wire request; reasoning/function call becomes thinking/tool_use after Resp04 | side-channel fields fail before provider send |
| SSE thinking + tool | validated structured frames preserve event order and reach the single Resp05/Server06 exit | malformed/unsupported frames fail explicitly; no handler parser |
| provider 429/5xx | failure enters Error01-06 and retains Anthropic error polarity | failure cannot reach Resp01-06 success nodes |
| topology | all 15 fixed adjacent nodes occur once and in order | shortcut, missing edge, duplicate response exit, dynamic hook, or P6 extension fails source/mutation gates |

## Controlled blackbox

The existing harness starts one loopback Responses upstream and invokes the built Server-owned driver.
Every fixture must capture exactly one real provider request, compare its exact payload, compare the
client projection, and verify the fixed node trace. The stable fixture digest is
`74e56c98d05ced968949acdd5d73a05d2a78330cc58a50cae5445a30f50ff50e`.

The pre-change baseline is `status=wiring_missing` with eight missing adjacent edges. A missing driver,
zero/multiple upstream captures, fixture transformer, fabricated node trace, side-channel leakage, or
provider failure projected as success must remain red.

## Completion boundary

Passing proves only Anthropic Relay controlled Runtime integration through the Server-owned
`/v1/messages` entry, single Hub v1 lifecycle, generic Responses provider transport, and controlled
upstream. It does not prove live 5555, continuation E2E, P6 deletion, global installation, restart,
release, real-provider compatibility, or production cutover.
