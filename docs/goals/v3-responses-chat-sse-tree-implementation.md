# Responses / Chat SSE typed-tree implementation plan

Status: typed transport/tree boundary plus hook contract slice

Canonical design: `docs/goals/v3-responses-chat-sse-tree-design.md`.

## Current slice

Owner: `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs`.

Responsibilities:

- classify Responses output items into independent typed kinds;
- expose `TransportObject`, `ProtocolMetadata`, and `SemanticObject` hook inputs;
- expose typed content rewrite targets;
- expose protocol-owned semantic hook contracts with separate notification and
  rewrite callbacks; the rewrite callback mutates the typed tree before
  projection and cannot mutate protocol/control metadata;
- reject unknown item types at the existing Responses provider event codec boundary;
- maintain typed response/container/item/terminal reducer state and explicit
  extension fields;
- maintain typed Chat reasoning/usage/terminal reducer state and explicit
  extension fields;
- reconstruct Responses event envelopes and item payloads from protocol fields
  and explicit extensions; tree-level normalized raw `Value` storage is no
  longer used;
- route the live Responses Relay provider stream through the typed reducer for
  scaffold merge, indexed item accumulation, content deltas, terminal output,
  and incomplete/error validation;
- preserve existing reducer output until typed reducer parity is proven.

## Fixed V3 direction contracts

The Responses/Chat stream work has two independent directions. The request
direction is JSON-first; the response direction may be provider SSE or JSON,
and the client projection is selected explicitly by the client stream mode.

### Request direction: client JSON to provider JSON

```text
ServerReqInbound01ClientRaw
  -> HubReqInbound02Standardized
  -> protocol request semantic tree
  -> request type/content hooks
  -> HubReqChatProcess03Governed
  -> HubReqOutbound05ProviderSemantic
  -> ProviderReqOutbound06WirePayload
```

The request hook runs after the client JSON has been parsed into the
Responses/Chat semantic tree and before provider JSON wire projection. It may
notify external consumers of typed nodes and rewrite business content only.
It cannot modify routing, retry, health, continuation ownership, scope,
terminal control, or transport framing.

### Response direction: provider content to client output

```text
ProviderRespInbound01Raw
  -> routecodex-v3-sse transport/object module
  -> provider protocol metadata
  -> Responses/Chat semantic tree
  -> response type/content hooks
  -> HubRespChatProcess03Governed
  -> explicit client projection
       +-> Json(SingleDocument)
       +-> Sse
  -> ServerRespOutbound05ClientFrame
```

Direct and Relay must both enter the same SSE object module before client
connection. Direct compatibility, provider error-response interpretation,
and Relay protocol projection are consumers of this module; none may decode
or re-encode SSE independently.

### Provider and client response interfaces

The provider-facing response interface accepts either provider JSON or
provider SSE according to the selected provider protocol. The client-facing
response interface emits either one complete JSON document or an SSE stream.
`application/json` never emits multiple independent item documents. The
semantic accumulator still completes and classifies each item incrementally;
only `Sse` may expose those increments immediately. An item sequence requires
an explicitly declared NDJSON/JSON-Sequence endpoint and is not a normal JSON
projection.

### Hook ownership

Request hooks consume the request semantic tree after JSON parse. Response
hooks consume the provider semantic tree after SSE/JSON object parse. Both
share the same two effects:

1. external typed-node notification;
2. business-content rewrite.

Hook effects cannot change item identity, indices, protocol event type,
sequence number, finish reason, terminality, error-chain state, or frame
boundaries. The output projection owns JSON/SSE serialization.

## Bidirectional conversion contract

Inbound and outbound are a paired contract, not two independent parsers. Every
protocol object must support both directions:

```text
wire -> transport object -> protocol tree -> Hub object
Hub object -> protocol tree -> transport object -> wire
```

The required invariants are:

1. Same-protocol semantic round trip:
   `decode(encode(tree)) == tree`.
2. Full normalization: outbound is built from the normalized protocol tree;
   it never replays or consults raw JSON as a round-trip shortcut. Wire-byte
   identity is not a normalization contract.
3. Lossless unknown-field handling: unknown protocol fields, provider
   extensions, item ordering, choice/index values, event names, and SSE data
   segments are represented by explicit typed extension/order fields attached
   to the owning object. A typed parser may classify them, but may not silently
   discard them.
4. Explicit mutation boundary: after a hook rewrites business content, the
   owning object is re-encoded deterministically; transport framing and control
   state remain outside the mutation.
5. Cross-protocol projection is explicit and is not falsely claimed to be
   invertible. `Responses <-> Chat` or provider protocol projection must retain
   a typed provenance/projection record so that the owning protocol can rebuild
   its own shape without guessing from client payload.

JSON and SSE use the same object consumer contract. JSON is a single document
transport at the normal HTTP boundary, but its root, response container, item,
content, choice, and tool-call objects are still consumed individually inside
the pipeline. Only an explicitly declared NDJSON/JSON-Sequence endpoint may
emit multiple JSON documents externally.

The object layer therefore has one semantic source of truth and may retain
explicit normalized extension information where the protocol requires it:

- a normalized transport envelope (event and field order, data segments,
  unknown fields represented as typed extensions);
- a typed semantic view (Responses/Chat container, item, content, choice, and
  tool-call nodes).

Both forms are normalized projections of the same object model. The paired
outbound builder always serializes that model; it never reads raw JSON. MetadataCenter resources,
routing state, continuation ownership, health, retry, and error decisions are
not part of either business object and remain typed side-channel resources.

Anthropic follow-on status:

- `anthropic_sse_tree.rs` owns the typed event metadata, message/container, indexed block,
  delta, usage, terminal, unknown-extension, and semantic-hook contracts.
- The live Anthropic provider stream now feeds every event through that reducer and rebuilds
  the message projection from its typed state. Historical collector symbols remain only for
  compatibility tests and are the next physical-deletion slice.

Not owned:

- transport framing;
- Chat tree;
- Gemini;
- MetadataCenter control state;
- routing/retry/continuation/health;
- final JSON/SSE projection.

## Next slices

1. Completed: physically removed the legacy, now-unowned `output_items: Vec<Value>` reducer
   implementation and migrated its terminal tests to the typed reducer. The live Responses
   provider materializer now has one reducer owner.
2. Bind the type-notification and item-specific content-rewrite contracts to
   the existing Direct/Relay hook owners. The current tree modules define and
   test the contract; runtime registration remains pending until the historical
   JSON hook effects have typed adapters.
3. Add JSON/SSE parity tests and cross-protocol projection through Hub semantic nodes.
4. Add paired inbound/outbound builders and red/green round-trip tests for
   Responses and Chat JSON/SSE, including unchanged-wire, rewritten-content,
   unknown-field, ordering, and malformed-input cases.

## Red/green contract

- unknown Responses item type fails at provider event codec;
- message, reasoning, function_call remain distinct;
- content rewrite preserves item type and identity;
- `decode(encode(tree)) == tree` for Responses and Chat object trees;
- JSON/SSE outbound is rebuilt from normalized objects, never raw JSON;
- changed content re-encodes only the owning object and preserves explicit
  extensions, item identity, ordering, and transport boundaries;
- protocol metadata cannot carry business `metadata` or control state;
- existing Responses event behavior remains unchanged for registered item types.
