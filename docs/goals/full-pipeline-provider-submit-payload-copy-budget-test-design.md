# Responses Provider Submit Payload Copy Budget Test Design

## Lifecycle

1. `ProviderReqOutbound06WirePayload` reaches the Responses provider runtime.
2. A native `/v1/responses.submit_tool_outputs` request carries a top-level `response_id` or `responseId` plus the exact submit body fields.
3. `extractSubmitToolOutputsPayload` derives the upstream response-specific endpoint and removes only those two top-level routing fields from the body.
4. The resulting body is request-scoped and releases after the provider transport completes.

## White-Box Positive

- The returned body is a distinct top-level object so deleting routing fields cannot mutate the caller.
- Nested `tool_outputs`, tools, metadata, and arbitrary protocol extension values preserve exact values and object identity because the helper does not mutate them.
- `response_id` and `responseId` are absent from the upstream submit body.

## White-Box Negative

- The helper must not use `JSON.parse(JSON.stringify(record))`, `structuredClone`, or another complete payload deep clone.
- Missing response id or empty `tool_outputs` must still return `null`.
- The helper must not remove, summarize, reorder, or rebuild any field other than the two endpoint-routing ids.

## Module Black-Box

- Existing Responses provider helper tests remain green.
- Both relay and direct provider call sites continue to send the derived body through the existing `sendSubmitToolOutputsRequest` owner.

## Project Black-Box

- No Hub Pipeline, Virtual Router, continuation, MetadataCenter, provider configuration, or client response behavior changes.
- Provider wire semantics remain byte-value equivalent except for the already-required omission of top-level `response_id` and `responseId`.

## Known Gap

- This source test proves removal of one full in-process object-graph clone. It does not prove process RSS improvement; live concurrent replay remains part of the parent goal closeout.
