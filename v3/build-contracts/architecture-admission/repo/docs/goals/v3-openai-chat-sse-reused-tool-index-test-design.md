# V3 OpenAI Chat SSE Reused Tool Index Test Design

## Goal

Preserve every provider-emitted OpenAI Chat streaming tool call when an upstream reuses one wire
`tool_calls[].index` for a later call with a different non-empty `id`. The provider-event codec must
materialize distinct calls in first-seen order and keep each call's argument delta stream separate.

## Proven Failure

- Source response sample: `652829-7346` on port `5555`.
- The provider emitted `call_fd43749791dd443095a00a6f` at wire index `0`, then emitted
  `call_0048c92a53454527a6b3a264` at the same wire index `0`, followed by a third call at index `1`.
- `V3OpenAiChatStreamChoice.tool_calls` used the wire index as the materialized-call identity and
  concatenated the first two argument streams into `{"cmd":...}{"cmd":...}`.
- The malformed call entered client history. Request sample `653138-7655` then sent that history to
  `minimax_openai`, which rejected it with HTTP 400 / code 2013: `invalid function arguments json
  string`.

## Unique Owner

- Feature: `v3.hub_relay_runtime_closeout`.
- Node edge: `V3ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat`.
- Runtime owner: OpenAI Chat provider-event codec in
  `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`.
- Forbidden locations: request cleanup, Req04 history governance, Virtual Router, Target, provider
  error projection, client SSE framing, and provider-specific branches.

## Lifecycle

1. Decode OpenAI Chat SSE frames without changing payload data.
2. Track both the active materialized call for each provider wire index and previously seen
   non-empty provider call ids within that wire-index stream.
3. Continue appending deltas when the incoming id is absent or matches the active call id.
4. When a different, previously unseen non-empty id arrives for an occupied wire index, append a new
   materialized call and retarget that wire index to the new call.
5. When a previously seen id reappears after the wire index was reused, retarget the wire index to
   the existing materialized call and continue its argument stream without duplicating the id.
6. Emit calls in first-seen order with their original ids, names, kinds, and complete argument
   strings.
7. Preserve duplicate ids emitted on different wire indices as distinct inbound calls so Resp03,
   the existing tool-identity governance owner, can reject them explicitly.

## Positive Tests

- Two different ids emitted at wire index `0`, followed by a third id at wire index `1`, materialize
  as three calls in encounter order.
- Every materialized argument string parses independently as JSON and retains its original command.
- The exact old provider SSE sample or an exact-shape replay no longer produces `}{` concatenation.

## Reverse Tests

- Repeating the same non-empty id at one wire index remains one call and continues its argument
  stream.
- A sequence `id=A`, `id=B`, `id=A` on one wire index materializes only two calls and rejoins both
  `A` argument fragments into the original call.
- The same non-empty id on two different wire indices remains two calls with independent arguments;
  Resp01 must not merge it into a successful response before Resp03 duplicate-id validation.
- Interleaved ordinary parallel calls at distinct wire indices remain distinct without duplication.
- An id-less continuation delta attaches to the active call for its wire index.
- Missing id/name or malformed terminal streams remain fail-fast under the existing codec contract.

## Verification

- Focused red/green unit tests in `responses_relay_runtime::tests`.
- `npm run test:v3-hub-relay-runtime-closeout`.
- `npm run test:v3-openai-chat-stream-tool-call-identity`.
- `npm run verify:v3-hub-relay-runtime-closeout`.
- V3 architecture/resource/map gates and `git diff --check`.
- `.github/workflows/test.yml` runs `npm run test:v3-openai-chat-stream-tool-call-identity` before the V3
  file-size ratchet, so the focused library regressions are part of CI rather than a manual gate.
- `RUSTUP_TOOLCHAIN=stable npm run install:v3`, then `rccv3 config check -c
  /Volumes/extension/.rcc/config.v3.toml` and `rccv3 restart -c
  /Volumes/extension/.rcc/config.v3.toml` for the native V3 aggregate.
- Verify the installed V3 process identity and every configured member port health before exact
  old-shape live or no-network replay proving all emitted tool-call arguments are valid JSON.
