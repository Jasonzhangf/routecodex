# V3 Direct thinking-tag response compatibility test design

## Contract

- Scope is the current `/v1/responses` Direct response only.
- Activation is explicit compatibility profile `responses:thinking-tags`, never provider-id matching.
- A paired `<thinking>...</thinking>` region becomes a Responses `reasoning` output item whose `summary` contains `summary_text`; it is removed from visible `output_text`.
- An unmatched opening or closing thinking tag is removed while its surrounding text remains visible.
- Request history, Relay, continuation storage, server handlers, and generic SSE framing are unchanged.

## Lifecycle and owner

The owner is the existing adjacent Direct response projection edge
`V3ProviderResp14Raw -> V3DirectResp14ProviderProjectionPrepared -> V3Resp15ClientPayload`.
JSON is rewritten before `V3Resp15ClientPayload` is built. SSE compatibility is a
per-response transducer inside the Direct runtime; it buffers only the profiled
current response so tags split across provider frames can be classified without
guessing or rewriting history.

## Positive tests

1. JSON: a fully paired message becomes one reasoning item.
2. JSON: paired reasoning embedded beside visible text is removed from the message
   and appended as reasoning content.
3. SSE: opening/closing tags split across delta frames still become canonical
   reasoning item/summary events and a matching transformed terminal response.
4. SSE: an unmatched opening tag is stripped and the following text stays visible.

## Negative tests

1. The same JSON/SSE without the profile remains unchanged.
2. Ordinary output text without thinking tags remains unchanged under the profile.
3. The transformed SSE contains neither literal `<thinking>` nor
   `</thinking>` and never reports paired reasoning as visible output text.

## Required verification

- Focused runtime red/green tests for JSON and SSE.
- V3 architecture/resource/module gates and Rust workspace tests.
- Global V3 install, one aggregate `routecodex restart`, all configured health
  probes, then a real cc-sol Direct response proving reasoning events are present
  and literal tags are absent.
