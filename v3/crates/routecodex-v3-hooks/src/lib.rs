//! RCC internal hooks sidecar typed contract.
//!
//! This crate is the first delivery slice for the RCC optional hooks sidecar
//! work: stable data types, pure gates, and failure-injection tests before the
//! process/binary integration lands.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

mod control;
pub use control::*;
mod appserver;
pub use appserver::*;
mod daemon;
pub use daemon::*;
mod handler;
pub use handler::*;

pub const PROTOCOL: &str = "rcc-hooks-sidecar/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HooksUnavailableReason {
    Disabled,
    Missing,
    Timeout,
    InvalidReadiness,
    Crashed,
}

impl HooksUnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Missing => "missing",
            Self::Timeout => "timeout",
            Self::InvalidReadiness => "invalid_readiness",
            Self::Crashed => "crashed",
        }
    }
}

pub fn hooks_unavailable(reason: HooksUnavailableReason) -> String {
    format!("hooks_unavailable:{}", reason.as_str())
}

/// Formats a Unix timestamp (seconds) as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// UTC ISO-8601 strings of this fixed shape sort lexicographically in
/// chronological order, which is what schedule comparison relies on.
pub fn iso8601_utc_from_unix_seconds(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Namespace {
    CodexTui,
    CodexApp,
}

impl Namespace {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodexTui => "codex_tui",
            Self::CodexApp => "codex_app",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTarget {
    pub namespace: Namespace,
    pub appserver_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    IdleOnly,
    WorkingAllowed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageIntent {
    pub intent_id: String,
    pub source: SessionTarget,
    pub target: SessionTarget,
    pub body: String,
    pub send_mode: SendMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Accepted,
    Delivered,
    Executed,
    Replied,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryEvidenceRecord {
    pub intent_id: String,
    pub message_id: String,
    pub state: DeliveryState,
    pub cursor: Option<String>,
    pub read_item_id: Option<String>,
}

impl DeliveryEvidenceRecord {
    fn rank(&self) -> u8 {
        match self.state {
            DeliveryState::Accepted => 0,
            DeliveryState::Delivered => 1,
            DeliveryState::Executed => 2,
            DeliveryState::Replied => 3,
            DeliveryState::Read => 4,
        }
    }

    pub fn advance_to_reply(&self) -> Result<Self, DeliveryEvidenceError> {
        let state = match self.state {
            DeliveryState::Executed => DeliveryState::Replied,
            _ => {
                return Err(DeliveryEvidenceError::MissingReplyEvidence(
                    self.intent_id.clone(),
                    self.state,
                ))
            }
        };
        Ok(Self {
            state,
            ..self.clone()
        })
    }

    pub fn mark_read(
        &self,
        cursor: &str,
        read_item_id: &str,
    ) -> Result<Self, DeliveryEvidenceError> {
        if self.state != DeliveryState::Replied {
            return Err(DeliveryEvidenceError::MissingReadEvidence(
                self.intent_id.clone(),
                self.state,
            ));
        }
        Ok(Self {
            state: DeliveryState::Read,
            cursor: Some(cursor.to_string()),
            read_item_id: Some(read_item_id.to_string()),
            ..self.clone()
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeliveryEvidenceError {
    #[error("cannot claim reply before executed evidence for intent {0}; current {1:?}")]
    MissingReplyEvidence(String, DeliveryState),
    #[error("cannot claim read before replied evidence for intent {0}; current {1:?}")]
    MissingReadEvidence(String, DeliveryState),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookDecision {
    NoOp,
    SendMessage(Box<MessageIntent>),
}

pub trait HookHandler {
    fn handle(
        &self,
        event: &HookEvent,
        state: &HookState,
    ) -> Result<HookDecision, HookRegistryError>;
}

#[derive(Debug, Default)]
pub struct NoOpHookHandler;

impl HookHandler for NoOpHookHandler {
    fn handle(
        &self,
        _event: &HookEvent,
        _state: &HookState,
    ) -> Result<HookDecision, HookRegistryError> {
        Ok(HookDecision::NoOp)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookEvent {
    pub event_name: String,
    pub hook_kind: String,
    pub source: Option<SessionTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookState {
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HookRegistryError {
    #[error("no handler mounted for hook kind {0}")]
    NoHandler(String),
    #[error("handler {0} returned an error")]
    HandlerError(String),
}

#[derive(Default)]
pub struct HookRegistry {
    handlers: BTreeMap<String, HookHandlerEntry>,
}

struct HookHandlerEntry {
    handler_id: String,
    // `None` means the control plane registered the hook kind but no runtime
    // handler has been mounted yet. Dispatch must fail closed in that state
    // rather than silently treating it as a no-op.
    handler: Option<Box<dyn HookHandler + Send>>,
}

impl HookRegistry {
    pub fn register_handler(&mut self, handler_id: &str, hook_kind: &str) {
        self.handlers.insert(
            hook_kind.to_string(),
            HookHandlerEntry {
                handler_id: handler_id.to_string(),
                handler: None,
            },
        );
    }

    pub fn mount_handler(
        &mut self,
        handler_id: &str,
        hook_kind: &str,
        handler: impl HookHandler + Send + 'static,
    ) {
        self.handlers.insert(
            hook_kind.to_string(),
            HookHandlerEntry {
                handler_id: handler_id.to_string(),
                handler: Some(Box::new(handler)),
            },
        );
    }

    pub fn dispatch(
        &self,
        event: &HookEvent,
        state: &HookState,
    ) -> Result<HookDecision, HookRegistryError> {
        self.handlers
            .get(&event.hook_kind)
            .ok_or_else(|| HookRegistryError::NoHandler(event.hook_kind.clone()))?
            .handler
            .as_ref()
            .ok_or_else(|| HookRegistryError::NoHandler(event.hook_kind.clone()))?
            .handle(event, state)
            .map_err(|error| match error {
                HookRegistryError::HandlerError(_) => error,
                HookRegistryError::NoHandler(_) => error,
            })
    }

    pub fn handler_id_for(&self, hook_kind: &str) -> Result<&str, HookRegistryError> {
        self.handlers
            .get(hook_kind)
            .map(|entry| entry.handler_id.as_str())
            .ok_or_else(|| HookRegistryError::NoHandler(hook_kind.to_string()))
    }

    pub fn handler_for(&self, hook_kind: &str) -> Result<&str, HookRegistryError> {
        self.handler_id_for(hook_kind)
    }

    pub fn unregister(&mut self, hook_kind: &str) {
        self.handlers.remove(hook_kind);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduledMessage {
    pub id: String,
    pub at_iso8601: String,
    pub registrant: SessionTarget,
    pub body: String,
    pub send_mode: SendMode,
}

impl ScheduledMessage {
    pub fn return_to_registrant(&self, intent_id: String) -> MessageIntent {
        MessageIntent {
            intent_id,
            source: self.registrant.clone(),
            target: self.registrant.clone(),
            body: self.body.clone(),
            send_mode: self.send_mode,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Working,
    Stopping,
    Unknown,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStatus {
    pub state: SessionState,
    pub input_active: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AppServerError {
    #[error("app server socket missing for {0}")]
    SocketMissing(String),
    #[error("app server transport error: {0}")]
    Transport(String),
    #[error("session unknown: {0}")]
    UnknownSession(String),
    #[error("session disconnected: {0}")]
    Disconnected(String),
    #[error("app server transport timeout: {0}")]
    TransportTimeout(String),
    #[error("delivery unresolved: {0}")]
    DeliveryUnresolved(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendAttemptEvidence {
    pub delivery: DeliveryEvidenceRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<NativeBaselineSnapshot>,
}

pub trait AppServerTransport {
    fn session_status(&mut self, target: &SessionTarget) -> Result<SessionStatus, AppServerError>;

    fn send_message(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<DeliveryEvidenceRecord, AppServerError>;

    fn send_message_with_baseline(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<SendAttemptEvidence, AppServerError> {
        self.send_message(intent)
            .map(|delivery| SendAttemptEvidence {
                delivery,
                baseline: None,
            })
    }

    fn delivery_evidence(
        &mut self,
        intent: &MessageIntent,
        baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError>;

    fn delivery_evidence_with_baseline(
        &mut self,
        intent: &MessageIntent,
        baseline: Option<&NativeBaselineSnapshot>,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        self.delivery_evidence(
            intent,
            &baseline.map_or_else(Vec::new, |value| value.item_ids()),
        )
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SidecarStateError {
    #[error("sidecar state io failed: {0}")]
    Io(String),
    #[error("sidecar state JSON failed: {0}")]
    Json(String),
    #[error("unsupported sidecar state schema version: {0}")]
    UnsupportedSchema(u16),
}

impl From<std::io::Error> for SidecarStateError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<serde_json::Error> for SidecarStateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error.to_string())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SidecarDispatchError {
    #[error(transparent)]
    AppServer(#[from] AppServerError),
    #[error(transparent)]
    Forward(#[from] ForwardError),
    #[error(transparent)]
    Hook(#[from] HookRegistryError),
    #[error(transparent)]
    State(#[from] SidecarStateError),
    #[error("intent id {0} was reused with different content")]
    IntentConflict(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchOutcome {
    NoOp,
    Sent(DeliveryEvidenceRecord),
    UnknownDelivery {
        intent_id: String,
        reason: String,
    },
    Deferred {
        target: SessionTarget,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedIntentPhase {
    Pending,
    Deferred,
    Sent,
    UnknownDelivery,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedIntentRecord {
    pub intent: MessageIntent,
    pub phase: PersistedIntentPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<NativeBaselineSnapshot>,
    #[serde(default)]
    pub evidence: Vec<DeliveryEvidenceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<DispatchOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidecarPersistentState {
    pub schema_version: u16,
    #[serde(default)]
    pub schedules: BTreeMap<String, ScheduledMessage>,
    #[serde(default)]
    pub paused_schedule_ids: BTreeSet<String>,
    #[serde(default)]
    pub handlers: Vec<HookHandlerConfig>,
    #[serde(default)]
    pub intents: BTreeMap<String, PersistedIntentRecord>,
}

impl Default for SidecarPersistentState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            schedules: BTreeMap::new(),
            paused_schedule_ids: BTreeSet::new(),
            handlers: Vec::new(),
            intents: BTreeMap::new(),
        }
    }
}

pub struct HooksSidecarCore<T> {
    transport: T,
    registry: HookRegistry,
    schedules: BTreeMap<String, ScheduledMessage>,
    paused_schedule_ids: BTreeSet<String>,
    handlers: Vec<HookHandlerConfig>,
    intents: BTreeMap<String, PersistedIntentRecord>,
    state_path: Option<PathBuf>,
}

impl<T: AppServerTransport> HooksSidecarCore<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            registry: HookRegistry::default(),
            schedules: BTreeMap::new(),
            paused_schedule_ids: BTreeSet::new(),
            handlers: Vec::new(),
            intents: BTreeMap::new(),
            state_path: None,
        }
    }

    pub fn with_state_file(
        transport: T,
        state_path: impl Into<PathBuf>,
    ) -> Result<Self, SidecarStateError> {
        let state_path = state_path.into();
        let mut state = load_sidecar_state(&state_path)?;
        let mut recovered = false;
        for record in state.intents.values_mut() {
            if record.phase == PersistedIntentPhase::Pending {
                record.phase = PersistedIntentPhase::UnknownDelivery;
                record.outcome = Some(DispatchOutcome::UnknownDelivery {
                    intent_id: record.intent.intent_id.clone(),
                    reason: "restart recovery requires reconciliation".to_string(),
                });
                record.error = Some("restart_recovery_requires_reconcile".to_string());
                recovered = true;
            }
        }
        if recovered {
            write_sidecar_state(&state_path, &state)?;
        }
        let mut core = Self {
            transport,
            registry: HookRegistry::default(),
            schedules: state.schedules,
            paused_schedule_ids: state.paused_schedule_ids,
            handlers: Vec::new(),
            intents: state.intents,
            state_path: Some(state_path),
        };
        for handler in state.handlers {
            core.mount_handler_config(handler);
        }
        Ok(core)
    }

    pub fn persist_state(&self) -> Result<(), SidecarStateError> {
        let Some(state_path) = self.state_path.as_deref() else {
            return Ok(());
        };
        write_sidecar_state(
            state_path,
            &SidecarPersistentState {
                schema_version: 1,
                schedules: self.schedules.clone(),
                paused_schedule_ids: self.paused_schedule_ids.clone(),
                handlers: self.handlers.clone(),
                intents: self.intents.clone(),
            },
        )
    }

    pub fn register_handler(&mut self, handler_id: &str, hook_kind: &str) {
        self.registry.register_handler(handler_id, hook_kind);
    }

    pub fn mount_handler(
        &mut self,
        handler_id: &str,
        hook_kind: &str,
        handler: impl HookHandler + Send + 'static,
    ) {
        self.registry.mount_handler(handler_id, hook_kind, handler);
    }

    pub fn unregister_handler(&mut self, hook_kind: &str) {
        self.registry.unregister(hook_kind);
        self.handlers
            .retain(|handler| handler.hook_kind != hook_kind);
    }

    pub fn mount_handler_config(&mut self, config: HookHandlerConfig) {
        match &config.strategy {
            HookHandlerStrategy::NoOp => {
                self.mount_handler(&config.handler_id, &config.hook_kind, NoOpHookHandler)
            }
            HookHandlerStrategy::Command { command, args } => self.mount_handler(
                &config.handler_id,
                &config.hook_kind,
                CommandHookHandler::new(command.clone(), args.clone()),
            ),
        }
        self.handlers
            .retain(|existing| existing.hook_kind != config.hook_kind);
        self.handlers.push(config);
    }

    pub fn upsert_schedule(&mut self, schedule: ScheduledMessage) {
        self.paused_schedule_ids.remove(&schedule.id);
        self.schedules.insert(schedule.id.clone(), schedule);
    }

    pub fn due_schedules(&self, now_iso8601: &str) -> Vec<MessageIntent> {
        self.schedules
            .values()
            .filter(|schedule| {
                !self.paused_schedule_ids.contains(&schedule.id)
                    && schedule.at_iso8601.as_str() <= now_iso8601
            })
            .map(|schedule| {
                schedule
                    .return_to_registrant(format!("timer:{}:{}", schedule.id, schedule.at_iso8601))
            })
            .collect()
    }

    pub fn pause_schedule(&mut self, schedule_id: &str) -> bool {
        if !self.schedules.contains_key(schedule_id) {
            return false;
        }
        self.paused_schedule_ids.insert(schedule_id.to_string())
    }

    pub fn resume_schedule(&mut self, schedule_id: &str) -> bool {
        self.schedules.contains_key(schedule_id) && self.paused_schedule_ids.remove(schedule_id)
    }

    pub fn remove_schedule(&mut self, schedule_id: &str) -> bool {
        self.paused_schedule_ids.remove(schedule_id);
        self.schedules.remove(schedule_id).is_some()
    }

    pub fn dispatch_hook_event(
        &mut self,
        event: &HookEvent,
        state: &HookState,
    ) -> Result<DispatchOutcome, SidecarDispatchError> {
        let decision = self
            .registry
            .dispatch(event, state)
            .map_err(SidecarDispatchError::Hook)?;
        match decision {
            HookDecision::NoOp => Ok(DispatchOutcome::NoOp),
            HookDecision::SendMessage(intent) => self.send_to_target(*intent),
        }
    }

    pub fn forward(
        &mut self,
        intent: MessageIntent,
    ) -> Result<DispatchOutcome, SidecarDispatchError> {
        if intent.source == intent.target {
            return Err(ForwardError::SameSession.into());
        }
        self.send_to_target(intent)
    }

    pub fn session_status(
        &mut self,
        target: &SessionTarget,
    ) -> Result<SessionStatus, AppServerError> {
        self.transport.session_status(target)
    }

    pub fn delivery_evidence(
        &mut self,
        intent: &MessageIntent,
        baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, SidecarDispatchError> {
        let record = self.intents.get(&intent.intent_id).ok_or_else(|| {
            SidecarDispatchError::AppServer(AppServerError::DeliveryUnresolved(format!(
                "intent {} was not accepted",
                intent.intent_id
            )))
        })?;
        // Evidence must be bound to the exact accepted intent. A caller may
        // reuse an accepted intent id with different content; never query the
        // changed target or record an observation under the original entry.
        if &record.intent != intent {
            return Err(SidecarDispatchError::IntentConflict(
                intent.intent_id.clone(),
            ));
        }
        let baseline_for_intent = if baseline.is_empty() {
            record.baseline.as_ref()
        } else {
            None
        };
        let observation = if baseline.is_empty() {
            self.transport
                .delivery_evidence_with_baseline(intent, baseline_for_intent)?
        } else {
            self.transport.delivery_evidence(intent, baseline)?
        };
        self.record_delivery_observation(&intent.intent_id, observation)?;
        self.persist_state()?;
        Ok(self.intents[&intent.intent_id]
            .evidence
            .last()
            .cloned()
            .expect("accepted intent always has accepted evidence"))
    }

    pub fn intent_evidence(
        &self,
        intent_id: &str,
    ) -> Result<PersistedIntentRecord, SidecarDispatchError> {
        self.intents.get(intent_id).cloned().ok_or_else(|| {
            SidecarDispatchError::AppServer(AppServerError::DeliveryUnresolved(format!(
                "intent {intent_id} is not in the delivery ledger"
            )))
        })
    }

    pub fn run_due_schedules(
        &mut self,
        now_iso8601: &str,
    ) -> Vec<Result<DispatchOutcome, SidecarDispatchError>> {
        let due_ids = self
            .schedules
            .iter()
            .filter(|(id, schedule)| {
                !self.paused_schedule_ids.contains(*id)
                    && schedule.at_iso8601.as_str() <= now_iso8601
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut outcomes = Vec::with_capacity(due_ids.len());
        let had_due = !due_ids.is_empty();
        for id in due_ids {
            let Some(schedule) = self.schedules.get(&id).cloned() else {
                continue;
            };
            let intent = schedule
                .return_to_registrant(format!("timer:{}:{}", schedule.id, schedule.at_iso8601));
            let outcome = if self
                .intents
                .get(&intent.intent_id)
                .is_some_and(|record| record.phase == PersistedIntentPhase::Deferred)
            {
                self.resume_deferred_intent(&intent.intent_id)
            } else {
                self.send_to_target(intent)
            };
            if !matches!(&outcome, Ok(DispatchOutcome::Deferred { .. })) {
                self.schedules.remove(&id);
            }
            outcomes.push(outcome);
        }
        if had_due {
            if let Err(error) = self.persist_state() {
                outcomes.push(Err(SidecarDispatchError::State(error)));
            }
        }
        outcomes
    }

    fn send_to_target(
        &mut self,
        intent: MessageIntent,
    ) -> Result<DispatchOutcome, SidecarDispatchError> {
        if let Some(existing) = self.intents.get(&intent.intent_id) {
            if existing.intent != intent {
                return Err(SidecarDispatchError::IntentConflict(
                    intent.intent_id.clone(),
                ));
            }
            if let Some(outcome) = &existing.outcome {
                return Ok(outcome.clone());
            }
            let error = existing
                .error
                .clone()
                .unwrap_or_else(|| "previous intent attempt was not completed".to_string());
            return Err(SidecarDispatchError::AppServer(AppServerError::Transport(
                error,
            )));
        }
        self.intents.insert(
            intent.intent_id.clone(),
            PersistedIntentRecord {
                intent: intent.clone(),
                phase: PersistedIntentPhase::Pending,
                baseline: None,
                evidence: Vec::new(),
                outcome: None,
                error: None,
            },
        );
        self.persist_state()?;
        self.perform_send_attempt(intent)
    }

    fn perform_send_attempt(
        &mut self,
        intent: MessageIntent,
    ) -> Result<DispatchOutcome, SidecarDispatchError> {
        let status = self
            .transport
            .session_status(&intent.target)
            .map_err(|error| {
                self.record_failed(&intent.intent_id, error.to_string());
                let _ = self.persist_state();
                SidecarDispatchError::AppServer(error)
            })?;
        if status.input_active
            || (matches!(status.state, SessionState::Working | SessionState::Stopping)
                && intent.send_mode == SendMode::IdleOnly)
        {
            let outcome = DispatchOutcome::Deferred {
                target: intent.target.clone(),
                reason: "target working or input-active with idle_only mode".to_string(),
            };
            self.record_outcome(
                &intent.intent_id,
                PersistedIntentPhase::Deferred,
                outcome.clone(),
            );
            self.persist_state()?;
            return Ok(outcome);
        }
        if status.state == SessionState::Unknown {
            let error = AppServerError::UnknownSession(intent.target.session_id.clone());
            self.record_failed(&intent.intent_id, error.to_string());
            self.persist_state()?;
            return Err(SidecarDispatchError::AppServer(error));
        }
        if status.state == SessionState::Disconnected {
            let error = AppServerError::Disconnected(intent.target.session_id.clone());
            self.record_failed(&intent.intent_id, error.to_string());
            self.persist_state()?;
            return Err(SidecarDispatchError::AppServer(error));
        }
        match self.transport.send_message_with_baseline(&intent) {
            Ok(attempt) => {
                let outcome = DispatchOutcome::Sent(attempt.delivery.clone());
                self.record_sent_attempt(&intent.intent_id, attempt);
                self.persist_state()?;
                Ok(outcome)
            }
            Err(error @ AppServerError::TransportTimeout(_)) => {
                let outcome = DispatchOutcome::UnknownDelivery {
                    intent_id: intent.intent_id.clone(),
                    reason: error.to_string(),
                };
                self.record_outcome(
                    &intent.intent_id,
                    PersistedIntentPhase::UnknownDelivery,
                    outcome.clone(),
                );
                self.persist_state()?;
                Ok(outcome)
            }
            Err(error) => {
                self.record_failed(&intent.intent_id, error.to_string());
                self.persist_state()?;
                Err(SidecarDispatchError::AppServer(error))
            }
        }
    }

    fn resume_deferred_intent(
        &mut self,
        intent_id: &str,
    ) -> Result<DispatchOutcome, SidecarDispatchError> {
        let record = self.intents.get_mut(intent_id).ok_or_else(|| {
            SidecarDispatchError::AppServer(AppServerError::DeliveryUnresolved(format!(
                "deferred intent not found: {intent_id}"
            )))
        })?;
        if record.phase != PersistedIntentPhase::Deferred {
            return Ok(record
                .outcome
                .clone()
                .unwrap_or(DispatchOutcome::UnknownDelivery {
                    intent_id: intent_id.to_string(),
                    reason: "intent is not deferrable in its current phase".to_string(),
                }));
        }
        let intent = record.intent.clone();
        record.phase = PersistedIntentPhase::Pending;
        record.outcome = None;
        record.error = None;
        self.persist_state()?;
        self.perform_send_attempt(intent)
    }

    fn record_outcome(
        &mut self,
        intent_id: &str,
        phase: PersistedIntentPhase,
        outcome: DispatchOutcome,
    ) {
        if let Some(record) = self.intents.get_mut(intent_id) {
            record.phase = phase;
            record.outcome = Some(outcome);
            record.error = None;
        }
    }

    fn record_sent_attempt(&mut self, intent_id: &str, attempt: SendAttemptEvidence) {
        if let Some(record) = self.intents.get_mut(intent_id) {
            record.phase = PersistedIntentPhase::Sent;
            record.baseline = attempt.baseline;
            record.evidence = vec![attempt.delivery.clone()];
            record.outcome = Some(DispatchOutcome::Sent(attempt.delivery));
            record.error = None;
        }
    }

    fn record_delivery_observation(
        &mut self,
        intent_id: &str,
        observation: DeliveryEvidenceRecord,
    ) -> Result<(), SidecarDispatchError> {
        let record = self.intents.get_mut(intent_id).ok_or_else(|| {
            SidecarDispatchError::AppServer(AppServerError::DeliveryUnresolved(format!(
                "intent {intent_id} is not in the delivery ledger"
            )))
        })?;
        if record.evidence.is_empty() {
            return Err(SidecarDispatchError::AppServer(
                AppServerError::DeliveryUnresolved(format!(
                    "intent {intent_id} has no accepted evidence"
                )),
            ));
        }
        let previous_rank = record
            .evidence
            .iter()
            .map(DeliveryEvidenceRecord::rank)
            .max()
            .unwrap_or_default();
        let observation_rank = observation.rank();
        if observation_rank < previous_rank {
            return Err(SidecarDispatchError::AppServer(
                AppServerError::DeliveryUnresolved(format!(
                    "delivery state moved backwards for {intent_id}: {previous_rank} -> {observation_rank}"
                )),
            ));
        }

        upsert_delivery_evidence(record, observation);
        Ok(())
    }

    fn record_failed(&mut self, intent_id: &str, error: String) {
        if let Some(record) = self.intents.get_mut(intent_id) {
            record.phase = PersistedIntentPhase::Failed;
            record.outcome = None;
            record.error = Some(error);
        }
    }
}

fn upsert_delivery_evidence(record: &mut PersistedIntentRecord, evidence: DeliveryEvidenceRecord) {
    if let Some(existing) = record
        .evidence
        .iter_mut()
        .find(|existing| existing.state == evidence.state)
    {
        *existing = evidence;
    } else {
        record.evidence.push(evidence);
        record.evidence.sort_by_key(DeliveryEvidenceRecord::rank);
    }
}

fn load_sidecar_state(path: &Path) -> Result<SidecarPersistentState, SidecarStateError> {
    match fs::read(path) {
        Ok(bytes) => {
            let state: SidecarPersistentState = serde_json::from_slice(&bytes)?;
            if state.schema_version != 1 {
                return Err(SidecarStateError::UnsupportedSchema(state.schema_version));
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(SidecarPersistentState::default())
        }
        Err(error) => Err(error.into()),
    }
}

fn write_sidecar_state(
    path: &Path,
    state: &SidecarPersistentState,
) -> Result<(), SidecarStateError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary_path = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary_path, serde_json::to_vec_pretty(state)?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ForwardError {
    #[error("forward source and target are the same session")]
    SameSession,
}

pub fn forward_intent(
    intent_id: String,
    source: SessionTarget,
    target: SessionTarget,
    body: String,
    send_mode: SendMode,
) -> Result<MessageIntent, ForwardError> {
    if source == target {
        return Err(ForwardError::SameSession);
    }
    Ok(MessageIntent {
        intent_id,
        source,
        target,
        body,
        send_mode,
    })
}

#[derive(Debug, Default)]
pub struct DisabledTransport;

impl AppServerTransport for DisabledTransport {
    fn session_status(&mut self, target: &SessionTarget) -> Result<SessionStatus, AppServerError> {
        Err(AppServerError::SocketMissing(target.appserver_id.clone()))
    }

    fn send_message(
        &mut self,
        _intent: &MessageIntent,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        Err(AppServerError::SocketMissing("disabled".to_string()))
    }

    fn delivery_evidence(
        &mut self,
        _intent: &MessageIntent,
        _baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        Err(AppServerError::SocketMissing("disabled".to_string()))
    }
}

pub enum AnyAppServerTransport {
    Disabled(DisabledTransport),
    Native(NativeAppServerTransport),
}

impl AppServerTransport for AnyAppServerTransport {
    fn session_status(&mut self, target: &SessionTarget) -> Result<SessionStatus, AppServerError> {
        match self {
            Self::Disabled(transport) => transport.session_status(target),
            Self::Native(transport) => transport.session_status(target),
        }
    }

    fn send_message(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        match self {
            Self::Disabled(transport) => transport.send_message(intent),
            Self::Native(transport) => transport.send_message(intent),
        }
    }

    fn delivery_evidence(
        &mut self,
        intent: &MessageIntent,
        baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        match self {
            Self::Disabled(transport) => transport.delivery_evidence(intent, baseline),
            Self::Native(transport) => transport.delivery_evidence(intent, baseline),
        }
    }

    fn delivery_evidence_with_baseline(
        &mut self,
        intent: &MessageIntent,
        baseline: Option<&NativeBaselineSnapshot>,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        match self {
            Self::Disabled(transport) => {
                transport.delivery_evidence_with_baseline(intent, baseline)
            }
            Self::Native(transport) => transport.delivery_evidence_with_baseline(intent, baseline),
        }
    }
}

#[cfg(test)]
struct StubTransport {
    status: SessionStatus,
}

#[cfg(test)]
impl AppServerTransport for StubTransport {
    fn session_status(&mut self, _target: &SessionTarget) -> Result<SessionStatus, AppServerError> {
        Ok(self.status.clone())
    }

    fn send_message(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        Ok(DeliveryEvidenceRecord {
            intent_id: intent.intent_id.clone(),
            message_id: format!("message:{}", intent.intent_id),
            state: DeliveryState::Accepted,
            cursor: None,
            read_item_id: None,
        })
    }

    fn delivery_evidence(
        &mut self,
        intent: &MessageIntent,
        _baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        Ok(DeliveryEvidenceRecord {
            intent_id: intent.intent_id.clone(),
            message_id: format!("message:{}", intent.intent_id),
            state: DeliveryState::Accepted,
            cursor: None,
            read_item_id: None,
        })
    }
}

#[cfg(test)]
mod tests;
