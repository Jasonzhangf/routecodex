# V3 OpenAI Chat Relay Runtime Integration Test Design

## Lifecycle

The controlled lifecycle is fixed:

/v1/chat/completions -> Hub Req01-Req09 -> OpenAI Chat provider wire -> Hub Resp01-Resp06 -> client.

OpenAI Chat protocol interpretation belongs to the existing native codec. Runtime owns only
adjacent-node orchestration, routing, transport invocation, Error01-06, and the single response
exit. Responses Direct, Anthropic continuation, WebSocket transport, live config, install, and
restart are outside this slice.

## Red baseline

Before the governance projection was added, the focused JSON Runtime test reached the existing Hub
response hooks and failed with V3HubRelayResponseError::MissingStatus: raw OpenAI Chat JSON has
choices[].finish_reason, while the protocol-neutral Hub governance contract consumes canonical
status/output. This proved the missing owner boundary without adding an OpenAI-specific branch to
Hub hooks.

## Whitebox

- JSON preserves messages, tools, prior tool-call/result identity, client metadata, usage, and
  finish reason while changing only the selected wire model.
- SSE accepts arbitrarily split chunks, validates each Chat chunk, preserves tool delta and
  terminal order, and emits one DONE marker. A controlled channel keeps terminal pending while the
  first client frame is consumed, proving the Runtime does not materialize the full stream.
- Provider HTTP failure enters the typed Error01-06 chain and never reaches Resp01.
- Internal metadata/debug/resource/continuation fields fail before provider transport.
- Both JSON and SSE traverse exactly one Req01-Req09 and Resp01-Resp06 chain.

## Module and project blackbox

- Controlled transport captures one real provider request and returns JSON/SSE/error fixtures.
- The Server-owned /v1/chat/completions wrapper calls only the Runtime owner. A loopback HTTP
  upstream validates the exact URL, wire model, auth, JSON projection, SSE first-frame timing,
  provider 429 Error01-06, and zero upstream capture for rejected side-channel input.
- Source and mutation gates reject fabricated traces, fallback, Responses Direct re-entry, dynamic
  hooks, JSON payload round-trips, full raw SSE materialization, side-channel leakage, and a second
  Runtime kernel.

## Positive and negative locks

- Positive: JSON and SSE complete the single request/response lifecycle; SSE first frame remains
  observable while provider terminal is still delayed.
- Negative: 429 never enters Resp01; `[DONE]` before terminal fails; stream end without terminal
  fails; `metadata_center` never reaches provider transport.

## Known boundary

This controlled slice does not prove live provider compatibility, production cutover, install,
restart, or any 5555/5520 behavior.
