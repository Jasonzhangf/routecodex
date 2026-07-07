<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Runtime Lifecycle Call Graph

Source of truth:
- `docs/architecture/mainline-call-map.yml` defines adjacent edges for this chain
- `docs/architecture/function-map.yml` enriches owner summary and owner module context

Render rules:
- This page is a filtered render artifact, not a second architecture truth source.
- `anchored` = verified caller/callee binding
- `partial` = edge is bound, but only part of the transition is concretely anchored
- `binding pending` = edge intentionally left unresolved until code audit pins the real bridge

## runtime.lifecycle.mainline

Managed server lifecycle: `ROUTECODEX_SESSION_DIR` is only the runtime workdir root; pid cache writes on start, stop-intent writes on stop, and `tmuxSessionId` / request `sessionId` / `conversationId` stay separate namespaces rather than directory-derived identity.

Entry contract: `ServerPidCacheRecord` via `docs/design/server-runtime-lifecycle-ssot.md`

```mermaid
flowchart LR
  StartShutdownHandler["StartShutdownHandler"]
  DaemonRestartLoop["DaemonRestartLoop"]
  DaemonSupervisorLoop["DaemonSupervisorLoop"]
  RuntimeInstanceRecord["RuntimeInstanceRecord"]
  StopIntentRecord["StopIntentRecord"]
  ServerStopCommand["ServerStopCommand"]
  ServerPidCacheRecord["ServerPidCacheRecord"]
  ServerStartCommand["ServerStartCommand"]
  ServerStartCommand -->|rtl-01| ServerPidCacheRecord
  ServerStartCommand -->|rtl-02| ServerPidCacheRecord
  ServerStopCommand -->|rtl-03| StopIntentRecord
  ServerStartCommand -->|rtl-04| StopIntentRecord
  ServerStartCommand -->|rtl-07| RuntimeInstanceRecord
  DaemonSupervisorLoop -->|rtl-08| RuntimeInstanceRecord
  DaemonRestartLoop -->|rtl-09| RuntimeInstanceRecord
  ServerStartCommand -->|rtl-10| RuntimeInstanceRecord
  StartShutdownHandler -->|rtl-11| RuntimeInstanceRecord
  ServerStopCommand -->|rtl-12| RuntimeInstanceRecord
  classDef anchored fill:#edf7ed,stroke:#2e7d32,stroke-width:1px,color:#1b1f23;
  classDef partial fill:#fff7e6,stroke:#b26a00,stroke-width:1px,color:#1b1f23;
  classDef pending fill:#f4f4f5,stroke:#6b7280,stroke-width:1px,stroke-dasharray: 5 5,color:#1b1f23;
  class ServerStartCommand anchored;
  class ServerPidCacheRecord anchored;
  class ServerStopCommand anchored;
  class StopIntentRecord anchored;
  class RuntimeInstanceRecord anchored;
  class DaemonSupervisorLoop anchored;
  class DaemonRestartLoop anchored;
  class StartShutdownHandler anchored;
```

| step | transition | status | caller -> callee | split binding | owner |
| --- | --- | --- | --- | --- | --- |
| rtl-01 | `ServerStartCommand -> ServerPidCacheRecord` | anchored | `writeServerPidCache -> writeServerPidCache` |  | `runtime.lifecycle.pid_cache`<br/>server pid cache lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/pid.cache; pid is a transient cache, not the authoritative runtime state |
| rtl-02 | `ServerStartCommand -> ServerPidCacheRecord` | anchored | `writeServerPidCache -> writeServerPidCache` |  | `runtime.lifecycle.pid_cache`<br/>server pid cache lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/pid.cache; pid is a transient cache, not the authoritative runtime state |
| rtl-03 | `ServerStopCommand -> StopIntentRecord` | anchored | `writeDaemonStopIntent -> writeServerStopIntent` |  | `runtime.lifecycle.stop_intent`<br/>stop-intent is a cross-process signal under <rccUserDir>/state/runtime-lifecycle/ports/<port>/stop-intent.json; it must be reaped when older than TTL |
| rtl-04 | `ServerStartCommand -> StopIntentRecord` | anchored | `consumeDaemonStopIntent -> consumeServerStopIntent` |  | `runtime.lifecycle.stop_intent`<br/>stop-intent is a cross-process signal under <rccUserDir>/state/runtime-lifecycle/ports/<port>/stop-intent.json; it must be reaped when older than TTL |
| rtl-07 | `ServerStartCommand -> RuntimeInstanceRecord` | anchored | `writeRuntimeInstance -> writeRuntimeInstance` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |
| rtl-08 | `DaemonSupervisorLoop -> RuntimeInstanceRecord` | anchored | `writeRuntimeInstance -> writeRuntimeInstance` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |
| rtl-09 | `DaemonRestartLoop -> RuntimeInstanceRecord` | anchored | `writeRuntimeInstance -> writeRuntimeInstance` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |
| rtl-10 | `ServerStartCommand -> RuntimeInstanceRecord` | anchored | `updateRuntimeInstanceStatus -> updateRuntimeInstanceStatus` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |
| rtl-11 | `StartShutdownHandler -> RuntimeInstanceRecord` | anchored | `updateRuntimeInstanceStatus -> updateRuntimeInstanceStatus` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |
| rtl-12 | `ServerStopCommand -> RuntimeInstanceRecord` | anchored | `updateRuntimeInstanceStatus -> updateRuntimeInstanceStatus` |  | `runtime.lifecycle.instance_registry`<br/>managed server instance declaration lives under <rccUserDir>/state/runtime-lifecycle/ports/<port>/instance.json |


## Other Chains

[config.user_config_materialization.mainline](docs/architecture/wiki/mainline-call-graph.md) · [webui.config_editor_surface.mainline](docs/architecture/wiki/webui-config_editor_surface-mainline.md) · [servertool.hook_skeleton.mainline](docs/architecture/wiki/servertool-hook_skeleton-mainline.md) · [request.mainline](docs/architecture/wiki/request-mainline-call-graph.md) · [responses.direct_passthrough.mainline](docs/architecture/wiki/responses-direct_passthrough-mainline.md) · [response.mainline](docs/architecture/wiki/response-mainline-call-graph.md) · [responses.continuation.mainline](docs/architecture/wiki/responses-continuation-mainline.md) · [debug.unified_surface.mainline](docs/architecture/wiki/debug-unified_surface-mainline.md) · [internal_error_numbering.mainline](docs/architecture/wiki/internal_error_numbering-mainline.md) · [error.mainline](docs/architecture/wiki/error-mainline-call-graph.md) · [vr.route_availability.mainline](docs/architecture/wiki/vr-route_availability-mainline.md) · [vr.online_diagnostics.mainline](docs/architecture/wiki/vr-online_diagnostics-mainline.md) · [vr.hit_log_projection.mainline](docs/architecture/wiki/vr-hit_log_projection-mainline.md) · [stopless.session.mainline](docs/architecture/wiki/runtime-lifecycle-call-graph.md) · [metadata.center.mainline](docs/architecture/wiki/metadata-center-mainline-source.md) · [sse.chat_stream_projection.mainline](docs/architecture/wiki/sse-chat_stream_projection-mainline.md) · [stage_a.p0_rust_migration.mainline](docs/architecture/wiki/stage_a-p0_rust_migration-mainline.md)
