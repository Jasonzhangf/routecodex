# V3 Direct protocol-aware precommit SSE failure test design

Design ID: `CCSOL-SSE-PRECOMMIT-EMPTY-20260816-01`

## Lifecycle under test

`V3ProviderResp14Raw` may contain HTTP 2xx SSE lifecycle frames before any client-visible business output. The Direct protocol codec must pass its already-decided provider wire protocol into one protocol-aware precommit classifier. Only a replay-unsafe business frame for that protocol may authorize `V3DirectResp15ClientPayloadReady`. Error, malformed/empty terminal, timeout, or EOF while only lifecycle frames have arrived must remain precommit and enter Error01→05 so the existing retry/reselection state machine can act.

## White-box contracts

- Responses `response.created`, `response.in_progress`, and empty in-progress message/reasoning items remain precommit; a real output/tool frame authorizes client commit. `reasoning_text`/`summary_text` content and non-empty encrypted reasoning are registered business output, including in `response.output_item.done` and terminal `response.completed` snapshots.
- Responses `response.completed` with `output=[]` or no `output` is an empty terminal: it raises Error01 `provider_response_sse_empty` before Resp15 and is consumed by the existing retry/reselect chain.
- Anthropic `message_start` remains precommit, `content_block_delta`/non-empty content blocks authorize client commit, and `message_stop` without earlier business output is an empty terminal.
- OpenAI Chat role-only/empty deltas remain precommit, content/reasoning/tool deltas authorize client commit, and a finish-only chunk without earlier business output is an empty terminal.
- Protocol selection is an explicit argument. A frame belonging to another protocol fails classification; no JSON shape auto-detection or second classification pass is allowed.
- Each protocol maps its own provider error event to typed `Failure`; keepalive and `[DONE]` frames remain non-semantic.
- Error, malformed/empty terminal, and EOF after lifecycle-only frames return provider Error01 before Resp15.

## Module black box

The Direct runtime kernel receives three transient attempts whose provider streams contain an empty lifecycle frame followed by `response.failed`, then a successful alternative provider. Expected behavior is three same-provider attempts, one typed provider failure report, `V3TargetLocalReselected`, and second-provider success. No retry logic is added to the codec or server.

## Project black box and online verification

- Healthy cc-sol SSE still produces incremental output and `response.completed`.
- The captured 2026-08-19 05:34 opencode-go Direct stream with a `reasoning_text` item must finish normally; it must not become `provider_response_sse_event_invalid` or a terminal 502 after partial output.
- The captured session `01a01316-a601-7e62-a8d5-1ee3699e6264` 05:58 and 06:00 empty-completed 200 responses must be rejected before Resp15 instead of producing a client-visible task-complete with no item.
- A controlled old failure shape must log provider-error and switch before any failed-attempt Resp15 client commit.
- Final client response must come from the replacement provider or, only after candidate exhaustion, Error06 502.

## Paired risks

- Positive tests prevent empty/error SSE and foreign-protocol frames from being silently committed.
- Reverse tests prove the first genuine Responses, Anthropic, and OpenAI Chat output/tool frame still commits without materializing the stream.
- Existing post-business-output failure tests continue to require explicit post-commit 502 without transparent reselection, preventing duplicate mixed-provider output.
