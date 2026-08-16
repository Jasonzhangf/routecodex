# V3 Responses Direct precommit SSE failure test design

Design ID: `CCSOL-SSE-PRECOMMIT-EMPTY-20260816-01`

## Lifecycle under test

`V3ProviderResp14Raw` may contain HTTP 2xx SSE lifecycle frames before any client-visible business output. Only a replay-unsafe business frame may authorize `V3DirectResp15ClientPayloadReady`. Error, malformed terminal, timeout, or EOF while only empty lifecycle frames have arrived must remain precommit and enter Error01→05 so the existing retry/reselection state machine can act.

## White-box contracts

- `response.created` and `response.in_progress` remain precommit.
- Empty in-progress message/reasoning `response.output_item.added` remains precommit.
- Non-empty message items and tool-call items remain stream-commit authority.
- Error and EOF after empty lifecycle frames return provider Error01 before Resp15.
- A real output delta still starts Direct streaming before provider EOF.

## Module black box

The Direct runtime kernel receives three transient attempts whose provider streams contain an empty lifecycle frame followed by `response.failed`, then a successful alternative provider. Expected behavior is three same-provider attempts, one typed provider failure report, `V3TargetLocalReselected`, and second-provider success. No retry logic is added to the codec or server.

## Project black box and online verification

- Healthy cc-sol SSE still produces incremental output and `response.completed`.
- A controlled old failure shape must log provider-error and switch before any failed-attempt Resp15 client commit.
- Final client response must come from the replacement provider or, only after candidate exhaustion, Error06 502.

## Paired risks

- Positive tests prevent empty/error SSE from being silently committed.
- Reverse tests prevent buffering genuine output/tool semantics or materializing the entire stream.
- Existing post-business-output failure tests continue to require explicit post-commit 502 without transparent reselection, preventing duplicate mixed-provider output.
