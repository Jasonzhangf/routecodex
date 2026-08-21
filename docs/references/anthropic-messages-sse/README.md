# Anthropic Messages API SSE

Snapshot date: 2026-08-20

Scope: Anthropic Messages API streaming response wire contract (`POST /v1/messages` with `stream: true`). This is the API-specific SSE contract, not the generic W3C/WHATWG SSE transport specification and not Anthropic Managed Agents event streaming.

## Canonical stream lifecycle

```text
message_start
  (content_block_start -> content_block_delta* -> content_block_stop)*
message_delta+
message_stop
```

`ping` may appear anywhere between normal events. `error` may appear mid-stream. Unknown event types must be tolerated according to Anthropic versioning guidance.

Every SSE record has an SSE event name and JSON `data`; the JSON `type` matches the event name.

## Event contract

| SSE event | Required/important fields | Meaning |
|---|---|---|
| `message_start` | `message` (`id`, `type`, `role`, `content`, `model`, `stop_reason`, `stop_sequence`, `usage`) | Starts response; `content` is empty; `stop_reason` normally null. |
| `content_block_start` | `index`, `content_block` | Opens one final-message content block. `index` is its final content-array index. |
| `content_block_delta` | `index`, `delta` | Incremental update for open block. |
| `content_block_stop` | `index` | Closes open block. |
| `message_delta` | `delta`, optional `usage` | Top-level message changes, chiefly stop reason/sequence and cumulative usage. |
| `message_stop` | none beyond `type` | Terminates normal stream. |
| `ping` | none beyond `type` | Keepalive/stream signal. |
| `error` | `error` (`type`, `message`) | In-band stream error; do not treat HTTP 200 as success if this event arrives. |

## Delta variants

`content_block_delta.delta.type` currently includes:

- `text_delta`: append `text` to a text block.
- `input_json_delta`: append `partial_json` to a `tool_use` input buffer; parse only after block close or use an incremental parser. Final `tool_use.input` is an object.
- `thinking_delta`: append `thinking` to a thinking block.
- `signature_delta`: append/record `signature` immediately before thinking block close.
- Citation and other feature-specific delta variants exist in the SDK type snapshot; dispatch by discriminated `type`, not by a fixed exhaustive list.

## Parser invariants

1. Preserve event order and block `index`; do not reorder blocks by arrival time.
2. Accumulate each block independently.
3. `message_delta.usage` is cumulative for the stream; replace the prior usage total rather than add it.
4. `message_start` must precede all content/message deltas; `message_stop` closes the stream.
5. `input_json_delta.partial_json` is a byte/string fragment, not a standalone JSON value.
6. `error` is a terminal failure signal for the current stream even when HTTP status was 200.
7. Accept unknown future event/delta types without corrupting known blocks; retain or expose them for observability.

## Local source snapshots

- `typescript-messages.ts`: official `anthropics/anthropic-sdk-typescript` current `messages.ts`; includes `RawMessageStreamEvent`, all current raw event and delta unions, aliases, and message shapes.
- `python-raw-message-stream-event.py`: official Python SDK discriminated union entrypoint.
- `python-raw-*-event.py`: official Python SDK event component types.
- `python-stream-accumulator.py`: official Python SDK accumulation/order behavior, including cumulative usage replacement and event-order checks.

The official rendered page was searched at [Claude Platform Docs — Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming). Shell TLS retrieval of that rendered HTML timed out in this environment, so the local machine-readable snapshots are the SDK sources above; the URL remains the canonical prose source.

## Sources

- Official prose: <https://platform.claude.com/docs/en/build-with-claude/streaming>
- Official TypeScript SDK: <https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts>
- Official Python SDK event union: <https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/raw_message_stream_event.py>
- Official Python accumulator: <https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/lib/streaming/_messages.py>

This directory is reference material. It does not define a new RouteCodex pipeline contract and must not be used to move control metadata into normal payloads.
