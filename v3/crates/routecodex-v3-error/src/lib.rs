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
    RequestConflict,
    UnsupportedMediaType,
    PayloadTooLarge,
    MethodNotAllowed,
    PathNotFound,
    ModelNotFound,
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
    pub route_pool_remaining_after_exclusion: usize,
    pub default_pool_available: bool,
    pub same_provider_retry_available: bool,
    pub target_exhausted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderFailureSessionScope {
    server_id: String,
    routing_group: String,
    session_id: String,
}

impl V3ProviderFailureSessionScope {
    pub fn new(
        server_id: impl Into<String>,
        routing_group: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<Self, String> {
        fn required(value: String, field: &str) -> Result<String, String> {
            let value = value.trim();
            if value.is_empty() {
                return Err(format!(
                    "provider failure session scope {field} cannot be empty"
                ));
            }
            Ok(value.to_string())
        }

        Ok(Self {
            server_id: required(server_id.into(), "server_id")?,
            routing_group: required(routing_group.into(), "routing_group")?,
            session_id: required(session_id.into(), "session_id")?,
        })
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn routing_group(&self) -> &str {
        &self.routing_group
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error05RecoveryAdmissionWitness {
    failure_session_scope: V3ProviderFailureSessionScope,
    provider_runtime_identity: String,
    normalized_error_family: String,
    generation: u64,
}

impl V3Error05RecoveryAdmissionWitness {
    pub fn new(
        failure_session_scope: V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
        normalized_error_family: impl Into<String>,
        generation: u64,
    ) -> Result<Self, String> {
        fn required(value: String, field: &str) -> Result<String, String> {
            let value = value.trim();
            if value.is_empty() {
                return Err(format!("Error05 recovery witness {field} cannot be empty"));
            }
            Ok(value.to_string())
        }

        if generation == 0 {
            return Err("Error05 recovery witness generation must be positive".to_string());
        }
        Ok(Self {
            failure_session_scope,
            provider_runtime_identity: required(
                provider_runtime_identity.into(),
                "provider_runtime_identity",
            )?,
            normalized_error_family: required(
                normalized_error_family.into(),
                "normalized_error_family",
            )?,
            generation,
        })
    }

    pub fn server_id(&self) -> &str {
        self.failure_session_scope.server_id()
    }

    pub fn routing_group(&self) -> &str {
        self.failure_session_scope.routing_group()
    }

    pub fn session_id(&self) -> &str {
        self.failure_session_scope.session_id()
    }

    pub fn failure_session_scope(&self) -> &V3ProviderFailureSessionScope {
        &self.failure_session_scope
    }

    pub fn provider_runtime_identity(&self) -> &str {
        &self.provider_runtime_identity
    }

    pub fn normalized_error_family(&self) -> &str {
        &self.normalized_error_family
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3Error05ExecutionAction {
    WaitThenRetrySame {
        recovery: V3Error05RecoveryAdmissionWitness,
    },
    WaitThenReselect {
        recovery: V3Error05RecoveryAdmissionWitness,
    },
    ProjectTerminal,
    ClientDisconnected,
    RejectNonProviderError,
}

impl V3Error05ExecutionAction {
    pub const fn observability_label(&self) -> &'static str {
        match self {
            Self::WaitThenRetrySame { .. } => "retry_same_provider",
            Self::WaitThenReselect { .. } => "target_local_reselect",
            Self::ProjectTerminal | Self::RejectNonProviderError => "project_client_error",
            Self::ClientDisconnected => "project_client_disconnect",
        }
    }

    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::ProjectTerminal | Self::ClientDisconnected | Self::RejectNonProviderError
        )
    }

    pub fn recovery_witness(&self) -> Option<&V3Error05RecoveryAdmissionWitness> {
        match self {
            Self::WaitThenRetrySame { recovery } | Self::WaitThenReselect { recovery } => {
                Some(recovery)
            }
            Self::ProjectTerminal | Self::ClientDisconnected | Self::RejectNonProviderError => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Error05ExecutionDecision {
    pub exhaustion: V3Error04TargetExhaustionDecision,
    pub action: V3Error05ExecutionAction,
}

impl V3Error05ExecutionDecision {
    #[allow(clippy::result_large_err)]
    pub fn try_into_terminal(self) -> Result<V3Error05TerminalDecision, Self> {
        let source_kind = &self.exhaustion.local_action.classified.source.source_kind;
        let valid_terminal = match source_kind {
            V3ErrorSourceKind::ProviderFailure => {
                self.action == V3Error05ExecutionAction::ProjectTerminal
                    && self.exhaustion.route_pool_remaining_after_exclusion == 0
                    && !self.exhaustion.default_pool_available
                    && !self.exhaustion.same_provider_retry_available
                    && self.exhaustion.target_exhausted
            }
            V3ErrorSourceKind::ClientDisconnect => {
                self.action == V3Error05ExecutionAction::ClientDisconnected
            }
            _ => self.action == V3Error05ExecutionAction::RejectNonProviderError,
        };
        if valid_terminal {
            Ok(V3Error05TerminalDecision(self))
        } else {
            Err(self)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Error05TerminalDecision(V3Error05ExecutionDecision);

impl V3Error05TerminalDecision {
    pub fn execution(&self) -> &V3Error05ExecutionDecision {
        &self.0
    }

    fn into_execution(self) -> V3Error05ExecutionDecision {
        self.0
    }
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
        | V3ErrorSourceKind::RequestConflict
        | V3ErrorSourceKind::UnsupportedMediaType
        | V3ErrorSourceKind::PayloadTooLarge
        | V3ErrorSourceKind::MethodNotAllowed
        | V3ErrorSourceKind::PathNotFound
        | V3ErrorSourceKind::ModelNotFound
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
        | V3ErrorSourceKind::RequestConflict
        | V3ErrorSourceKind::UnsupportedMediaType
        | V3ErrorSourceKind::PayloadTooLarge
        | V3ErrorSourceKind::MethodNotAllowed
        | V3ErrorSourceKind::PathNotFound
        | V3ErrorSourceKind::ModelNotFound => ("client_input", "already_terminal"),
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

/// 瞬态失败（SSE 流内协议失败 / transport 响应头挂起）判定，由错误处理中心
/// 根据**错误阶段 + 错误类别**决定，与入口（direct/relay/chat）无关。
/// 命中时 provider failure 层按「同 provider 直接重试 3 次、health-neutral
/// （不计冷却）、第 3 次失败后一次回报错误中心再切 provider」驱动重试。
///
/// - SSE 流内阶段：ProviderFailure 一律视为瞬态（HTTP 2xx 后响应体/流内失败，
///   含裸 error 事件、response.failed/incomplete、空包、首事件超时、
///   malformed SSE、body 读取错误等）。
/// - transport 阶段：仅挂起（响应头等待超时，code=`provider_response_header_timeout`）
///   视为瞬态；其余 transport 错误（连接失败等）保持计 health 的原策略。
pub fn is_v3_retryable_transient_source(source: &V3Error01SourceRaised) -> bool {
    if source.source_kind != V3ErrorSourceKind::ProviderFailure {
        return false;
    }
    is_v3_retryable_transient_stage_code(source.source_stage, &source.code)
}

/// Returns whether a provider failure is health-neutral and eligible for the
/// transient same-provider retry budget at the given pipeline stage.
pub fn is_v3_retryable_transient_stage_code(source_stage: &str, code: &str) -> bool {
    match source_stage {
        // direct 与 relay 两套阶段命名都覆盖。该阶段的 ProviderFailure 含两类：
        // - HTTP 状态错误（code=`provider_http_*`）：真实 provider 故障，计 health；
        // - 2xx 响应内容/流内失败（裸 error 事件、response.failed/incomplete、
        //   空包、首事件超时、malformed SSE、body/JSON 解码失败、SSE 事件内
        //   动态错误码等）：provider 内部瞬态问题，health-neutral 重试。
        "V3ProviderResp14Raw" | "V3ProviderRespInbound01Raw" => !code.starts_with("provider_http_"),
        // transport 阶段仅挂起（响应头等待超时，专属 code）为瞬态。
        "V3Transport13ResponsesHttpRequest" | "V3ProviderReqOutbound09TransportRequest" => {
            code == V3_TRANSIENT_TRANSPORT_HANG_CODE
        }
        _ => false,
    }
}

pub const V3_TRANSIENT_TRANSPORT_HANG_CODE: &str = "provider_response_header_timeout";

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
    let model_not_found = matches!(
        classified.source.source_kind,
        V3ErrorSourceKind::ModelNotFound
    );
    let retry_eligible = provider_failure && candidates_remaining > 0;
    // 瞬态失败（SSE 流内/挂起，由错误处理中心按阶段+类别判定）为 provider
    // 内部瞬态问题：不计入 provider health（health-neutral），由 provider
    // failure 层按「同 provider 重试 3 次、第 3 次失败后一次回报再切」处理。
    let health_affecting = provider_failure
        && !matches!(scope, V3ErrorActionScope::None)
        && !is_v3_retryable_transient_source(&classified.source);
    let exhaustion_effect = if retry_eligible {
        "target_local_reselect"
    } else if client_disconnect {
        "health_neutral_client_disconnect"
    } else if model_not_found {
        "project_client_error"
    } else if candidates_remaining == 0 {
        "target_pool_exhausted"
    } else {
        "project_client_error"
    };
    V3Error03TargetLocalAction {
        action: V3ErrorActionPlan {
            scope,
            reason: classified.source.code.clone(),
            // Error03 is deliberately parameter-free at this crate boundary;
            // cooldown duration is supplied by the compiled disposition path
            // at the runtime health owner.
            duration_ms: None,
            retry_eligible,
            health_affecting,
            exhaustion_effect: exhaustion_effect.to_string(),
        },
        classified,
    }
}

pub fn build_v3_error_04_target_exhaustion_decision_with_provider_availability(
    local_action: V3Error03TargetLocalAction,
    route_pool_remaining_after_exclusion: usize,
    default_pool_available: bool,
    same_provider_retry_available: bool,
) -> V3Error04TargetExhaustionDecision {
    let provider_failure = matches!(
        local_action.classified.source.source_kind,
        V3ErrorSourceKind::ProviderFailure
    );
    let target_exhausted = (provider_failure
        && route_pool_remaining_after_exclusion == 0
        && !default_pool_available
        && !same_provider_retry_available)
        || matches!(
            local_action.classified.source.source_kind,
            V3ErrorSourceKind::PendingEndpoint
                | V3ErrorSourceKind::InvalidRequest
                | V3ErrorSourceKind::RequestConflict
                | V3ErrorSourceKind::UnsupportedMediaType
                | V3ErrorSourceKind::PayloadTooLarge
                | V3ErrorSourceKind::MethodNotAllowed
                | V3ErrorSourceKind::PathNotFound
                | V3ErrorSourceKind::ModelNotFound
                | V3ErrorSourceKind::TargetPoolExhausted
                | V3ErrorSourceKind::RuntimeFailure
                | V3ErrorSourceKind::ClientDisconnect
                | V3ErrorSourceKind::SuccessControl
        );
    V3Error04TargetExhaustionDecision {
        local_action,
        route_pool_remaining_after_exclusion,
        default_pool_available,
        same_provider_retry_available,
        target_exhausted,
    }
}

pub fn build_v3_error_05_execution_decision_from_v3_error_04(
    exhaustion: V3Error04TargetExhaustionDecision,
    recovery: Option<V3Error05RecoveryAdmissionWitness>,
) -> V3Error05ExecutionDecision {
    let action = match exhaustion.local_action.classified.source.source_kind {
        V3ErrorSourceKind::ClientDisconnect => V3Error05ExecutionAction::ClientDisconnected,
        V3ErrorSourceKind::ProviderFailure if exhaustion.same_provider_retry_available => {
            V3Error05ExecutionAction::WaitThenRetrySame {
                recovery: recovery
                    .expect("retry-same Error05 requires an exact recovery admission witness"),
            }
        }
        V3ErrorSourceKind::ProviderFailure
            if exhaustion.route_pool_remaining_after_exclusion > 0
                || exhaustion.default_pool_available =>
        {
            V3Error05ExecutionAction::WaitThenReselect {
                recovery: recovery
                    .expect("reselect Error05 requires an exact recovery admission witness"),
            }
        }
        V3ErrorSourceKind::ProviderFailure => V3Error05ExecutionAction::ProjectTerminal,
        _ => V3Error05ExecutionAction::RejectNonProviderError,
    };
    V3Error05ExecutionDecision { exhaustion, action }
}

pub fn build_v3_error_06_client_projected_from_v3_error_05(
    terminal: V3Error05TerminalDecision,
) -> V3Error06ClientProjected {
    let execution = terminal.into_execution();
    let source = &execution.exhaustion.local_action.classified.source;
    let status = match source.source_kind {
        V3ErrorSourceKind::InvalidRequest => 400,
        V3ErrorSourceKind::RequestConflict => 409,
        V3ErrorSourceKind::UnsupportedMediaType => 415,
        V3ErrorSourceKind::PayloadTooLarge => 413,
        V3ErrorSourceKind::MethodNotAllowed => 405,
        V3ErrorSourceKind::PathNotFound => 404,
        V3ErrorSourceKind::ModelNotFound => 404,
        V3ErrorSourceKind::PendingEndpoint => 501,
        V3ErrorSourceKind::ProviderFailure => source
            .external_error
            .as_ref()
            .and_then(|external| external.status)
            .filter(|status| *status >= 400)
            .unwrap_or(502),
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
    let error = serde_json::json!({
        "code": source.code,
        "message": source.message,
    });
    let body = routecodex_v3_debug::project_debug_value_verbatim(
        &routecodex_v3_debug::V3RedactionPolicy,
        serde_json::json!({ "error": error }),
    );
    V3Error06ClientProjected {
        status,
        body,
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
    pub fn project_terminal_decision(
        terminal: V3Error05TerminalDecision,
    ) -> V3Error06ClientProjected {
        build_v3_error_06_client_projected_from_v3_error_05(terminal)
    }

    pub fn project_terminal(decision: V3Error05ExecutionDecision) -> V3Error06ClientProjected {
        let terminal = decision.try_into_terminal().unwrap_or_else(|decision| {
            panic!(
                "nonterminal {:?} Error05 cannot enter V3Error06ClientProjected",
                decision.action
            )
        });
        Self::project_terminal_decision(terminal)
    }

    pub fn decide_provider(
        input: V3ErrorHandlingCenterInput,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        recovery: Option<V3Error05RecoveryAdmissionWitness>,
    ) -> V3Error05ExecutionDecision {
        let classified = build_v3_error_02_classified_from_v3_error_01(input.source);
        let action = build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            input.action_scope,
            input.candidates_remaining,
        );
        let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            action,
            input.candidates_remaining,
            default_pool_available,
            same_provider_retry_available,
        );
        build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, recovery)
    }

    pub fn handle(input: V3ErrorHandlingCenterInput) -> V3Error06ClientProjected {
        assert!(
            input.source.source_kind != V3ErrorSourceKind::ProviderFailure,
            "provider failure projection requires caller-owned route/default availability proof"
        );
        let source_status = input.source_status;
        let execution = Self::decide_provider(input, false, false, None);
        let mut projected = Self::project_terminal(execution);
        let linked_status = projected
            .body
            .pointer("/error/external_error/status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .filter(|status| *status >= 400);
        if let Some(status) = source_status
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
    RequestInFlight,
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
        V3HttpBoundaryErrorKind::RequestInFlight => {
            (V3ErrorSourceKind::RequestConflict, "request_in_flight")
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

fn project_v3_server_boundary_error(
    source_kind: V3ErrorSourceKind,
    source_stage: &'static str,
    code: impl Into<String>,
    detail: impl Into<String>,
    status: u16,
) -> V3Error06ClientProjected {
    let source = build_v3_error_01_source_raised(source_kind, source_stage, code, detail);
    V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
        source,
        action_scope: V3ErrorActionScope::None,
        candidates_remaining: 0,
        source_status: Some(status),
    })
}

pub fn project_v3_server_invalid_request(
    source_stage: &'static str,
    code: impl Into<String>,
    detail: impl Into<String>,
    status: u16,
) -> V3Error06ClientProjected {
    project_v3_server_boundary_error(
        V3ErrorSourceKind::InvalidRequest,
        source_stage,
        code,
        detail,
        status,
    )
}

pub fn project_v3_server_runtime_failure(
    source_stage: &'static str,
    code: impl Into<String>,
    detail: impl Into<String>,
    status: u16,
) -> V3Error06ClientProjected {
    project_v3_server_boundary_error(
        V3ErrorSourceKind::RuntimeFailure,
        source_stage,
        code,
        detail,
        status,
    )
}

pub fn project_v3_server_websocket_error(
    code: &'static str,
    detail: impl Into<String>,
) -> V3Error06ClientProjected {
    if code == "invalid_client_event" {
        return project_v3_server_invalid_request(
            "V3ServerRespOutbound06ClientFrame",
            code,
            detail,
            400,
        );
    }
    project_v3_server_runtime_failure("V3ServerRespOutbound06ClientFrame", code, detail, 500)
}

pub fn raise_v3_sse_provider_failure(
    code: impl Into<String>,
    message: impl Into<String>,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderRespInbound01Raw",
        code,
        message,
    )
}

pub fn raise_v3_sse_client_disconnect() -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ClientDisconnect,
        "V3ServerRespOutbound06ClientFrame",
        "client_disconnect",
        "client disconnected before provider SSE stream completed",
    )
}

pub fn is_v3_client_disconnect_source(source: &V3Error01SourceRaised) -> bool {
    matches!(source.source_kind, V3ErrorSourceKind::ClientDisconnect)
}

pub fn raise_v3_debug_artifact_failure(message: impl Into<String>) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3DebugArtifact",
        "codex_sample_persistence_failed",
        message,
        V3InternalErrorCode::V3DebugArtifact,
    )
}

pub fn raise_v3_runtime_observability_contract_failure(
    message: impl Into<String>,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        "V3RuntimeObservability",
        "runtime_observability_contract",
        message,
    )
}

pub fn project_v3_post_commit_sse_source(
    source: V3Error01SourceRaised,
    status: u16,
) -> V3Error06ClientProjected {
    let projected_status = status;
    if matches!(source.source_kind, V3ErrorSourceKind::ProviderFailure) {
        // 例外证明：post-commit 阶段 SSE 事件已向客户端提交（200 + 已流出的
        // 帧），物理上无法 reroute/reselect；此处硬编码 0/false/false 走完整
        // Error01-06 链仅用于 console 观测投影，不进入 client body。
        let classified = build_v3_error_02_classified_from_v3_error_01(source);
        let action = build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            V3ErrorActionScope::None,
            0,
        );
        let exhaustion = build_v3_error_04_target_exhaustion_decision_with_provider_availability(
            action, 0, false, false,
        );
        let decision = build_v3_error_05_execution_decision_from_v3_error_04(exhaustion, None);
        let terminal = decision
            .try_into_terminal()
            .expect("post-commit provider SSE source must project terminal Error05");
        let mut projected = V3ErrorHandlingCenter::project_terminal_decision(terminal);
        projected.status = projected_status;
        projected
    } else {
        let mut projected = V3ErrorHandlingCenter::handle(V3ErrorHandlingCenterInput {
            source,
            action_scope: V3ErrorActionScope::None,
            candidates_remaining: 0,
            source_status: Some(status),
        });
        projected.status = projected_status;
        projected
    }
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

    #[test]
    fn sse_closeout_client_disconnect_is_raised_at_client_frame_boundary() {
        let source = raise_v3_sse_client_disconnect();

        assert_eq!(source.source_kind, V3ErrorSourceKind::ClientDisconnect);
        assert_eq!(source.code, "client_disconnect");
        assert_eq!(source.source_stage, "V3ServerRespOutbound06ClientFrame");
    }

    #[test]
    fn sse_closeout_provider_failure_is_raised_by_error_owner() {
        let source =
            raise_v3_sse_provider_failure("provider_response_sse_stream", "provider broke");

        assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderFailure);
        assert_eq!(source.source_stage, "V3ProviderRespInbound01Raw");
        assert_eq!(source.code, "provider_response_sse_stream");
        assert_eq!(source.message, "provider broke");
    }

    #[test]
    fn server_side_failures_are_raised_by_error_owner() {
        let debug = raise_v3_debug_artifact_failure("disk full");
        assert_eq!(debug.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(debug.source_stage, "V3DebugArtifact");
        assert_eq!(debug.code, "codex_sample_persistence_failed");
        assert_eq!(
            debug
                .internal_error
                .as_ref()
                .map(|internal| internal.internal_code),
            Some("500-300")
        );

        let observability = raise_v3_runtime_observability_contract_failure("missing terminal");
        assert_eq!(observability.source_kind, V3ErrorSourceKind::RuntimeFailure);
        assert_eq!(observability.source_stage, "V3RuntimeObservability");
        assert_eq!(observability.code, "runtime_observability_contract");
    }

    #[test]
    fn transient_stage_code_classifier_accepts_stream_and_header_hang_failures() {
        assert!(is_v3_retryable_transient_stage_code(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream"
        ));
        assert!(is_v3_retryable_transient_stage_code(
            "V3ProviderReqOutbound09TransportRequest",
            V3_TRANSIENT_TRANSPORT_HANG_CODE
        ));
    }

    #[test]
    fn transient_stage_code_classifier_rejects_http_and_non_provider_failures() {
        assert!(!is_v3_retryable_transient_stage_code(
            "V3ProviderRespInbound01Raw",
            "provider_http_502"
        ));
        assert!(!is_v3_retryable_transient_stage_code(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed"
        ));
        assert!(!is_v3_retryable_transient_stage_code(
            "V3ServerRespOutbound06ClientFrame",
            "provider_response_sse_stream"
        ));
    }
}
mod subscription;

pub use subscription::V3ProviderErrorFingerprint;
