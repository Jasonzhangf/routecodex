# V3 Direct protocol-aware precommit SSE failure test design

Design ID: `CCSOL-SSE-PRECOMMIT-EMPTY-20260816-01`

## Lifecycle under test

`V3ProviderResp14Raw` may contain HTTP 2xx SSE lifecycle frames before any client-visible business output. The Direct runtime must buffer the complete provider attempt until a protocol-valid terminal event. Error, malformed/empty terminal, timeout, or EOF before terminal must remain precommit and enter Error01→05 so the existing retry/reselection state machine can act.

## White-box contracts

- Responses `response.created`, `response.in_progress`, output items, reasoning, tool calls, and deltas remain in the runtime-owned attempt buffer; only a complete protocol-valid terminal event authorizes client commit.
- Responses `response.completed` with `output=[]` or no `output` is an empty terminal: it raises Error01 `provider_response_sse_empty` before Resp15 and is consumed by the existing retry/reselect chain.
- Anthropic `message_start`, content blocks, and deltas remain buffered until a valid `message_stop` terminal.
- OpenAI Chat role-only/empty deltas, content/reasoning/tool deltas, and finish chunks remain buffered until the protocol terminal is validated.
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
- The failed attempt's buffered frames must never be concatenated with the replacement attempt.
- Final client response must come from the complete replacement provider or, only after candidate exhaustion, Error06 502; no partial provider bytes may reach the client.

## Paired risks

- Positive tests prevent empty/error SSE and foreign-protocol frames from being silently committed.
- Reverse tests prove complete terminal Responses, Anthropic, and OpenAI Chat attempts commit with byte-stable buffered projection.
- Failure tests prove a network error after arbitrary buffered business frames still reselects before client semantic commit; no post-business-output reroute is allowed after the client has actually received bytes.
