use routecodex_v3_debug::V3Debug01NodeEventRegistered;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3InternalErrorLane {
    Request,
    Response,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3InternalErrorCode {
    V3Server03HttpRequestRaw,
    V3Req04StandardizedResponses,
    V3Router05RequestClassified,
    V3Router06RoutePoolResolved,
    V3Router07OpaqueTargetHitOnce,
    V3Target08KindClassified,
    V3Target09CandidateSetExpanded,
    V3Target10ConcreteProviderSelected,
    V3ResponsesDirect11Policy,
    V3Provider12ResponsesWirePayload,
    V3Transport13ResponsesHttpRequest,
    V3ProviderResp14Raw,
    V3DirectResp14ProviderProjectionPrepared,
    V3DirectResp15ClientPayloadReady,
    V3Server16HttpFrame,
    V3DebugArtifact,
    V3ContinuationStore,
    V3ConfigManifestRuntime,
    V3StaticHookRegistry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct V3InternalErrorRegistryEntry {
    pub code: &'static str,
    pub lane: V3InternalErrorLane,
    pub node_id: &'static str,
    pub owner_feature_id: &'static str,
    pub module_block: &'static str,
    pub title: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3InternalErrorEnvelope {
    pub internal_code: &'static str,
    pub lane: V3InternalErrorLane,
    pub node_id: &'static str,
    pub owner_feature_id: &'static str,
    pub module_block: &'static str,
    pub stage: &'static str,
}

impl V3InternalErrorCode {
    pub const fn registry_entry(self) -> V3InternalErrorRegistryEntry {
        match self {
            V3InternalErrorCode::V3Server03HttpRequestRaw => V3InternalErrorRegistryEntry {
                code: "500-100",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Server03HttpRequestRaw",
                owner_feature_id: "v3.config_server_full_function",
                module_block: "500-10x",
                title: "server request adapter internal failure",
            },
            V3InternalErrorCode::V3Req04StandardizedResponses => V3InternalErrorRegistryEntry {
                code: "500-110",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Req04StandardizedResponses",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-11x",
                title: "responses request standardization internal failure",
            },
            V3InternalErrorCode::V3Router05RequestClassified => V3InternalErrorRegistryEntry {
                code: "500-120",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Router05RequestClassified",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-12x",
                title: "router request classification internal failure",
            },
            V3InternalErrorCode::V3Router06RoutePoolResolved => V3InternalErrorRegistryEntry {
                code: "500-130",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Router06RoutePoolResolved",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-13x",
                title: "route pool resolution internal failure",
            },
            V3InternalErrorCode::V3Router07OpaqueTargetHitOnce => V3InternalErrorRegistryEntry {
                code: "500-131",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Router07OpaqueTargetHitOnce",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-13x",
                title: "opaque target hit internal failure",
            },
            V3InternalErrorCode::V3Target08KindClassified => V3InternalErrorRegistryEntry {
                code: "500-140",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Target08KindClassified",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-14x",
                title: "target kind classification internal failure",
            },
            V3InternalErrorCode::V3Target09CandidateSetExpanded => V3InternalErrorRegistryEntry {
                code: "500-141",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Target09CandidateSetExpanded",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-14x",
                title: "target candidate expansion internal failure",
            },
            V3InternalErrorCode::V3Target10ConcreteProviderSelected => {
                V3InternalErrorRegistryEntry {
                    code: "500-142",
                    lane: V3InternalErrorLane::Request,
                    node_id: "V3Target10ConcreteProviderSelected",
                    owner_feature_id: "v3.responses_direct_mvp_architecture",
                    module_block: "500-14x",
                    title: "concrete provider selection internal failure",
                }
            }
            V3InternalErrorCode::V3ResponsesDirect11Policy => V3InternalErrorRegistryEntry {
                code: "500-149",
                lane: V3InternalErrorLane::Request,
                node_id: "V3ResponsesDirect11Policy",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-14x",
                title: "direct policy internal failure",
            },
            V3InternalErrorCode::V3Provider12ResponsesWirePayload => V3InternalErrorRegistryEntry {
                code: "500-150",
                lane: V3InternalErrorLane::Request,
                node_id: "V3Provider12ResponsesWirePayload",
                owner_feature_id: "v3.debug_error_foundation",
                module_block: "500-15x",
                title: "provider wire payload internal failure",
            },
            V3InternalErrorCode::V3Transport13ResponsesHttpRequest => {
                V3InternalErrorRegistryEntry {
                    code: "500-160",
                    lane: V3InternalErrorLane::Request,
                    node_id: "V3Transport13ResponsesHttpRequest",
                    owner_feature_id: "v3.debug_error_foundation",
                    module_block: "500-16x",
                    title: "provider transport request internal failure",
                }
            }
            V3InternalErrorCode::V3ProviderResp14Raw => V3InternalErrorRegistryEntry {
                code: "500-200",
                lane: V3InternalErrorLane::Response,
                node_id: "V3ProviderResp14Raw",
                owner_feature_id: "v3.debug_error_foundation",
                module_block: "500-20x",
                title: "provider raw response internal failure",
            },
            V3InternalErrorCode::V3DirectResp14ProviderProjectionPrepared => {
                V3InternalErrorRegistryEntry {
                    code: "500-210",
                    lane: V3InternalErrorLane::Response,
                    node_id: "V3DirectResp14ProviderProjectionPrepared",
                    owner_feature_id: "v3.responses_direct_mvp_architecture",
                    module_block: "500-21x",
                    title: "direct provider projection internal failure",
                }
            }
            V3InternalErrorCode::V3DirectResp15ClientPayloadReady => V3InternalErrorRegistryEntry {
                code: "500-220",
                lane: V3InternalErrorLane::Response,
                node_id: "V3DirectResp15ClientPayloadReady",
                owner_feature_id: "v3.responses_direct_mvp_architecture",
                module_block: "500-22x",
                title: "direct client payload projection internal failure",
            },
            V3InternalErrorCode::V3Server16HttpFrame => V3InternalErrorRegistryEntry {
                code: "500-240",
                lane: V3InternalErrorLane::Response,
                node_id: "V3Server16HttpFrame",
                owner_feature_id: "v3.config_server_full_function",
                module_block: "500-24x",
                title: "server HTTP frame internal failure",
            },
            V3InternalErrorCode::V3DebugArtifact => V3InternalErrorRegistryEntry {
                code: "500-300",
                lane: V3InternalErrorLane::Other,
                node_id: "V3DebugArtifact",
                owner_feature_id: "v3.debug_error_foundation",
                module_block: "500-30x",
                title: "debug artifact internal failure",
            },
            V3InternalErrorCode::V3ContinuationStore => V3InternalErrorRegistryEntry {
                code: "500-310",
                lane: V3InternalErrorLane::Other,
                node_id: "V3HubRespContinuation04Committed",
                owner_feature_id: "v3.responses_direct_remote_continuation_integration",
                module_block: "500-31x",
                title: "continuation store internal failure",
            },
            V3InternalErrorCode::V3ConfigManifestRuntime => V3InternalErrorRegistryEntry {
                code: "500-320",
                lane: V3InternalErrorLane::Other,
                node_id: "V3Config05ManifestPublished",
                owner_feature_id: "v3.config_server_full_function",
                module_block: "500-32x",
                title: "config manifest runtime internal failure",
            },
            V3InternalErrorCode::V3StaticHookRegistry => V3InternalErrorRegistryEntry {
                code: "500-330",
                lane: V3InternalErrorLane::Other,
                node_id: "V3StaticHookRegistry",
                owner_feature_id: "v3.debug_error_foundation",
                module_block: "500-33x",
                title: "static hook registry internal failure",
            },
        }
    }
}

pub fn build_v3_internal_error_envelope(
    code: V3InternalErrorCode,
    stage: &'static str,
) -> V3InternalErrorEnvelope {
    let entry = code.registry_entry();
    V3InternalErrorEnvelope {
        internal_code: entry.code,
        lane: entry.lane,
        node_id: entry.node_id,
        owner_feature_id: entry.owner_feature_id,
        module_block: entry.module_block,
        stage,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3ExternalErrorKind {
    Provider,
    Upstream,
    Client,
    Transport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ExternalErrorLink {
    pub kind: V3ExternalErrorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_error: Option<V3InternalErrorEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_error: Option<V3ExternalErrorLink>,
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
        internal_error: None,
        external_error: None,
    }
}

pub fn build_v3_error_01_source_raised_internal(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    internal_code: V3InternalErrorCode,
) -> V3Error01SourceRaised {
    validate_internal_error_source_kind(&source_kind);
    V3Error01SourceRaised {
        source_kind,
        source_stage,
        code: code.into(),
        message: message.into(),
        internal_error: Some(build_v3_internal_error_envelope(
            internal_code,
            source_stage,
        )),
        external_error: None,
    }
}

pub fn build_v3_error_01_source_raised_external(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    message: impl Into<String>,
    external_error: V3ExternalErrorLink,
) -> V3Error01SourceRaised {
    validate_external_error_source_kind(&source_kind);
    V3Error01SourceRaised {
        source_kind,
        source_stage,
        code: code.into(),
        message: message.into(),
        internal_error: None,
        external_error: Some(external_error),
    }
}

fn validate_internal_error_source_kind(source_kind: &V3ErrorSourceKind) {
    match source_kind {
        V3ErrorSourceKind::RuntimeFailure | V3ErrorSourceKind::SuccessControl => {}
        V3ErrorSourceKind::ProviderFailure => {
            panic!("ProviderFailure cannot carry a RouteCodex internal error code")
        }
        V3ErrorSourceKind::InvalidRequest
        | V3ErrorSourceKind::UnsupportedMediaType
        | V3ErrorSourceKind::PayloadTooLarge
        | V3ErrorSourceKind::MethodNotAllowed
        | V3ErrorSourceKind::PathNotFound
        | V3ErrorSourceKind::PendingEndpoint
        | V3ErrorSourceKind::TargetPoolExhausted
        | V3ErrorSourceKind::ClientDisconnect => {
            panic!("client/route terminal errors cannot carry a RouteCodex internal error code")
        }
    }
}

fn validate_external_error_source_kind(source_kind: &V3ErrorSourceKind) {
    if matches!(
        source_kind,
        V3ErrorSourceKind::RuntimeFailure | V3ErrorSourceKind::SuccessControl
    ) {
        panic!("RouteCodex internal failures must use an internal error code, not an external link")
    }
}

pub fn build_v3_error_02_classified_from_v3_error_01(
    source: V3Error01SourceRaised,
) -> V3Error02Classified {
    if source.internal_error.is_some() {
        validate_internal_error_source_kind(&source.source_kind);
    }
    if source.external_error.is_some() {
        validate_external_error_source_kind(&source.source_kind);
    }
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
    let mut error = serde_json::json!({
        "code": source.code,
        "message": source.message,
        "stage": source.source_stage,
        "class": execution.exhaustion.local_action.classified.class,
        "decision": execution.decision,
        "target_exhausted": execution.exhaustion.target_exhausted,
        "candidates_remaining": execution.exhaustion.candidates_remaining,
        "error_node": "V3Error06ClientProjected"
    });
    if let Some(internal_error) = &source.internal_error {
        error["internal_code"] =
            serde_json::Value::String(internal_error.internal_code.to_string());
        error["internal_node"] = serde_json::Value::String(internal_error.node_id.to_string());
        error["internal_owner_feature_id"] =
            serde_json::Value::String(internal_error.owner_feature_id.to_string());
        error["internal_module_block"] =
            serde_json::Value::String(internal_error.module_block.to_string());
    }
    if let Some(external_error) = &source.external_error {
        error["external_error"] =
            serde_json::to_value(external_error).expect("V3ExternalErrorLink must serialize");
    }
    V3Error06ClientProjected {
        status,
        body: serde_json::json!({ "error": error }),
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
        let linked_status = projected
            .body
            .pointer("/error/external_error/status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .filter(|status| *status >= 400);
        if let Some(status) = input
            .source_status
            .filter(|status| *status >= 400)
            .or(linked_status)
        {
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
