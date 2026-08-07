use routecodex_v3_config::V3Config05ManifestPublished;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

pub(crate) fn v3_stopless_center_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(manifest, server_id, "stopless_center", true)
}

pub(crate) fn v3_responses_direct_stopless_center_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_stopless_center_enabled_for_server(manifest, server_id)
        && v3_feature_enabled_for_server(
            manifest,
            server_id,
            "responses_direct_stopless_center",
            false,
        )
}

fn v3_feature_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    feature: &str,
    default_enabled: bool,
) -> bool {
    let global_enabled = manifest
        .features
        .get(feature)
        .copied()
        .unwrap_or(default_enabled);
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.features.get(feature).copied())
        .unwrap_or(global_enabled)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubEntryProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubRequestSemanticProtocol {
    Chat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationOwnership {
    New,
    RemoteProviderOwned,
    RouteCodexLocalOwned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubProviderWireProtocol {
    Responses,
    Anthropic,
    Gemini,
    OpenAiChat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTargetResolution {
    Routed,
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubInvocationSource {
    Client,
    ServertoolFollowup,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubTransportIntent {
    Json,
    Sse,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3HubOpaquePayload(pub(crate) Value);

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3HubResponsePayload(pub(crate) Arc<Value>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3ProviderCompatProfileId {
    Passthrough,
    Profile(String),
}

impl V3ProviderCompatProfileId {
    pub(crate) fn from_config(profile: Option<&str>) -> Self {
        match profile.map(str::trim).filter(|profile| !profile.is_empty()) {
            Some(profile) if profile.eq_ignore_ascii_case("compat:passthrough") => {
                Self::Passthrough
            }
            Some(profile) => Self::Profile(profile.to_string()),
            None => Self::Passthrough,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Passthrough => "compat:passthrough",
            Self::Profile(profile) => profile.as_str(),
        }
    }

    pub(crate) fn as_optional_string(&self) -> Option<String> {
        match self {
            Self::Passthrough => None,
            Self::Profile(profile) => Some(profile.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("provider compat profile {profile} failed at {stage}: {reason}")]
pub struct V3ProviderCompatError {
    pub(crate) stage: &'static str,
    pub(crate) profile: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseNormalizedKind {
    Json,
    Sse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubResponseTerminality {
    Terminal,
    NonTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubServertoolResponseAction {
    None,
    FollowupRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3StoplessCenterSteering {
    Continue,
    NaturalStopWithoutReasoningStop,
    ReasoningStopNeedsEvidence,
    Blocked,
    NeedContinue,
    GuardTerminal,
}

impl V3StoplessCenterSteering {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::NaturalStopWithoutReasoningStop => "natural_stop_without_reasoning_stop",
            Self::ReasoningStopNeedsEvidence => "reasoning_stop_needs_evidence",
            Self::Blocked => "blocked",
            Self::NeedContinue => "need_continue",
            Self::GuardTerminal => "guard_terminal",
        }
    }

    pub fn parse_str(value: &str) -> Option<Self> {
        match value.trim() {
            "continue" => Some(Self::Continue),
            "natural_stop_without_reasoning_stop" => Some(Self::NaturalStopWithoutReasoningStop),
            "reasoning_stop_needs_evidence" => Some(Self::ReasoningStopNeedsEvidence),
            "blocked" => Some(Self::Blocked),
            "need_continue" => Some(Self::NeedContinue),
            "guard_terminal" => Some(Self::GuardTerminal),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3StoplessCenterPhase {
    Idle,
    ProviderTurnInFlight,
    RespStopObserved,
    CliNoopProjected,
    CliNoopObserved,
    ContinuationGuidancePrepared,
    TerminalCompleted,
    TerminalBlocked,
    GuardTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3StoplessCenterStopKind {
    NaturalStop,
    NoSchema,
    InvalidSchema,
    ReasoningContinue,
    ReasoningNeedsEvidence,
    ReasoningFinished,
    ReasoningBlocked,
    NonStopProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3StoplessCenterNextRequestPolicy {
    ContinueDefault,
    ContinueWithStrongerInstruction,
    AskForCompletionEvidence,
    AskForBlockedEvidence,
    StopForUserBlock,
    StopForGuard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3StoplessCenterState {
    phase: V3StoplessCenterPhase,
    consecutive_stop_count: u32,
    max_stop_budget: u32,
    last_stop_kind: V3StoplessCenterStopKind,
    need_continue: bool,
    blocked: bool,
    terminal: bool,
    guard_exhausted: bool,
    next_request_policy: V3StoplessCenterNextRequestPolicy,
    next_step_prompt: Option<String>,
    schema_guidance_active: bool,
    schema_guidance_request_id: Option<String>,
    schema_guidance_contract: Option<String>,
    last_request_id: Option<String>,
    last_response_id: Option<String>,
    last_transition_reason: Option<String>,
    last_provider_stopless_call_id: Option<String>,
    updated_at: u64,
    steering: V3StoplessCenterSteering,
}

impl V3StoplessCenterState {
    pub fn new(
        natural_stop_count: u32,
        max_natural_stops: u32,
        steering: V3StoplessCenterSteering,
    ) -> Self {
        let max_stop_budget = max_natural_stops.max(1);
        let guard_exhausted = matches!(steering, V3StoplessCenterSteering::GuardTerminal)
            || natural_stop_count > max_stop_budget;
        let blocked = matches!(steering, V3StoplessCenterSteering::Blocked);
        let terminal = guard_exhausted || blocked;
        let need_continue = !terminal;
        let last_stop_kind = match steering {
            V3StoplessCenterSteering::Continue | V3StoplessCenterSteering::NeedContinue => {
                V3StoplessCenterStopKind::ReasoningContinue
            }
            V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
            | V3StoplessCenterSteering::GuardTerminal => V3StoplessCenterStopKind::NaturalStop,
            V3StoplessCenterSteering::ReasoningStopNeedsEvidence => {
                V3StoplessCenterStopKind::ReasoningNeedsEvidence
            }
            V3StoplessCenterSteering::Blocked => V3StoplessCenterStopKind::ReasoningBlocked,
        };
        let next_request_policy = if guard_exhausted {
            V3StoplessCenterNextRequestPolicy::StopForGuard
        } else {
            match steering {
                V3StoplessCenterSteering::ReasoningStopNeedsEvidence => {
                    V3StoplessCenterNextRequestPolicy::AskForCompletionEvidence
                }
                V3StoplessCenterSteering::Blocked => {
                    V3StoplessCenterNextRequestPolicy::StopForUserBlock
                }
                V3StoplessCenterSteering::NaturalStopWithoutReasoningStop
                    if natural_stop_count > 1 =>
                {
                    V3StoplessCenterNextRequestPolicy::ContinueWithStrongerInstruction
                }
                _ => V3StoplessCenterNextRequestPolicy::ContinueDefault,
            }
        };
        let phase = if guard_exhausted {
            V3StoplessCenterPhase::GuardTerminal
        } else if blocked {
            V3StoplessCenterPhase::TerminalBlocked
        } else {
            V3StoplessCenterPhase::CliNoopProjected
        };
        Self {
            phase,
            consecutive_stop_count: natural_stop_count,
            max_stop_budget,
            last_stop_kind,
            need_continue,
            blocked,
            terminal,
            guard_exhausted,
            next_request_policy,
            next_step_prompt: None,
            schema_guidance_active: false,
            schema_guidance_request_id: None,
            schema_guidance_contract: None,
            last_request_id: None,
            last_response_id: None,
            last_transition_reason: None,
            last_provider_stopless_call_id: None,
            updated_at: 0,
            steering,
        }
    }

    pub fn phase(&self) -> V3StoplessCenterPhase {
        self.phase
    }

    pub fn consecutive_stop_count(&self) -> u32 {
        self.consecutive_stop_count
    }

    pub fn natural_stop_count(&self) -> u32 {
        self.consecutive_stop_count
    }

    pub fn max_stop_budget(&self) -> u32 {
        self.max_stop_budget
    }

    pub fn max_natural_stops(&self) -> u32 {
        self.max_stop_budget
    }

    pub fn last_stop_kind(&self) -> V3StoplessCenterStopKind {
        self.last_stop_kind
    }

    pub fn need_continue(&self) -> bool {
        self.need_continue
    }

    pub fn blocked(&self) -> bool {
        self.blocked
    }

    pub fn terminal(&self) -> bool {
        self.terminal
    }

    pub fn guard_exhausted(&self) -> bool {
        self.guard_exhausted
    }

    pub fn next_request_policy(&self) -> V3StoplessCenterNextRequestPolicy {
        self.next_request_policy
    }

    pub fn next_step_prompt(&self) -> Option<&str> {
        self.next_step_prompt.as_deref()
    }

    pub fn schema_guidance_active(&self) -> bool {
        self.schema_guidance_active
    }

    pub fn schema_guidance_request_id(&self) -> Option<&str> {
        self.schema_guidance_request_id.as_deref()
    }

    pub fn schema_guidance_contract(&self) -> Option<&str> {
        self.schema_guidance_contract.as_deref()
    }

    pub fn schema_guidance_active_for(&self, request_id: Option<&str>) -> bool {
        if !self.schema_guidance_active {
            return false;
        }
        let Some(expected) = request_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return false;
        };
        self.schema_guidance_request_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|actual| actual == expected)
    }

    pub fn last_request_id(&self) -> Option<&str> {
        self.last_request_id.as_deref()
    }

    pub fn last_response_id(&self) -> Option<&str> {
        self.last_response_id.as_deref()
    }

    pub fn last_provider_stopless_call_id(&self) -> Option<&str> {
        self.last_provider_stopless_call_id.as_deref()
    }

    pub fn last_transition_reason(&self) -> Option<&str> {
        self.last_transition_reason.as_deref()
    }

    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }

    pub fn steering(&self) -> V3StoplessCenterSteering {
        self.steering
    }

    pub fn with_last_request_id(mut self, request_id: Option<impl Into<String>>) -> Self {
        self.last_request_id = request_id.map(Into::into);
        self
    }

    pub fn with_last_response_id(mut self, response_id: Option<impl Into<String>>) -> Self {
        self.last_response_id = response_id.map(Into::into);
        self
    }

    pub fn with_last_transition_reason(mut self, reason: impl Into<String>) -> Self {
        self.last_transition_reason = Some(reason.into());
        self
    }

    pub fn with_updated_at(mut self, updated_at: u64) -> Self {
        self.updated_at = updated_at;
        self
    }

    pub fn with_last_provider_stopless_call_id(
        mut self,
        call_id: Option<impl Into<String>>,
    ) -> Self {
        self.last_provider_stopless_call_id = call_id.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_max_stop_budget_floor(mut self, floor: u32) -> Self {
        self.max_stop_budget = self.max_stop_budget.max(floor.max(1));
        self.guard_exhausted = self.consecutive_stop_count > self.max_stop_budget;
        if self.guard_exhausted {
            self.terminal = true;
            self.need_continue = false;
            self.phase = V3StoplessCenterPhase::GuardTerminal;
            self.next_request_policy = V3StoplessCenterNextRequestPolicy::StopForGuard;
        }
        self
    }

    pub fn with_next_step_prompt(mut self, next_step_prompt: Option<impl Into<String>>) -> Self {
        self.next_step_prompt = next_step_prompt.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn provider_turn_in_flight(
        mut self,
        request_id: Option<&str>,
        updated_at: Option<u64>,
    ) -> Self {
        self.phase = V3StoplessCenterPhase::ProviderTurnInFlight;
        self.schema_guidance_active = false;
        self.schema_guidance_request_id = None;
        self.schema_guidance_contract = None;
        if let Some(request_id) = request_id {
            let request_id = request_id.trim();
            if !request_id.is_empty() {
                self.last_request_id = Some(request_id.to_string());
                self.schema_guidance_active = true;
                self.schema_guidance_request_id = Some(request_id.to_string());
                self.schema_guidance_contract = Some("stop_schema".to_string());
            }
        }
        if let Some(updated_at) = updated_at {
            self.updated_at = updated_at;
        }
        self.last_transition_reason = Some("req04_stopless_guidance_prepared".to_string());
        self
    }

    pub fn cli_noop_observed(mut self, request_id: Option<&str>, updated_at: Option<u64>) -> Self {
        self.phase = V3StoplessCenterPhase::CliNoopObserved;
        if let Some(request_id) = request_id {
            if !request_id.trim().is_empty() {
                self.last_request_id = Some(request_id.to_string());
            }
        }
        if let Some(updated_at) = updated_at {
            self.updated_at = updated_at;
        }
        self.last_transition_reason = Some("req04_stopless_noop_observed".to_string());
        self.schema_guidance_active = false;
        self.schema_guidance_request_id = None;
        self.schema_guidance_contract = None;
        self
    }

    pub fn continuation_guidance_prepared(
        mut self,
        request_id: Option<&str>,
        updated_at: Option<u64>,
    ) -> Self {
        self.phase = V3StoplessCenterPhase::ContinuationGuidancePrepared;
        if let Some(request_id) = request_id {
            if !request_id.trim().is_empty() {
                self.last_request_id = Some(request_id.to_string());
            }
        }
        if let Some(updated_at) = updated_at {
            self.updated_at = updated_at;
        }
        self.last_transition_reason =
            Some("req04_stopless_continuation_guidance_prepared".to_string());
        self.schema_guidance_active = false;
        self.schema_guidance_request_id = None;
        self.schema_guidance_contract = None;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3HubRelayToolKind {
    Function,
    Custom,
    Servertool,
    ApplyPatch,
    Mcp,
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3HubResponseToolCall {
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) kind: V3HubRelayToolKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3HubContinuationCommit {
    None,
    RemoteBinding,
    LocalContext,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3HubRelayCanonicalResponseContext {
    pub(crate) payload: Arc<Value>,
    pub(crate) terminality: V3HubResponseTerminality,
    pub(crate) tool_calls: Vec<V3HubResponseToolCall>,
    pub(crate) servertool_action: V3HubServertoolResponseAction,
}

// ==== V3 ServerToolCenter：通用 servertool 状态注册中心（stopless / websearch 按 toolName+scope 隔离）====

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum V3ServerToolName {
    Stopless,
    WebSearch,
}

impl V3ServerToolName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopless => "stopless",
            Self::WebSearch => "websearch",
        }
    }

    pub fn parse_str(value: &str) -> Option<Self> {
        match value.trim() {
            "stopless" => Some(Self::Stopless),
            "websearch" => Some(Self::WebSearch),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3WebSearchCenterPhase {
    Idle,
    LocalToolSurfaceActive,
    ToolCallObserved,
    SearchDispatchPrepared,
    SearchInFlight,
    SearchResultCaptured,
    HostedResultProjected,
    MainModelContinuationPrepared,
    Completed,
    Failed,
}

impl V3WebSearchCenterPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::LocalToolSurfaceActive => "local_tool_surface_active",
            Self::ToolCallObserved => "tool_call_observed",
            Self::SearchDispatchPrepared => "search_dispatch_prepared",
            Self::SearchInFlight => "search_in_flight",
            Self::SearchResultCaptured => "search_result_captured",
            Self::HostedResultProjected => "hosted_result_projected",
            Self::MainModelContinuationPrepared => "main_model_continuation_prepared",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn parse_str(value: &str) -> Option<Self> {
        match value.trim() {
            "idle" => Some(Self::Idle),
            "local_tool_surface_active" => Some(Self::LocalToolSurfaceActive),
            "tool_call_observed" => Some(Self::ToolCallObserved),
            "search_dispatch_prepared" => Some(Self::SearchDispatchPrepared),
            "search_in_flight" => Some(Self::SearchInFlight),
            "search_result_captured" => Some(Self::SearchResultCaptured),
            "hosted_result_projected" => Some(Self::HostedResultProjected),
            "main_model_continuation_prepared" => Some(Self::MainModelContinuationPrepared),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}

/// websearch 工具实例的 typed 状态。只承载当前轮搜索闭环的控制数据；
/// 路由/重试/健康/continuation 状态属于各自独立控制资源，不得混入。
#[derive(Debug, Clone, PartialEq)]
pub struct V3WebSearchCenterState {
    phase: V3WebSearchCenterPhase,
    transition_reason: Option<String>,
    execution_budget: u32,
    original_call_id: Option<String>,
    query: Option<String>,
    count: Option<u32>,
    recency: Option<String>,
    content_types: Vec<String>,
    backend_binding: Option<String>,
    normalized_result: Option<Value>,
    typed_failure: Option<String>,
    last_request_id: Option<String>,
    last_response_id: Option<String>,
    updated_at: u64,
}

impl V3WebSearchCenterState {
    pub fn new() -> Self {
        Self {
            phase: V3WebSearchCenterPhase::Idle,
            transition_reason: None,
            execution_budget: 0,
            original_call_id: None,
            query: None,
            count: None,
            recency: None,
            content_types: Vec::new(),
            backend_binding: None,
            normalized_result: None,
            typed_failure: None,
            last_request_id: None,
            last_response_id: None,
            updated_at: 0,
        }
    }

    pub fn phase(&self) -> V3WebSearchCenterPhase {
        self.phase
    }

    pub fn transition_reason(&self) -> Option<&str> {
        self.transition_reason.as_deref()
    }

    pub fn execution_budget(&self) -> u32 {
        self.execution_budget
    }

    pub fn original_call_id(&self) -> Option<&str> {
        self.original_call_id.as_deref()
    }

    pub fn query(&self) -> Option<&str> {
        self.query.as_deref()
    }

    pub fn count(&self) -> Option<u32> {
        self.count
    }

    pub fn recency(&self) -> Option<&str> {
        self.recency.as_deref()
    }

    pub fn content_types(&self) -> &[String] {
        &self.content_types
    }

    pub fn backend_binding(&self) -> Option<&str> {
        self.backend_binding.as_deref()
    }

    pub fn normalized_result(&self) -> Option<&Value> {
        self.normalized_result.as_ref()
    }

    pub fn typed_failure(&self) -> Option<&str> {
        self.typed_failure.as_deref()
    }

    pub fn last_request_id(&self) -> Option<&str> {
        self.last_request_id.as_deref()
    }

    pub fn last_response_id(&self) -> Option<&str> {
        self.last_response_id.as_deref()
    }

    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }

    pub fn with_execution_budget(mut self, budget: u32) -> Self {
        self.execution_budget = budget;
        self
    }

    pub fn with_original_call_id(mut self, call_id: Option<impl Into<String>>) -> Self {
        self.original_call_id = call_id.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_query(mut self, query: Option<impl Into<String>>) -> Self {
        self.query = query.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_count(mut self, count: Option<u32>) -> Self {
        self.count = count;
        self
    }

    pub fn with_recency(mut self, recency: Option<impl Into<String>>) -> Self {
        self.recency = recency.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_content_types(mut self, content_types: Vec<String>) -> Self {
        self.content_types = content_types;
        self
    }

    pub fn with_backend_binding(mut self, binding: Option<impl Into<String>>) -> Self {
        self.backend_binding = binding.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_normalized_result(mut self, result: Option<Value>) -> Self {
        self.normalized_result = result;
        self
    }

    pub fn with_typed_failure(mut self, failure: Option<impl Into<String>>) -> Self {
        self.typed_failure = failure.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_last_request_id(mut self, request_id: Option<impl Into<String>>) -> Self {
        self.last_request_id = request_id.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_last_response_id(mut self, response_id: Option<impl Into<String>>) -> Self {
        self.last_response_id = response_id.and_then(|value| {
            let value = value.into();
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self
    }

    pub fn with_updated_at(mut self, updated_at: u64) -> Self {
        self.updated_at = updated_at;
        self
    }

    /// 只允许 proposal 定义的相邻迁移；任何非 terminal phase 可进入 Failed。
    pub fn transition_to(
        &self,
        next: V3WebSearchCenterPhase,
        reason: impl Into<String>,
    ) -> Result<V3WebSearchCenterState, String> {
        let legal = match (self.phase, next) {
            (_, V3WebSearchCenterPhase::Failed) => !self.phase.is_terminal(),
            (V3WebSearchCenterPhase::Idle, V3WebSearchCenterPhase::LocalToolSurfaceActive) => {
                true
            }
            (
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                V3WebSearchCenterPhase::ToolCallObserved,
            ) => true,
            (
                V3WebSearchCenterPhase::ToolCallObserved,
                V3WebSearchCenterPhase::SearchDispatchPrepared,
            ) => true,
            (
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                V3WebSearchCenterPhase::SearchInFlight,
            ) => true,
            (V3WebSearchCenterPhase::SearchInFlight, V3WebSearchCenterPhase::SearchResultCaptured) => {
                true
            }
            (
                V3WebSearchCenterPhase::SearchResultCaptured,
                V3WebSearchCenterPhase::HostedResultProjected,
            ) => true,
            (
                V3WebSearchCenterPhase::HostedResultProjected,
                V3WebSearchCenterPhase::MainModelContinuationPrepared,
            ) => true,
            (
                V3WebSearchCenterPhase::MainModelContinuationPrepared,
                V3WebSearchCenterPhase::Completed,
            ) => true,
            _ => false,
        };
        if !legal {
            return Err(format!(
                "invalid web_search ServerTool transition: {:?} -> {:?}",
                self.phase, next
            ));
        }
        let mut next_state = self.clone();
        next_state.phase = next;
        next_state.transition_reason = Some(reason.into());
        Ok(next_state)
    }
}

impl Default for V3WebSearchCenterState {
    fn default() -> Self {
        Self::new()
    }
}

/// 通用注册中心持有的每个工具实例：typed per-tool state，禁止跨工具读写。
#[derive(Debug, Clone, PartialEq)]
pub enum V3ServerToolInstanceState {
    Stopless(V3StoplessCenterState),
    WebSearch(V3WebSearchCenterState),
}

impl V3ServerToolInstanceState {
    pub fn tool_name(&self) -> V3ServerToolName {
        match self {
            Self::Stopless(_) => V3ServerToolName::Stopless,
            Self::WebSearch(_) => V3ServerToolName::WebSearch,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3ServerToolCenterKey {
    pub tool_name: V3ServerToolName,
    /// entryProtocol + endpoint + serverId/port + routingGroup + sessionId + toolRunId
    /// 归一化后的 scope 键；sessionId 是硬会话隔离边界。
    pub scope_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("v3 servertool center state poisoned")]
pub struct V3ServerToolCenterPoisoned;

#[derive(Debug, Default)]
pub struct V3ServerToolCenter {
    store: Arc<Mutex<BTreeMap<V3ServerToolCenterKey, V3ServerToolInstanceState>>>,
}

impl Clone for V3ServerToolCenter {
    fn clone(&self) -> Self {
        Self {
            store: Arc::clone(&self.store),
        }
    }
}

impl V3ServerToolCenter {
    pub fn len(&self) -> Result<usize, V3ServerToolCenterPoisoned> {
        Ok(self.lock_store()?.len())
    }

    pub fn is_empty(&self) -> Result<bool, V3ServerToolCenterPoisoned> {
        Ok(self.lock_store()?.is_empty())
    }

    /// 注册新实例；同 key 已存在则 fail-fast（禁止覆盖/串台）。
    pub fn register(
        &self,
        key: V3ServerToolCenterKey,
        instance: V3ServerToolInstanceState,
    ) -> Result<(), String> {
        if instance.tool_name() != key.tool_name {
            return Err(format!(
                "cross-tool register rejected: key tool_name={:?} instance tool_name={:?}",
                key.tool_name,
                instance.tool_name()
            ));
        }
        let mut store = self
            .lock_store()
            .map_err(|error| error.to_string())?;
        if store.contains_key(&key) {
            return Err(format!(
                "servertool instance already registered for tool_name={:?} scope={}",
                key.tool_name, key.scope_key
            ));
        }
        store.insert(key, instance);
        Ok(())
    }

    pub fn load(
        &self,
        key: &V3ServerToolCenterKey,
    ) -> Result<Option<V3ServerToolInstanceState>, String> {
        self.lock_store()
            .map_err(|error| error.to_string())
            .map(|store| store.get(key).cloned())
    }

    /// 覆盖式写入；instance 的 toolName 必须与 key 一致（跨工具 fail-fast）。
    pub fn store(
        &self,
        key: V3ServerToolCenterKey,
        instance: V3ServerToolInstanceState,
    ) -> Result<(), String> {
        if instance.tool_name() != key.tool_name {
            return Err(format!(
                "cross-tool store rejected: key tool_name={:?} instance tool_name={:?}",
                key.tool_name,
                instance.tool_name()
            ));
        }
        self.lock_store()
            .map_err(|error| error.to_string())?
            .insert(key, instance);
        Ok(())
    }

    pub fn clear(&self, key: &V3ServerToolCenterKey) -> Result<(), String> {
        self.lock_store()
            .map_err(|error| error.to_string())?
            .remove(key);
        Ok(())
    }

    /// 原子迁移：load + 工具 typed 校验 + store，全程持锁。
    pub fn transition<F>(
        &self,
        key: &V3ServerToolCenterKey,
        transition: F,
    ) -> Result<V3ServerToolInstanceState, String>
    where
        F: FnOnce(V3ServerToolInstanceState) -> Result<V3ServerToolInstanceState, String>,
    {
        let mut store = self.lock_store().map_err(|error| error.to_string())?;
        let Some(current) = store.get(key).cloned() else {
            return Err(format!(
                "servertool transition on missing instance: tool_name={:?} scope={}",
                key.tool_name, key.scope_key
            ));
        };
        let next = transition(current)?;
        if next.tool_name() != key.tool_name {
            return Err(format!(
                "cross-tool transition rejected: key tool_name={:?} instance tool_name={:?}",
                key.tool_name,
                next.tool_name()
            ));
        }
        store.insert(key.clone(), next.clone());
        Ok(next)
    }

    fn lock_store(
        &self,
    ) -> Result<MutexGuard<'_, BTreeMap<V3ServerToolCenterKey, V3ServerToolInstanceState>>, V3ServerToolCenterPoisoned>
    {
        self.store
            .lock()
            .map_err(|_| V3ServerToolCenterPoisoned)
    }
}

#[cfg(test)]
mod server_tool_center_tests {
    use super::*;

    fn web_search_instance() -> V3WebSearchCenterState {
        V3WebSearchCenterState::new()
            .with_original_call_id(Some("call_web_search_1"))
            .with_query(Some("routecodex v3"))
            .with_count(Some(5))
            .with_execution_budget(1)
    }

    fn stopless_instance() -> V3StoplessCenterState {
        V3StoplessCenterState::new(1, 3, V3StoplessCenterSteering::Continue)
    }

    fn key(tool: V3ServerToolName, session: &str) -> V3ServerToolCenterKey {
        V3ServerToolCenterKey {
            tool_name: tool,
            scope_key: format!("responses:/v1/responses:5555:group1:{}:run1", session),
        }
    }

    #[test]
    fn web_search_state_machine_adjacent_transitions() {
        let state = V3WebSearchCenterState::new();
        let active = state
            .transition_to(V3WebSearchCenterPhase::LocalToolSurfaceActive, "req04")
            .expect("idle -> local_tool_surface_active");
        let observed = active
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "resp03")
            .expect("local_tool_surface_active -> tool_call_observed");
        let prepared = observed
            .transition_to(V3WebSearchCenterPhase::SearchDispatchPrepared, "resp03")
            .expect("tool_call_observed -> search_dispatch_prepared");
        let in_flight = prepared
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "resp03")
            .expect("search_dispatch_prepared -> search_in_flight");
        let captured = in_flight
            .transition_to(V3WebSearchCenterPhase::SearchResultCaptured, "resp03")
            .expect("search_in_flight -> search_result_captured");
        let projected = captured
            .transition_to(V3WebSearchCenterPhase::HostedResultProjected, "resp03")
            .expect("search_result_captured -> hosted_result_projected");
        let continuation = projected
            .transition_to(V3WebSearchCenterPhase::MainModelContinuationPrepared, "req04")
            .expect("hosted_result_projected -> main_model_continuation_prepared");
        let completed = continuation
            .transition_to(V3WebSearchCenterPhase::Completed, "req04")
            .expect("main_model_continuation_prepared -> completed");
        assert!(completed.phase().is_terminal());
    }

    #[test]
    fn web_search_state_machine_rejects_non_adjacent_transition() {
        let state = V3WebSearchCenterState::new();
        let error = state
            .transition_to(V3WebSearchCenterPhase::SearchInFlight, "skip")
            .expect_err("idle -> search_in_flight must be rejected");
        assert!(error.contains("invalid web_search ServerTool transition"));
    }

    #[test]
    fn web_search_state_machine_failed_is_terminal() {
        let state = V3WebSearchCenterState::new();
        let failed = state
            .transition_to(V3WebSearchCenterPhase::Failed, "dispatch_error")
            .expect("idle -> failed allowed for non-terminal");
        assert!(failed.phase().is_terminal());
        let error = failed
            .transition_to(V3WebSearchCenterPhase::Completed, "after_failure")
            .expect_err("terminal failed must not transition");
        assert!(error.contains("invalid web_search ServerTool transition"));
    }

    #[test]
    fn center_isolates_web_search_and_stopless_by_tool_name() {
        let center = V3ServerToolCenter::default();
        let web_key = key(V3ServerToolName::WebSearch, "session-a");
        let stopless_key = key(V3ServerToolName::Stopless, "session-a");
        center
            .register(web_key.clone(), V3ServerToolInstanceState::WebSearch(web_search_instance()))
            .expect("register web_search");
        center
            .register(
                stopless_key.clone(),
                V3ServerToolInstanceState::Stopless(stopless_instance()),
            )
            .expect("register stopless");
        assert_eq!(center.len().expect("len"), 2);
        // 同 key 重复注册 fail-fast
        let duplicate = center.register(
            web_key.clone(),
            V3ServerToolInstanceState::WebSearch(web_search_instance()),
        );
        assert!(duplicate.is_err());
        // 各自工具实例互不可见
        let web = center
            .load(&web_key)
            .expect("load web_search")
            .expect("web_search present");
        let stopless = center
            .load(&stopless_key)
            .expect("load stopless")
            .expect("stopless present");
        assert!(matches!(web, V3ServerToolInstanceState::WebSearch(_)));
        assert!(matches!(
            stopless,
            V3ServerToolInstanceState::Stopless(_)
        ));
    }

    #[test]
    fn center_rejects_cross_tool_register_store_transition() {
        let center = V3ServerToolCenter::default();
        let web_key = key(V3ServerToolName::WebSearch, "session-a");
        let stopless_key = key(V3ServerToolName::Stopless, "session-a");
        // register: key=websearch, instance=stopless -> reject
        let cross_register = center.register(
            web_key.clone(),
            V3ServerToolInstanceState::Stopless(stopless_instance()),
        );
        assert!(cross_register.is_err());
        assert!(cross_register
            .expect_err("cross-tool register")
            .contains("cross-tool register rejected"));
        // store: key=stopless, instance=websearch -> reject
        let cross_store = center.store(
            stopless_key.clone(),
            V3ServerToolInstanceState::WebSearch(web_search_instance()),
        );
        assert!(cross_store.is_err());
        assert!(cross_store
            .expect_err("cross-tool store")
            .contains("cross-tool store rejected"));
        // transition 返回跨工具实例 -> reject
        center
            .register(web_key.clone(), V3ServerToolInstanceState::WebSearch(web_search_instance()))
            .expect("register web_search");
        let cross_transition = center.transition(&web_key, |_| {
            Ok(V3ServerToolInstanceState::Stopless(stopless_instance()))
        });
        assert!(cross_transition.is_err());
        assert!(cross_transition
            .expect_err("cross-tool transition")
            .contains("cross-tool transition rejected"));
    }

    #[test]
    fn center_isolates_sessions() {
        let center = V3ServerToolCenter::default();
        let session_a = key(V3ServerToolName::WebSearch, "session-a");
        let session_b = key(V3ServerToolName::WebSearch, "session-b");
        center
            .register(session_a.clone(), V3ServerToolInstanceState::WebSearch(web_search_instance()))
            .expect("register session-a");
        center
            .register(session_b.clone(), V3ServerToolInstanceState::WebSearch(web_search_instance()))
            .expect("register session-b");
        // session-a 迁移不影响 session-b
        center
            .transition(&session_a, |instance| match instance {
                V3ServerToolInstanceState::WebSearch(state) => Ok(
                    V3ServerToolInstanceState::WebSearch(
                        state
                            .transition_to(
                                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                                "req04",
                            )
                            .expect("adjacent"),
                    ),
                ),
                other => Err(format!("unexpected tool instance {:?}", other)),
            })
            .expect("transition session-a");
        let a = center
            .load(&session_a)
            .expect("load a")
            .expect("a present");
        let b = center
            .load(&session_b)
            .expect("load b")
            .expect("b present");
        let (V3ServerToolInstanceState::WebSearch(state_a), V3ServerToolInstanceState::WebSearch(state_b)) =
            (a, b)
        else {
            panic!("expected web_search instances");
        };
        assert_eq!(state_a.phase(), V3WebSearchCenterPhase::LocalToolSurfaceActive);
        assert_eq!(state_b.phase(), V3WebSearchCenterPhase::Idle);
    }

    #[test]
    fn stopless_instance_preserves_behavior_inside_center() {
        let center = V3ServerToolCenter::default();
        let stopless_key = key(V3ServerToolName::Stopless, "session-a");
        let original = stopless_instance();
        center
            .register(
                stopless_key.clone(),
                V3ServerToolInstanceState::Stopless(original.clone()),
            )
            .expect("register stopless");
        let loaded = center
            .load(&stopless_key)
            .expect("load")
            .expect("present");
        let V3ServerToolInstanceState::Stopless(state) = loaded else {
            panic!("expected stopless instance");
        };
        assert_eq!(state, original, "stopless behavior must be unchanged");
        assert!(state.need_continue());
        assert_eq!(state.phase(), V3StoplessCenterPhase::CliNoopProjected);
    }
}
