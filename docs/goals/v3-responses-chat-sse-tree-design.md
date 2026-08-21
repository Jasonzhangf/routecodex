# V3 Responses / OpenAI Chat SSE typed-object design

Status: canonical design for the first implementation phase

Scope is limited to OpenAI Responses and OpenAI Chat Completions. Gemini and
Anthropic are explicitly out of scope until both protocols complete this
design, implementation, verification, and runtime cutover.

## Pipeline

```text
provider JSON/SSE
  -> routecodex-v3-sse transport object
  -> protocol transport object
  -> protocol metadata
  -> protocol semantic tree
  -> normalized Hub object
  -> protocol semantic tree
  -> client JSON/SSE projection
```

Direct and Relay share the independent transport boundary. Direct then uses
Direct-owned object consumers and passthrough projection. Relay continues
through the Hub response pipeline. Neither path may introduce a second raw SSE
parser or a raw JSON remap layer.

## Object layers

The independent SSE crate owns bytes, UTF-8, event/data fields, multiline data,
frame boundaries, limits, EOF, and transport errors. It does not know protocol
item, tool, terminal, routing, continuation, MetadataCenter, or provider
semantics.

Responses owns a root/container view, response identity/status/model/usage/error,
output-item identity/index, item subtype, content-part subtype, tool/function
fields, reasoning/message fields, terminal events, and explicit extensions.
Each supported item subtype is classified distinctly; unknown types fail at the
owning parser until an explicit typed extension contract exists.

Chat owns chunk envelope, response identity, model/created/fingerprint, choice
and choice index, role/content/reasoning/refusal deltas, tool-call position and
function fields, finish reason, usage, terminal state, and extensions.

MetadataCenter and Error chain are side channels. They are never fields of a
transport object, normalized business object, SSE data value, provider body, or
client response body.

## Hook contract

Both protocol trees expose a hook input composed of:

1. transport object;
2. protocol metadata;
3. typed semantic object.

Hooks have exactly two effects:

- notify an external consumer of typed nodes;
- rewrite registered business content on the typed object.

They cannot alter identity, index, item/choice type, event order, terminality,
frame boundaries, control state, retry, routing, continuation, health, or
MetadataCenter resources. Projection serializes the resulting normalized tree.

## Round-trip and projection rules

Same-protocol conversion must satisfy `decode(encode(tree)) == tree`, including
identity, order, indices, terminal state, typed fields, usage/error semantics,
and modeled extensions. JSON and SSE use the same normalized object. Ordinary
JSON remains one valid JSON document; per-item external JSON requires a separate
registered NDJSON/JSON-Sequence contract. Cross-protocol Responses/Chat
projection is explicit and may be lossy only when its projection record says so.

Raw input may exist transiently at the parser boundary, but raw JSON strings are
not normalized state, unknown-field storage, direct/relay bridge state, or
outbound reconstruction input.

## Error and control boundaries

SSE decode, UTF-8, malformed event, frame limit, incomplete-frame, EOF, and
provider stream errors enter `ErrorErr01SourceRaised` and continue through the
existing ErrorErr02–ErrorErr06 chain. They cannot become a successful terminal
response or be repaired by outbound/handler fallback.

MetadataCenter control resources remain owned by their existing owners. SSE
consumers may emit business type notifications and content rewrites only; they
cannot read/write or reconstruct routing, switching, retry, health, scope,
continuation, servertool, debug, snapshot, or error-policy state.

