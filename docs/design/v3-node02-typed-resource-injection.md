# Node02 request normalization: typed resource capability

Status: design candidate. No Node02 runtime cutover, live replay, or implementation review is claimed.

## Entry and owners

The already selected HTTP route or WebSocket endpoint supplies an immutable typed ingress contract: entry protocol, `RawEntry` or `AlreadyCanonical`, and invocation origin. `RuntimeRequestGraphEntry` creates this descriptor and owns the request lease. The JSON body does not select its protocol or origin. Node02 cannot reject a valid object merely because a familiar discriminator field is absent.

Node02 is the only owner of lossless inbound normalization. For `RawEntry`, one registered field walk maps Chat semantics into canonical Chat, retains each otherwise unrepresented business field as an opaque extension, and produces inverse path/identity provenance and explicit tool/history pairing. Tool arguments and results stay complete business values. A field has one semantic owner; copying whole `tools` or `input` arrays into both canonical and extension is not an inverse mapping. `AlreadyCanonical` consumes the prior canonical value and request slots without re-normalizing or overwriting provenance. Retry and internal follow-up must name this contract explicitly.

## One control channel

DAGpipe v0.1.0 `Operator::execute` accepts and returns a JSON `Value`. Its `OperatorContext` exposes identity and node ID, not a resource store; the SDK does not execute the JSON graph's `resources` declarations. The canonical ARC therefore contains business data only. It contains no generated `entry_protocol`, routing choice, inverse map, pairing map, ARC identity envelope, or serialized MetadataCenter.

`RuntimeRequestGraphEntry` creates an invocation-specific Node02 Operator. Its constructor receives restricted typed handles to the **same request-scoped MetadataCenter instance** held by the Runtime request lease. The Runtime adapter compares graph resource declarations, the V3 resource map, and the Operator's static access contract before registration; SDK effects/grants check declared effect names, while the restricted handles enforce actual slot access. A registry or compiled graph capturing request handles cannot be cached across requests or stored in a global singleton. Static graph declarations may be reused.

Node02 first computes canonical payload, inverse provenance, and explicit history pairing in local temporary values. On complete success it publishes both typed slots together. A failure leaves no half-written control state and enters the existing Runtime → Error graph. The MetadataCenter stores the single authoritative request slots; the request lease only owns its lifetime and does not mirror their values. Node03 and later inverse projection read those slots through declared restricted handles.

`request_origin_kind` and entry protocol are immutable invocation descriptor fields, not MetadataCenter slots. Request-scoped inverse and pairing slots survive attempt cleanup and Direct→Relay handoff. `RuntimeRequestFinalizer` alone releases them after success, terminal error, cancellation, or disconnect. Attempt cleanup does not release request scope.

## Capability gate before product implementation

Use the real pinned DAGpipe SDK and a minimal Runtime consumer through its public compile/run boundary. A fixed business `Value` is sufficient at this stage; this consumer proves the resource channel, not Node02 normalization. Prove: a declared read/write succeeds; an undeclared access is rejected; two concurrent invocations cannot read each other's slots; failed publication leaves neither inverse nor pairing slot; an `AlreadyCanonical` invocation reads original request slots without a second write; the finalizer releases them on success, failure, cancellation, and disconnect. Prove that the selected HTTP/WebSocket endpoint supplies its typed ingress protocol independently of body shape.

Only after this capability proof and independent design PASS may Node02 product implementation resume. The implementation candidate must remove JSON-shape protocol guessing, rejection of unclassifiable objects, generated control fields in canonical payload, discarded `_inverse_row`, whole-array duplication as inverse provenance, and compile with an empty grant set. The existing production Direct/Relay normalization remains until a single verified caller cutover replaces every consumer. No shadow normalization or raw bypass counts as a cutover.

After Node02 implementation, compare original client payload, canonical data, provider projection, and inverse client response through the real OpenAI Chat, Responses, Anthropic, and Gemini entries. Verify tool identity, complete arguments/output, unknown fields, pairing, success and typed failure paths before architecture review or caller cutover.
