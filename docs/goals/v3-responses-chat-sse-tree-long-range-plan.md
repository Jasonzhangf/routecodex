# V3 Responses / OpenAI Chat SSE tree long-range implementation plan

Status: active implementation plan; completion is forbidden until every gate
below has current evidence.

Canonical design: `docs/goals/v3-responses-chat-sse-tree-design.md`.

Anthropic follow-on reference: Anthropic Messages SSE has been downloaded at
`docs/references/anthropic-messages-sse/`. Its tree must model
`message_start`, independently indexed content blocks and deltas,
`message_delta`, `message_stop`, `ping`, and in-band `error`, including
cumulative-usage replacement, `input_json_delta` accumulation, order checks,
and tolerated future event/delta extensions. Jason has now authorized this
follow-on after the Responses/Chat typed reducer milestone; the typed tree is
present and live validation is wired, with sole-owner materialization and hooks
still required before completion.

## Definition of Done

- Responses and OpenAI Chat typed trees are complete at the required root,
  container/chunk, item/choice, content/delta, tool, usage, terminal, and
  extension layers.
- `routecodex-v3-sse` is the sole SSE transport parser for both Direct and
  Relay; it contains no protocol or control semantics.
- Normalized typed objects are the semantic source of truth. No raw JSON
  replay, raw JSON bridge, or raw JSON escape hatch remains.
- Same-protocol JSON/SSE round trips preserve identity, ordering, indices,
  types, terminal state, modeled extensions, tool structure, usage, and errors.
- Direct and Relay both pass through the object pipeline and emit explicit JSON
  or SSE projections from the same normalized object.
- Hooks provide external type notification and typed business-content rewrite;
  historical Direct and Relay hooks are migrated to their unique owners.
- SSE transport/provider errors enter ErrorErr01–ErrorErr06 without becoming
  success or taking a fallback path.
- MetadataCenter/control state is absent from provider/client payloads and
  cannot be reconstructed from business payloads.
- Positive, negative, non-terminal, terminal, malformed, round-trip,
  control-leakage, Direct, Relay, JSON, and SSE tests pass.
- Architecture gates, Rust build, global installation, `routecodex restart`,
  all configured listener health checks, online old-sample replay, evidence,
  handoff, and DSH Review PASS are complete.

## Execution phases

1. Baseline: read MemoryPalace, current run evidence/events/notes, resource,
   function, mainline, module, verification maps, design, and hook inventory;
   lock owner and test design.
2. Transport: red tests first; implement framing, event/data, multiline data,
   validation, limits, EOF, `[DONE]`, and Error01 transport export.
3. Responses: implement root/container, response metadata, item identity/index,
   every registered item subtype, content parts, reducer state, extensions,
   normalized object, JSON/SSE projection, and round trips.
4. Chat: implement envelope, choices, role/content/reasoning/refusal,
   tool/function arguments, usage, finish/terminal state, extensions,
   normalized object, JSON/SSE projection, and round trips.
5. Hooks: implement external type notification, typed content rewrite,
   ordering, extension preservation, and MetadataCenter isolation tests.
6. Direct: replace frame handling with the object consumer, migrate historical
   Direct content hooks, preserve compatibility behavior, connect transport
   errors, and run full Direct simulation.
7. Relay: replace Responses and Chat parser/materializer entry points, feed the
   normalized Hub response chain, connect typed hooks and JSON/SSE projectors,
   and run full Relay simulation.
8. Closure: audit ErrorErr01–06, control/data isolation, maps, wiki/manifest,
   dead paths, duplicate parsers, and module boundaries.
9. Verification: targeted tests, feature tests, architecture gates, Rust
   build, diff check, module audit, installation, `routecodex restart`, all
   member-port health checks, and online old/real sample replay.
10. Review: only after all prior evidence, run DSH review with provider/model
    resolved by DSH settings. Any post-review code/config/test change
    invalidates the evidence and requires re-verification and review.

## Required test matrix

Transport tests cover single/multiline data, event/comment/empty flush,
UTF-8/incomplete/limit/EOF/malformed frames, `[DONE]`, and transport errors.
Responses tests cover created/in-progress, item/content-part add/done, text,
reasoning, refusal, function/custom-tool deltas and done events, all registered
item types, interleaving, extensions, order/identity, completed/incomplete/
failed/cancelled. Chat tests cover multiple choices, role/content/reasoning/
refusal, tool calls and argument deltas, finish reason, usage, `[DONE]`,
extensions, order/index. Full-pipeline tests cover Direct and Relay success,
non-terminal, terminal, malformed, transport error, notification, rewrite,
JSON/SSE projection, and no control-plane leakage, with positive and reverse
tests for terminal/error behavior.

## Non-negotiable constraints

No Gemini work in this task. No fallback, silent strip, request
cleanup, handler compensation, raw JSON replay, duplicate semantic DTO, or
control metadata in payload. Modify only after owner/map review, use explicit
`apply_patch` hunks, preserve unrelated dirty changes, and never declare
completion from targeted tests alone.
