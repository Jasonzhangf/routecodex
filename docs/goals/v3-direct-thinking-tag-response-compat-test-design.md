# V3 Direct thinking-tag response compatibility test design

## Contract

- Scope is the current `/v1/responses` Direct response only.
- Registered complete Responses Direct hooks apply recognized-marker governance without provider-id or capability guessing. Legacy raw projection retains explicit profile behavior; the managed path disables the earlier thinking rewrite so normalization occurs once after tool harvesting.
- A paired `<thinking>...</thinking>` region becomes a Responses `reasoning` output item whose `summary` contains `summary_text`; it is removed from visible `output_text`.
- A known leading unmatched opener with no complete tools preserves its body as reasoning. With complete tools, partial thinking/text markers are removed while the body stays visible. Unknown-start reasoning stays text. An isolated closing marker removes only the marker and preserves text on both sides.
- Request history, Relay, continuation storage, server handlers, and generic SSE framing are unchanged.

## Lifecycle and owner

The owner is the existing adjacent Direct response projection edge
`V3ProviderResp14Raw -> V3DirectResp14ProviderProjectionPrepared -> V3Resp15ClientPayload`.
JSON is rewritten before `V3Resp15ClientPayload` is built. SSE compatibility is a
registered complete-attempt transducer inside the Direct runtime; it reads the
already buffered current response so tags split across frames can be classified without
guessing or rewriting history.

## Positive tests

1. JSON: a fully paired message becomes one reasoning item.
2. JSON: paired reasoning embedded beside visible text is removed from the message
   and appended as reasoning content.
3. SSE: opening/closing tags split across delta frames still become canonical
   reasoning item/summary events and a matching transformed terminal response.
4. SSE: with complete tools, an unmatched opener is stripped and its body stays visible; without tools, a known leading opener preserves its body as reasoning.

## Negative tests

1. Quoted, code and unknown-start malformed labels remain business text, independent of profile.
2. Ordinary output text without thinking tags remains unchanged under the profile.
3. The transformed SSE contains neither literal `<thinking>` nor
   `</thinking>` and never reports paired reasoning as visible output text.

## Required verification

- Focused runtime red/green tests for JSON and SSE.
- V3 architecture/resource/module gates and Rust workspace tests.
- Global V3 install, one aggregate `routecodex restart`, all configured health
  probes, then a real selected-provider Direct response proving reasoning events are present
  and literal tags are absent.
