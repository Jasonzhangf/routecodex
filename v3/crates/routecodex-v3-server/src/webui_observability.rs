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

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const V3_WEBUI_RECENT_REQUEST_CAPACITY: usize = 10_000;
const V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY: usize = 1_024;
const V3_WEBUI_PERSISTENCE_GAP_CAPACITY: usize = 256;
const V3_WEBUI_HISTORY_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// The transport-cancel path holds a typed Error01 `ClientDisconnect` source
/// but no `V3Error06ClientProjected`. This source names that actual fact instead
/// of claiming Error06 exposure or describing only its absence.
pub(crate) const V3_OBS_SOURCE_ERROR01_CLIENT_DISCONNECT: &str = "error01_client_disconnect";

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
    // `provider_status` and `error_category` come from the typed terminal facts,
    // never from the client-facing projected status. A NoResponse terminal
    // (body decode/operation timeout, transport break, client cancel) has no
    // upstream HTTP status; only a real upstream witness (or a typed external
    // error status) may set `provider_status`.
    let terminal_provider_status =
        typed
            .terminal_disposition
            .and_then(|disposition| match disposition {
                routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness) => {
                    Some(witness.status())
                }
                routecodex_v3_error::V3ProviderTerminalDisposition::ProjectExternalHttp(
                    witness,
                ) => Some(witness.status()),
                routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse => None,
            });
    let external_error_status = typed
        .diagnostic_source
        .and_then(|source| source.external_error.as_ref())
        .and_then(|external| external.status);
    // Lanes that expose no typed terminal facts keep the legacy projection:
    // the already-projected client status stands in for `provider_status`. Only
    // a lane that carries a typed provider terminal may report `None`.
    let provider_status =
        if typed.terminal_disposition.is_some() || typed.diagnostic_source.is_some() {
            terminal_provider_status.or(external_error_status)
        } else {
            Some(status)
        };
    let typed_http200_body_failure = typed.diagnostic_source.filter(|source| {
        source.code == "provider_response_body_error"
            && source
                .external_error
                .as_ref()
                .and_then(|external| external.status)
                .is_some_and(|status| (200..300).contains(&status))
    });
    let (error_category, error_detail) = match typed_http200_body_failure {
        // The projected client body is an internal response-processing error in
        // this branch. The typed source owns the real 2xx status and cause.
        Some(source) => (source.code.clone(), source.message.clone()),
        None => match (body, typed.terminal_disposition) {
            // A real upstream error HTTP status owns the terminal category even
            // when the internal Error06 projection also carries a proxy status.
            (
                _,
                Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)),
            ) if witness.status() >= 400 => (
                format!("http_{}", witness.status()),
                format!("HTTP status {}", witness.status()),
            ),
            (
                _,
                Some(routecodex_v3_error::V3ProviderTerminalDisposition::ProjectExternalHttp(
                    witness,
                )),
            ) if witness.status() >= 400 => (
                format!("provider_http_{}", witness.status()),
                format!("HTTP status {}", witness.status()),
            ),
            (Some(body), _) => crate::v3_error_body_code_message(body),
            (None, typed_terminal) => match (typed.diagnostic_source, typed_terminal) {
                // NoResponse (timeout, transport break, client cancel) or a 2xx
                // provider head that failed later: the typed source names the
                // cause.
                (Some(source), _) => (source.code.clone(), source.message.clone()),
                (
                    None,
                    Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)),
                ) => (
                    format!("http_{}", witness.status()),
                    format!("HTTP status {}", witness.status()),
                ),
                (
                    None,
                    Some(routecodex_v3_error::V3ProviderTerminalDisposition::ProjectExternalHttp(
                        witness,
                    )),
                ) => (
                    format!("provider_http_{}", witness.status()),
                    format!("HTTP status {}", witness.status()),
                ),
                (None, _) => (format!("http_{status}"), format!("HTTP status {status}")),
            },
        },
    };
    let client_disconnect = typed.diagnostic_source.is_some_and(|source| {
        source.source_kind == routecodex_v3_error::V3ErrorSourceKind::ClientDisconnect
    });
    let request_key = build_v3_obs_request_key(port, request_id);
    let scope = V3ObsScope {
        port,
        workdir: project_path.map(str::to_string),
        session: session.map(str::to_string),
    };
    let observed_error = V3ObsErrorTruth {
        source: typed
            .observed_source
            .unwrap_or(if typed.exposed {
                "error06_projection"
            } else {
                "error06_projection_not_exposed"
            })
            .to_string(),
        error_class: typed.error_class.map(str::to_string),
        chain: build_v3_obs_error_chain(typed.error_chain, typed.error_class, status),
        internal_code: typed
            .diagnostic_source
            .and_then(|source| source.internal_error.as_ref())
            .map(|internal| internal.internal_code.to_string()),
        external_error_kind: typed
            .diagnostic_source
            .and_then(|source| source.external_error.as_ref())
            .map(|external| format!("{:?}", external.kind).to_ascii_lowercase()),
        external_error_code: typed
            .diagnostic_source
            .and_then(|source| source.external_error.as_ref())
            .and_then(|external| external.code.clone()),
        external_error_status,
        upstream_request_id: typed.upstream_request_id.map(str::to_string).or_else(|| {
            typed
                .diagnostic_source
                .and_then(|source| source.external_error.as_ref())
                .and_then(|external| external.upstream_request_id.clone())
        }),
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
        execution_mode: typed.execution_mode.map(str::to_string),
        provider_status,
        terminal_typed_status_cleared: typed.terminal_typed_status_cleared
            || matches!(
                typed.terminal_disposition,
                Some(routecodex_v3_error::V3ProviderTerminalDisposition::NoResponse)
            ),
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
        if client_disconnect {
            V3ObsEventType::Cancelled
        } else {
            V3ObsEventType::Failed
        },
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
    incoming_establishes_completed_terminal: bool,
    established_result_is_success: bool,
) -> V3ObsRequestMeta {
    let route = incoming
        .route
        .filter(|value| !value.trim().is_empty() && value != "-")
        .or(previous.route);
    // The typed Error06 projection lane distinguishes "the current typed
    // terminal has no provider HTTP status" from "this event supplies no
    // provider-status update". Only the former clears the row's inherited
    // status: `record_v3_webui_error_projection` derives a typed NoResponse as
    // `provider_status: None` while also carrying a typed terminal/disposition
    // fact, so a later terminal on candidate B must not keep candidate A's real
    // 502. A legacy lane with no typed terminal facts keeps the existing
    // incoming-or-previous behavior. A row that already established success has
    // delivered its real provider status: a later post-commit failure may add
    // error truth but must not erase that status.
    let provider_status =
        if established_result_is_success && !incoming_establishes_completed_terminal {
            previous.provider_status
        } else if incoming.terminal_typed_status_cleared && !established_result_is_success {
            None
        } else {
            incoming.provider_status.or(previous.provider_status)
        };
    let (finish_reason, error_category, error_detail, observed_error) =
        if incoming_establishes_completed_terminal {
            (
                incoming.finish_reason,
                incoming.error_category,
                incoming.error_detail,
                incoming.observed_error,
            )
        } else if established_result_is_success {
            (
                previous.finish_reason,
                incoming.error_category.or(previous.error_category),
                incoming.error_detail.or(previous.error_detail),
                merge_v3_obs_error_truth(previous.observed_error, incoming.observed_error),
            )
        } else {
            (
                incoming.finish_reason.or(previous.finish_reason),
                incoming.error_category.or(previous.error_category),
                incoming.error_detail.or(previous.error_detail),
                merge_v3_obs_error_truth(previous.observed_error, incoming.observed_error),
            )
        };
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
        provider_status,
        response_status: if established_result_is_success
            && !incoming_establishes_completed_terminal
        {
            previous.response_status
        } else {
            incoming.response_status.or(previous.response_status)
        },
        finish_reason,
        error_category,
        error_detail,
        terminal_typed_status_cleared: incoming.terminal_typed_status_cleared
            || previous.terminal_typed_status_cleared,
        observed_error,
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
    /// Internal merge control, never persisted or rendered: `true` only on a
    /// row update from the typed Error06 projection whose terminal explicitly
    /// has no provider HTTP status (`provider_status: None`). It clears a
    /// previously inherited provider status instead of falling back to it.
    #[serde(skip)]
    pub terminal_typed_status_cleared: bool,
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
    /// `error06_projection` | `error06_projection_not_exposed` |
    /// `error01_client_disconnect`. The transport-cancel value records the
    /// typed Error01 `ClientDisconnect` fact the lane actually holds; the
    /// not-exposed value says only that no typed Error06 truth is available.
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
    pub execution_mode: Option<&'a str>,
    /// `true` when the caller's lane holds the typed `V3Error06ClientProjected`.
    /// `false` records an explicit "not exposed on this lane" marker instead of
    /// silently writing an empty chain.
    pub exposed: bool,
    pub error_class: Option<&'a str>,
    /// Explicit `observed_error.source` for a typed terminal whose source fact
    /// is neither a real Error06 projection nor merely its absence.
    pub observed_source: Option<&'a str>,
    pub error_chain: &'a [&'static str],
    pub health_action: Option<&'a routecodex_v3_error::V3ErrorActionPlan>,
    pub upstream_request_id: Option<&'a str>,
    /// Typed Error01 source raised at the terminal, when the lane exposes it.
    pub diagnostic_source: Option<&'a routecodex_v3_error::V3Error01SourceRaised>,
    /// Typed provider terminal disposition, when the lane exposes it.
    pub terminal_disposition: Option<&'a routecodex_v3_error::V3ProviderTerminalDisposition>,
    /// `true` when the caller's lane explicitly reports that its typed terminal
    /// has no provider HTTP status. The row merge must not inherit an earlier
    /// provider attempt's status onto this terminal.
    pub terminal_typed_status_cleared: bool,
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
/// * `error01_client_disconnect` — the transport-cancel lane holds the typed
///   Error01 `ClientDisconnect` source but no `V3Error06ClientProjected`.
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
        V3_OBS_SOURCE_ERROR01_CLIENT_DISCONNECT => 2,
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
    Append {
        row: V3ObsRequestRow,
        attempt_ordinal: Option<u64>,
    },
    Flush(mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<Result<(), String>>),
}

#[derive(Debug, Clone)]
struct V3WebuiObservabilityQueueGap {
    listener_id: u16,
    request_key: String,
    started_epoch_ms: u64,
}

#[derive(Debug, Default)]
struct V3WebuiObservabilityPersistenceGaps {
    pending: VecDeque<V3WebuiObservabilityQueueGap>,
    dropped_listeners: std::collections::BTreeSet<u16>,
}

impl V3WebuiObservabilityPersistenceGaps {
    fn push(&mut self, gap: V3WebuiObservabilityQueueGap) {
        if self.pending.len() >= V3_WEBUI_PERSISTENCE_GAP_CAPACITY {
            self.dropped_listeners.insert(gap.listener_id);
            return;
        }
        self.pending.push_back(gap);
    }
}

#[derive(Debug, Clone)]
struct V3WebuiObservabilityGapQueue {
    pending: Arc<std::sync::Mutex<V3WebuiObservabilityPersistenceGaps>>,
}

impl V3WebuiObservabilityGapQueue {
    fn new() -> Self {
        Self {
            pending: Arc::new(std::sync::Mutex::new(
                V3WebuiObservabilityPersistenceGaps::default(),
            )),
        }
    }

    fn push(&self, gap: V3WebuiObservabilityQueueGap, alarm: &RwLock<Option<String>>) {
        match self.pending.lock() {
            Ok(mut pending) => pending.push(gap),
            Err(error) => set_v3_webui_observability_alarm(
                alarm,
                format!("observability persistence gap state poisoned: {error}"),
            ),
        }
    }

    fn front(&self) -> Result<Option<V3WebuiObservabilityQueueGap>, String> {
        self.pending
            .lock()
            .map(|pending| pending.pending.front().cloned())
            .map_err(|error| format!("observability persistence gap state poisoned: {error}"))
    }

    fn pop_front(&self) -> Result<(), String> {
        self.pending
            .lock()
            .map(|mut pending| {
                pending.pending.pop_front();
            })
            .map_err(|error| format!("observability persistence gap state poisoned: {error}"))
    }

    fn first_dropped_listener(&self) -> Result<Option<u16>, String> {
        self.pending
            .lock()
            .map(|pending| pending.dropped_listeners.first().copied())
            .map_err(|error| format!("observability persistence gap state poisoned: {error}"))
    }

    fn clear_dropped_listener(&self, listener_id: u16) -> Result<(), String> {
        self.pending
            .lock()
            .map(|mut pending| {
                pending.dropped_listeners.remove(&listener_id);
            })
            .map_err(|error| format!("observability persistence gap state poisoned: {error}"))
    }
}

#[derive(Debug, Clone)]
struct V3WebuiObservabilityPersistenceWriter {
    gaps: V3WebuiObservabilityGapQueue,
    alarm: Arc<RwLock<Option<String>>>,
    pending_write_error: Arc<std::sync::Mutex<Option<String>>>,
    history_max_bytes: u64,
    lifecycle: Arc<V3WebuiObservabilityPersistenceWriterLifecycle>,
}

#[derive(Debug)]
struct V3WebuiObservabilityPersistenceWriterLifecycle {
    state: std::sync::Mutex<V3WebuiObservabilityPersistenceWriterLifecycleState>,
    wait_for_completion: bool,
}

#[derive(Debug)]
struct V3WebuiObservabilityPersistenceWriterLifecycleState {
    sender: Option<mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>>,
    thread: Option<std::thread::JoinHandle<()>>,
    close_result: Option<Result<(), String>>,
}

impl V3WebuiObservabilityPersistenceWriterLifecycle {
    fn new(
        sender: mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>,
        wait_for_completion: bool,
    ) -> Self {
        Self {
            state: std::sync::Mutex::new(V3WebuiObservabilityPersistenceWriterLifecycleState {
                sender: Some(sender),
                thread: None,
                close_result: None,
            }),
            wait_for_completion,
        }
    }

    fn attach_thread(&self, thread: std::thread::JoinHandle<()>) {
        if let Ok(mut state) = self.state.lock() {
            state.thread = Some(thread);
        }
    }
}

impl Drop for V3WebuiObservabilityPersistenceWriterLifecycle {
    fn drop(&mut self) {
        let completion = self.state.lock().ok().and_then(|mut state| {
            if state.close_result.is_some() {
                return None;
            }
            let sender = state.sender.take()?;
            let thread = state.thread.take();
            Some((sender, thread))
        });
        if let Some((sender, thread)) = completion {
            let wait_for_completion = self.wait_for_completion;
            std::thread::spawn(move || {
                let (receipt_sender, receipt_receiver) = mpsc::channel();
                if sender
                    .send(V3WebuiObservabilityPersistenceCommand::Shutdown(
                        receipt_sender,
                    ))
                    .is_ok()
                    && wait_for_completion
                {
                    let _ = receipt_receiver.recv();
                }
                drop(sender);
                if let Some(thread) = thread {
                    let _ = thread.join();
                }
            });
        }
    }
}

impl V3WebuiObservabilityPersistenceWriter {
    fn start(path: PathBuf, alarm: Arc<RwLock<Option<String>>>) -> Self {
        Self::start_with_limit(path, alarm, V3_WEBUI_HISTORY_MAX_BYTES)
    }

    fn start_with_limit(
        path: PathBuf,
        alarm: Arc<RwLock<Option<String>>>,
        history_max_bytes: u64,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel(V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY);
        let gaps = V3WebuiObservabilityGapQueue::new();
        let pending_write_error = Arc::new(std::sync::Mutex::new(None));
        let writer_alarm = Arc::clone(&alarm);
        let writer_gaps = gaps.clone();
        let writer_pending_error = Arc::clone(&pending_write_error);
        let spawned = Self::spawn_writer(
            path,
            receiver,
            writer_gaps,
            writer_alarm,
            writer_pending_error,
            history_max_bytes,
            routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits::default(),
        );
        Self::after_spawn(
            gaps,
            alarm,
            pending_write_error,
            sender,
            spawned,
            history_max_bytes,
        )
    }

    fn spawn_writer(
        path: PathBuf,
        receiver: mpsc::Receiver<V3WebuiObservabilityPersistenceCommand>,
        gaps: V3WebuiObservabilityGapQueue,
        writer_alarm: Arc<RwLock<Option<String>>>,
        pending_write_error: Arc<std::sync::Mutex<Option<String>>>,
        history_max_bytes: u64,
        fact_limits: routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        #[cfg(test)]
        {
            if take_v3_webui_force_writer_spawn_failure() {
                return Err(std::io::Error::other(
                    "injected observability persistence writer start failure",
                ));
            }
        }
        let spawned = std::thread::Builder::new()
            .name("v3-webui-observability-writer".to_string())
            .spawn(move || {
                let store =
                    match routecodex_v3_debug::V3ProviderUsagePersistenceStore::open_with_limits(
                        &path,
                        fact_limits,
                    ) {
                        Ok(store) => store,
                        Err(error) => {
                            set_v3_webui_observability_alarm(
                                &writer_alarm,
                                format!(
                                "observability persistence write failed: store open failed: {error}"
                            ),
                            );
                            return;
                        }
                    };
                run_v3_webui_observability_persistence_writer(
                    store,
                    receiver,
                    gaps,
                    writer_alarm,
                    pending_write_error,
                    history_max_bytes,
                );
            });
        spawned
    }

    fn after_spawn(
        gaps: V3WebuiObservabilityGapQueue,
        alarm: Arc<RwLock<Option<String>>>,
        pending_write_error: Arc<std::sync::Mutex<Option<String>>>,
        sender: mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>,
        spawned: std::io::Result<std::thread::JoinHandle<()>>,
        history_max_bytes: u64,
    ) -> Self {
        let lifecycle = Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
            sender.clone(),
            true,
        ));
        match spawned {
            Ok(thread) => lifecycle.attach_thread(thread),
            Err(error) => {
                // The writer thread is the only owner of the receive side. If
                // it cannot start, every append/flush fails the channel and is
                // surfaced through the persistence alarm instead of crashing
                // the listener at startup. Persisted observability is advisory,
                // not business truth.
                eprintln!("[RouteCodexV3] webui observability persistence disabled: {error}");
                set_v3_webui_observability_alarm(
                    &alarm,
                    format!("observability persistence writer start failed: {error}"),
                );
            }
        }
        Self {
            gaps,
            alarm,
            pending_write_error,
            history_max_bytes,
            lifecycle,
        }
    }

    fn enqueue(&self, row: V3ObsRequestRow, attempt_ordinal: Option<u64>) {
        let listener_id = row.scope.port;
        let request_key = row.request_key.clone();
        let started_epoch_ms = row.started_epoch_ms;
        let error = {
            let state = match self.lifecycle.state.lock() {
                Ok(state) => state,
                Err(error) => {
                    set_v3_webui_observability_alarm(
                        &self.alarm,
                        format!("observability persistence lifecycle poisoned: {error}"),
                    );
                    return;
                }
            };
            let Some(sender) = state.sender.as_ref() else {
                return;
            };
            let error = sender
                .try_send(V3WebuiObservabilityPersistenceCommand::Append {
                    row,
                    attempt_ordinal,
                })
                .err();
            if error.is_some() {
                // Seal admission and rejected-work coverage under the same lock.
                self.gaps.push(
                    V3WebuiObservabilityQueueGap {
                        listener_id,
                        request_key,
                        started_epoch_ms,
                    },
                    &self.alarm,
                );
            }
            error
        };
        if let Some(error) = error {
            set_v3_webui_observability_alarm(
                &self.alarm,
                format!("observability persistence queue rejected row: {error}"),
            );
        }
    }

    fn flush(&self) -> Result<(), String> {
        let (receipt_sender, receipt_receiver) = mpsc::channel();
        let sender = self
            .lifecycle
            .state
            .lock()
            .map_err(|error| format!("observability persistence lifecycle poisoned: {error}"))?
            .sender
            .as_ref()
            .cloned()
            .ok_or_else(|| "observability persistence writer is closed".to_string())?;
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Flush(
                receipt_sender,
            ))
            .map_err(|error| format!("observability persistence writer unavailable: {error}"))?;
        receipt_receiver
            .recv()
            .map_err(|error| format!("observability persistence flush receipt missing: {error}"))?
    }

    async fn flush_for_exec(&self) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.lifecycle
            .state
            .lock()
            .map_err(|error| format!("observability persistence lifecycle poisoned: {error}"))?
            .sender
            .as_ref()
            .ok_or_else(|| "observability persistence writer is closed".to_string())?
            .try_send(V3WebuiObservabilityPersistenceCommand::Flush(sender))
            .map_err(|error| format!("observability persistence queue unavailable: {error}"))?;
        loop {
            match receiver.try_recv() {
                Ok(result) => return result,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("observability persistence flush receipt missing".into())
                }
                Err(mpsc::TryRecvError::Empty) => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await
                }
            }
        }
    }

    async fn close_async(&self) -> Result<(), String> {
        let completion = {
            let mut state = self.lifecycle.state.lock().map_err(|error| {
                format!("observability persistence lifecycle poisoned: {error}")
            })?;
            if let Some(result) = state.close_result.clone() {
                return result;
            }
            // Taking the sole sender seals admission before the first await.
            // The completion worker owns both the terminal command and join,
            // even when a caller stops waiting for it.
            state
                .sender
                .take()
                .map(|sender| (sender, state.thread.take()))
        };
        if let Some((sender, thread)) = completion {
            let writer = self.clone();
            tokio::task::spawn_blocking(move || {
                let result = writer.finish_close(sender, thread);
                let _ = writer.set_close_result(result);
            });
        }
        loop {
            if let Some(result) = self
                .lifecycle
                .state
                .lock()
                .map_err(|error| format!("observability persistence lifecycle poisoned: {error}"))?
                .close_result
                .clone()
            {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    fn close(&self) -> Result<(), String> {
        let (sender, thread) = {
            let mut state = self.lifecycle.state.lock().map_err(|error| {
                format!("observability persistence lifecycle poisoned: {error}")
            })?;
            if let Some(result) = state.close_result.clone() {
                return result;
            }
            let sender = state
                .sender
                .take()
                .ok_or_else(|| "observability persistence writer was not started".to_string())?;
            let thread = state.thread.take();
            (sender, thread)
        };
        let result = self.finish_close(sender, thread);
        self.set_close_result(result.clone())?;
        result
    }

    fn finish_close(
        &self,
        sender: mpsc::SyncSender<V3WebuiObservabilityPersistenceCommand>,
        thread: Option<std::thread::JoinHandle<()>>,
    ) -> Result<(), String> {
        let (receipt_sender, receipt_receiver) = mpsc::channel();
        let send_result = sender
            .send(V3WebuiObservabilityPersistenceCommand::Shutdown(
                receipt_sender,
            ))
            .map_err(|error| format!("observability persistence writer unavailable: {error}"));
        let shutdown_result = send_result.and_then(|()| {
            receipt_receiver.recv().unwrap_or_else(|error| {
                Err(format!(
                    "observability persistence shutdown receipt missing: {error}"
                ))
            })
        });
        drop(sender);
        let join_result = match thread {
            Some(thread) => thread
                .join()
                .map_err(|_| "observability persistence writer thread panicked".to_string()),
            None => Err("observability persistence writer thread unavailable".to_string()),
        };
        match (shutdown_result, join_result) {
            (Err(error), Err(join_error)) => Err(format!("{error}; {join_error}")),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    fn set_close_result(&self, result: Result<(), String>) -> Result<(), String> {
        self.lifecycle
            .state
            .lock()
            .map_err(|error| format!("observability persistence lifecycle poisoned: {error}"))?
            .close_result = Some(result);
        Ok(())
    }
}

fn run_v3_webui_observability_persistence_writer(
    mut store: routecodex_v3_debug::V3ProviderUsagePersistenceStore,
    receiver: mpsc::Receiver<V3WebuiObservabilityPersistenceCommand>,
    gaps: V3WebuiObservabilityGapQueue,
    writer_alarm: Arc<RwLock<Option<String>>>,
    pending_write_error: Arc<std::sync::Mutex<Option<String>>>,
    history_max_bytes: u64,
) {
    if let Err(error) = store.backfill_detail() {
        set_v3_webui_observability_alarm(
            &writer_alarm,
            format!("provider usage backfill failed: {error}"),
        );
    }
    while let Ok(command) = receiver.recv() {
        match command {
            V3WebuiObservabilityPersistenceCommand::Append {
                row,
                attempt_ordinal,
            } => {
                let result = V3WebuiObservability::persist_usage_then_detail(
                    &mut store,
                    &row,
                    attempt_ordinal,
                    history_max_bytes,
                );
                if let Err(error) = result {
                    if let Ok(mut pending_error) = pending_write_error.lock() {
                        if pending_error.is_none() {
                            *pending_error = Some(error.clone());
                        }
                    }
                    set_v3_webui_observability_alarm(
                        &writer_alarm,
                        format!("observability persistence write failed: {error}"),
                    );
                }
            }
            V3WebuiObservabilityPersistenceCommand::Flush(receipt) => {
                let pending_result = pending_write_error
                    .lock()
                    .map_err(|error| {
                        format!("observability persistence write error state poisoned: {error}")
                    })
                    .map(|mut pending| pending.take());
                let gap_result = persist_queue_gaps(&mut store, &gaps);
                let result = match (gap_result, pending_result) {
                    (Err(gap_error), Err(pending_error)) => {
                        Err(format!("{pending_error}; {gap_error}"))
                    }
                    (Err(error), _) | (Ok(()), Err(error)) => Err(error),
                    (Ok(()), Ok(Some(error))) => Err(error),
                    (Ok(()), Ok(None)) => Ok(()),
                };
                if let Err(ref error) = result {
                    set_v3_webui_observability_alarm(&writer_alarm, error.clone());
                }
                let _ = receipt.send(result);
            }
            V3WebuiObservabilityPersistenceCommand::Shutdown(receipt) => {
                let pending_result = pending_write_error
                    .lock()
                    .map_err(|error| {
                        format!("observability persistence write error state poisoned: {error}")
                    })
                    .map(|mut pending| pending.take());
                let gap_result = persist_queue_gaps(&mut store, &gaps);
                let close_result = store
                    .close_generation()
                    .map_err(|error| format!("observability persistence close failed: {error}"));
                let pending_error = pending_result.unwrap_or_else(Some);
                let errors: Vec<_> = [pending_error, gap_result.err(), close_result.err()]
                    .into_iter()
                    .flatten()
                    .collect();
                let result = if errors.is_empty() {
                    Ok(())
                } else {
                    Err(errors.join("; "))
                };
                if let Err(ref error) = result {
                    set_v3_webui_observability_alarm(&writer_alarm, error.clone());
                }
                let _ = receipt.send(result);
                break;
            }
        }
    }
}

fn persist_queue_gaps(
    store: &mut routecodex_v3_debug::V3ProviderUsagePersistenceStore,
    gaps: &V3WebuiObservabilityGapQueue,
) -> Result<(), String> {
    while let Some(gap) = gaps.front()? {
        store
            .persist_queue_gap(
                gap.listener_id,
                &gap.request_key,
                gap.started_epoch_ms,
                "persistence_queue_rejected",
            )
            .map_err(|error| format!("observability persistence queue gap failed: {error}"))?;
        gaps.pop_front()?;
    }
    while let Some(listener_id) = gaps.first_dropped_listener()? {
        store
            .mark_coverage_gap_only(listener_id, "persistence_gap_queue_overflow")
            .map_err(|error| format!("observability persistence gap overflow failed: {error}"))?;
        gaps.clear_dropped_listener(listener_id)?;
    }
    store
        .flush()
        .map_err(|error| format!("observability persistence queue gap failed: {error}"))
}

fn set_v3_webui_observability_alarm(alarm: &RwLock<Option<String>>, message: String) {
    if let Ok(mut alarm) = alarm.write() {
        if alarm.is_none() {
            *alarm = Some(message);
        }
    }
}

// Test-only fault injection: a real thread spawn only fails under OS resource
// exhaustion, so tests force the failure to exercise the listener startup path
// without exhausting the process. The flag is thread-local and consumed once, so
// it never leaks into another test's writer.
#[cfg(test)]
thread_local! {
    static V3_WEBUI_FORCE_WRITER_SPAWN_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn set_v3_webui_force_writer_spawn_failure() {
    V3_WEBUI_FORCE_WRITER_SPAWN_FAILURE.with(|flag| flag.set(true));
}

#[cfg(test)]
fn take_v3_webui_force_writer_spawn_failure() -> bool {
    V3_WEBUI_FORCE_WRITER_SPAWN_FAILURE.with(|flag| flag.replace(false))
}

#[cfg(test)]
thread_local! {
    static V3_WEBUI_TEST_HISTORY_MAX_BYTES: std::cell::Cell<Option<u64>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn take_v3_webui_test_history_max_bytes() -> Option<u64> {
    V3_WEBUI_TEST_HISTORY_MAX_BYTES.with(|limit| limit.take())
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
        #[cfg(test)]
        let history_limit = take_v3_webui_test_history_max_bytes();
        #[cfg(not(test))]
        let history_limit: Option<u64> = None;
        let persistence_writer = path.as_ref().map(|path| match history_limit {
            #[cfg(test)]
            Some(limit) => V3WebuiObservabilityPersistenceWriter::start_with_limit(
                path.clone(),
                Arc::clone(&alarm),
                limit,
            ),
            _ => V3WebuiObservabilityPersistenceWriter::start(path.clone(), Arc::clone(&alarm)),
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

    pub(crate) async fn flush_persistence_for_exec(&self) -> Result<(), String> {
        match self.persistence_writer.as_ref() {
            Some(writer) => writer.flush_for_exec().await,
            None => Ok(()),
        }
    }

    pub(crate) fn close_persistence(&self) -> Result<(), String> {
        match self.persistence_writer.as_ref() {
            Some(writer) => writer.close(),
            None => Ok(()),
        }
    }

    pub(crate) async fn close_persistence_async(&self) -> Result<(), String> {
        match self.persistence_writer.as_ref() {
            Some(writer) => writer.close_async().await,
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
        let incoming_establishes_completed_terminal =
            event_type == V3ObsEventType::Completed && !terminal_event_after_terminal_row;
        let established_result_is_success = terminal_event_after_terminal_row
            && inner
                .requests
                .get(request_key)
                .is_some_and(|row| row.result.as_deref() == Some("success"));
        // A request terminates once, so a second terminal event must not restart
        // its outcome, duration or counters. It DOES still merge its metadata:
        // several lanes project terminal error truth for one request (the relay
        // lane records the honest absence marker, the direct lane records the real
        // chain), and whichever lands first must not decide what the row says.
        // `merge_v3_obs_error_truth` owns that precedence, and it is monotonic, so
        // a later lane can only strengthen the recorded truth, never weaken it.
        let mut row;
        let mut persistence_attempt_ordinal = None;
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
            row.meta =
                merge_v3_obs_request_meta(row.meta, meta, false, established_result_is_success);
            // A terminal replay must not move an ordinary lifecycle row to the
            // front of the bounded startup fold. The durable fact file already
            // owns replay idempotency.
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
            row.meta = merge_v3_obs_request_meta(
                row.meta,
                meta,
                incoming_establishes_completed_terminal,
                false,
            );
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
                    persistence_attempt_ordinal = Some(attempt_index);
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
        // A provider switch is a lifecycle control event, not a second failure.
        // The provider_attempt_failed row already carries this attempt's upstream
        // status, category, detail and typed error truth; persisting them again on
        // the switch line makes one failure look like two in request-records.jsonl
        // and in every facet/streak consumer that reads the raw lifecycle lines.
        // The in-memory row keeps its last-failure projection for the live table;
        // only the persisted switch snapshot drops the duplicated failure fields.
        if event_type == V3ObsEventType::ProviderSwitched {
            row.meta.provider_status = None;
            row.meta.error_category = None;
            row.meta.error_detail = None;
            row.meta.observed_error = None;
        }
        if let Some(writer) = self.persistence_writer.as_ref() {
            writer.enqueue(row, persistence_attempt_ordinal);
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

    fn persist_usage_then_detail(
        store: &mut routecodex_v3_debug::V3ProviderUsagePersistenceStore,
        row: &V3ObsRequestRow,
        attempt_ordinal: Option<u64>,
        max_history_bytes: u64,
    ) -> Result<(), String> {
        let path = store.observability_path().to_path_buf();
        let value = serde_json::to_value(row)
            .map_err(|error| format!("encode observability record failed: {error}"))?;
        let fact_result =
            store.persist_row_before_detail(&value, attempt_ordinal, attempt_ordinal.is_some());
        if let Err(fact_error) = fact_result {
            let detail_result =
                routecodex_v3_debug::v3_webui_observability_append_row_without_retention_hard_cap(
                    &path,
                    &value,
                    max_history_bytes,
                );
            let (failure_result, detail_overflowed) = match detail_result {
                Ok(()) => (
                    Err(format!(
                        "persist provider usage fact failed: {fact_error}; detail appended within hard limit without retention"
                    )),
                    false,
                ),
                Err(detail_error) => {
                    (
                        Err(format!(
                            "persist provider usage fact failed: {fact_error}; detail dropped at hard limit: {detail_error}; fact_write_failed_detail_overflow"
                        )),
                        true,
                    )
                }
            };
            let _ = store.mark_fact_write_failure(
                row.scope.port,
                row.started_epoch_ms,
                detail_overflowed,
            );
            return failure_result;
        }
        Self::append_persisted_row_with_limit(&path, row, max_history_bytes).map_err(
            |detail_error| {
                if let Err(gap_error) = store.mark_gap(
                    row.scope.port,
                    &row.request_key,
                    attempt_ordinal,
                    "detail_append_failed",
                ) {
                    return format!(
                        "write observability store failed: {detail_error}; mark detail gap failed: {gap_error}"
                    );
                }
                format!("write observability store failed: {detail_error}")
            },
        )?;
        store
            .mark_detail_started(row.scope.port, row.started_epoch_ms)
            .map_err(|error| format!("mark provider usage detail coverage failed: {error}"))
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
pub(crate) mod tests {
    include!("webui_observability_tests.rs");

    use routecodex_v3_debug::observability_store::{
        v3_provider_usage_read_generation, v3_webui_observability_read_provider_usage,
        v3_webui_observability_read_provider_usage_with_limits, V3ProviderUsageFact,
        V3ProviderUsageFactResult,
    };
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;

    fn observed_usage(input: u64, output: u64) -> crate::V3RuntimeObservability {
        crate::V3RuntimeObservability {
            usage: Some(crate::V3RuntimeUsageSummary {
                input_tokens: Some(input),
                output_tokens: Some(output),
                total_tokens: Some(input.saturating_add(output)),
                cached_tokens: None,
                cache_read_input_tokens: None,
                cache_creation_input_tokens: None,
            }),
            ..Default::default()
        }
    }

    fn provider_meta(req: &str, provider: &str) -> V3ObsRequestMeta {
        V3ObsRequestMeta {
            request_id: req.to_string(),
            endpoint: "/v1/responses".to_string(),
            provider_id: Some(provider.to_string()),
            provider: Some(provider.to_string()),
            entry_protocol: Some("responses".to_string()),
            ..Default::default()
        }
    }

    fn isolated_store(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "v3-provider-usage-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("isolated store directory");
        dir
    }

    fn recount_terminal(
        observability: &V3WebuiObservability,
        key: &str,
        port: u16,
        req: &str,
        provider: &str,
        observed: &crate::V3RuntimeObservability,
    ) {
        record_observed(
            observability,
            V3ObsEventType::Completed,
            key,
            scope(port),
            provider_meta(req, provider),
            observed,
        )
        .expect("terminal replay");
        observability
            .flush_persistence()
            .expect("terminal persistence flush");
    }

    #[test]
    fn provider_usage_backfill_reads_historical_attempts_without_overwriting_facts() {
        let dir = isolated_store("raw-backfill");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let key = build_v3_obs_request_key(4444, "r-historical");
        let rows = [
            serde_json::json!({
                "request_key": key,
                "event_type": "request.started",
                "started_epoch_ms": 10,
                "updated_epoch_ms": 10,
                "scope": { "port": 4444 },
                "meta": { "request_id": "r-historical" }
            }),
            serde_json::json!({
                "request_key": key,
                "event_type": "request.provider_attempt_failed",
                "started_epoch_ms": 10,
                "updated_epoch_ms": 20,
                "scope": { "port": 4444 },
                "meta": {
                    "request_id": "r-historical",
                    "provider_id": "p-old",
                    "observed_error": { "attempt_index": 1 }
                }
            }),
            serde_json::json!({
                "request_key": key,
                "event_type": "request.completed",
                "started_epoch_ms": 10,
                "updated_epoch_ms": 30,
                "finished_epoch_ms": 30,
                "scope": { "port": 4444 },
                "meta": { "request_id": "r-historical", "provider_id": "p-new" },
                "result": "success",
                "usage": { "input_tokens": 40, "output_tokens": 5, "total_tokens": 45 }
            }),
        ];
        for row in &rows {
            routecodex_v3_debug::v3_webui_observability_append_row(&records, row).unwrap();
        }

        routecodex_v3_debug::v3_provider_usage_backfill_detail(&records).unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == key
                && fact.attempt_ordinal == Some(1)
                && fact.provider_id.as_deref() == Some("p-old")
                && fact.result == V3ProviderUsageFactResult::FailedAttempt
        }));
        let terminal = read
            .facts
            .iter()
            .find(|fact| fact.request_key == key && fact.attempt_ordinal.is_none())
            .expect("terminal historical fact");
        assert_eq!(terminal.provider_id.as_deref(), Some("p-new"));

        routecodex_v3_debug::v3_provider_usage_backfill_detail(&records).unwrap();
        let replay = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert_eq!(replay.facts.len(), read.facts.len());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_survives_backfill_detail_rotation_restart_and_corrected_attribution() {
        V3_WEBUI_TEST_HISTORY_MAX_BYTES.with(|limit| limit.set(Some(2000)));
        let dir = isolated_store("lifecycle");
        let records = dir.join("records.jsonl");
        let hash = build_v3_obs_request_key(4444, "r-hash");
        let backfill = build_v3_obs_request_key(4444, "r-backfill");
        let retry = build_v3_obs_request_key(7777, "r-retry");

        let first = V3WebuiObservability::with_persistence_path(Some(records.clone()));
        record_observed(
            &first,
            V3ObsEventType::Completed,
            &hash,
            scope(4444),
            provider_meta("r-hash", "p1"),
            &observed_usage(100, 20),
        )
        .unwrap();
        first.flush_persistence().unwrap();
        let before_backfill = std::fs::File::open(&records).unwrap();
        record_observed(
            &first,
            V3ObsEventType::Completed,
            &backfill,
            scope(4444),
            provider_meta("r-backfill", "p-backfill"),
            &observed_usage(7, 3),
        )
        .unwrap();
        first.flush_persistence().unwrap();
        assert_ne!(
            std::fs::metadata(&records).unwrap().ino(),
            before_backfill.metadata().unwrap().ino(),
            "backfill must exercise a detail compaction round"
        );
        drop(before_backfill);
        let before_first_attempt = std::fs::File::open(&records).unwrap();
        record(
            &first,
            V3ObsEventType::ProviderAttemptStarted,
            &retry,
            scope(7777),
            provider_meta("r-retry", "p-a"),
        )
        .unwrap();
        record(
            &first,
            V3ObsEventType::ProviderAttemptFailed,
            &retry,
            scope(7777),
            provider_meta("r-retry", "p-a"),
        )
        .unwrap();
        first.flush_persistence().unwrap();
        assert_ne!(
            std::fs::metadata(&records).unwrap().ino(),
            before_first_attempt.metadata().unwrap().ino(),
            "attempt detail must exercise the second compaction round"
        );
        drop(before_first_attempt);
        assert!(
            std::fs::metadata(&records).unwrap().len() <= 2_000,
            "each compaction round must enforce the configured retention threshold"
        );
        record(
            &first,
            V3ObsEventType::ProviderAttemptStarted,
            &retry,
            scope(7777),
            provider_meta("r-retry", "p-b"),
        )
        .unwrap();
        record(
            &first,
            V3ObsEventType::ProviderAttemptFailed,
            &retry,
            scope(7777),
            provider_meta("r-retry", "p-b"),
        )
        .unwrap();
        record_observed(
            &first,
            V3ObsEventType::Completed,
            &retry,
            scope(7777),
            provider_meta("r-retry", "p-b"),
            &observed_usage(50, 10),
        )
        .unwrap();
        first.flush_persistence().unwrap();
        recount_terminal(
            &first,
            &hash,
            4444,
            "r-hash",
            "p1",
            &observed_usage(100, 20),
        );
        recount_terminal(
            &first,
            &retry,
            7777,
            "r-retry",
            "p-b",
            &observed_usage(50, 10),
        );

        let stale_detail = V3ObsRequestRow {
            request_key: retry.clone(),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 1,
            updated_epoch_ms: 2,
            finished_epoch_ms: Some(2),
            meta: provider_meta("r-retry", "p-a"),
            scope: scope(7777),
            result: Some("success".to_string()),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(999),
                output_tokens: Some(999),
                total_tokens: Some(1998),
                ..Default::default()
            }),
            ..Default::default()
        };
        drop(first);
        let second = V3WebuiObservability::load_persisted(&records);
        V3WebuiObservability::append_persisted_row(&records, &stale_detail).unwrap();
        second.flush_persistence().unwrap();

        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert_eq!(
            read.facts.len(),
            5,
            "three terminal requests and two stable ordinal attempts remain five facts"
        );
        let retry_facts = read
            .facts
            .iter()
            .filter(|fact| fact.listener_id == 7777 && fact.request_key == retry)
            .collect::<Vec<_>>();
        assert_eq!(retry_facts.len(), 3);
        assert!(retry_facts.iter().any(|fact| {
            fact.attempt_ordinal == Some(1)
                && fact.provider_id.as_deref() == Some("p-a")
                && fact.result == V3ProviderUsageFactResult::FailedAttempt
        }));
        assert!(retry_facts.iter().any(|fact| {
            fact.attempt_ordinal == Some(2)
                && fact.provider_id.as_deref() == Some("p-b")
                && fact.result == V3ProviderUsageFactResult::FailedAttempt
        }));
        let corrected = retry_facts
            .iter()
            .find(|fact| fact.attempt_ordinal.is_none())
            .expect("terminal fact");
        assert_eq!(corrected.provider_id.as_deref(), Some("p-b"));
        assert_eq!(
            corrected
                .usage
                .as_ref()
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(serde_json::Value::as_u64),
            Some(50)
        );
        let coverage = read
            .coverage_for(4444)
            .expect("listener statistics coverage");
        assert!(coverage.statistics_started_epoch_ms.is_some());
        assert!(coverage.detail_started_epoch_ms.is_some());
        assert!(coverage.detail_incomplete);
        assert!(coverage.gaps.iter().any(|gap| gap == "detail_unavailable"));
        assert!(read.coverage_for(7777).is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_restart_after_fact_success_and_detail_failure_keeps_corrected_attribution() {
        let dir = isolated_store("detail-failure");
        let records = dir.join("records.jsonl");
        let key = build_v3_obs_request_key(4444, "r-detail-failure");
        let first = V3WebuiObservability::with_persistence_path(Some(records.clone()));
        record_observed(
            &first,
            V3ObsEventType::Completed,
            &key,
            scope(4444),
            provider_meta("r-detail-failure", "p-new"),
            &observed_usage(11, 4),
        )
        .unwrap();
        first.flush_persistence().unwrap();

        std::fs::remove_file(&records).unwrap();
        std::fs::create_dir(&records).unwrap();
        record_observed(
            &first,
            V3ObsEventType::Completed,
            &key,
            scope(4444),
            provider_meta("r-detail-failure", "p-new"),
            &observed_usage(11, 4),
        )
        .unwrap();
        assert!(first
            .flush_persistence()
            .unwrap_err()
            .contains("write observability store failed"));
        drop(first);

        std::fs::remove_dir(&records).unwrap();
        let legacy = V3ObsRequestRow {
            request_key: key.clone(),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 10,
            updated_epoch_ms: 20,
            finished_epoch_ms: Some(20),
            meta: provider_meta("r-detail-failure", "p-old"),
            scope: scope(4444),
            result: Some("success".to_string()),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(1),
                output_tokens: Some(1),
                total_tokens: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        };
        V3WebuiObservability::append_persisted_row(&records, &legacy).unwrap();
        let restarted = V3WebuiObservability::load_persisted(&records);

        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        let terminal = read
            .facts
            .iter()
            .find(|fact| {
                fact.listener_id == 4444
                    && fact.request_key == key
                    && fact.attempt_ordinal.is_none()
            })
            .expect("terminal fact");
        assert_eq!(terminal.provider_id.as_deref(), Some("p-new"));
        assert_eq!(
            terminal
                .usage
                .as_ref()
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(serde_json::Value::as_u64),
            Some(11)
        );
        assert!(terminal
            .gaps
            .iter()
            .any(|gap| gap == "detail_append_failed"));
        assert!(read
            .coverage_for(4444)
            .expect("coverage")
            .gaps
            .iter()
            .any(|gap| gap == "detail_append_failed"));

        let later = build_v3_obs_request_key(4444, "r-later");
        record_observed(
            &restarted,
            V3ObsEventType::Completed,
            &later,
            scope(4444),
            provider_meta("r-later", "p-new"),
            &observed_usage(5, 2),
        )
        .unwrap();
        restarted.flush_persistence().unwrap();
        let after_success = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(after_success
            .coverage_for(4444)
            .expect("coverage after success")
            .gaps
            .iter()
            .any(|gap| gap == "detail_append_failed"));
        assert!(after_success
            .facts
            .iter()
            .find(|fact| fact.listener_id == 4444 && fact.request_key == key)
            .expect("terminal after later success")
            .gaps
            .iter()
            .any(|gap| gap == "detail_append_failed"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_marks_incomplete_detail_without_claiming_unfinished_request_usage() {
        let dir = isolated_store("incomplete");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(records.parent().unwrap()).unwrap();
        let complete = serde_json::json!({
            "schema_version": 1,
            "row": {
                "request_key": "4444:r-complete",
                "event_type": "request.completed",
                "started_epoch_ms": 10,
                "updated_epoch_ms": 20,
                "finished_epoch_ms": 20,
                "scope": { "port": 4444 },
                "meta": { "request_id": "r-complete", "provider_id": "p1" },
                "result": "success",
                "usage": { "input_tokens": 10, "output_tokens": 0, "total_tokens": 10 }
            }
        });
        let active = serde_json::json!({
            "schema_version": 1,
            "row": {
                "request_key": "4444:r-active",
                "event_type": "request.started",
                "started_epoch_ms": 30,
                "updated_epoch_ms": 30,
                "scope": { "port": 4444 },
                "meta": { "request_id": "r-active" }
            }
        });
        let fragment = "{\"schema_version\":1,\"row\":{\"request_key\":\"4444:r-half\"";
        std::fs::write(&records, format!("{complete}\n{active}\n{fragment}")).unwrap();
        let observability = V3WebuiObservability::load_persisted(&records);
        observability.flush_persistence().unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == "4444:r-active"
                && fact.result == V3ProviderUsageFactResult::Active
                && fact.usage.is_none()
        }));
        let coverage = read.coverage_for(4444).expect("coverage");
        assert!(coverage.detail_incomplete);
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "incomplete_detail_tail"));
        assert!(coverage.detail_started_epoch_ms.unwrap_or(u64::MAX) <= 10);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn issue_f8c64a9_exec_flush_remains_cancellable_when_writer_is_slow() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: V3WebuiObservabilityGapQueue::new(),
            alarm: Arc::new(RwLock::new(None)),
            pending_write_error: Arc::new(std::sync::Mutex::new(None)),
            history_max_bytes: V3_WEBUI_HISTORY_MAX_BYTES,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender, false,
            )),
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(30),
            writer.flush_for_exec(),
        )
        .await;
        assert!(
            result.is_err(),
            "an unanswered writer must yield to the timeout"
        );
        assert!(matches!(
            receiver.try_recv(),
            Ok(V3WebuiObservabilityPersistenceCommand::Flush(_))
        ));
        drop(receiver);
        drop(writer);
    }

    #[tokio::test]
    async fn issue_f8c64a9_close_yields_and_retains_terminal_ownership() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let (queued_tx, queued_rx) = mpsc::channel();
        sender
            .try_send(V3WebuiObservabilityPersistenceCommand::Flush(queued_tx))
            .unwrap();
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: V3WebuiObservabilityGapQueue::new(),
            alarm: Arc::new(RwLock::new(None)),
            pending_write_error: Arc::new(std::sync::Mutex::new(None)),
            history_max_bytes: V3_WEBUI_HISTORY_MAX_BYTES,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender, true,
            )),
        };
        let (release_tx, release_rx) = mpsc::channel();
        writer.lifecycle.attach_thread(std::thread::spawn(move || {
            release_rx.recv().unwrap();
            if let V3WebuiObservabilityPersistenceCommand::Flush(receipt) = receiver.recv().unwrap()
            {
                receipt.send(Ok(())).unwrap();
            } else {
                panic!("accepted queued work was lost");
            }
            if let V3WebuiObservabilityPersistenceCommand::Shutdown(receipt) =
                receiver.recv().unwrap()
            {
                receipt.send(Ok(())).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(30));
            } else {
                panic!("expected terminal command");
            }
        }));
        // Release even on a blocking baseline or failed assertion.
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            release_tx.send(()).unwrap();
        });
        let pending =
            tokio::time::timeout(std::time::Duration::from_millis(30), writer.close_async()).await;
        let was_pending = pending.is_err();
        if was_pending {
            assert!(writer
                .lifecycle
                .state
                .lock()
                .unwrap()
                .close_result
                .is_none());
            assert!(writer.lifecycle.state.lock().unwrap().sender.is_none());
            writer.close_async().await.unwrap();
        }
        releaser.join().unwrap();
        assert_eq!(queued_rx.recv().unwrap(), Ok(()));
        assert!(
            was_pending,
            "close blocked the runtime instead of yielding to the deadline"
        );
        assert_eq!(
            writer.lifecycle.state.lock().unwrap().close_result,
            Some(Ok(()))
        );
    }

    #[test]
    fn issue_f8c64a9_drop_does_not_wait_for_slow_writer() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let lifecycle = V3WebuiObservabilityPersistenceWriterLifecycle::new(sender, true);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        lifecycle.attach_thread(std::thread::spawn(move || {
            if let Ok(V3WebuiObservabilityPersistenceCommand::Shutdown(receipt)) = receiver.recv() {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let _ = receipt.send(Ok(()));
                finished_tx.send(()).unwrap();
            }
        }));
        let (dropped_tx, dropped_rx) = mpsc::channel();
        let dropper = std::thread::spawn(move || {
            drop(lifecycle);
            dropped_tx.send(()).unwrap();
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let returned_while_writer_held = dropped_rx
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok();
        release_tx.send(()).unwrap();
        dropper.join().unwrap();
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(
            returned_while_writer_held,
            "dropping the lifecycle blocked on the writer"
        );
    }

    #[test]
    fn provider_usage_queue_rejection_is_a_visible_gap() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let alarm = Arc::new(RwLock::new(None));
        let gaps = V3WebuiObservabilityGapQueue::new();
        let pending_write_error = Arc::new(std::sync::Mutex::new(None));
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: gaps.clone(),
            alarm: Arc::clone(&alarm),
            pending_write_error: Arc::clone(&pending_write_error),
            history_max_bytes: V3_WEBUI_HISTORY_MAX_BYTES,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender.clone(),
                true,
            )),
        };
        let key = build_v3_obs_request_key(4444, "r-queue");
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Append {
                row: V3ObsRequestRow {
                    request_key: build_v3_obs_request_key(4444, "r-queue-fill"),
                    scope: scope(4444),
                    ..Default::default()
                },
                attempt_ordinal: None,
            })
            .unwrap();
        writer.enqueue(
            V3ObsRequestRow {
                request_key: key.clone(),
                event_type: V3ObsEventType::Completed.as_str().to_string(),
                started_epoch_ms: 100,
                scope: scope(4444),
                result: Some("success".to_string()),
                ..Default::default()
            },
            None,
        );
        assert!(alarm
            .read()
            .unwrap()
            .as_deref()
            .is_some_and(|message| message.contains("queue rejected")));
        let dir = isolated_store("queue-rejection");
        let records = dir.join("records.jsonl");
        let spawned = V3WebuiObservabilityPersistenceWriter::spawn_writer(
            records.clone(),
            receiver,
            gaps.clone(),
            Arc::clone(&alarm),
            Arc::clone(&pending_write_error),
            V3_WEBUI_HISTORY_MAX_BYTES,
            routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits::default(),
        )
        .expect("real persistence writer");
        let completed = V3ObsRequestRow {
            request_key: build_v3_obs_request_key(4444, "r-queue-later"),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 200,
            updated_epoch_ms: 200,
            finished_epoch_ms: Some(200),
            scope: scope(4444),
            result: Some("success".to_string()),
            ..Default::default()
        };
        writer.flush().expect("drain queue gap through real writer");
        writer.enqueue(completed.clone(), None);
        writer.flush().expect("later successful persistence");
        drop(writer);
        spawned.join().expect("real persistence writer completion");
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read
            .coverage_for(4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "persistence_queue_rejected"));
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == completed.request_key
                && fact.result == V3ProviderUsageFactResult::Success
        }));
        assert!(read
            .facts
            .iter()
            .any(|fact| fact.request_key == "4444:r-queue-fill"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    pub(crate) fn terminal_close_returns_pending_write_failure_after_joining_the_writer() {
        let limits = routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits {
            latest_encoded_fact_bytes: 8_192,
            max_facts: 1,
            physical_fact_log_bytes: 8_192,
            complete_fact_bytes: 8_192,
            companion_state_bytes: 64 * 1024,
        };
        let (writer, dir, records) =
            terminal_close_test_writer("terminal-close-write-failure", limits);
        writer.enqueue(terminal_close_test_row(4444, "terminal-first", 10), None);
        writer.flush().expect("first accepted fact");
        writer.enqueue(terminal_close_test_row(4444, "terminal-capacity", 20), None);
        let error = writer
            .close()
            .expect_err("terminal close must retain an accepted capacity failure");
        assert!(
            error.contains("capacity"),
            "unexpected close error: {error}"
        );
        assert!(
            !v3_provider_usage_read_generation(&records).unwrap().open,
            "failed terminal close must still close generation before returning"
        );
        assert!(writer.close().is_err(), "terminal close must remain sticky");
        drop(writer);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    pub(crate) fn terminal_close_waits_for_queued_work_before_closing_generation() {
        let (writer, dir, records) = terminal_close_test_writer(
            "terminal-close-accepted-work",
            routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits::default(),
        );
        writer.enqueue(terminal_close_test_row(4444, "queued-terminal", 10), None);
        writer.close().expect("terminal close");
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert_eq!(
            read.facts.len(),
            1,
            "accepted work must be processed before close"
        );
        assert!(!v3_provider_usage_read_generation(&records).unwrap().open);
        drop(writer);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn issue_f8c64a9_async_close_preserves_real_records_and_write_error() {
        let limits = routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits {
            latest_encoded_fact_bytes: 8_192,
            max_facts: 1,
            physical_fact_log_bytes: 8_192,
            complete_fact_bytes: 8_192,
            companion_state_bytes: 64 * 1024,
        };
        let (writer, dir, records) =
            terminal_close_test_writer("async-close-write-failure", limits);
        writer.enqueue(terminal_close_test_row(4444, "async-first", 10), None);
        let flushing = writer.clone();
        tokio::task::spawn_blocking(move || flushing.flush())
            .await
            .unwrap()
            .unwrap();
        writer.enqueue(terminal_close_test_row(4444, "async-capacity", 20), None);
        let error = writer.close_async().await.unwrap_err();
        assert!(error.contains("capacity"), "{error}");
        assert_eq!(
            v3_webui_observability_read_provider_usage(&records)
                .unwrap()
                .facts
                .len(),
            1
        );
        assert!(!v3_provider_usage_read_generation(&records).unwrap().open);
        assert_eq!(writer.close_async().await.unwrap_err(), error);
        drop(writer);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn issue_f8c64a9_drop_reaper_preserves_accepted_records() {
        let (writer, dir, records) = terminal_close_test_writer(
            "drop-accepted-work",
            routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits::default(),
        );
        writer.enqueue(terminal_close_test_row(4444, "drop-terminal", 10), None);
        drop(writer);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if v3_provider_usage_read_generation(&records)
                .map(|generation| !generation.open && generation.last_normal_end_epoch_ms.is_some())
                .unwrap_or(false)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "reaper did not close generation"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            v3_webui_observability_read_provider_usage(&records)
                .unwrap()
                .facts
                .len(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn provider_usage_queue_gap_write_failure_is_retried_before_later_success() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let alarm = Arc::new(RwLock::new(None));
        let gaps = V3WebuiObservabilityGapQueue::new();
        let pending_write_error = Arc::new(std::sync::Mutex::new(None));
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: gaps.clone(),
            alarm: Arc::clone(&alarm),
            pending_write_error: Arc::clone(&pending_write_error),
            history_max_bytes: V3_WEBUI_HISTORY_MAX_BYTES,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender.clone(),
                true,
            )),
        };
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Append {
                row: V3ObsRequestRow {
                    request_key: build_v3_obs_request_key(4444, "r-gap-fill"),
                    scope: scope(4444),
                    ..Default::default()
                },
                attempt_ordinal: None,
            })
            .unwrap();
        let first = build_v3_obs_request_key(4444, "r-gap-first");
        let second = build_v3_obs_request_key(4444, "r-gap-second");
        for (request_key, started_epoch_ms) in [(&first, 100), (&second, 200)] {
            writer.enqueue(
                V3ObsRequestRow {
                    request_key: request_key.clone(),
                    event_type: V3ObsEventType::Completed.as_str().to_string(),
                    started_epoch_ms,
                    scope: scope(4444),
                    result: Some("success".to_string()),
                    ..Default::default()
                },
                None,
            );
        }
        let dir = isolated_store("queue-gap-retry");
        let records = dir.join("records.jsonl");
        routecodex_v3_debug::v3_provider_usage_append_fact(
            &records,
            V3ProviderUsageFact {
                listener_id: 4444,
                request_key: build_v3_obs_request_key(4444, "r-existing"),
                attempt_ordinal: None,
                request_started_epoch_ms: 1,
                result: V3ProviderUsageFactResult::Success,
                provider_id: Some("p-existing".to_string()),
                usage: Some(serde_json::json!({"input_tokens": 1})),
                gaps: Vec::new(),
            },
        )
        .expect("seed readable facts file");
        let coverage_path =
            routecodex_v3_debug::observability_store::v3_provider_usage_coverage_path(&records);
        std::fs::write(&coverage_path, b"[]").expect("seed readable coverage file");
        let store = routecodex_v3_debug::V3ProviderUsagePersistenceStore::open(&records)
            .expect("open real persistence store");
        std::fs::remove_file(&coverage_path).expect("remove coverage file");
        std::fs::create_dir(&coverage_path).expect("make coverage write fail");
        let spawned = std::thread::Builder::new()
            .name("v3-webui-observability-retry-test".to_string())
            .spawn({
                let gaps = gaps.clone();
                let alarm = Arc::clone(&alarm);
                let pending_write_error = Arc::clone(&pending_write_error);
                move || {
                    run_v3_webui_observability_persistence_writer(
                        store,
                        receiver,
                        gaps,
                        alarm,
                        pending_write_error,
                        V3_WEBUI_HISTORY_MAX_BYTES,
                    )
                }
            })
            .expect("real persistence writer loop");
        writer
            .flush()
            .expect_err("coverage failure must retain retryable queue gaps");
        std::fs::remove_dir(&coverage_path).expect("restore coverage path");
        let _ = writer.flush();
        writer.flush().expect("retry retained queue gaps");

        let completed = V3ObsRequestRow {
            request_key: build_v3_obs_request_key(4444, "r-gap-later-success"),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 300,
            updated_epoch_ms: 300,
            finished_epoch_ms: Some(300),
            scope: scope(4444),
            result: Some("success".to_string()),
            ..Default::default()
        };
        writer.enqueue(completed.clone(), None);
        writer.flush().expect("later successful persistence");
        drop(writer);
        spawned.join().expect("real persistence writer completion");

        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read
            .coverage_for(4444)
            .expect("coverage")
            .gaps
            .iter()
            .any(|gap| gap == "persistence_queue_rejected"));
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == completed.request_key
                && fact.result == V3ProviderUsageFactResult::Success
        }));
        for request_key in [first, second] {
            let fact = read
                .facts
                .iter()
                .find(|fact| fact.request_key == request_key)
                .expect("retried queue gap fact");
            assert!(fact
                .gaps
                .iter()
                .any(|gap| gap == "persistence_queue_rejected"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_queue_rejection_survives_normal_shutdown_without_flush() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let alarm = Arc::new(RwLock::new(None));
        let gaps = V3WebuiObservabilityGapQueue::new();
        let pending_write_error = Arc::new(std::sync::Mutex::new(None));
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: gaps.clone(),
            alarm: Arc::clone(&alarm),
            pending_write_error: Arc::clone(&pending_write_error),
            history_max_bytes: V3_WEBUI_HISTORY_MAX_BYTES,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender.clone(),
                true,
            )),
        };
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Append {
                row: V3ObsRequestRow {
                    request_key: build_v3_obs_request_key(4444, "r-shutdown-fill"),
                    scope: scope(4444),
                    ..Default::default()
                },
                attempt_ordinal: None,
            })
            .unwrap();
        writer.enqueue(
            V3ObsRequestRow {
                request_key: build_v3_obs_request_key(4444, "r-shutdown-gap"),
                event_type: V3ObsEventType::Completed.as_str().to_string(),
                started_epoch_ms: 100,
                scope: scope(4444),
                result: Some("success".to_string()),
                ..Default::default()
            },
            None,
        );
        let dir = isolated_store("shutdown-gap");
        let records = dir.join("records.jsonl");
        let spawned = V3WebuiObservabilityPersistenceWriter::spawn_writer(
            records.clone(),
            receiver,
            gaps,
            Arc::clone(&alarm),
            pending_write_error,
            V3_WEBUI_HISTORY_MAX_BYTES,
            routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits::default(),
        )
        .expect("real persistence writer");

        writer.lifecycle.attach_thread(spawned);
        writer.close().expect("normal writer shutdown");

        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read
            .coverage_for(4444)
            .expect("coverage")
            .gaps
            .iter()
            .any(|gap| gap == "persistence_queue_rejected"));
        assert!(!v3_provider_usage_read_generation(&records).unwrap().open);
        drop(writer);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_fact_failure_appends_detail_only_within_hard_limit() {
        let dir = isolated_store("fact-failure");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let mut store =
            routecodex_v3_debug::V3ProviderUsagePersistenceStore::open(&records).unwrap();
        std::fs::create_dir(routecodex_v3_debug::v3_provider_usage_facts_path(&records)).unwrap();
        let row = V3ObsRequestRow {
            request_key: build_v3_obs_request_key(4444, "r-fact-failure"),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 10,
            updated_epoch_ms: 20,
            finished_epoch_ms: Some(20),
            scope: scope(4444),
            result: Some("success".to_string()),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(9),
                output_tokens: Some(1),
                total_tokens: Some(10),
                ..Default::default()
            }),
            ..Default::default()
        };
        V3WebuiObservability::append_persisted_row(&records, &row).unwrap();
        let within_limit =
            V3WebuiObservability::persist_usage_then_detail(&mut store, &row, None, 100_000)
                .unwrap_err();
        assert!(within_limit.contains("detail appended within hard limit without retention"));
        let rows = routecodex_v3_debug::v3_webui_observability_read_raw_rows(&records).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.last()
                .and_then(|row| row.get("request_key"))
                .and_then(serde_json::Value::as_str),
            Some(row.request_key.as_str())
        );
        let inode_before = std::fs::metadata(&records).unwrap().ino();
        let error =
            V3WebuiObservability::persist_usage_then_detail(&mut store, &row, None, 1).unwrap_err();
        assert!(error.contains("detail dropped at hard limit"));
        assert_eq!(std::fs::metadata(&records).unwrap().ino(), inode_before);
        let rows = routecodex_v3_debug::v3_webui_observability_read_raw_rows(&records).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.last()
                .and_then(|row| row.get("request_key"))
                .and_then(serde_json::Value::as_str),
            Some(row.request_key.as_str())
        );
        std::fs::remove_dir(routecodex_v3_debug::v3_provider_usage_facts_path(&records)).unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read
            .coverage_for(4444)
            .expect("coverage")
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_write_failed"));
        assert!(read
            .coverage_for(4444)
            .expect("coverage")
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_write_failed_detail_overflow"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_detail_started_is_only_recorded_after_detail_append() {
        let dir = isolated_store("detail-start");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let mut store =
            routecodex_v3_debug::V3ProviderUsagePersistenceStore::open(&records).unwrap();
        std::fs::create_dir(&records).unwrap();
        let row = V3ObsRequestRow {
            request_key: build_v3_obs_request_key(4444, "r-detail-start"),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 50,
            updated_epoch_ms: 60,
            finished_epoch_ms: Some(60),
            scope: scope(4444),
            result: Some("success".to_string()),
            ..Default::default()
        };
        assert!(
            V3WebuiObservability::persist_usage_then_detail(&mut store, &row, None, 100_000,)
                .unwrap_err()
                .contains("write observability store failed")
        );
        std::fs::remove_dir(&records).unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        let coverage = read.coverage_for(4444).expect("statistics coverage");
        assert_eq!(coverage.statistics_started_epoch_ms, Some(50));
        assert_eq!(coverage.detail_started_epoch_ms, None);
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "detail_append_failed"));
        drop(store);
        let mut store =
            routecodex_v3_debug::V3ProviderUsagePersistenceStore::open(&records).unwrap();
        V3WebuiObservability::persist_usage_then_detail(&mut store, &row, None, 100_000).unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert_eq!(
            read.coverage_for(4444)
                .expect("detail coverage")
                .detail_started_epoch_ms,
            Some(50)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_capacity_rejection_survives_real_writer_success_and_shutdown() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let alarm = Arc::new(RwLock::new(None));
        let gaps = V3WebuiObservabilityGapQueue::new();
        let pending_write_error = Arc::new(std::sync::Mutex::new(None));
        let writer = V3WebuiObservabilityPersistenceWriter {
            gaps: gaps.clone(),
            alarm: Arc::clone(&alarm),
            pending_write_error: Arc::clone(&pending_write_error),
            history_max_bytes: 100_000,
            lifecycle: Arc::new(V3WebuiObservabilityPersistenceWriterLifecycle::new(
                sender.clone(),
                true,
            )),
        };
        let dir = isolated_store("capacity-real-writer");
        let records = dir.join("records.jsonl");
        let limits = routecodex_v3_debug::observability_store::V3ProviderUsagePersistenceLimits {
            latest_encoded_fact_bytes: 8_192,
            max_facts: 1,
            physical_fact_log_bytes: 8_192,
            complete_fact_bytes: 8_192,
            companion_state_bytes: 64 * 1024,
        };
        let spawned = V3WebuiObservabilityPersistenceWriter::spawn_writer(
            records.clone(),
            receiver,
            gaps,
            Arc::clone(&alarm),
            Arc::clone(&pending_write_error),
            100_000,
            limits,
        )
        .expect("real persistence writer");

        let first_key = build_v3_obs_request_key(4444, "r-capacity-first");
        let second_key = build_v3_obs_request_key(4444, "r-capacity-second");
        let first = V3ObsRequestRow {
            request_key: first_key.clone(),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 10,
            updated_epoch_ms: 10,
            finished_epoch_ms: Some(10),
            scope: scope(4444),
            result: Some("success".to_string()),
            meta: provider_meta("r-capacity-first", "p1"),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(1),
                output_tokens: Some(1),
                total_tokens: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        };
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Append {
                row: first,
                attempt_ordinal: None,
            })
            .unwrap();
        let flush_receipt = mpsc::channel();
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Flush(
                flush_receipt.0,
            ))
            .unwrap();
        let _ = flush_receipt.1.recv();

        let rejected = V3ObsRequestRow {
            request_key: second_key,
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 20,
            updated_epoch_ms: 20,
            finished_epoch_ms: Some(20),
            scope: scope(4444),
            result: Some("success".to_string()),
            meta: provider_meta("r-capacity-second", "p2"),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(2),
                output_tokens: Some(2),
                total_tokens: Some(4),
                ..Default::default()
            }),
            ..Default::default()
        };
        writer.enqueue(rejected, None);
        let rejection_receipt = mpsc::channel();
        sender
            .send(V3WebuiObservabilityPersistenceCommand::Flush(
                rejection_receipt.0,
            ))
            .unwrap();
        let rejection_error = rejection_receipt
            .1
            .recv()
            .expect("capacity rejection receipt")
            .expect_err("capacity rejection must stay explicit");
        assert!(rejection_error.contains("capacity"));

        let corrected = V3ObsRequestRow {
            request_key: first_key.clone(),
            event_type: V3ObsEventType::Completed.as_str().to_string(),
            started_epoch_ms: 10,
            updated_epoch_ms: 30,
            finished_epoch_ms: Some(30),
            scope: scope(4444),
            result: Some("success".to_string()),
            meta: provider_meta("r-capacity-first", "p1-corrected"),
            usage: Some(V3ObsUsageSummary {
                input_tokens: Some(3),
                output_tokens: Some(4),
                total_tokens: Some(7),
                ..Default::default()
            }),
            ..Default::default()
        };
        writer.enqueue(corrected, None);
        writer
            .flush()
            .expect("same-key correction must still persist");
        drop(writer);
        spawned.join().expect("normal writer shutdown");

        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        let read_with_limits =
            v3_webui_observability_read_provider_usage_with_limits(&records, limits).unwrap();
        assert_eq!(read.facts.len(), read_with_limits.facts.len());
        let coverage = read.coverage_for(4444).expect("listener coverage");
        assert!(coverage.detail_incomplete);
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_keys"));
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == first_key)
            .expect("corrected fact");
        assert_eq!(fact.provider_id.as_deref(), Some("p1-corrected"));
        assert_eq!(
            fact.usage
                .as_ref()
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(serde_json::Value::as_u64),
            Some(3)
        );
        assert!(!v3_provider_usage_read_generation(&records).unwrap().open);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_unstable_attempt_ordinal_does_not_overwrite_terminal_fact() {
        let dir = isolated_store("ambiguous-attempt");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let key = build_v3_obs_request_key(4444, "r-ambiguous");
        let terminal = V3ProviderUsageFact {
            listener_id: 4444,
            request_key: key.clone(),
            attempt_ordinal: None,
            request_started_epoch_ms: 10,
            result: V3ProviderUsageFactResult::Success,
            provider_id: Some("p-terminal".to_string()),
            usage: Some(serde_json::json!({"input_tokens": 4})),
            gaps: Vec::new(),
        };
        routecodex_v3_debug::v3_provider_usage_append_fact(&records, terminal).unwrap();
        let ambiguous = V3ProviderUsageFact {
            listener_id: 4444,
            request_key: key.clone(),
            attempt_ordinal: None,
            request_started_epoch_ms: 10,
            result: V3ProviderUsageFactResult::FailedAttempt,
            provider_id: Some("p-attempt".to_string()),
            usage: None,
            gaps: vec!["missing_attempt_ordinal".to_string()],
        };
        routecodex_v3_debug::v3_provider_usage_append_fact(&records, ambiguous).unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert_eq!(read.facts.len(), 2);
        let terminal = read
            .facts
            .iter()
            .find(|fact| fact.result == V3ProviderUsageFactResult::Success)
            .expect("terminal fact");
        assert_eq!(terminal.provider_id.as_deref(), Some("p-terminal"));
        let attempt = read
            .facts
            .iter()
            .find(|fact| fact.result == V3ProviderUsageFactResult::FailedAttempt)
            .expect("unstable attempt fact");
        assert_eq!(attempt.provider_id.as_deref(), Some("p-attempt"));
        assert!(attempt
            .gaps
            .iter()
            .any(|gap| gap == "missing_attempt_ordinal"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_missing_request_started_is_a_visible_gap() {
        let dir = isolated_store("missing-start");
        let records = dir.join("records.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let row = serde_json::json!({
            "request_key": "4444:r-missing-start",
            "event_type": "request.completed",
            "scope": {"port": 4444},
            "result": "success",
            "meta": {"provider_id": "p1"},
            "usage": {"input_tokens": 1, "output_tokens": 1}
        });
        routecodex_v3_debug::v3_provider_usage_persist_before_detail(&records, &row, None, true)
            .unwrap();
        let read = v3_webui_observability_read_provider_usage(&records).unwrap();
        assert!(read.facts[0]
            .gaps
            .iter()
            .any(|gap| gap == "missing_request_started"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
