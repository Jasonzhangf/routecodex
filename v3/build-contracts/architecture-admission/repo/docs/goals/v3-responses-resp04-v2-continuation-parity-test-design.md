# V3 Responses Resp04 / V2 Continuation Parity Test Design

## Goal

Align V3 Relay local continuation persistence with the V2 Responses conversation-store contract: a finalized response is continuation-eligible only when it contains a pending tool call. A non-terminal status by itself does not create local continuation truth.

## Lifecycle

```text
ProviderRespCompat02ProviderCompat
  -> V3HubRespChatProcess03Governed validates Responses tool-call identity
  -> V3HubRespContinuation04Committed saves only pending tool-call context
  -> immutable local store interval
  -> V3HubReqChatProcess04Governed restores by current tool-output identity
```

## White-Box Cases

1. `in_progress` or `queued` response with no tool call returns without a Resp04 local-context commit.
2. A genuine `function_call` with a non-empty `call_id` remains continuation-eligible and is committed.
3. A tool-call item missing `call_id` and `id` fails at Resp03 as `MALFORMED_RESPONSE`; Resp04 must not invent or recover an identifier.
4. A completed response without pending tool calls remains terminal and is not committed.
5. The internal stopless call remains keyed by the response id, not the fixed internal call id.

## Black-Box Cases

1. Replaying the 5520 failing Responses request no longer returns `Resp04 local context has no tool call id` when the provider returns a non-tool non-terminal response.
2. A streamed Responses request whose provider tool call omits identity receives `event: error` with the standard top-level Responses error fields `type`, `code`, `message`, `param`, and `sequence_number`; `code=MALFORMED_RESPONSE` and the message explicitly names missing `call_id/id` after the provider pool is exhausted.
3. A valid tool-call response still produces `requires_action`, persists local context, and restores on the following tool-output request.

## Negative Locks

- No empty-id skip, synthetic id, request-history id reuse, or success wrapping.
- No continuation classification in RespOutbound, SSE, handler, or store transport.
- No provider-specific branch in Resp03 or Resp04.
- No local-context commit based only on `requires_action`, `in_progress`, or `queued` status.

## Required Verification

- Focused Rust unit tests for Resp03/Resp04 save eligibility and missing-id Error01-06 projection.
- Focused Server test proving the SSE error event uses the standard Responses top-level error shape rather than a RouteCodex-nested error envelope.
- `npm run test:v3-relay-response-semantics`
- `npm run test:v3-responses-relay-local-continuation-integration`
- `npm run verify:v3-mainline-caller-flow`
- V3 runtime build, global install, managed aggregate restart, and exact 5520 sample replay.
