# V3 Provider Statistics Implementation Plan

Status: design plan, implementation not started
Date: 2026-07-26
Owner feature: `v3.provider_statistics`
Target owner crate: `routecodex-v3-stats` (new Rust crate)
Design scope: V3 managed runtime statistics for provider performance, route branch hits, token/cache usage, timing, provider switches, and error classes.

## 0. Executive Decision

V3 provider statistics must be an independent Rust-owned side-channel module. Runtime, server, target, router, provider, and error nodes may emit typed `V3StatsEvent` records, but only `routecodex-v3-stats` may persist, aggregate, or answer statistics queries.

The statistics truth source is a local SQLite WAL event store plus derived rollups under:

```text
~/.rcc/stats/v3/stats.sqlite
```

Statistics is explicitly not routing truth, provider health truth, debug truth, continuation truth, or console truth. Stats cannot change provider selection, retry, cooldown, continuation owner, error projection, request payloads, provider payloads, or client response bodies.

## 1. Problem Statement

V2 already has a provider statistics prototype. V3 currently has useful runtime observability and console logs, but no independent statistics subsystem with a unified writer, storage, rollup, and reader. Recent V3 debugging exposed that console `usage` lines, provider switch logs, `usage=unreported`, `time_i/time_e`, and internal/external error identity are operationally important, but they are scattered across runtime/server observability and logs.

The new V3 feature should make these measurements queryable and persistent without repeating V2's TS-owned JSONL manager and without parsing logs or SSE transport bytes as truth.

## 2. Goals

1. Count V3 requests, provider attempts, successes, failures, switches, retries, and client disconnects.
2. Record provider performance by provider/model/auth/route/protocol/entry endpoint.
3. Record internal, external, first-byte, stream, and total timing spans from runtime span facts, not console formatting.
4. Record usage tokens and cache metrics from provider semantic terminal events or parsed JSON usage, not `[DONE]` or transport close.
5. Record daily/hourly route branch hit counts by routing group, route, pool, target, provider, model, and execution mode.
6. Record error classes with the existing V3 Error01-06 identity split, including internal RouteCodex errors vs external provider/upstream errors.
7. Provide stable local CLI and diagnostics read surfaces.
8. Keep statistics storage, rollup, query, and writer health in one Rust crate with one public integration contract.
9. Keep all event payloads sanitized and payload-free.
10. Make stats writer failures visible in health/diagnostics without failing normal user requests.

## 3. Non-Goals

- Do not implement runtime behavior changes in this design phase.
- Do not reuse V2 `src/server/runtime/http-server/stats-manager.ts` as V3 truth.
- Do not parse console logs, ANSI lines, SSE bytes, or debug samples as statistics truth.
- Do not use stats to influence Virtual Router, Target selection, provider health, cooldown, retry, continuation, or error policy.
- Do not store raw request bodies, response bodies, prompt text, assistant text, tool output text, image bytes/base64, request headers, provider headers, auth handles, token paths, or raw metadata.
- Do not put stats into provider/client normal payload.
- Do not create remote/public stats endpoints in M0.
- Do not add a WebUI dashboard in M0.
- Do not make stats a fallback/repair path for missing runtime observability.

## 4. Evidence From Existing Code

### 4.1 V2 Prototype To Learn From, Not Reuse

`src/server/runtime/http-server/stats-manager.ts` currently has:

- `StatsManager`
- `recordRequestStart(requestId)`
- `bindProvider(requestId, provider/model/port)`
- `recordCompletion(requestId, usage/error)`
- `recordToolUsage(meta, payload)`
- in-memory session buckets
- periodic JSONL persistence to `provider-stats.jsonl`
- daily/weekly/monthly historical projections
- non-blocking persistence warnings

`src/server/runtime/http-server/daemon-admin/stats-handler.ts` exposes:

- `/daemon/stats`

V2 lessons to keep:

- Inflight request start and provider binding are separate events.
- Provider rows need provider/model/port dimensions.
- Persistence failure must be non-blocking and visible.
- Historical period rollups are useful.
- JSONL snapshots are simple but too coarse for V3's Direct/Relay/attempt/switch/error chain needs.

V2 parts not to carry forward as V3 truth:

- TS runtime owner.
- Snapshot-only persistence as the primary truth.
- Tool/payload scanning for stats semantics.
- Admin endpoint shape tied to V2 daemon.

### 4.2 V3 Current Observability Surface

`v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` defines:

- `V3RuntimeUsageSummary`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `cached_tokens`
- `V3RuntimeProviderFailureObservation`
  - provider id/key/auth/model/status
  - external error kind/code/status
  - internal code
  - health state/cooldown/action/next provider/wait
- `V3RuntimeObservability`
  - entry protocol, execution mode, transport
  - routing group, pool, provider, auth, provider key/type, model, wire model
  - provider status, response status, finish reason
  - attempts, unavailable candidates, provider failure events, target path, usage
- `V3RuntimeStreamObservation`
  - SSE terminal response status, finish reason, usage

`v3/crates/routecodex-v3-server/src/lib.rs` currently emits console lines from runtime observability. It also has the known temporary timing issue:

```rust
let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
let internal_ms = elapsed_ms;
let external_ms = 0.0;
```

Therefore current console `time_i/time_e` is not an authoritative stats source. It is only a display projection.

### 4.3 Current Architecture Maps

Existing V3 maps already contain request, response, route, target, error, provider health, debug, and continuation resources. There is no `v3.stats.*` family yet.

Relevant existing mainline nodes and edges for stats event taps:

- `V3Server03HttpRequestRaw`
- `V3Req04StandardizedResponses`
- `V3Router05RequestClassified`
- `V3Router06RoutePoolResolved`
- `V3Router07OpaqueTargetHitOnce`
- `V3Target09CandidateSetExpanded`
- `V3Target10ConcreteProviderSelected`
- `V3Execution11ProtocolDecision`
- `V3ResponsesDirect11Policy`
- `V3Provider12ResponsesWirePayload`
- `V3Transport13ResponsesHttpRequest`
- `V3ProviderResp14Raw`
- `V3Resp15ClientPayload`
- `V3Server16HttpFrame`
- Hub v1 request/response nodes
- `V3Error01SourceRaised` through `V3Error06ClientProjected`

These are the source-adjacent events; stats does not replace these nodes.

## 5. Architecture Contract

### 5.1 Topology

```text
V3 runtime/server nodes
  -> V3StatsEventEmitter side-channel call
  -> V3StatsRecorder::record(event)
  -> bounded queue
  -> V3StatsEventLog01AppendOnly SQLite writer
  -> V3StatsRollup02Projector hourly/daily projections
  -> V3StatsReader03Query
  -> rccv3 stats / local diagnostics HTTP
```

### 5.2 Hard Rules

1. Mainline nodes emit typed stats events; they do not aggregate.
2. `routecodex-v3-stats` is the only writer to stats storage.
3. `routecodex-v3-stats` is the only reader/aggregator for stats queries.
4. Stats events are side-channel records and never part of provider/client normal payload.
5. Stats cannot mutate routing, health, retry, cooldown, continuation, protocol decision, or error policy.
6. Writer failures update `v3.stats.writer_health`; they do not fail normal requests.
7. If stats input cannot be sanitized, fail the stats event locally and record writer health; do not silently persist unsafe fields.
8. Dry-run must be bucketed separately and must not increment provider network attempt counts.
9. Client disconnect is client closeout, not provider failure.
10. `[DONE]` is transport sentinel only; it is not terminal semantic success for usage/statistics.

### 5.3 Ownership

Owner crate:

```text
v3/crates/routecodex-v3-stats
```

Allowed integration crates:

```text
v3/crates/routecodex-v3-runtime
v3/crates/routecodex-v3-server
v3/crates/routecodex-v3-cli
v3/crates/routecodex-v3-config
v3/crates/routecodex-v3-lifecycle
```

Forbidden owners:

```text
src/**
sharedmodule/**
v3/crates/routecodex-v3-sse
v3/crates/routecodex-v3-debug
provider runtime crates as aggregators
server console/log formatter as aggregator
```

Clarification: provider/runtime/server may call `V3StatsRecorder::record`; they may not open the stats DB, compute rollups, or answer stats queries.

## 6. Resource Model To Add

Add these resources to `docs/architecture/v3-resource-operation-map.yml` before runtime implementation.

### 6.1 `v3.stats.event_log`

```yaml
resource_id: v3.stats.event_log
resource_kind: statistics_event_log
lifecycle: v3.provider_statistics
owner_feature_id: v3.provider_statistics
owner_crate: routecodex-v3-stats
owner_node: V3StatsEventLog01AppendOnly
identity: [serverId, requestId, eventSeq, eventKind]
allowed_writers: [V3StatsRecorder::record, V3StatsEventLog01AppendOnly::append]
allowed_readers: [V3StatsRollup02Projector, V3StatsReader03Query]
forbidden_writers: [routecodex-v3-runtime, routecodex-v3-server, routecodex-v3-provider-responses, routecodex-v3-virtual-router, routecodex-v3-target, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-sse]
may_enter_provider_body: false
may_enter_client_body: false
binding_status: planned
```

### 6.2 `v3.stats.rollup_projection`

```yaml
resource_id: v3.stats.rollup_projection
resource_kind: statistics_rollup_projection
lifecycle: v3.provider_statistics
owner_feature_id: v3.provider_statistics
owner_crate: routecodex-v3-stats
owner_node: V3StatsRollup02Projector
identity: [bucketKind, periodStart, providerKey, routeName, modelId, errorClass]
allowed_writers: [V3StatsRollup02Projector::project]
allowed_readers: [V3StatsReader03Query]
forbidden_writers: [routecodex-v3-runtime, routecodex-v3-server, routecodex-v3-provider-responses, routecodex-v3-virtual-router, routecodex-v3-target, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-sse]
may_enter_provider_body: false
may_enter_client_body: false
binding_status: planned
```

### 6.3 `v3.stats.query_projection`

```yaml
resource_id: v3.stats.query_projection
resource_kind: statistics_query_projection
lifecycle: v3.provider_statistics
owner_feature_id: v3.provider_statistics
owner_crate: routecodex-v3-stats
owner_node: V3StatsReader03Query
identity: [queryKind, timeRange, dimensions]
allowed_writers: [V3StatsReader03Query::query]
allowed_readers: [rccv3_stats_command, v3_local_stats_diagnostics]
forbidden_writers: [routecodex-v3-runtime, routecodex-v3-server, routecodex-v3-provider-responses, routecodex-v3-virtual-router, routecodex-v3-target, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-sse]
may_enter_provider_body: false
may_enter_client_body: true
client_body_scope: local_admin_or_cli_only
binding_status: planned
```

### 6.4 `v3.stats.writer_health`

```yaml
resource_id: v3.stats.writer_health
resource_kind: statistics_writer_health
lifecycle: v3.provider_statistics
owner_feature_id: v3.provider_statistics
owner_crate: routecodex-v3-stats
owner_node: V3StatsWriterHealth04State
identity: [serverId, sinkPath, lastErrorKind]
allowed_writers: [V3StatsRecorder::record_writer_health]
allowed_readers: [V3StatsReader03Query, rccv3_stats_health, v3_local_stats_health_diagnostics]
forbidden_writers: [routecodex-v3-runtime, routecodex-v3-server, routecodex-v3-provider-responses, routecodex-v3-virtual-router, routecodex-v3-target, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-sse]
may_enter_provider_body: false
may_enter_client_body: false
client_body_scope: local_admin_or_cli_health_only
binding_status: planned
```

### 6.5 `v3.stats.config_manifest`

```yaml
resource_id: v3.stats.config_manifest
resource_kind: statistics_config_manifest
lifecycle: v3.config.compile
owner_feature_id: v3.provider_statistics
owner_crate: routecodex-v3-config
owner_node: V3Config05ManifestPublished
identity: [enabled, storageKind, sinkPath, retentionDays, queueMaxEvents]
allowed_writers: [V3Config05ManifestPublished]
allowed_readers: [V3StatsRecorder::from_manifest, routecodex-v3-server startup]
forbidden_writers: [routecodex-v3-runtime, routecodex-v3-server, routecodex-v3-provider-responses, routecodex-v3-virtual-router, routecodex-v3-target, routecodex-v3-debug, routecodex-v3-error, routecodex-v3-sse]
may_enter_provider_body: false
may_enter_client_body: false
binding_status: planned
```

## 7. Function Map Entry To Add

Add `feature_id: v3.provider_statistics` to `docs/architecture/v3-function-map.yml`.

Planned entry:

```yaml
- feature_id: v3.provider_statistics
  owner_crates:
    - routecodex-v3-stats
  owner_files:
    - v3/crates/routecodex-v3-stats/src/lib.rs
    - v3/crates/routecodex-v3-stats/src/event.rs
    - v3/crates/routecodex-v3-stats/src/recorder.rs
    - v3/crates/routecodex-v3-stats/src/store.rs
    - v3/crates/routecodex-v3-stats/src/rollup.rs
    - v3/crates/routecodex-v3-stats/src/query.rs
    - v3/crates/routecodex-v3-stats/src/health.rs
    - v3/crates/routecodex-v3-stats/src/sanitize.rs
  integration_files:
    - v3/crates/routecodex-v3-runtime/src/kernel.rs
    - v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs
    - v3/crates/routecodex-v3-server/src/lib.rs
    - v3/crates/routecodex-v3-cli/src/main.rs
    - v3/crates/routecodex-v3-config/src/lib.rs
  resource_bindings:
    - v3.stats.config_manifest
    - v3.stats.event_log
    - v3.stats.rollup_projection
    - v3.stats.query_projection
    - v3.stats.writer_health
  mainline_bindings:
    - v3-stats-01
    - v3-stats-02
    - v3-stats-03
    - v3-stats-04
    - v3-stats-05
    - v3-stats-06
    - v3-stats-07
    - v3-stats-08
  entry_symbols:
    - V3StatsRecorder::record
    - V3StatsEventLog01AppendOnly::append
    - V3StatsRollup02Projector::project
    - V3StatsReader03Query::summary
    - V3StatsReader03Query::provider_performance
    - V3StatsReader03Query::route_branches
    - V3StatsReader03Query::errors
    - V3StatsReader03Query::health
  allowed_paths:
    - v3/crates/routecodex-v3-stats
    - v3/crates/routecodex-v3-runtime
    - v3/crates/routecodex-v3-server
    - v3/crates/routecodex-v3-cli
    - v3/crates/routecodex-v3-config
    - docs/goals/v3-provider-statistics-implementation-plan.md
    - docs/architecture/v3-resource-operation-map.yml
    - docs/architecture/v3-function-map.yml
    - docs/architecture/v3-mainline-call-map.yml
    - docs/architecture/v3-verification-map.yml
    - docs/architecture/wiki/v3-provider-statistics.md
  forbidden_paths:
    - src
    - sharedmodule
    - v3/crates/routecodex-v3-sse
    - v3/crates/routecodex-v3-debug as stats writer
    - provider/client normal payload builders
    - ~/.rcc provider config
    - live provider config
  required_gates:
    - npm run verify:v3-provider-statistics
    - npm run test:v3-provider-statistics-red-fixtures
    - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-stats --lib
    - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime stats --lib
    - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server stats --lib
    - npm run verify:v3-resource-map
    - npm run verify:v3-architecture-docs
    - npm run verify:v3-module-boundaries
    - npm run verify:v3-rust-only
    - cargo fmt --manifest-path v3/Cargo.toml --all -- --check
    - git diff --check
  runtime_status: planned_design_locked_no_runtime_code
```

## 8. Mainline Call Map Edges To Add

Add a stats side-channel chain to `docs/architecture/v3-mainline-call-map.yml`. These edges must be marked as side-channel writes. They must not replace the request, response, Direct, Relay, or error mainlines.

### 8.1 Stats Chain

```yaml
- chain_id: v3.provider_statistics.side_channel
  owner_feature_id: v3.provider_statistics
  summary: V3 stats side-channel event emission, append-only persistence, rollup, and local query projection. It never mutates execution decisions.
  edges:
    - step_id: v3-stats-01
      from_node: V3Config05ManifestPublished
      to_node: V3StatsConfig00Manifest
      caller_symbol: V3StatsRecorder::from_manifest
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsConfig::from_manifest
      callee_file: v3/crates/routecodex-v3-stats/src/config.rs
      status: planned
      resource_flow:
        consumes: [v3.stats.config_manifest]
        produces: []
        side_channel_reads: [v3.stats.config_manifest]
        side_channel_writes: []

    - step_id: v3-stats-02
      from_node: V3Server03HttpRequestRaw
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_request_started
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.request.protocol_context]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.request.protocol_context]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-03
      from_node: V3Router06RoutePoolResolved
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_route_selected
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.route.selection_plan]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.route.selection_plan]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-04
      from_node: V3Target10ConcreteProviderSelected
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_target_selected
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.target.concrete_provider]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.target.concrete_provider]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-05
      from_node: V3Transport13ResponsesHttpRequest
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_provider_attempt_started
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.provider.transport_request]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.provider.transport_request]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-06
      from_node: V3ProviderResp14Raw
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_provider_attempt_completed
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.response.provider_raw]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.response.provider_raw]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-07
      from_node: V3Error06ClientProjected
      to_node: V3StatsEventLog01AppendOnly
      caller_symbol: V3StatsRecorder::record_error_projected
      caller_file: v3/crates/routecodex-v3-stats/src/recorder.rs
      callee_symbol: V3StatsEventLog01AppendOnly::append
      callee_file: v3/crates/routecodex-v3-stats/src/store.rs
      status: planned
      resource_flow:
        consumes: [v3.error.client_projection]
        produces: [v3.stats.event_log]
        side_channel_reads: [v3.error.client_projection]
        side_channel_writes: [v3.stats.event_log]

    - step_id: v3-stats-08
      from_node: V3StatsEventLog01AppendOnly
      to_node: V3StatsRollup02Projector
      caller_symbol: V3StatsRollup02Projector::project
      caller_file: v3/crates/routecodex-v3-stats/src/rollup.rs
      callee_symbol: V3StatsReader03Query::query
      callee_file: v3/crates/routecodex-v3-stats/src/query.rs
      status: planned
      resource_flow:
        consumes: [v3.stats.event_log]
        produces: [v3.stats.rollup_projection, v3.stats.query_projection]
        side_channel_reads: [v3.stats.event_log]
        side_channel_writes: [v3.stats.rollup_projection, v3.stats.query_projection]
```

### 8.2 Event Tap Rules By Existing Node

| Existing node | Event kind | Required fields | Forbidden fields |
| --- | --- | --- | --- |
| `V3Server03HttpRequestRaw` | `request_started` | request id, server id, port, endpoint, method, entry protocol, stream intent, dry-run marker | body, headers, metadata |
| `V3Router06RoutePoolResolved` | `route_selected` | routing group, route, pool, default/primary marker, reason, route signals summary | payload, prompt |
| `V3Router07OpaqueTargetHitOnce` | `route_target_hit` | target id, hit count, pool, unavailable summary counts | raw candidate config secrets |
| `V3Target10ConcreteProviderSelected` | `target_selected` | provider id, auth alias label, provider type/protocol, model, wire model, attempt index, target path ids | auth token/path |
| `V3Execution11ProtocolDecision` | `execution_mode_decided` | direct/relay, entry protocol, provider protocol, mismatch reason if relay | provider/client payload |
| `V3Transport13ResponsesHttpRequest` | `provider_attempt_started` | attempt id, provider key, protocol, external_start_ms | URL query with secrets, headers, body |
| `V3ProviderResp14Raw` | `provider_attempt_completed` | status, first_byte_ms, external_end_ms, response kind, semantic terminal marker if known | raw response/SSE lines |
| `V3Resp15ClientPayload` / `V3HubRespOutbound05ClientSemantic` | `response_completed` | response status, finish reason, usage, continuation owner/outcome | response body text/output |
| `V3Error01..06` | `error_projected` | source kind, internal code, external kind/status/code, Error06 status/subcode, action | raw error body unless sanitized code/status only |
| `V3Server16HttpFrame` / `V3ServerRespOutbound06ClientFrame` | `client_completed` / `client_disconnected` | client status, total elapsed, bytes sent if available, disconnect class | frame body |

## 9. Event Schema

### 9.1 Rust Envelope

```rust
pub struct V3StatsEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub event_seq: u64,
    pub event_kind: V3StatsEventKind,
    pub timestamp_ms_utc: u64,
    pub monotonic_elapsed_ms: Option<u64>,
    pub server_id: String,
    pub port: Option<u16>,
    pub request_id: String,
    pub execution_id: Option<String>,
    pub attempt_id: Option<String>,
    pub session_scope_hash: Option<String>,
    pub dimensions: V3StatsDimensions,
    pub payload: V3StatsEventPayload,
}
```

### 9.2 Event Kinds

```rust
pub enum V3StatsEventKind {
    RequestStarted,
    RouteSelected,
    RouteTargetHit,
    TargetSelected,
    ExecutionModeDecided,
    ProviderAttemptStarted,
    ProviderAttemptCompleted,
    ProviderSwitchObserved,
    ResponseCompleted,
    ErrorProjected,
    ClientCompleted,
    ClientDisconnected,
    StatsWriterHealthUpdated,
}
```

### 9.3 Dimensions

```rust
pub struct V3StatsDimensions {
    pub entry_protocol: Option<String>,
    pub endpoint: Option<String>,
    pub method: Option<String>,
    pub execution_mode: Option<String>,
    pub transport: Option<String>,
    pub stream_intent: Option<bool>,
    pub dry_run: bool,

    pub routing_group_id: Option<String>,
    pub route_name: Option<String>,
    pub pool_id: Option<String>,
    pub target_id: Option<String>,
    pub route_reason: Option<String>,

    pub provider_id: Option<String>,
    pub auth_alias: Option<String>,
    pub provider_key: Option<String>,
    pub provider_type: Option<String>,
    pub provider_protocol: Option<String>,
    pub model_id: Option<String>,
    pub wire_model: Option<String>,
    pub request_model: Option<String>,

    pub continuation_owner: Option<String>,
    pub continuation_outcome: Option<String>,
    pub project_hash: Option<String>,
}
```

### 9.4 Payload Variants

Payloads must be enum variants with typed structs, not arbitrary `serde_json::Value` as the primary API. JSON is allowed only as the storage serialization of typed structs after sanitize validation.

```rust
pub enum V3StatsEventPayload {
    RequestStarted(V3StatsRequestStarted),
    RouteSelected(V3StatsRouteSelected),
    TargetSelected(V3StatsTargetSelected),
    ExecutionModeDecided(V3StatsExecutionModeDecided),
    ProviderAttemptStarted(V3StatsProviderAttemptStarted),
    ProviderAttemptCompleted(V3StatsProviderAttemptCompleted),
    ProviderSwitchObserved(V3StatsProviderSwitchObserved),
    ResponseCompleted(V3StatsResponseCompleted),
    ErrorProjected(V3StatsErrorProjected),
    ClientCloseout(V3StatsClientCloseout),
    WriterHealth(V3StatsWriterHealthSnapshot),
}
```

### 9.5 Timing Payload

```rust
pub struct V3StatsTimingSpans {
    pub request_started_ms_utc: Option<u64>,
    pub internal_started_ms: Option<u64>,
    pub provider_send_started_ms: Option<u64>,
    pub provider_first_byte_ms: Option<u64>,
    pub provider_terminal_ms: Option<u64>,
    pub response_projected_ms: Option<u64>,
    pub client_closed_ms: Option<u64>,
    pub internal_elapsed_ms: Option<u64>,
    pub external_provider_elapsed_ms: Option<u64>,
    pub first_byte_elapsed_ms: Option<u64>,
    pub stream_elapsed_ms: Option<u64>,
    pub total_elapsed_ms: Option<u64>,
}
```

Rule: initial M0 may emit only fields the runtime can prove. Missing spans remain null; do not derive fake `internal=elapsed`, `external=0` in stats.

### 9.6 Usage Payload

```rust
pub struct V3StatsUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}
```

Mapping sources:

- OpenAI Responses: `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens`, `usage.input_tokens_details.cached_tokens`.
- OpenAI Chat: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`, details if present.
- Anthropic: `usage.input_tokens`, `usage.output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- Gemini: `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`.

M0 can record the subset currently normalized by V3 runtime, but the schema must already distinguish cache read and cache creation so Anthropic/Gemini parity can be added without breaking storage.

## 10. Forbidden Data Contract

Stats must reject or sanitize events containing these field families:

- `body`, `request_body`, `response_body`, `payload`, `raw_payload`, `raw_body`
- `headers`, `authorization`, `api_key`, `token`, `secret`, `cookie`
- `metadata`, `client_metadata`, `x-codex-*` raw objects
- `input`, `messages`, `content`, `output`, `output_text`, `text`, `arguments`
- `image_url`, `base64`, `data:image`, `file_data`, `inlineData.data`
- `tool_result`, `tool_output`, `stdout`, `stderr`, `patch`, `diff`
- raw SSE `data:` lines

Allowed sanitized identifiers:

- provider id/key
- auth alias label, not secret/token path
- model id/wire model
- route group/route/pool/target id
- endpoint/protocol/method
- error code/status/subcode/internal code/external status
- stable request id/execution id/attempt id
- local project hash if enabled

Sanitizer red fixtures must include nested JSON attempts to smuggle these keys.

## 11. Metrics To Derive

Stats reports internal RouteCodex/runtime errors and external provider/upstream errors as separate dimensions. A stats writer/store failure is a `v3.stats.writer_health` condition only; it is not a provider error, not an Error01-06 provider failure, and not eligible for provider switch/retry policy.

### 11.1 Provider Performance

Group by provider/model/auth/route/protocol/execution mode:

- request count
- provider attempt count
- success count
- error count
- switch count
- retry count
- client disconnect count
- internal runtime error count
- external provider error count
- total latency sum/max/avg
- internal latency sum/max/avg
- external provider latency sum/max/avg
- first-byte latency sum/max/avg
- stream duration sum/max/avg
- p50/p95/p99 latency after histogram/sketch is introduced

### 11.2 Token And Cache Usage

Group by provider/model/route/hour/day:

- input tokens
- output tokens
- total tokens
- cached tokens
- cache read tokens
- cache creation tokens
- reasoning tokens
- cache hit ratio
- average tokens/request
- average tokens/success
- tokens by error class if upstream provides terminal usage

### 11.3 Route Branch Statistics

Group by routing group/route/pool/target/hour/day:

- route selected count
- target selected count
- provider chosen distribution
- direct count
- relay count
- route hit ratio
- default pool hit count
- default floor/final default route count when represented by route events
- dry-run count separated from real request count

### 11.4 Error Classification

Group by provider/model/route/hour/day:

- Error01 source kind
- Error06 HTTP status/subcode
- internal RouteCodex code
- external provider kind/status/code
- provider failure action: switch, retry, cooldown, exclude, terminal
- provider transport error count
- provider response codec error count
- provider semantic error count
- local runtime/config/auth error count
- client input error count
- client disconnect count

### 11.5 Streaks

Derived from ordered events only:

- provider selection streak
- provider success streak
- provider error streak
- route branch streak
- daily max streak
- continuous provider switch streak

Streaks are query/rollup projections only and must not feed health or routing.

## 12. Storage Design

### 12.1 Choice

Use SQLite WAL with synchronous normal, local file locking, and schema migrations.

Recommended dependency:

```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```

Use `rusqlite` inside a background writer thread or blocking task. Do not run SQLite writes on async request hot path.

### 12.2 Default Path

```text
~/.rcc/stats/v3/stats.sqlite
```

Path resolution must be in stats/config/lifecycle utility code, not duplicated in runtime nodes.

### 12.3 Tables

#### `schema_migrations`

```sql
version INTEGER PRIMARY KEY,
applied_at_ms INTEGER NOT NULL,
description TEXT NOT NULL
```

#### `stats_events`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
schema_version INTEGER NOT NULL,
event_id TEXT NOT NULL UNIQUE,
event_seq INTEGER NOT NULL,
event_kind TEXT NOT NULL,
timestamp_ms_utc INTEGER NOT NULL,
server_id TEXT NOT NULL,
port INTEGER,
request_id TEXT NOT NULL,
execution_id TEXT,
attempt_id TEXT,
session_scope_hash TEXT,
entry_protocol TEXT,
endpoint TEXT,
execution_mode TEXT,
transport TEXT,
dry_run INTEGER NOT NULL DEFAULT 0,
routing_group_id TEXT,
route_name TEXT,
pool_id TEXT,
target_id TEXT,
provider_id TEXT,
auth_alias TEXT,
provider_key TEXT,
provider_type TEXT,
provider_protocol TEXT,
model_id TEXT,
wire_model TEXT,
request_model TEXT,
continuation_owner TEXT,
error_status INTEGER,
error_subcode TEXT,
internal_code TEXT,
external_error_kind TEXT,
external_error_code TEXT,
external_error_status INTEGER,
payload_json TEXT NOT NULL
```

Indexes:

```sql
CREATE INDEX idx_stats_events_time ON stats_events(timestamp_ms_utc);
CREATE INDEX idx_stats_events_request ON stats_events(request_id, event_seq);
CREATE INDEX idx_stats_events_provider_time ON stats_events(provider_key, model_id, timestamp_ms_utc);
CREATE INDEX idx_stats_events_route_time ON stats_events(routing_group_id, route_name, pool_id, timestamp_ms_utc);
CREATE INDEX idx_stats_events_kind_time ON stats_events(event_kind, timestamp_ms_utc);
CREATE INDEX idx_stats_events_error_time ON stats_events(error_subcode, internal_code, external_error_code, timestamp_ms_utc);
```

#### `stats_rollup_hourly`

Dimensions:

- `bucket_start_ms_utc`
- `server_id`
- `port`
- `routing_group_id`
- `route_name`
- `pool_id`
- `provider_key`
- `provider_id`
- `provider_type`
- `provider_protocol`
- `model_id`
- `wire_model`
- `execution_mode`
- `transport`
- `dry_run`
- `error_subcode`
- `internal_code`
- `external_error_code`

Counters:

- `request_count`
- `attempt_count`
- `success_count`
- `error_count`
- `switch_count`
- `retry_count`
- `client_disconnect_count`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `cached_tokens`
- `cache_read_tokens`
- `cache_creation_tokens`
- `latency_total_ms_sum`
- `latency_total_ms_max`
- `latency_external_ms_sum`
- `latency_external_ms_max`
- `first_byte_ms_sum`
- `first_byte_ms_max`

#### `stats_rollup_daily`

Same logical fields as hourly, bucketed by local day plus stored UTC start/end.

#### `stats_writer_health`

```sql
server_id TEXT NOT NULL,
sink_path TEXT NOT NULL,
last_success_ms INTEGER,
last_error_ms INTEGER,
last_error_kind TEXT,
last_error_message_sanitized TEXT,
queued_event_count INTEGER NOT NULL DEFAULT 0,
dropped_event_count INTEGER NOT NULL DEFAULT 0,
sanitation_reject_count INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY(server_id, sink_path)
```

## 13. Writer Semantics

### 13.1 Request Path

Runtime/server code gets a cheap handle:

```rust
#[derive(Clone)]
pub struct V3StatsRecorderHandle { /* sender + static dims */ }
```

Call shape:

```rust
recorder.record(V3StatsEvent::target_selected(...));
```

`record` behavior:

1. Validate event schema version.
2. Run sanitizer on dimensions and payload.
3. Try enqueue to bounded channel.
4. If enqueue succeeds, return immediately.
5. If queue full, increment in-memory dropped count and update writer health asynchronously.
6. If sanitizer rejects, increment sanitation reject count and update writer health.
7. Never panic on normal path.

### 13.2 Background Writer

Background writer owns SQLite connection:

- creates parent directory with private permissions where applicable
- opens SQLite WAL
- applies migrations
- batches events
- writes append-only rows
- updates rollups periodically or on batch flush
- updates writer health
- flushes on shutdown with bounded timeout

### 13.3 Failure Policy

Stats writer failure classes:

- `StatsDbOpenFailed`
- `StatsMigrationFailed`
- `StatsInsertFailed`
- `StatsRollupFailed`
- `StatsQueueFull`
- `StatsSanitizeRejected`
- `StatsShutdownFlushTimedOut`

Projection:

- visible via `rccv3 stats health`
- visible via local diagnostics health
- server warning allowed with throttle
- not projected as request/provider/client failure
- not considered provider failure
- not counted as provider error

## 14. Reader Semantics

### 14.1 Rust API

```rust
pub struct V3StatsQuery {
    pub range_start_ms_utc: Option<u64>,
    pub range_end_ms_utc: Option<u64>,
    pub group_by: Vec<V3StatsDimensionKey>,
    pub filters: V3StatsFilters,
    pub limit: Option<u32>,
}

pub trait V3StatsReader {
    fn summary(&self, query: V3StatsQuery) -> Result<V3StatsSummary, V3StatsError>;
    fn provider_performance(&self, query: V3StatsQuery) -> Result<V3ProviderStatsTable, V3StatsError>;
    fn route_branches(&self, query: V3StatsQuery) -> Result<V3RouteStatsTable, V3StatsError>;
    fn tokens(&self, query: V3StatsQuery) -> Result<V3TokenStatsTable, V3StatsError>;
    fn errors(&self, query: V3StatsQuery) -> Result<V3ErrorStatsTable, V3StatsError>;
    fn request_timeline(&self, request_id: &str) -> Result<V3StatsRequestTimeline, V3StatsError>;
    fn health(&self) -> Result<V3StatsWriterHealthSnapshot, V3StatsError>;
}
```

### 14.2 CLI Surface

M0 CLI:

```text
rccv3 stats summary --since 24h
rccv3 stats providers --since today --group-by provider,model,route
rccv3 stats routes --since today --port 5555
rccv3 stats tokens --since today --group-by provider,model,route
rccv3 stats errors --since 7d --group-by provider,error
rccv3 stats request --request-id <id>
rccv3 stats health
```

Useful flags:

```text
--json
--since <1h|24h|today|7d|YYYY-MM-DD>
--until <timestamp>
--port <port>
--provider <provider_id_or_key>
--model <model_id>
--route <route_name>
--dry-run <include|exclude|only>
--group-by provider,model,route,hour,error
--limit <n>
```

### 14.3 Local Admin HTTP Surface

Add local diagnostics endpoints only:

```text
GET /_routecodex/diagnostics/stats/summary
GET /_routecodex/diagnostics/stats/providers
GET /_routecodex/diagnostics/stats/routes
GET /_routecodex/diagnostics/stats/tokens
GET /_routecodex/diagnostics/stats/errors
GET /_routecodex/diagnostics/stats/request/:requestId
GET /_routecodex/diagnostics/stats/health
```

Access control must match existing local diagnostics rules. No remote public stats in M0.

## 15. Configuration

### 15.1 TOML Authoring Proposal

```toml
[stats]
enabled = true
storage = "sqlite"
path = "~/.rcc/stats/v3/stats.sqlite"
retention_days = 90
flush_interval_ms = 1000
queue_max_events = 10000
local_admin_http_enabled = true
include_project_hash = true
include_project_path = false
```

### 15.2 Manifest Rule

`routecodex-v3-config` compiles authoring config into `V3Config05ManifestPublished`. Runtime/server/stats consume only the manifest. Runtime/server must not read config files directly.

If config authoring is deferred in M0, compile defaults into the manifest and mark TOML authoring as M1. Do not read env vars directly in runtime hot path as the long-term control plane.

### 15.3 Default Decision

M0 default recommendation:

- enabled by default
- local-only SQLite
- bounded queue
- no payload retention
- no project path retention
- 90-day retention

Reason: Jason wants provider performance visibility; local-only sanitized stats are low-risk and operationally useful. Writer health makes failures visible without disrupting model requests.

## 16. Implementation Phases

### Phase 0: Design, Maps, Review Surface, Gates

Deliverables:

- this design plan
- `v3.stats.*` resource entries
- `v3.provider_statistics` function map entry
- `v3.provider_statistics.side_channel` mainline chain
- verification map entry
- generated Markdown + HTML review surface
- red fixture scanner for forbidden patterns

No runtime event emission in Phase 0.

Acceptance:

- map parse gates pass
- architecture wiki render gates pass
- red fixture test fails on forbidden sample and passes on clean source
- `git diff --check` passes for docs/scripts

### Phase 1: `routecodex-v3-stats` Crate Skeleton

Create:

```text
v3/crates/routecodex-v3-stats/Cargo.toml
v3/crates/routecodex-v3-stats/src/lib.rs
v3/crates/routecodex-v3-stats/src/config.rs
v3/crates/routecodex-v3-stats/src/event.rs
v3/crates/routecodex-v3-stats/src/recorder.rs
v3/crates/routecodex-v3-stats/src/store.rs
v3/crates/routecodex-v3-stats/src/rollup.rs
v3/crates/routecodex-v3-stats/src/query.rs
v3/crates/routecodex-v3-stats/src/health.rs
v3/crates/routecodex-v3-stats/src/sanitize.rs
v3/crates/routecodex-v3-stats/src/time.rs
```

Add workspace member and dependency wiring only after crate unit tests exist.

Tests:

- event schema serde roundtrip
- sanitizer rejects forbidden keys and nested payload content
- SQLite store creates migrations and appends events
- duplicate `event_id` is idempotent or rejected deterministically
- rollup derives request/attempt/success/error/token counts from event replay
- writer health records DB open/insert/sanitize failures
- bounded queue records drops without panicking

### Phase 2: Runtime/Server Event Emission

Add a stats recorder handle to server/runtime state.

Emit typed events at:

- request accepted
- route selected
- target selected
- execution mode decided
- provider attempt start
- provider attempt complete/failure
- provider switch/retry observed
- response complete
- error projected
- client closeout/disconnect

Constraints:

- Direct and Relay emit the same event schema.
- Dry-run has `dry_run=true` and no provider network attempt completion unless it genuinely did a network send.
- Event emission must not clone provider/client bodies.
- Event emission must not require SSE stream materialization.
- Event emission must preserve mainline semantics if stats is disabled or unhealthy.

### Phase 3: Runtime Timing Truth

Add a timing span resource/struct emitted by runtime, not console:

```rust
pub struct V3RuntimeTimingObservation {
    pub request_started_ms_utc: u64,
    pub provider_send_started_ms: Option<u64>,
    pub provider_first_byte_ms: Option<u64>,
    pub provider_terminal_ms: Option<u64>,
    pub response_projected_ms: Option<u64>,
    pub client_closed_ms: Option<u64>,
}
```

Stats consumes this timing observation. Console may later display the same timing observation, but stats must not derive timing from console.

Minimum M0 timing:

- total elapsed
- external provider elapsed for non-dry-run requests
- first byte if available
- stream duration if available

Do not fake unavailable spans.

### Phase 4: Query Surface

Add CLI commands and local diagnostics HTTP endpoints.

M0 outputs:

- summary
- providers
- routes
- tokens
- errors
- request timeline
- health

Each CLI command must support `--json` for automated verification.

### Phase 5: Retention, Migration, Operational Hardening

Add:

- retention pruning
- schema migration tests
- concurrent read/write test
- shutdown flush test
- DB corruption/open failure health test
- live install/restart stats probe
- targeted DB scan proving no payload/header/secret strings

## 17. Test Design

### 17.1 Red / Negative Tests

These tests must fail before implementation or fail against intentionally bad fixtures:

1. V3 imports `src/server/runtime/http-server/stats-manager.ts` for stats truth -> fail.
2. V3 stats parses console `[usage]` lines -> fail.
3. `routecodex-v3-sse` writes stats semantic events -> fail.
4. Provider/client request or response body is serialized into stats event -> fail.
5. Header/secret/token/metadata/image/tool output key appears in stats event payload -> fail.
6. Stats writer failure returns non-2xx/non-original response for an otherwise valid request -> fail.
7. Provider health reads stats rollup -> fail.
8. Virtual Router reads stats rollup -> fail.
9. Target selection reads stats rollup -> fail.
10. Dry-run increments real provider network attempt count -> fail.
11. `[DONE]` without semantic terminal records success usage -> fail.
12. Provider switch increments request count twice -> fail; attempt count may increment twice.
13. Client disconnect increments provider failure count -> fail.
14. Stats stores raw project path while `include_project_path=false` -> fail.
15. Stats event uses untyped `serde_json::Value` as primary event payload owner -> fail, except storage serialization internals.
16. Stats DB is opened directly from runtime/server/provider crates -> fail.

### 17.2 Positive Tests

1. Single Direct JSON success records one request, one attempt, one success, usage tokens.
2. Direct SSE success records usage from semantic terminal event, not `[DONE]`.
3. Relay OpenAI Chat success records provider protocol `openai_chat`, route branch, provider attempt, usage.
4. Relay Anthropic success records cache read and cache creation tokens when source usage exposes them.
5. Gemini success records cached content and thoughts tokens when source usage exposes them.
6. Provider switch records failed first attempt, switch action, final success, and one request.
7. Provider 429 exhausted records external provider status/code and Error06 projection.
8. Local missing auth/config records internal code and HTTP 500 class without external provider status.
9. Unknown continuation records `responses_continuation_not_found` before provider attempt.
10. Dry-run records dry-run request/route/target events only and no provider network attempt.
11. Client disconnect records client disconnect class and does not count as provider failure.
12. Stats reader totals match raw event replay for the same time range.
13. Writer health reports DB failure/dropped event counts without changing request response.
14. Retention pruning removes old event rows and preserves newer rollups according to policy.

### 17.3 Required Gate Names

Add scripts:

```text
scripts/architecture/verify-v3-provider-statistics.mjs
scripts/tests/v3-provider-statistics-red-fixtures.mjs
```

Package scripts:

```json
"verify:v3-provider-statistics": "node scripts/architecture/verify-v3-provider-statistics.mjs",
"test:v3-provider-statistics-red-fixtures": "node scripts/tests/v3-provider-statistics-red-fixtures.mjs"
```

The verify script should check:

- `routecodex-v3-stats` exists when implementation starts.
- Maps contain `v3.provider_statistics` and `v3.stats.*` resources.
- No V3 stats owner imports V2 TS stats manager.
- No stats read imports in Virtual Router/Target/provider health.
- No stats DB open outside stats crate.
- No forbidden payload key literals in stats event structs/tests except red fixtures and sanitizer denylist.
- CLI/admin read surfaces call stats reader, not logs/debug samples.

## 18. Live Verification Plan

After source gates pass:

1. Build/install:

```text
RUSTUP_TOOLCHAIN=stable npm run install:v3
```

2. Config check:

```text
rccv3 config check -c /Volumes/extension/.rcc/config.v3.toml
```

3. Managed restart:

```text
rccv3 restart -c /Volumes/extension/.rcc/config.v3.toml
```

4. Health:

```text
curl -sS http://127.0.0.1:4444/health
curl -sS http://127.0.0.1:5555/health
curl -sS http://127.0.0.1:10000/health
```

5. Real probes:

- 4444 `/v1/responses` JSON success
- 5555 `/v1/responses` JSON success
- 5555 `/v1/responses` SSE success
- one controlled provider switch sample if cost/risk acceptable
- one controlled Error06 sample such as unknown continuation
- one provider-request dry-run sample

6. Query:

```text
rccv3 stats summary --since 1h --json
rccv3 stats providers --since 1h --json
rccv3 stats routes --since 1h --json
rccv3 stats tokens --since 1h --json
rccv3 stats errors --since 1h --json
rccv3 stats health --json
```

7. Cross-check:

- Query rows include the request ids from live probes.
- Request count equals real requests, not attempts.
- Attempt count reflects provider switches.
- Dry-run is separate.
- Unknown continuation has no provider attempt.
- Client disconnect, if tested, is not provider failure.
- `stats.sqlite` exists.
- Targeted scan finds no prompt text, assistant text, raw image base64, auth secret, or raw header strings.

## 19. Rollout And Migration

M0 creates a new V3 stats store. It does not migrate V2 `provider-stats.jsonl` into V3 truth.

Optional M1 migration can provide a one-time import tool with explicit marking:

```text
source_version = "v2_jsonl_import"
truth_level = "historical_projection_only"
```

Imported V2 data must not mix with V3 event truth without source tagging.

## 20. Acceptance Criteria

This feature is complete only when all of these are true:

1. `v3.stats.*` resources are in resource map.
2. `v3.provider_statistics` is in function map.
3. Stats side-channel chain is in mainline call map.
4. Verification map lists required gates.
5. Generated wiki/HTML review surface exists and passes sync/render gates.
6. `routecodex-v3-stats` owns event schema, writer, store, rollup, query, and writer health.
7. Runtime/server only emit typed stats events.
8. No V2 TS stats manager is used as V3 truth.
9. Direct/Relay/JSON/SSE/provider protocol paths share the same event schema.
10. Stats writer failure is visible but non-fatal to user requests.
11. CLI and local admin reads come only from stats reader.
12. Red and positive tests pass.
13. Global install/restart/live query validation passes on managed V3 instance.
14. Final note/MEMORY/skill updates record only verified facts.

## 21. Open Decisions Before Runtime Implementation

1. SQLite crate: default recommendation is `rusqlite` with a background writer thread.
2. M0 default enabled: recommendation is enabled local-only with bounded queue.
3. Project path: recommendation is hash only; raw path disabled unless explicitly enabled.
4. Per-request timeline in M0: recommendation is yes for local admin/CLI because it is high diagnostic value and low cost.
5. Retention of raw event log vs rollups: recommendation is 90 days event log, longer rollups later if needed.
6. Multi-process writers: if one aggregate server process owns multiple ports, one writer handle per aggregate is sufficient. If future multiple processes write to the same DB, SQLite WAL supports it, but stats writer health must include process/server identity.

## 22. Why This Design Fits V3 Architecture

- It follows the resource center rule: statistics has explicit resources, owners, identities, allowed writers/readers, and forbidden edges.
- It follows the mainline rule: stats edges are adjacent side-channel observations of existing nodes; they do not shortcut request/response/error chains.
- It follows the Rust truth rule: the new owner is a Rust crate; TS V2 stats remains only audit evidence.
- It follows metadata/payload isolation: stats stores dimensions and counters, never raw payloads or metadata objects.
- It follows no-fallback: stats writer failures are reported as stats health failures, not silently converted to success truth and not used to repair runtime behavior.
- It keeps routing and capability separate: stats can report route hits and provider performance but cannot become route/capability input.
- It preserves Direct/Relay semantics: event schema observes both paths without forcing protocol conversion or SSE materialization.
- It keeps Error01-06 identity: stats records internal and external error fields from the error chain instead of flattening them into one ambiguous provider error.

## 23. Immediate Next Implementation Order

1. Add map entries and verification map entry.
2. Add review surface source and renderer/gate updates.
3. Add red fixture scanner.
4. Create `routecodex-v3-stats` crate with schema/sanitizer/store tests.
5. Wire recorder handle into server/runtime without enabling event taps by default until crate tests pass.
6. Add event taps one lifecycle slice at a time: request/route/target first, provider attempts second, response/error/client closeout third.
7. Add CLI and diagnostics readers.
8. Build/install/restart/live verify.
