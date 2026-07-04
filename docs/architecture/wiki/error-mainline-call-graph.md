<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Error Mainline Call Graph

Source of truth:
- `docs/architecture/mainline-call-map.yml` defines adjacent edges for this chain
- `docs/architecture/function-map.yml` enriches owner summary and owner module context

Render rules:
- This page is a filtered render artifact, not a second architecture truth source.
- `anchored` = verified caller/callee binding
- `partial` = edge is bound, but only part of the transition is concretely anchored
- `binding pending` = edge intentionally left unresolved until code audit pins the real bridge

## error.mainline

Provider/runtime/direct failures enter unified ErrorErr chain; provider availability/cooldown truth stays provider/server-scoped and must not be rewritten into session-storm truth before client projection.

Entry contract: `ErrorErr01SourceRaised` via `docs/design/pipeline-type-topology-and-module-boundaries.md`

```mermaid
flowchart LR
  ErrorErr06ClientProjected["ErrorErr06ClientProjected"]
  ErrorErr05ExecutionDecision["ErrorErr05ExecutionDecision"]
  ErrorErr03RuntimeClassified["ErrorErr03RuntimeClassified"]
  ErrorErr02HostCaptured["ErrorErr02HostCaptured"]
  ErrorErr01SourceRaised["ErrorErr01SourceRaised"]
  ErrorErr01SourceRaised -->|err-01| ErrorErr02HostCaptured
  ErrorErr02HostCaptured -->|err-02| ErrorErr03RuntimeClassified
  ErrorErr03RuntimeClassified -.->|err-03| ErrorErr05ExecutionDecision
  ErrorErr05ExecutionDecision -->|err-04| ErrorErr06ClientProjected
  classDef anchored fill:#edf7ed,stroke:#2e7d32,stroke-width:1px,color:#1b1f23;
  classDef partial fill:#fff7e6,stroke:#b26a00,stroke-width:1px,color:#1b1f23;
  classDef pending fill:#f4f4f5,stroke:#6b7280,stroke-width:1px,stroke-dasharray: 5 5,color:#1b1f23;
  class ErrorErr01SourceRaised anchored;
  class ErrorErr02HostCaptured anchored;
  class ErrorErr03RuntimeClassified partial;
  class ErrorErr05ExecutionDecision partial;
  class ErrorErr06ClientProjected anchored;
```

| step | transition | status | caller -> callee | split binding | owner |
| --- | --- | --- | --- | --- | --- |
| err-01 | `ErrorErr01SourceRaised -> ErrorErr02HostCaptured` | anchored | `reportProviderErrorToRouterPolicy -> reportProviderErrorToRouterPolicy` |  | `error.pipeline_contract`<br/>ErrorErr01-06 provider/runtime error chain contract and architecture gate |
| err-02 | `ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified` | anchored | `classifyProviderFailure -> classifyProviderFailure` |  | `error.provider_failure_policy`<br/>provider/server error cataloging, runtime classification, router policy application, and availability/cooldown truth; session-local storm semantics are explicitly separate |
| err-03 | `ErrorErr03RuntimeClassified -> ErrorErr05ExecutionDecision` | partial | `resolveProviderRetryExecutionPlan -> resolveProviderRetryExecutionPlan` |  | `error.execution_decision_consumer`<br/>Request/direct executor consumption of ErrorErr04 router policy into ErrorErr05 execution decisions, including primary_exhausted and upstream_stream_incomplete reroute |
| err-04 | `ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected` | anchored | `project_error_err_06_client_from_error_err_05_execution_decision -> mapErrorToHttp` |  | `error.client_projection`<br/>ErrorErr06 client-visible HTTP/SSE error projection, including started-stream incomplete SSE error frames |


## Other Chains

[servertool.hook_skeleton.mainline](docs/architecture/wiki/servertool-hook_skeleton-mainline.md) · [request.mainline](docs/architecture/wiki/request-mainline-call-graph.md) · [response.mainline](docs/architecture/wiki/response-mainline-call-graph.md) · [responses.continuation.mainline](docs/architecture/wiki/responses-continuation-mainline.md) · [debug.unified_surface.mainline](docs/architecture/wiki/debug-unified_surface-mainline.md) · [internal_error_numbering.mainline](docs/architecture/wiki/internal_error_numbering-mainline.md) · [vr.route_availability.mainline](docs/architecture/wiki/vr-route_availability-mainline.md) · [vr.online_diagnostics.mainline](docs/architecture/wiki/vr-online_diagnostics-mainline.md) · [runtime.lifecycle.mainline](docs/architecture/wiki/runtime-lifecycle-call-graph.md) · [stopless.session.mainline](docs/architecture/wiki/runtime-lifecycle-call-graph.md) · [metadata.center.mainline](docs/architecture/wiki/metadata-center-mainline-source.md) · [sse.chat_stream_projection.mainline](docs/architecture/wiki/sse-chat_stream_projection-mainline.md) · [stage_a.p0_rust_migration.mainline](docs/architecture/wiki/stage_a-p0_rust_migration-mainline.md)
