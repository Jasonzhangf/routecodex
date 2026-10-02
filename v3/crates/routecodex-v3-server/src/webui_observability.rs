// feature_id: v3.webui_request_observability
// Typed request-observability projection owner (contract-as-code).
// This is a typed side-channel projection host: it merges lifecycle events
// from existing V3 runtime observability sources into one row per request and
// appends that row to the per-listener JSONL store. Admin reads the same store
// directly; there is no loopback snapshot/event transport.
//
// P0 boundary: NO control semantics enter business payload, and the projection
// does not own routing/retry/provider-health/error-policy truth. It only
// projects already-typed observability data. Store IO errors remain explicit
// and are never recovered into success.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const V3_WEBUI_RECENT_REQUEST_CAPACITY: usize = 10_000;
const V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY: usize = 1_024;
const V3_WEBUI_HISTORY_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Unique request key: `<port>:<requestId>`.
pub(crate) fn build_v3_obs_request_key(port: u16, request_id: &str) -> String {
    format!("{port}:{request_id}")
}

/// Single server-side ingress for the typed request-observability projection.
/// Console/runtime/Error06 callers must not call V3WebuiObservability methods directly.
pub(crate) fn record_v3_observability_event(
    observability: &V3WebuiObservability,
    event_type: V3ObsEventType,
    request_key: &str,
    scope: V3ObsScope,
    meta: V3ObsRequestMeta,
    runtime_observability: &crate::V3RuntimeObservability,
) -> Result<u64, String> {
    observability.record_observed(event_type, request_key, scope, meta, runtime_observability)
}

/// Record the terminal Error06 projection for the WebUI request ledger.
/// This is the single error-to-WebUI projection owner; callers provide only
/// the already-projected client status/body plus the typed Error06 truth their
/// lane exposes (`V3ObsErrorProjection`). Nothing is re-classified here.
pub(crate) fn record_v3_webui_error_projection(
    observability: &V3WebuiObservability,
    port: u16,
    request_id: &str,
    endpoint: &str,
    entry_protocol: &str,
    project_path: Option<&str>,
    session: Option<&str>,
    status: u16,
    body: Option<&Value>,
    typed: V3ObsErrorProjection<'_>,
) -> Result<u64, String> {
    let (error_category, error_detail) = body
        .map(crate::v3_error_body_code_message)
        .map(|(code, message)| (code, message))
        .unwrap_or_else(|| (format!("http_{status}"), format!("HTTP status {status}")));
    let request_key = build_v3_obs_request_key(port, request_id);
    let scope = V3ObsScope {
        port,
        workdir: project_path.map(str::to_string),
        session: session.map(str::to_string),
    };
    let observed_error = V3ObsErrorTruth {
        source: if typed.exposed {
            "error06_projection"
        } else {
            "error06_projection_not_exposed"
        }
        .to_string(),
        error_class: typed.error_class.map(str::to_string),
        chain: build_v3_obs_error_chain(typed.error_chain, typed.error_class, status),
        upstream_request_id: typed.upstream_request_id.map(str::to_string),
        health_action: match typed.health_action {
            Some(plan) => Some(v3_obs_health_action_from_plan(plan)?),
            None => None,
        },
        ..Default::default()
    };
    let meta = V3ObsRequestMeta {
        request_id: request_id.to_string(),
        endpoint: endpoint.to_string(),
        entry_protocol: Some(entry_protocol.to_string()),
        provider_status: Some(status),
        response_status: Some("error".to_string()),
        finish_reason: Some("error".to_string()),
        route: Some("-".to_string()),
        error_category: Some(error_category),
        error_detail: Some(error_detail),
        observed_error: Some(observed_error),
        ..Default::default()
    };
    record_v3_observability_event(
        observability,
        V3ObsEventType::Failed,
        &request_key,
        scope,
        meta,
        &crate::V3RuntimeObservability::default(),
    )
}

/// `true` when this lane ran the typed Error path in-process and therefore holds
/// the typed `V3Error06ClientProjected`: the direct lane, stamped by
/// `build_v3_direct_runtime_observability`.
///
/// The relay lane genuinely cannot carry the typed projection (`plan §9.4`
/// boundary A), so only a lane that does *not* hold it may record the explicit
/// `error06_projection_not_exposed` absence marker. An unknown or empty mode
/// reports `false` so an unfamiliar lane keeps the marker rather than silently
/// losing its observed_error.
pub(crate) fn v3_obs_lane_holds_typed_error06(lane: &crate::V3RuntimeObservability) -> bool {
    lane.execution_mode == V3_OBS_EXECUTION_MODE_DIRECT
}

/// Execution mode string stamped by the direct runtime lane.
const V3_OBS_EXECUTION_MODE_DIRECT: &str = "direct";

/// Typed-error projection for the direct lane.
///
/// A direct `V3Server16HttpFrame` was projected from the typed
/// `V3Error06ClientProjected`, so a non-empty `error_chain` IS real typed truth:
/// the chain and the client status are forwarded verbatim. A frame without a
/// chain has no typed truth to expose, so it records the honest absence marker
/// instead of an empty chain that would read as "no error chain". `error_class`
/// and `health_action` are not carried by the frame, so they stay unobserved
/// here rather than being re-derived.
pub(crate) fn v3_obs_error_projection_for_direct_frame<'a>(
    error_chain: &'a [&'static str],
) -> V3ObsErrorProjection<'a> {
    V3ObsErrorProjection {
        exposed: !error_chain.is_empty(),
        error_chain,
        ..Default::default()
    }
}

fn merge_v3_obs_request_meta(
    previous: V3ObsRequestMeta,
    incoming: V3ObsRequestMeta,
) -> V3ObsRequestMeta {
    let route = incoming
        .route
        .filter(|value| !value.trim().is_empty() && value != "-")
        .or(previous.route);
    V3ObsRequestMeta {
        request_id: if incoming.request_id.is_empty() {
            previous.request_id
        } else {
            incoming.request_id
        },
        endpoint: if incoming.endpoint.is_empty() {
            previous.endpoint
        } else {
            incoming.endpoint
        },
        model: incoming.model.or(previous.model),
        route,
        route_reason: incoming.route_reason.or(previous.route_reason),
        routing_group: incoming.routing_group.or(previous.routing_group),
        pool: incoming.pool.or(previous.pool),
        provider_id: incoming.provider_id.or(previous.provider_id),
        auth_alias: incoming.auth_alias.or(previous.auth_alias),
        provider_type: incoming.provider_type.or(previous.provider_type),
        wire_model: incoming.wire_model.or(previous.wire_model),
        provider: incoming.provider.or(previous.provider),
        entry_protocol: incoming.entry_protocol.or(previous.entry_protocol),
        execution_mode: incoming.execution_mode.or(previous.execution_mode),
        transport: incoming.transport.or(previous.transport),
        provider_status: incoming.provider_status.or(previous.provider_status),
        response_status: incoming.response_status.or(previous.response_status),
        finish_reason: incoming.finish_reason.or(previous.finish_reason),
        error_category: incoming.error_category.or(previous.error_category),
        error_detail: incoming.error_detail.or(previous.error_detail),
        observed_error: merge_v3_obs_error_truth(previous.observed_error, incoming.observed_error),
    }
}

/// Event kinds per the observability contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum V3ObsEventType {
    Started,
    RouteSelected,
    ProviderAttemptStarted,
    ProviderAttemptFailed,
    ProviderSwitched,
    Completed,
    Failed,
    Cancelled,
}

impl V3ObsEventType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Started => "request.started",
            Self::RouteSelected => "request.route_selected",
            Self::ProviderAttemptStarted => "request.provider_attempt_started",
            Self::ProviderAttemptFailed => "request.provider_attempt_failed",
            Self::ProviderSwitched => "request.provider_switched",
            Self::Completed => "request.completed",
            Self::Failed => "request.failed",
            Self::Cancelled => "request.cancelled",
        }
    }
}

/// scope carried on every event for grouping/filtering.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsScope {
    pub port: u16,
    pub workdir: Option<String>,
    pub session: Option<String>,
}

/// Request identity fields shown in the main table + collapsible identity detail.
///
/// `observed_error` is an **observed-at-attempt diagnostic snapshot**. It records
/// what the runtime typed Error chain / provider-failure observation produced for
/// this request at the moment it was projected. It is NOT control state: the live
/// cooldown pool and the current provider health are owned by the typed cooldown
/// resource (`/_routecodex/health/cooldown-pool`), and readers must never treat
/// `observed_error.health_action` / `cooldown_until_ms` as "the provider is
/// currently cooled/healthy".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsRequestMeta {
    pub request_id: String,
    pub endpoint: String,
    pub model: Option<String>,
    pub route: Option<String>,
    pub route_reason: Option<String>,
    pub routing_group: Option<String>,
    pub pool: Option<String>,
    pub provider_id: Option<String>,
    pub auth_alias: Option<String>,
    pub provider_type: Option<String>,
    pub wire_model: Option<String>,
    pub provider: Option<String>,
    pub entry_protocol: Option<String>,
    pub execution_mode: Option<String>,
    pub transport: Option<String>,
    pub provider_status: Option<u16>,
    pub response_status: Option<String>,
    pub finish_reason: Option<String>,
    pub error_category: Option<String>,
    pub error_detail: Option<String>,
    /// Observed-at-attempt typed error truth (diagnostic only, never control state).
    pub observed_error: Option<V3ObsErrorTruth>,
}

/// Typed error truth observed at attempt/projection time.
///
/// Every field is optional: `None` means the lane that produced this row did not
/// expose that fact, which is distinct from an observed empty value. The
/// projection forwards what the runtime Error chain already computed and never
/// re-classifies or re-derives an error.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsErrorTruth {
    /// Origin of the snapshot: `provider_attempt_failure` |
    /// `error06_projection` | `error06_projection_not_exposed`.
    /// The last value makes "this lane exposed no typed Error06 truth" explicit
    /// instead of an empty object that reads as "there was no error chain".
    pub source: String,
    /// `V3Error02Classified.class` as projected by `V3Error06ClientProjected`.
    pub error_class: Option<String>,
    /// Ordered `V3Error01..V3Error06` chain nodes; never flattened into one string.
    pub chain: Vec<V3ObsErrorChainNode>,
    /// `V3Error01SourceRaised.internal_error.internal_code`, when the lane exposed it.
    pub internal_code: Option<String>,
    pub external_error_kind: Option<String>,
    pub external_error_code: Option<String>,
    pub external_error_status: Option<u16>,
    /// Upstream provider request id captured from the provider response headers.
    pub upstream_request_id: Option<String>,
    /// `V3Error06ClientProjected.health_action` (typed `V3ErrorActionPlan`).
    pub health_action: Option<V3ObsHealthAction>,
    /// Provider health record state observed at attempt time.
    pub health_state: Option<String>,
    /// Provider-failure runtime action label observed at attempt time.
    pub action: Option<String>,
    pub failure_count: Option<u32>,
    pub cooldown_until_ms: Option<u64>,
    pub next_provider_key: Option<String>,
    pub wait_ms: Option<u64>,
    /// 1-based index of the provider attempt this snapshot belongs to.
    ///
    /// Definition (a chosen convention, not a spec found in the code): the row's
    /// attempt counter (`row.attempts.max(1)`) at the moment the
    /// `ProviderAttemptFailed` event lands, and only when an observed snapshot
    /// exists on that event. Attempts that never produced an observation carry
    /// `None` rather than a guessed ordinal.
    pub attempt_index: Option<u64>,
}

/// One node of the typed Error01..Error06 chain.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsErrorChainNode {
    pub node: String,
    /// Canonical state of that chain node. The chain is only attached to a
    /// projection after the typed chain reached it, so the state is the node's
    /// typed state rather than a guess.
    pub state: String,
    /// Node output code where the projection exposes one, else `None`.
    pub code: Option<String>,
}

/// `V3ErrorActionPlan` projected as typed side-channel diagnostics.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsHealthAction {
    /// `none` | `provider_instance` | `auth_key` | `canonical_model`.
    pub scope: String,
    /// Identity the action applies to (`provider` / `provider:auth` / `provider:model`).
    pub scope_target: Option<String>,
    pub reason: String,
    pub duration_ms: Option<u64>,
    pub retry_eligible: bool,
    pub health_affecting: bool,
    pub exhaustion_effect: String,
}

/// Typed Error06 truth forwarded by the projection caller. `None`/empty means the
/// caller's lane did not expose that fact; the projection never re-derives it.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct V3ObsErrorProjection<'a> {
    /// `true` when the caller's lane holds the typed `V3Error06ClientProjected`.
    /// `false` records an explicit "not exposed on this lane" marker instead of
    /// silently writing an empty chain.
    pub exposed: bool,
    pub error_class: Option<&'a str>,
    pub error_chain: &'a [&'static str],
    pub health_action: Option<&'a routecodex_v3_error::V3ErrorActionPlan>,
    pub upstream_request_id: Option<&'a str>,
}

/// Canonical typed state per Error chain node. Keyed by node id so the chain the
/// caller passes is preserved verbatim (order and identity included).
fn v3_obs_error_chain_node_state(node: &str) -> &'static str {
    match node {
        "V3Error01SourceRaised" => "raised",
        "V3Error02Classified" => "classified",
        "V3Error03TargetLocalAction" => "action_planned",
        "V3Error04TargetExhaustionDecision" => "exhaustion_decided",
        "V3Error05ExecutionDecision" => "execution_decided",
        "V3Error06ClientProjected" => "projected",
        _ => "unknown",
    }
}

fn build_v3_obs_error_chain(
    chain: &[&'static str],
    error_class: Option<&str>,
    status: u16,
) -> Vec<V3ObsErrorChainNode> {
    chain
        .iter()
        .map(|node| {
            let code = match *node {
                "V3Error02Classified" => error_class.map(str::to_string),
                "V3Error06ClientProjected" => Some(status.to_string()),
                _ => None,
            };
            V3ObsErrorChainNode {
                node: (*node).to_string(),
                state: v3_obs_error_chain_node_state(node).to_string(),
                code,
            }
        })
        .collect()
}

/// Project `V3ErrorActionPlan` into the row's typed side-channel shape.
///
/// The error crate owns the action-plan wire form, so this reads the already
/// serialized plan back instead of matching its enum: the server stays purely
/// projective and never classifies or rebuilds an Error node.
fn v3_obs_health_action_from_plan(
    plan: &routecodex_v3_error::V3ErrorActionPlan,
) -> Result<V3ObsHealthAction, String> {
    let value = serde_json::to_value(plan)
        .map_err(|error| format!("encode V3ErrorActionPlan failed: {error}"))?;
    let scope = value
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let scope_target = ["provider_id", "auth_alias", "model_id"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(":");
    Ok(V3ObsHealthAction {
        scope,
        scope_target: (!scope_target.is_empty()).then_some(scope_target),
        reason: plan.reason.clone(),
        duration_ms: plan.duration_ms,
        retry_eligible: plan.retry_eligible,
        health_affecting: plan.health_affecting,
        exhaustion_effect: plan.exhaustion_effect.clone(),
    })
}

/// Precedence rank for `observed_error.source`.
///
/// `observed_error` has more than one writer (the provider-attempt snapshot, the
/// terminal Error06 projection, and the "typed truth not exposed on this lane"
/// marker), so the merge below needs one explicit monotonic rule instead of
/// "whoever arrives first wins". Higher rank wins; equal rank keeps the incoming
/// (fresher) observation:
///
/// * `""` — nothing observed yet.
/// * `provider_attempt_failure` — one provider attempt: diagnostic, not terminal.
/// * `error06_projection_not_exposed` — the terminal Error06 projection happened
///   but this lane cannot carry its typed form (relay lane, plan §9.4 boundary A).
///   This is a statement about the *carrier*, not about the request.
/// * `error06_projection` — the terminal typed `V3Error06ClientProjected`.
///
/// The ladder is what makes the merge order-independent: the absence marker can
/// never replace real typed truth whichever is merged first, and real typed truth
/// always replaces the marker. Add any new source here explicitly.
fn v3_obs_error_source_rank(source: &str) -> u8 {
    match source {
        "" => 0,
        "provider_attempt_failure" => 1,
        "error06_projection_not_exposed" => 2,
        "error06_projection" => 3,
        // An unlisted source is a real observation of unknown provenance; rank it
        // at terminal level so the absence marker can never erase it silently.
        _ => 2,
    }
}

/// Merge two observed-at-attempt snapshots into the row's single `observed_error`.
///
/// This is the ONLY owner of `observed_error` precedence, and the rule is
/// monotonic and order-independent:
/// * `source` — the highest [`v3_obs_error_source_rank`] wins, so a genuinely
///   typed observation (`error06_projection` with a real chain) always beats the
///   `error06_projection_not_exposed` absence marker, in either arrival order;
/// * every other field — an incoming fact wins, and an absent incoming fact never
///   erases an observed one;
/// * `chain` — a non-empty chain always beats an empty one, so a later marker can
///   never clear a real chain and a later real chain always replaces a marker.
///   When both are non-empty the later (fresher) observation wins.
fn merge_v3_obs_error_truth(
    previous: Option<V3ObsErrorTruth>,
    incoming: Option<V3ObsErrorTruth>,
) -> Option<V3ObsErrorTruth> {
    match (previous, incoming) {
        (None, None) => None,
        (Some(previous), None) => Some(previous),
        (None, Some(incoming)) => Some(incoming),
        (Some(previous), Some(incoming)) => Some(V3ObsErrorTruth {
            source: if v3_obs_error_source_rank(&incoming.source)
                >= v3_obs_error_source_rank(&previous.source)
            {
                incoming.source
            } else {
                previous.source
            },
            error_class: incoming.error_class.or(previous.error_class),
            chain: if incoming.chain.is_empty() {
                previous.chain
            } else {
                incoming.chain
            },
            internal_code: incoming.internal_code.or(previous.internal_code),
            external_error_kind: incoming
                .external_error_kind
                .or(previous.external_error_kind),
            external_error_code: incoming
                .external_error_code
                .or(previous.external_error_code),
            external_error_status: incoming
                .external_error_status
                .or(previous.external_error_status),
            upstream_request_id: incoming
                .upstream_request_id
                .or(previous.upstream_request_id),
            health_action: incoming.health_action.or(previous.health_action),
            health_state: incoming.health_state.or(previous.health_state),
            action: incoming.action.or(previous.action),
            failure_count: incoming.failure_count.or(previous.failure_count),
            cooldown_until_ms: incoming.cooldown_until_ms.or(previous.cooldown_until_ms),
            next_provider_key: incoming.next_provider_key.or(previous.next_provider_key),
            wait_ms: incoming.wait_ms.or(previous.wait_ms),
            attempt_index: incoming.attempt_index.or(previous.attempt_index),
        }),
    }
}

/// The mutable request projection (one row per requestKey).
/// The store replays records written by older binaries; every field defaults so
/// late additions (stopless, servertool, …) never make legacy rows undecodable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsRequestRow {
    pub request_key: String,
    pub event_type: String,
    pub started_epoch_ms: u64,
    pub updated_epoch_ms: u64,
    pub finished_epoch_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub meta: V3ObsRequestMeta,
    pub scope: V3ObsScope,
    pub result: Option<String>,
    pub attempts: u64,
    pub failed_attempts: u64,
    pub switches: u64,
    pub usage: Option<V3ObsUsageSummary>,
    pub timing_internal_ms: Option<u64>,
    pub timing_external_ms: Option<u64>,
    pub servertool: bool,
    #[serde(default)]
    pub stopless: bool,
    // rawArtifactRef is a controlled reference only; never the full body.
    pub raw_artifact_ref: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct V3ObsUsageSummary {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    /// Anthropic/MiniMax/glm-5.3 cache read (prompt-cache hit). Stored
    /// alongside `cached_tokens` so the Admin/WebUI hit-rate denominator
    /// does not collapse Anthropic read+creation into one number.
    pub cache_read_input_tokens: Option<u64>,
    /// Anthropic cache write (creation). Tracked separately and excluded
    /// from the hit-rate denominator.
    pub cache_creation_input_tokens: Option<u64>,
}

/// Shared per-listener projection state. The mutable map is only an
/// in-process cache used to merge lifecycle fields and enforce terminal
/// immutability; every accepted event is also appended to the JSONL store.
#[derive(Debug, Clone)]
pub(crate) struct V3WebuiObservability {
    inner: Arc<std::sync::Mutex<V3WebuiObservabilityInner>>,
    persistence_path: Option<Arc<std::path::PathBuf>>,
    persistence_writer: Option<V3WebuiObservabilityPersistenceWriter>,
    alarm: Arc<RwLock<Option<String>>>,
}

#[derive(Debug, Clone, Default)]
struct V3WebuiObservabilityInner {
    requests: BTreeMap<String, V3ObsRequestRow>,
}

#[derive(Debug)]
enum V3WebuiObservabilityPersistenceCommand {
    Append(V3ObsRequestRow),
    Flush(mpsc::Sender<Result<(), String>>),
}

#[derive(Debug, Clone)]
struct V3WebuiObservabilityPersistenceWriter {
    sender: mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>,
    alarm: Arc<RwLock<Option<String>>>,
}

impl V3WebuiObservabilityPersistenceWriter {
    fn start(path: PathBuf, alarm: Arc<RwLock<Option<String>>>) -> Self {
        let (sender, receiver) = mpsc::sync_channel(V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY);
        let writer_alarm = Arc::clone(&alarm);
        let spawned = std::thread::Builder::new()
            .name("v3-webui-observability-writer".to_string())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        V3WebuiObservabilityPersistenceCommand::Append(row) => {
                            if let Err(error) =
                                V3WebuiObservability::append_persisted_row(&path, &row)
                            {
                                set_v3_webui_observability_alarm(
                                    &writer_alarm,
                                    format!("observability persistence write failed: {error}"),
                                );
                            } else if let Ok(mut alarm) = writer_alarm.write() {
                                *alarm = None;
                            }
                        }
                        V3WebuiObservabilityPersistenceCommand::Flush(receipt) => {
                            let result = writer_alarm
                                .read()
                                .map_err(|error| {
                                    format!("observability alarm lock poisoned: {error}")
                                })
                                .and_then(|alarm| match alarm.as_ref() {
                                    Some(error) => Err(error.clone()),
                                    None => Ok(()),
                                });
                            let _ = receipt.send(result);
                        }
                    }
                }
            });
        Self::after_spawn(sender, alarm, spawned)
    }

    fn after_spawn(
        sender: mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>,
        alarm: Arc<RwLock<Option<String>>>,
        spawned: std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Self {
        if let Err(error) = spawned {
            // The writer thread is the only owner of the receive side. If it
            // cannot start, every append/flush fails the channel and is surfaced
            // through the persistence alarm instead of crashing the listener at
            // startup. Persisted observability is advisory, not business truth.
            eprintln!("[RouteCodexV3] webui observability persistence disabled: {error}");
            set_v3_webui_observability_alarm(
                &alarm,
                format!("observability persistence writer start failed: {error}"),
            );
        }
        Self { sender, alarm }
    }

    fn enqueue(&self, row: V3ObsRequestRow) {
        if let Err(error) = self
            .sender
            .try_send(V3WebuiObservabilityPersistenceCommand::Append(row))
        {
            set_v3_webui_observability_alarm(
                &self.alarm,
                format!("observability persistence queue rejected row: {error}"),
            );
        }
    }

    fn flush(&self) -> Result<(), String> {
        let (receipt_sender, receipt_receiver) = mpsc::channel();
        self.sender
            .send(V3WebuiObservabilityPersistenceCommand::Flush(
                receipt_sender,
            ))
            .map_err(|error| format!("observability persistence writer unavailable: {error}"))?;
        receipt_receiver
            .recv()
            .map_err(|error| format!("observability persistence flush receipt missing: {error}"))?
    }
}

fn set_v3_webui_observability_alarm(alarm: &RwLock<Option<String>>, message: String) {
    if let Ok(mut alarm) = alarm.write() {
        if alarm.is_none() {
            *alarm = Some(message);
        }
    }
}

impl Default for V3WebuiObservability {
    fn default() -> Self {
        Self::new()
    }
}

impl V3WebuiObservability {
    pub(crate) fn new() -> Self {
        Self::with_persistence_path(None)
    }

    pub(crate) fn with_persistence_path(path: Option<std::path::PathBuf>) -> Self {
        let alarm = Arc::new(RwLock::new(None));
        let persistence_writer = path.as_ref().map(|path| {
            V3WebuiObservabilityPersistenceWriter::start(path.clone(), Arc::clone(&alarm))
        });
        Self {
            inner: Arc::new(std::sync::Mutex::new(V3WebuiObservabilityInner::default())),
            persistence_path: path.map(Arc::new),
            persistence_writer,
            alarm,
        }
    }

    /// Load the persisted request projection without ever blocking listener
    /// startup. The store is Debug surface: legacy rows missing late fields
    /// decode through serde defaults, and any line a strict read or row decode
    /// still rejects is skipped into the alarm instead of failing the load.
    pub(crate) fn load_persisted(path: &std::path::Path) -> Self {
        let handle = Self::with_persistence_path(Some(path.to_path_buf()));
        let report = routecodex_v3_debug::observability_store::v3_webui_observability_read_rows_bounded_lenient(
            path,
            V3_WEBUI_RECENT_REQUEST_CAPACITY,
        );
        let mut skipped = report.skipped;
        match handle.inner.lock() {
            Ok(mut inner) => {
                for value in report.rows {
                    match serde_json::from_value::<V3ObsRequestRow>(value) {
                        Ok(row) => {
                            inner.requests.insert(row.request_key.clone(), row);
                        }
                        Err(error) => {
                            skipped.push(format!(
                                "observability record {} skipped: {error}",
                                path.display()
                            ));
                        }
                    }
                }
            }
            Err(_) => skipped.push("v3 webui observability state is poisoned".to_string()),
        }
        if !skipped.is_empty() {
            set_v3_webui_observability_alarm(
                &handle.alarm,
                format!(
                    "observability load skipped {} undecodable record(s) in {}: {}",
                    skipped.len(),
                    path.display(),
                    skipped.join("; ")
                ),
            );
        }
        handle
    }

    pub(crate) fn persistence_path(&self) -> Option<PathBuf> {
        self.persistence_path.as_deref().cloned()
    }

    pub(crate) fn flush_persistence(&self) -> Result<(), String> {
        match self.persistence_writer.as_ref() {
            Some(writer) => writer.flush(),
            None => Ok(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn alarm(&self) -> Option<String> {
        self.alarm
            .read()
            .map(|alarm| alarm.clone())
            .unwrap_or_else(|error| Some(format!("observability alarm lock poisoned: {error}")))
    }

    #[cfg(test)]
    pub(crate) fn rows(&self) -> Result<BTreeMap<String, V3ObsRequestRow>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        Ok(inner.requests.clone())
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Record a lifecycle event, upserting the mutable row for requestKey.
    /// Returns Ok(sequence) on success; Err(e) is explicit and never becomes success.
    #[cfg(test)]
    pub(crate) fn record(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
    ) -> Result<u64, String> {
        record_v3_observability_event(
            self,
            event_type,
            request_key,
            scope,
            meta,
            &crate::V3RuntimeObservability::default(),
        )
    }

    pub(crate) fn record_observed(
        &self,
        event_type: V3ObsEventType,
        request_key: &str,
        scope: V3ObsScope,
        meta: V3ObsRequestMeta,
        observability: &crate::V3RuntimeObservability,
    ) -> Result<u64, String> {
        let now = Self::now_ms();

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "v3 webui observability state is poisoned".to_string())?;
        let event_type_str = event_type.as_str().to_string();
        let is_terminal = matches!(
            event_type,
            V3ObsEventType::Completed | V3ObsEventType::Failed | V3ObsEventType::Cancelled
        );
        if !is_terminal
            && inner
                .requests
                .get(request_key)
                .is_some_and(|row| row.result.is_some())
        {
            return Err(format!(
                "request {request_key} is already terminal; refusing {} restart",
                event_type_str
            ));
        }
        let terminal_event_after_terminal_row = is_terminal
            && inner
                .requests
                .get(request_key)
                .is_some_and(|row| row.result.is_some());
        // A request terminates once, so a second terminal event must not restart
        // its outcome, duration or counters. It DOES still merge its metadata:
        // several lanes project terminal error truth for one request (the relay
        // lane records the honest absence marker, the direct lane records the real
        // chain), and whichever lands first must not decide what the row says.
        // `merge_v3_obs_error_truth` owns that precedence, and it is monotonic, so
        // a later lane can only strengthen the recorded truth, never weaken it.
        let mut row;
        if terminal_event_after_terminal_row {
            // A request terminates once. A second terminal event must not
            // restart the row's outcome, duration or counters; it only merges
            // metadata, and `merge_v3_obs_error_truth`'s monotonic precedence
            // can only strengthen the recorded truth. Both branches converge
            // on the single persist site below, so "release the mutex before
            // touching the writer" is structurally one site: it cannot be
            // satisfied by one branch while another violates it.
            row = inner.requests.get(request_key).cloned().unwrap_or_default();
            row.request_key = request_key.to_string();
            row.meta = merge_v3_obs_request_meta(row.meta, meta);
            row.updated_epoch_ms = now;
        } else {
            if !inner.requests.contains_key(request_key)
                && inner.requests.len() >= V3_WEBUI_RECENT_REQUEST_CAPACITY
            {
                if let Some(oldest_terminal_key) = inner
                    .requests
                    .iter()
                    .filter(|(_, row)| row.result.is_some())
                    .min_by_key(|(_, row)| row.updated_epoch_ms)
                    .map(|(key, _)| key.clone())
                {
                    inner.requests.remove(&oldest_terminal_key);
                } else {
                    set_v3_webui_observability_alarm(
                        &self.alarm,
                        format!(
                            "observability active request cache reached {} rows",
                            V3_WEBUI_RECENT_REQUEST_CAPACITY
                        ),
                    );
                    return Ok(0);
                }
            }

            row = inner.requests.get(request_key).cloned().unwrap_or_default();
            row.request_key = request_key.to_string();
            row.event_type = event_type_str.clone();
            row.meta = merge_v3_obs_request_meta(row.meta, meta);
            row.scope.port = scope.port;
            if scope.workdir.is_some() {
                row.scope.workdir = scope.workdir.clone();
            }
            if scope.session.is_some() {
                row.scope.session = scope.session.clone();
            }
            row.updated_epoch_ms = now;
            if row.started_epoch_ms == 0 {
                row.started_epoch_ms = now;
            }
            // maintain attempt/switch counters and terminal result
            match event_type {
                V3ObsEventType::ProviderAttemptStarted => row.attempts += 1,
                V3ObsEventType::ProviderAttemptFailed => {
                    row.failed_attempts += 1;
                    let attempt_index = row.attempts.max(1);
                    if let Some(truth) = row.meta.observed_error.as_mut() {
                        truth.attempt_index = Some(attempt_index);
                    }
                }
                V3ObsEventType::ProviderSwitched => row.switches += 1,
                V3ObsEventType::Completed => {
                    row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                    row.finished_epoch_ms = Some(now);
                    row.result = Some(
                        if observability
                            .usage
                            .as_ref()
                            .is_some_and(v3_runtime_usage_is_zero_issue)
                        {
                            "issue"
                        } else {
                            "success"
                        }
                        .to_string(),
                    );
                    if let Some(usage) = observability.usage.as_ref() {
                        row.usage = Some(V3ObsUsageSummary {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            total_tokens: usage.total_tokens,
                            cached_tokens: usage.cached_tokens,
                            cache_read_input_tokens: usage.cache_read_input_tokens,
                            cache_creation_input_tokens: usage.cache_creation_input_tokens,
                        });
                    }
                    row.timing_internal_ms = observability
                        .timing
                        .as_ref()
                        .map(|t| t.internal.as_millis() as u64);
                    row.timing_external_ms = observability
                        .timing
                        .as_ref()
                        .map(|t| t.external.as_millis() as u64);
                    row.servertool = false;
                    // Preserve the most recent provider-failure category for completed-but-recovered rows
                    // so the UI/facets keep the last attempt's error category even when the meta
                    // projection is otherwise rebuilt from a fresh payload here.
                }
                V3ObsEventType::Failed => {
                    row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                    row.finished_epoch_ms = Some(now);
                    row.result = Some("error".to_string());
                }
                V3ObsEventType::Cancelled => {
                    row.duration_ms = Some(now.saturating_sub(row.started_epoch_ms));
                    row.finished_epoch_ms = Some(now);
                    row.result = Some("cancelled".to_string());
                }
                V3ObsEventType::Started => {}
                _ => {}
            }
            // Controlled artifact reference: resolved only when the debug sample
            // directory for this request actually exists. A missing directory is
            // "no artifact captured", never proof that a stage succeeded, and a
            // path is never fabricated.
            if row.raw_artifact_ref.is_none()
                && matches!(
                    event_type,
                    V3ObsEventType::ProviderAttemptFailed
                        | V3ObsEventType::Completed
                        | V3ObsEventType::Failed
                        | V3ObsEventType::Cancelled
                )
            {
                row.raw_artifact_ref = resolve_v3_obs_raw_artifact_ref(
                    row.scope.port,
                    row.meta.entry_protocol.as_deref(),
                    Some(row.meta.endpoint.as_str()).filter(|value| !value.is_empty()),
                    &row.meta.request_id,
                );
            }
        }
        inner.requests.insert(request_key.to_string(), row.clone());
        drop(inner);
        if let Some(writer) = self.persistence_writer.as_ref() {
            writer.enqueue(row);
        }
        Ok(1)
    }

    pub(crate) fn append_persisted_row(
        path: &std::path::Path,
        row: &V3ObsRequestRow,
    ) -> Result<(), String> {
        Self::append_persisted_row_with_limit(path, row, V3_WEBUI_HISTORY_MAX_BYTES)
    }

    fn append_persisted_row_with_limit(
        path: &std::path::Path,
        row: &V3ObsRequestRow,
        max_history_bytes: u64,
    ) -> Result<(), String> {
        let row = serde_json::to_value(row)
            .map_err(|error| format!("encode observability record failed: {error}"))?;
        routecodex_v3_debug::v3_webui_observability_append_row_with_retention(
            path,
            &row,
            max_history_bytes,
        )
        .map_err(|error| format!("write observability store failed: {error}"))
    }
}

fn v3_runtime_usage_is_zero_issue(usage: &crate::V3RuntimeUsageSummary) -> bool {
    usage.input_tokens == Some(0) && usage.output_tokens == Some(0) && usage.total_tokens == Some(0)
}

/// Resolve the debug sample directory for one request into a controlled
/// reference. The directory layout is owned by
/// `routecodex_v3_debug::v3_codex_sample_request_dir`; this function only adds
/// the existence check. Returns `None` when HOME is unavailable, the layout
/// cannot be derived, or the directory does not exist.
fn resolve_v3_obs_raw_artifact_ref(
    port: u16,
    entry_protocol: Option<&str>,
    endpoint: Option<&str>,
    request_id: &str,
) -> Option<String> {
    let root = routecodex_v3_debug::resolve_v3_codex_samples_root().ok()?;
    resolve_v3_obs_raw_artifact_ref_in(&root, port, entry_protocol, endpoint, request_id)
}

/// Same resolution against a caller supplied samples root, so the existence
/// rule is testable without depending on the process `HOME`.
fn resolve_v3_obs_raw_artifact_ref_in(
    samples_root: &std::path::Path,
    port: u16,
    entry_protocol: Option<&str>,
    endpoint: Option<&str>,
    request_id: &str,
) -> Option<String> {
    let entry_protocol = entry_protocol.filter(|value| !value.trim().is_empty())?;
    let endpoint = endpoint.filter(|value| !value.trim().is_empty())?;
    if request_id.trim().is_empty() {
        return None;
    }
    let dir = routecodex_v3_debug::v3_codex_sample_request_dir_in(
        samples_root,
        port,
        entry_protocol,
        endpoint,
        request_id,
    );
    dir.is_dir().then(|| dir.display().to_string())
}

#[cfg(test)]
#[path = "webui_observability_tests.rs"]
mod tests;
