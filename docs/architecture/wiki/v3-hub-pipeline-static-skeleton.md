# V3 Hub Pipeline Static Skeleton Review

Canonical contract: [V3 Hub Pipeline Static Skeleton Contract](../../design/v3-hub-pipeline-static-skeleton-contract.md)

Implementation order: [V3 Hub Pipeline Static Skeleton Plan](../../goals/v3-hub-pipeline-static-skeleton-implementation-plan.md)

Existing source audit: [Existing Hub and Provider Path Audit](../../design/v3-existing-hub-provider-path-audit.md)

## Fixed topology

```mermaid
flowchart TD
  R1[V3HubReqInbound01ClientRaw] --> R2[V3HubReqInbound02Normalized]
  R2 --> R3[V3HubReqContinuation03Classified]
  R3 --> R4[V3HubReqChatProcess04Governed]
  R4 --> R5[V3HubReqExecution05Planned]
  R5 --> R6[V3HubReqTarget06Resolved]
  R6 --> R7[V3HubReqOutbound07ProviderSemantic]
  R7 --> R8[V3ProviderReqOutbound08WirePayload]
  R8 --> R9[V3ProviderReqOutbound09TransportRequest]
  R9 --> P1[V3ProviderRespInbound01Raw]
  P1 --> S2[V3HubRespInbound02Normalized]
  S2 --> S3[V3HubRespChatProcess03Governed]
  S3 --> S4[V3HubRespContinuation04Committed]
  S4 --> S5[V3HubRespOutbound05ClientSemantic]
  S5 --> S6[V3ServerRespOutbound06ClientFrame]
```

## Four independent branch axes

| Axis | Closed values | Must not be inferred from |
| --- | --- | --- |
| Entry protocol | Responses, Anthropic, Gemini, OpenAI Chat | Provider identity |
| Continuation ownership | new, remote-provider-owned, RouteCodex-local-owned | GPT family or wire protocol |
| Execution mode | Direct, Relay | same-protocol equality |
| Provider wire protocol | Responses, Anthropic, Gemini, OpenAI Chat | Direct/Relay mode |

Target resolution is a typed sub-branch: routed and pinned both merge into
`V3HubReqTarget06Resolved`.

Cross-cutting branches are fixed too: client/servertool/Dry Run invocation source, JSON/SSE frame
transport, and success/global-Error outcome. They occupy existing hook slots and never add a
lifecycle or response exit.

## Immutable interval

```mermaid
flowchart LR
  Save[V3HubRespContinuation04Committed<br/>LocalContext save]
  Store[Immutable envelope<br/>normalize/store/scope only]
  Restore[V3HubReqChatProcess04Governed<br/>LocalContext restore]
  Save --> Store --> Restore
```

No business logic, tool/history repair, request rebuild, routing, Provider adaptation, Debug replay,
or fallback is allowed between save and restore.

## Current-state review

- P6 Responses Direct: implemented and verified, but not the final Hub topology.
- P6 freeze: source gate plus eight mutation fixtures reject Chat Process, Relay, continuation,
  additional protocol, provider-specific branching, dynamic hook, second lifecycle, and second
  response exit expansion.
- Hub v1 H1 nodes: implemented in Rust as opaque types with private fields. Thirteen adjacent
  builders are source-bound through `all_adjacent_builders_form_the_fixed_typed_topology`; this is
  a typed-test binding, not a production request-path binding.
- Hub v1 static registry: thirteen closed callable slots compile deterministically. Every H1 hook
  returns explicit `not_implemented`; missing, duplicate, unknown, incompatible node pair, or
  Config mismatch fails startup validation.
- Config declarations: `V3Config02AuthoringParsed -> V3Config04ResourceRegistryBuilt ->
  V3Config05ManifestPublished` publishes the closed skeleton, protocols, hooks, capabilities, and
  allowed server execution facts. It publishes no selected request branch.
- Remote continuation: pending hook implementation.
- Local continuation/Relay: pending hook implementation.
- Other protocols: pending hook implementation.
- P6 deletion: required after Hub v1 Direct cutover; permanent dual paths are forbidden.

Canonical bindings: [V3 function map](../v3-function-map.yml),
[V3 mainline call map](../v3-mainline-call-map.yml),
[V3 resource map](../v3-resource-operation-map.yml), and
[V3 verification map](../v3-verification-map.yml).
