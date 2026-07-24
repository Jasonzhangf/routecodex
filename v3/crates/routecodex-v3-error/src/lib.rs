use routecodex_v3_debug::V3Debug01NodeEventRegistered;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3ErrorSourceKind {
    InvalidRequest,
    UnsupportedMediaType,
    PayloadTooLarge,
    MethodNotAllowed,
    PathNotFound,
    PendingEndpoint,
    ProviderFailure,
    TargetPoolExhausted,
    RuntimeFailure,
    ClientDisconnect,
    SuccessControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error01SourceRaised {
    pub source_kind: V3ErrorSourceKind,
    pub source_stage: &'static str,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error02Classified {
    pub source: V3Error01SourceRaised,
    pub class: &'static str,
    pub terminal_state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum V3ErrorActionScope {
    None,
    ProviderInstance {
        provider_id: String,
    },
    AuthKey {
        provider_id: String,
        auth_alias: String,
    },
    CanonicalModel {
        provider_id: String,
        model_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ErrorActionPlan {
    pub scope: V3ErrorActionScope,
    pub reason: String,
    pub duration_ms: Option<u64>,
    pub retry_eligible: bool,
    pub health_affecting: bool,
    pub exhaustion_effect: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error03TargetLocalAction {
    pub classified: V3Error02Classified,
    pub action: V3ErrorActionPlan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error04TargetExhaustionDecision {
    pub local_action: V3Error03TargetLocalAction,
    pub candidates_remaining: usize,
    pub target_exhausted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error05ExecutionDecision {
    pub exhaustion: V3Error04TargetExhaustionDecision,
    pub decision: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct V3Error06ClientProjected {
    pub status: u16,
    pub body: serde_json::Value,
    pub chain: [&'static str; 6],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_action: Option<V3ErrorActionPlan>,
}

pub fn build_v3_error_01_source_raised(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
) -> V3Error01SourceRaised {
    V3Error01SourceRaised {
        source_kind,
        source_stage,
        code: code.into(),
        message: message.into(),
    }
}

pub fn build_v3_error_02_classified_from_v3_error_01(
    source: V3Error01SourceRaised,
) -> V3Error02Classified {
    let (class, terminal_state) = match source.source_kind {
        V3ErrorSourceKind::InvalidRequest
        | V3ErrorSourceKind::UnsupportedMediaType
        | V3ErrorSourceKind::PayloadTooLarge
        | V3ErrorSourceKind::MethodNotAllowed
        | V3ErrorSourceKind::PathNotFound => ("client_input", "already_terminal"),
        V3ErrorSourceKind::PendingEndpoint => ("pending_endpoint", "already_terminal"),
        V3ErrorSourceKind::ProviderFailure => {
            ("provider_failure", "non_terminal_if_candidates_remain")
        }
        V3ErrorSourceKind::TargetPoolExhausted => ("target_pool_exhausted", "already_terminal"),
        V3ErrorSourceKind::RuntimeFailure => ("runtime_failure", "already_terminal"),
        V3ErrorSourceKind::ClientDisconnect => ("client_disconnect", "already_terminal"),
        V3ErrorSourceKind::SuccessControl => ("success_control_violation", "already_terminal"),
    };
    V3Error02Classified {
        source,
        class,
        terminal_state,
    }
}

pub fn build_v3_error_03_target_local_action_from_v3_error_02(
    classified: V3Error02Classified,
    scope: V3ErrorActionScope,
    candidates_remaining: usize,
) -> V3Error03TargetLocalAction {
    let provider_failure = matches!(
        classified.source.source_kind,
        V3ErrorSourceKind::ProviderFailure
    );
    let client_disconnect = matches!(
        classified.source.source_kind,
        V3ErrorSourceKind::ClientDisconnect
    );
    let retry_eligible = provider_failure && candidates_remaining > 0;
    let health_affecting = provider_failure && !matches!(scope, V3ErrorActionScope::None);
    let exhaustion_effect = if retry_eligible {
        "target_local_reselect"
    } else if client_disconnect {
        "health_neutral_client_disconnect"
    } else if candidates_remaining == 0 {
        "target_pool_exhausted"
    } else {
        "project_client_error"
    };
    V3Error03TargetLocalAction {
        action: V3ErrorActionPlan {
            scope,
            reason: classified.source.code.clone(),
            duration_ms: if health_affecting { Some(30_000) } else { None },
            retry_eligible,
            health_affecting,
            exhaustion_effect: exhaustion_effect.to_string(),
        },
        classified,
    }
}

pub fn build_v3_error_04_target_exhaustion_decision_from_v3_error_03(
    local_action: V3Error03TargetLocalAction,
    candidates_remaining: usize,
) -> V3Error04TargetExhaustionDecision {
    let target_exhausted = candidates_remaining == 0
        || matches!(
            local_action.classified.source.source_kind,
            V3ErrorSourceKind::PendingEndpoint
                | V3ErrorSourceKind::InvalidRequest
                | V3ErrorSourceKind::UnsupportedMediaType
                | V3ErrorSourceKind::PayloadTooLarge
                | V3ErrorSourceKind::MethodNotAllowed
                | V3ErrorSourceKind::PathNotFound
                | V3ErrorSourceKind::TargetPoolExhausted
                | V3ErrorSourceKind::RuntimeFailure
                | V3ErrorSourceKind::ClientDisconnect
                | V3ErrorSourceKind::SuccessControl
        );
    V3Error04TargetExhaustionDecision {
        local_action,
        candidates_remaining,
        target_exhausted,
    }
}

pub fn build_v3_error_05_execution_decision_from_v3_error_04(
    exhaustion: V3Error04TargetExhaustionDecision,
) -> V3Error05ExecutionDecision {
    let decision = if matches!(
        exhaustion.local_action.classified.source.source_kind,
        V3ErrorSourceKind::ClientDisconnect
    ) {
        "project_client_disconnect"
    } else if !exhaustion.target_exhausted && exhaustion.local_action.action.retry_eligible {
        "target_local_reselect"
    } else {
        "project_client_error"
    };
    V3Error05ExecutionDecision {
        exhaustion,
        decision,
    }
}

pub fn build_v3_error_06_client_projected_from_v3_error_05(
    execution: V3Error05ExecutionDecision,
) -> V3Error06ClientProjected {
    let source = &execution.exhaustion.local_action.classified.source;
    let status = match source.source_kind {
        V3ErrorSourceKind::InvalidRequest => 400,
        V3ErrorSourceKind::UnsupportedMediaType => 415,
        V3ErrorSourceKind::PayloadTooLarge => 413,
        V3ErrorSourceKind::MethodNotAllowed => 405,
        V3ErrorSourceKind::PathNotFound => 404,
        V3ErrorSourceKind::PendingEndpoint => 501,
        V3ErrorSourceKind::ProviderFailure => 502,
        V3ErrorSourceKind::TargetPoolExhausted => 503,
        V3ErrorSourceKind::RuntimeFailure => 500,
        V3ErrorSourceKind::ClientDisconnect => 499,
        V3ErrorSourceKind::SuccessControl => 500,
    };
    let health_action = execution
        .exhaustion
        .local_action
        .action
        .health_affecting
        .then(|| execution.exhaustion.local_action.action.clone());
    V3Error06ClientProjected {
        status,
        body: serde_json::json!({
            "error": {
                "code": source.code,
                "message": source.message,
                "stage": source.source_stage,
                "class": execution.exhaustion.local_action.classified.class,
                "decision": execution.decision,
                "target_exhausted": execution.exhaustion.target_exhausted,
                "candidates_remaining": execution.exhaustion.candidates_remaining,
                "error_node": "V3Error06ClientProjected"
            }
        }),
        chain: V3_ERROR_CHAIN_NODE_IDS,
        health_action,
    }
}

pub const V3_ERROR_CHAIN_NODE_IDS: [&str; 6] = [
    "V3Error01SourceRaised",
    "V3Error02Classified",
    "V3Error03TargetLocalAction",
    "V3Error04TargetExhaustionDecision",
    "V3Error05ExecutionDecision",
    "V3Error06ClientProjected",
];

#[derive(Debug, Clone)]
pub struct V3ErrorHandlingCenterInput {
    pub source: V3Error01SourceRaised,
    pub action_scope: V3ErrorActionScope,
    pub candidates_remaining: usize,
    pub source_status: Option<u16>,
}

pub struct V3ErrorHandlingCenter;

impl V3ErrorHandlingCenter {
    pub fn handle(input: V3ErrorHandlingCenterInput) -> V3Error06ClientProjected {
        let classified = build_v3_error_02_classified_from_v3_error_01(input.source);
        let action = build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            input.action_scope,
            input.candidates_remaining,
        );
        let exhaustion = build_v3_error_04_target_exhaustion_decision_from_v3_error_03(
            action,
            input.candidates_remaining,
        );
        let execution = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion);
        let mut projected = build_v3_error_06_client_projected_from_v3_error_05(execution);
        if let Some(status) = input.source_status.filter(|status| *status >= 400) {
            projected.status = status;
        }
        debug_assert!(
            projected.status >= 400,
            "V3 ErrorHandlingCenter must never project an error as HTTP success"
        );
        projected
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HttpBoundaryErrorKind {
    MalformedJson,
    ContentTypeRequired,
    ContentTypeUnsupported,
    BodyTooLarge,
    MethodNotAllowed,
    PathNotFound,
    EndpointNotEnabled,
    WebSocketUpgradeRequired,
    WebSocketBetaRequired,
}

pub fn project_v3_http_boundary_error(
    kind: V3HttpBoundaryErrorKind,
    detail: impl Into<String>,
) -> V3Error06ClientProjected {
    let (source_kind, code) = match kind {
        V3HttpBoundaryErrorKind::MalformedJson => {
            (V3ErrorSourceKind::InvalidRequest, "malformed_json")
        }
        V3HttpBoundaryErrorKind::ContentTypeRequired => (
            V3ErrorSourceKind::UnsupportedMediaType,
            "content_type_required",
        ),
        V3HttpBoundaryErrorKind::ContentTypeUnsupported => (
            V3ErrorSourceKind::UnsupportedMediaType,
            "content_type_unsupported",
        ),
        V3HttpBoundaryErrorKind::BodyTooLarge => {
            (V3ErrorSourceKind::PayloadTooLarge, "body_too_large")
        }
        V3HttpBoundaryErrorKind::MethodNotAllowed => {
            (V3ErrorSourceKind::MethodNotAllowed, "method_not_allowed")
        }
        V3HttpBoundaryErrorKind::PathNotFound => {
            (V3ErrorSourceKind::PathNotFound, "path_not_found")
        }
        V3HttpBoundaryErrorKind::EndpointNotEnabled => {
            (V3ErrorSourceKind::PendingEndpoint, "endpoint_not_enabled")
        }
        V3HttpBoundaryErrorKind::WebSocketUpgradeRequired => (
            V3ErrorSourceKind::InvalidRequest,
            "websocket_upgrade_required",
        ),
        V3HttpBoundaryErrorKind::WebSocketBetaRequired => {
            (V3ErrorSourceKind::InvalidRequest, "websocket_beta_required")
        }
    };
    let source =
        build_v3_error_01_source_raised(source_kind, "V3Server03HttpRequestRaw", code, detail);
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    })
}

pub fn project_v3_pending_endpoint_error(
    event: V3Debug01NodeEventRegistered,
) -> V3Error06ClientProjected {
    let source = build_v3_error_01_source_raised(
        V3ErrorSourceKind::PendingEndpoint,
        "V3Server03HttpRequestRaw",
        "not_implemented",
        format!(
            "V3 endpoint node is registered but not implemented: {} {} on {}",
            event.method, event.path, event.server_id
        ),
    );
    let mut projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: None,
    });
    projected.body["error"]["server_id"] = serde_json::Value::String(event.server_id);
    projected.body["error"]["method"] = serde_json::Value::String(event.method);
    projected.body["error"]["path"] = serde_json::Value::String(event.path);
    projected.body["error"]["debug_node"] = serde_json::Value::String(event.node_id.to_string());
    projected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_endpoint_uses_all_adjacent_typed_nodes() {
        let projected = project_v3_pending_endpoint_error(V3Debug01NodeEventRegistered {
            server_id: "srv".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            node_id: "V3Debug01NodeEventRegistered",
        });
        assert_eq!(projected.status, 501);
        assert_eq!(projected.chain, V3_ERROR_CHAIN_NODE_IDS);
        assert_eq!(projected.body["error"]["code"], "not_implemented");
        assert!(projected.health_action.is_none());
    }
}
