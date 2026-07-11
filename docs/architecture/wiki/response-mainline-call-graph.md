<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Response Mainline Call Graph

Source of truth:
- `docs/architecture/mainline-call-map.yml` defines adjacent edges for this chain
- `docs/architecture/function-map.yml` enriches owner summary and owner module context

Render rules:
- This page is a filtered render artifact, not a second architecture truth source.
- `anchored` = verified caller/callee binding
- `partial` = edge is bound, but only part of the transition is concretely anchored
- `binding pending` = edge intentionally left unresolved until code audit pins the real bridge

## response.mainline

Provider response enters Hub, gets governed, then projects to client protocol and server frame.

Entry contract: `ProviderRespInbound01Raw` via `docs/design/pipeline-type-topology-and-module-boundaries.md`

```mermaid
flowchart LR
  ServerRespOutbound05ClientFrame["ServerRespOutbound05ClientFrame"]
  HubRespOutbound04ClientSemantic["HubRespOutbound04ClientSemantic"]
  HubRespChatProcess03Governed["HubRespChatProcess03Governed"]
  HubRespInbound02Parsed["HubRespInbound02Parsed"]
  ProviderRespInbound01Raw["ProviderRespInbound01Raw"]
  ProviderRespInbound01Raw -->|resp-01| HubRespInbound02Parsed
  HubRespInbound02Parsed -->|resp-02| HubRespChatProcess03Governed
  HubRespChatProcess03Governed -->|resp-03| HubRespOutbound04ClientSemantic
  HubRespOutbound04ClientSemantic -->|resp-04| ServerRespOutbound05ClientFrame
  classDef anchored fill:#edf7ed,stroke:#2e7d32,stroke-width:1px,color:#1b1f23;
  classDef partial fill:#fff7e6,stroke:#b26a00,stroke-width:1px,color:#1b1f23;
  classDef pending fill:#f4f4f5,stroke:#6b7280,stroke-width:1px,stroke-dasharray: 5 5,color:#1b1f23;
  class ProviderRespInbound01Raw anchored;
  class HubRespInbound02Parsed anchored;
  class HubRespChatProcess03Governed anchored;
  class HubRespOutbound04ClientSemantic anchored;
  class ServerRespOutbound05ClientFrame anchored;
```

| step | transition | status | caller -> callee | split binding | owner |
| --- | --- | --- | --- | --- | --- |
| resp-01 | `ProviderRespInbound01Raw -> HubRespInbound02Parsed` | anchored | `run_hub_resp_inbound_02_parsed_entrypoint -> parse_hub_resp_inbound_02_from_provider_resp_inbound_01` |  | `hub.response_provider_sse_materialization`<br/>Provider response SSE marker/bodyText materialization before Rust Hub response pipeline entry |
| resp-02 | `HubRespInbound02Parsed -> HubRespChatProcess03Governed` | anchored | `run_hub_resp_chatprocess_03_governed_entrypoint -> build_hub_resp_chatprocess_03_from_hub_resp_inbound_02` |  | `hub.response_responses_chat_projection`<br/>OpenAI Responses provider payload to OpenAI Chat client semantic projection, including bridge response actions and Responses retention carriers |
| resp-03 | `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic` | anchored | `prepareResponsesJsonClientDispatchPlanForHttp -> projectResponsesClientPayloadForClientNative` |  | `hub.response_responses_client_projection`<br/>OpenAI Responses client-visible payload projection for JSON body and SSE frames after HubRespChatProcess03Governed normalization, including apply_patch freeform custom tool output plus client-visible model/reasoning restore |
| resp-04 | `HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame` | anchored | `sendPipelineResponse -> sendSsePipelineResponse` |  | `server.responses_response_handler_bridge_surface`<br/>/v1/responses response dispatch is handler-local HTTP IO plus Rust/NAPI response projection; duplicate response bridge facade is deleted |


## Other Chains

[config.user_config_materialization.mainline](docs/architecture/wiki/mainline-call-graph.md) · [webui.config_editor_surface.mainline](docs/architecture/wiki/webui-config_editor_surface-mainline.md) · [servertool.hook_skeleton.mainline](docs/architecture/wiki/servertool-hook_skeleton-mainline.md) · [request.mainline](docs/architecture/wiki/request-mainline-call-graph.md) · [responses.direct_passthrough.mainline](docs/architecture/wiki/responses-direct_passthrough-mainline.md) · [responses.continuation.mainline](docs/architecture/wiki/responses-continuation-mainline.md) · [debug.unified_surface.mainline](docs/architecture/wiki/debug-unified_surface-mainline.md) · [debug.pipeline_dry_run_loop.mainline](docs/architecture/wiki/debug-pipeline_dry_run_loop-mainline.md) · [internal_error_numbering.mainline](docs/architecture/wiki/internal_error_numbering-mainline.md) · [error.mainline](docs/architecture/wiki/error-mainline-call-graph.md) · [vr.route_availability.mainline](docs/architecture/wiki/vr-route_availability-mainline.md) · [vr.online_diagnostics.mainline](docs/architecture/wiki/vr-online_diagnostics-mainline.md) · [vr.hit_log_projection.mainline](docs/architecture/wiki/vr-hit_log_projection-mainline.md) · [runtime.lifecycle.mainline](docs/architecture/wiki/runtime-lifecycle-call-graph.md) · [stopless.session.mainline](docs/architecture/wiki/runtime-lifecycle-call-graph.md) · [metadata.center.mainline](docs/architecture/wiki/metadata-center-mainline-source.md) · [sse.chat_stream_projection.mainline](docs/architecture/wiki/sse-chat_stream_projection-mainline.md) · [stage_a.p0_rust_migration.mainline](docs/architecture/wiki/stage_a-p0_rust_migration-mainline.md)
