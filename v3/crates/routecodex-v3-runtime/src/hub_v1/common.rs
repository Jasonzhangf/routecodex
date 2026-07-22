use serde_json::Value;
use std::sync::Arc;

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
    last_request_id: Option<String>,
    last_response_id: Option<String>,
    last_transition_reason: Option<String>,
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
            || natural_stop_count >= max_stop_budget;
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
            last_request_id: None,
            last_response_id: None,
            last_transition_reason: None,
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

    pub fn last_request_id(&self) -> Option<&str> {
        self.last_request_id.as_deref()
    }

    pub fn last_response_id(&self) -> Option<&str> {
        self.last_response_id.as_deref()
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

    pub fn provider_turn_in_flight(
        mut self,
        request_id: Option<&str>,
        updated_at: Option<u64>,
    ) -> Self {
        self.phase = V3StoplessCenterPhase::ProviderTurnInFlight;
        if let Some(request_id) = request_id {
            if !request_id.trim().is_empty() {
                self.last_request_id = Some(request_id.to_string());
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
