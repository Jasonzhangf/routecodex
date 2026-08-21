# V3 SSE / Hook / MetadataCenter pre-wiring inventory

Status: source inventory during Direct object-consumer cutover

## Existing hook surfaces

| Surface | Current owner | Current role | Migration target |
| --- | --- | --- | --- |
| `V3HookRegistry` | `runtime/src/hooks.rs` | Direct route, request projection, provider transport, response projection, Error05 decision | Preserve request/error control hooks; response data hooks move behind the independent object pipeline |
| `ResponsesDirectResponseProjectionHook` | `runtime/src/hooks.rs` | Builds the Direct response compatibility plan and calls provider raw projection | Become the Direct object-pipeline consumer coordinator |
| `ChatDirectResponseProjectionHook` | `runtime/src/hooks.rs` | Uses the same compatibility-plan path for Chat Direct | Use Chat object consumers and the same output projection boundary |
| `wrap_direct_sse_provider_event_json_observation_stream_with_compat` | `runtime/src/kernel/direct_runtime_helpers_stream.rs` | Re-decodes Direct SSE, observes, rewrites response id/cipher/tool compatibility | Remove after consumer parity tests pass |
| `wrap_v3_direct_responses_thinking_tag_consumer_stream` | `runtime/src/kernel/direct_response_thinking_compat.rs` | Stateful Direct Responses consumer buffers validated SSE objects until terminal, then inserts typed reasoning events | Replace remaining compatibility event planner with typed event emission; no server/SSE repair owner |
| Hub static node hooks | `runtime/src/hub_v1/resource_hooks.rs` | Fixed entry/exit declarations; currently `NotImplemented` except optional disabled no-op | Do not replace with dynamic SSE hooks; bind protocol consumers to declared response nodes |
| Relay JSON hooks | `runtime/src/hub_v1/responses_relay_json_hooks.rs` and related runtime modules | Responses/Chat semantic request/response projection | Consume typed object trees after protocol parse |
| Server SSE error framing | `server/src/frame_builders.rs` | Client error frame projection | Consume Error06 only; must not classify provider SSE or synthesize success |

## MetadataCenter connection

The currently registered MetadataCenter resource is:

```text
v3.metadata.runtime_control_stopless
```

Its owner is `StoplessCenterMetadataControl`. Direct and Relay have separate
scoped adapters, but both use the same control resource contract.

Allowed control lifecycle:

```text
Req04 -> load scoped control state
Resp03 -> apply same-turn control transition
Req04 -> inject only registered current-turn protocol projection
```

The SSE/object module must not read or write this resource. SSE consumers may
read protocol data and emit typed business notifications/content effects, but
routing, retry, health, continuation, scope, and Stopless state stay in the
existing typed control owners.

## Required pre-wiring checks

1. Every historical Direct response hook has a typed object consumer or is
   explicitly marked control-plane and remains outside the SSE module.
2. Every `SseTransportError` becomes an `SseTransportErrorExport` and then an
   Error01 source; no handler-level error repair remains.
3. Direct response content rewrites pass positive and reverse tests for
   configured rewrite and ordinary pass-through.
4. MetadataCenter tests prove SSE consumers cannot write or reconstruct
   `v3.metadata.runtime_control_stopless`.
5. Static hook registry and resource map entries point to the same owners before
   Direct/Relay wiring changes.
6. Only after the above gates pass may the old Direct SSE wrappers be removed
   and both Direct and Relay be routed through the object pipeline.

## Typed hook contract status

`responses_sse_tree.rs` and `openai_chat_sse_tree.rs` now expose protocol-owned
semantic hook contracts. Each contract has two explicit operations: `notify`
receives transport/protocol/semantic references for external type notification,
and `rewrite` mutates only typed business content. Tests prove that rewrite
preserves item identity, choice index, finish reason, and unknown extensions.

Relay response-side runtime registry binding is now owned by
`V3HubRelayResponseHookRegistry::typed_sse_catalog`; Direct response-side
binding is owned by `V3HookRegistry::direct_sse_typed_hooks` and is passed into
the independent Direct SSE object consumer.
Existing Relay JSON hooks include control transitions and compatibility effects;
they must be split into typed business-content adapters and typed control-side
consumers before they can be registered behind these contracts. The Direct
request-key catalog is now mounted by `V3HookRegistry` and is passed through the
actual Responses Direct request projection; its default catalog remains empty
until historical business adapters are migrated. No inert no-op response
registry is treated as completion.

The historical Direct response compatibility plan (`responses:thinking-tags`,
`responses:deepseek-console-go`, response-cipher retention, and response-id
projection) remains a provider-compat/control-adjacent owner. It is not silently
reclassified as a business-content hook. Only future text/reasoning/tool-field
rewrites may be registered in `V3DirectSseTypedHookCatalog`; routing, health,
continuation, and provider-shape effects stay outside that catalog.

## Direct request key mounts

Direct request projection has one typed key surface for each business key
family: `system`, `developer`, and `tools`. The owner is
`kernel/direct_request_key_hooks.rs`; it parses protocol-specific key views for
Responses, OpenAI Chat, and Anthropic, then applies typed edits before provider
wire emission. The edit surface supports prompt append, tool-description
rewrite, and protocol-shaped tool injection without editing provider-specific
compatibility modules.

The projection owner exposes a catalog-aware test seam, and
`V3HookRegistry::run_request_projection` now consumes the registry-owned catalog
against the actual provider wire body. The default Direct runtime catalog
remains explicit and empty until historical business adapters are migrated; this
keeps test registration separate from production behavior while preserving a
single mounting point.

The key mounts are represented by `V3DirectRequestKeyHookCatalog`; its default
catalog is intentionally empty and is the only place where protocol-specific
business adapters are registered. These mounts are Direct-only. Relay JSON remains governed by
`req_inbound -> req_chatprocess` and must not call the Direct key hook. The key
view/effect carries business request content only; routing, retry, health,
continuation, Stopless, and MetadataCenter state remain outside this module.
