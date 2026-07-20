use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

pub const V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR: &str =
    "client-request,provider-request,provider-response,client-response";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3Debug01NodeEventRegistered {
    pub server_id: String,
    pub method: String,
    pub path: String,
    pub node_id: &'static str,
}

pub fn register_v3_debug_01_pending_endpoint_event(
    server_id: impl Into<String>,
    method: impl Into<String>,
    path: impl Into<String>,
) -> V3Debug01NodeEventRegistered {
    V3Debug01NodeEventRegistered {
        server_id: server_id.into(),
        method: method.into(),
        path: path.into(),
        node_id: "V3Debug01NodeEventRegistered",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DebugRuntimeConfig {
    pub log_console: bool,
    pub log_file: Option<String>,
    pub snapshots_enabled: bool,
    pub snapshot_stages: Option<String>,
    pub dry_run_enabled: bool,
    pub raw_request_retention: usize,
    pub raw_response_retention: usize,
    pub event_retention: usize,
    pub redaction: V3RedactionPolicy,
}

impl Default for V3DebugRuntimeConfig {
    fn default() -> Self {
        Self {
            log_console: false,
            log_file: None,
            snapshots_enabled: false,
            snapshot_stages: None,
            dry_run_enabled: false,
            raw_request_retention: 16,
            raw_response_retention: 16,
            event_retention: 512,
            redaction: V3RedactionPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RedactionPolicy {
    sensitive_key_fragments: Vec<&'static str>,
}

impl Default for V3RedactionPolicy {
    fn default() -> Self {
        Self {
            sensitive_key_fragments: vec![
                "authorization",
                "api_key",
                "apikey",
                "token",
                "secret",
                "password",
                "credential",
                "auth_env",
                "token_file",
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3DebugTraceScope {
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
}

impl V3DebugTraceScope {
    fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.server_id, self.request_id, self.execution_id
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct V3DebugEventProjection {
    pub sequence: u64,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub node_id: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct V3DebugRawCaptureProjection {
    pub sequence: u64,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct V3DebugSnapshotProjection {
    pub sequence: u64,
    pub session_id: String,
    pub server_id: String,
    pub request_id: String,
    pub execution_id: String,
    pub node_id: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3DebugStatusProjection {
    pub log_console: bool,
    pub log_file: Option<String>,
    pub snapshots_enabled: bool,
    pub snapshot_stages: String,
    pub dry_run_enabled: bool,
    pub event_count: usize,
    pub raw_request_count: usize,
    pub raw_response_count: usize,
    pub snapshot_count: usize,
    pub dry_run_fixture_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct V3DryRunFixture {
    pub fixture_id: String,
    pub server_id: String,
    pub method: String,
    pub path: String,
    pub request_payload: Value,
    pub response_payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct V3DryRunExecutionPlan {
    pub fixture_id: String,
    pub server_id: String,
    pub method: String,
    pub path: String,
    pub terminal_effect: &'static str,
}

#[derive(Debug)]
pub enum V3DebugError {
    Disabled(&'static str),
    FixtureNotFound(String),
    MalformedFixture(String),
    Sink(String),
    SnapshotSessionNotFound(String),
    SnapshotScopeMismatch(String),
    Poisoned(String),
}

impl std::fmt::Display for V3DebugError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled(feature) => write!(formatter, "debug feature disabled: {feature}"),
            Self::FixtureNotFound(id) => write!(formatter, "dry-run fixture not found: {id}"),
            Self::MalformedFixture(message) => {
                write!(formatter, "malformed dry-run fixture: {message}")
            }
            Self::Sink(message) => write!(formatter, "debug sink failed: {message}"),
            Self::SnapshotSessionNotFound(id) => {
                write!(formatter, "snapshot session not found: {id}")
            }
            Self::SnapshotScopeMismatch(id) => {
                write!(formatter, "snapshot session scope mismatch: {id}")
            }
            Self::Poisoned(message) => write!(formatter, "debug runtime lock poisoned: {message}"),
        }
    }
}

impl std::error::Error for V3DebugError {}

type V3DebugResult<T> = Result<T, V3DebugError>;

#[derive(Debug, Clone)]
pub struct V3DebugRuntime {
    config: Arc<V3DebugRuntimeConfig>,
    state: Arc<RwLock<V3DebugState>>,
    sequence: Arc<AtomicU64>,
}

#[derive(Debug, Default)]
struct V3DebugState {
    events: VecDeque<V3DebugEventProjection>,
    raw_requests: VecDeque<V3DebugRawCaptureProjection>,
    raw_responses: VecDeque<V3DebugRawCaptureProjection>,
    snapshot_sessions: BTreeMap<String, V3SnapshotSession>,
    snapshots: VecDeque<V3DebugSnapshotProjection>,
    dry_run_fixtures: BTreeMap<String, V3DryRunFixture>,
}

#[derive(Debug, Clone)]
struct V3SnapshotSession {
    scope_key: String,
}

impl V3DebugRuntime {
    pub fn new(config: V3DebugRuntimeConfig) -> V3DebugResult<Self> {
        if let Some(path) = config.log_file.as_deref() {
            if let Some(parent) = std::path::Path::new(path).parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| V3DebugError::Sink(error.to_string()))?;
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|error| V3DebugError::Sink(error.to_string()))?;
        }
        Ok(Self {
            config: Arc::new(config),
            state: Arc::new(RwLock::new(V3DebugState::default())),
            sequence: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn start_trace(
        &self,
        server_id: impl Into<String>,
        request_id: impl Into<String>,
        execution_id: impl Into<String>,
    ) -> V3DebugResult<V3DebugTraceScope> {
        Ok(V3DebugTraceScope {
            server_id: server_id.into(),
            request_id: request_id.into(),
            execution_id: execution_id.into(),
        })
    }

    pub fn next_request_id(&self, server_id: &str) -> String {
        format!(
            "{}-req-{}",
            server_id,
            self.sequence.fetch_add(1, Ordering::SeqCst)
        )
    }

    pub fn next_execution_id(&self, server_id: &str) -> String {
        format!(
            "{}-exec-{}",
            server_id,
            self.sequence.fetch_add(1, Ordering::SeqCst)
        )
    }

    pub fn record_node_event(
        &self,
        scope: &V3DebugTraceScope,
        node_id: impl Into<String>,
        event: impl Into<String>,
        details: Option<Value>,
    ) -> V3DebugResult<V3DebugEventProjection> {
        let projection = V3DebugEventProjection {
            sequence: self.sequence.fetch_add(1, Ordering::SeqCst),
            server_id: scope.server_id.clone(),
            request_id: scope.request_id.clone(),
            execution_id: scope.execution_id.clone(),
            node_id: node_id.into(),
            event: event.into(),
            details: details.map(|value| redact_debug_value(&self.config.redaction, value)),
        };
        {
            let mut state = self.write_state()?;
            state.events.push_back(projection.clone());
            retain_latest(&mut state.events, self.config.event_retention);
        }
        self.write_sink(&projection)?;
        Ok(projection)
    }

    pub fn append_human_console_line(&self, line: &str) -> V3DebugResult<()> {
        let Some(path) = self.config.log_file.as_deref() else {
            return Ok(());
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|error| V3DebugError::Sink(error.to_string()))?;
        writeln!(file, "{line}").map_err(|error| V3DebugError::Sink(error.to_string()))?;
        Ok(())
    }

    pub fn redact_payload_for_side_channel(&self, payload: Value) -> Value {
        redact_debug_value(&self.config.redaction, payload)
    }

    pub fn capture_raw_request(
        &self,
        scope: &V3DebugTraceScope,
        payload: Value,
    ) -> V3DebugResult<Option<V3DebugRawCaptureProjection>> {
        self.capture_raw(scope, "request", payload, self.config.raw_request_retention)
    }

    pub fn capture_raw_response(
        &self,
        scope: &V3DebugTraceScope,
        payload: Value,
    ) -> V3DebugResult<Option<V3DebugRawCaptureProjection>> {
        self.capture_raw(
            scope,
            "response",
            payload,
            self.config.raw_response_retention,
        )
    }

    fn capture_raw(
        &self,
        scope: &V3DebugTraceScope,
        kind: &str,
        payload: Value,
        retention: usize,
    ) -> V3DebugResult<Option<V3DebugRawCaptureProjection>> {
        if retention == 0 {
            return Ok(None);
        }
        let projection = V3DebugRawCaptureProjection {
            sequence: self.sequence.fetch_add(1, Ordering::SeqCst),
            server_id: scope.server_id.clone(),
            request_id: scope.request_id.clone(),
            execution_id: scope.execution_id.clone(),
            kind: kind.to_string(),
            payload: redact_debug_value(&self.config.redaction, payload),
        };
        let mut state = self.write_state()?;
        match kind {
            "request" => {
                state.raw_requests.push_back(projection.clone());
                retain_latest(&mut state.raw_requests, retention);
            }
            "response" => {
                state.raw_responses.push_back(projection.clone());
                retain_latest(&mut state.raw_responses, retention);
            }
            _ => unreachable!("fixed raw capture kind"),
        }
        Ok(Some(projection))
    }

    pub fn start_snapshot_session(
        &self,
        scope: &V3DebugTraceScope,
        reason: impl AsRef<str>,
    ) -> V3DebugResult<String> {
        if !self.config.snapshots_enabled {
            return Err(V3DebugError::Disabled("snapshots"));
        }
        let session_id = format!(
            "snap-{}-{}",
            reason.as_ref(),
            self.sequence.fetch_add(1, Ordering::SeqCst)
        );
        self.write_state()?.snapshot_sessions.insert(
            session_id.clone(),
            V3SnapshotSession {
                scope_key: scope.key(),
            },
        );
        Ok(session_id)
    }

    pub fn should_capture_snapshot_stage(&self, stage: &str) -> bool {
        if !self.config.snapshots_enabled {
            return false;
        }
        should_capture_v3_snapshot_stage(self.config.snapshot_stages.as_deref(), stage)
    }

    pub fn record_snapshot(
        &self,
        scope: &V3DebugTraceScope,
        session_id: &str,
        node_id: impl Into<String>,
        payload: Value,
    ) -> V3DebugResult<V3DebugSnapshotProjection> {
        if !self.config.snapshots_enabled {
            return Err(V3DebugError::Disabled("snapshots"));
        }
        let mut state = self.write_state()?;
        let session = state
            .snapshot_sessions
            .get(session_id)
            .ok_or_else(|| V3DebugError::SnapshotSessionNotFound(session_id.to_string()))?;
        if session.scope_key != scope.key() {
            return Err(V3DebugError::SnapshotScopeMismatch(session_id.to_string()));
        }
        let snapshot = V3DebugSnapshotProjection {
            sequence: self.sequence.fetch_add(1, Ordering::SeqCst),
            session_id: session_id.to_string(),
            server_id: scope.server_id.clone(),
            request_id: scope.request_id.clone(),
            execution_id: scope.execution_id.clone(),
            node_id: node_id.into(),
            payload: redact_debug_value(&self.config.redaction, payload),
        };
        state.snapshots.push_back(snapshot.clone());
        retain_latest(&mut state.snapshots, self.config.event_retention);
        Ok(snapshot)
    }

    pub fn close_snapshot_session_keep_snapshots(
        &self,
        scope: &V3DebugTraceScope,
        session_id: &str,
    ) -> V3DebugResult<()> {
        let mut state = self.write_state()?;
        let session = state
            .snapshot_sessions
            .get(session_id)
            .ok_or_else(|| V3DebugError::SnapshotSessionNotFound(session_id.to_string()))?;
        if session.scope_key != scope.key() {
            return Err(V3DebugError::SnapshotScopeMismatch(session_id.to_string()));
        }
        state.snapshot_sessions.remove(session_id);
        Ok(())
    }

    pub fn release_snapshot_session(
        &self,
        scope: &V3DebugTraceScope,
        session_id: &str,
    ) -> V3DebugResult<()> {
        let mut state = self.write_state()?;
        let session = state
            .snapshot_sessions
            .get(session_id)
            .ok_or_else(|| V3DebugError::SnapshotSessionNotFound(session_id.to_string()))?;
        if session.scope_key != scope.key() {
            return Err(V3DebugError::SnapshotScopeMismatch(session_id.to_string()));
        }
        state.snapshot_sessions.remove(session_id);
        state
            .snapshots
            .retain(|snapshot| snapshot.session_id != session_id);
        Ok(())
    }

    pub fn register_dry_run_fixture(&self, fixture: V3DryRunFixture) -> V3DebugResult<()> {
        if !self.config.dry_run_enabled {
            return Err(V3DebugError::Disabled("dry_run"));
        }
        if fixture.fixture_id.trim().is_empty() {
            return Err(V3DebugError::MalformedFixture(
                "fixture_id is empty".to_string(),
            ));
        }
        if fixture.server_id.trim().is_empty() {
            return Err(V3DebugError::MalformedFixture(
                "server_id is empty".to_string(),
            ));
        }
        if fixture.method.trim().is_empty() {
            return Err(V3DebugError::MalformedFixture(
                "method is empty".to_string(),
            ));
        }
        if !fixture.path.starts_with('/') {
            return Err(V3DebugError::MalformedFixture(
                "path must start with /".to_string(),
            ));
        }
        self.write_state()?
            .dry_run_fixtures
            .insert(fixture.fixture_id.clone(), fixture);
        Ok(())
    }

    pub fn dry_run_fixture(&self, fixture_id: &str) -> V3DebugResult<V3DryRunFixture> {
        self.read_state()?
            .dry_run_fixtures
            .get(fixture_id)
            .cloned()
            .ok_or_else(|| V3DebugError::FixtureNotFound(fixture_id.to_string()))
    }

    pub fn build_dry_run_execution_plan(
        &self,
        fixture_id: &str,
    ) -> V3DebugResult<V3DryRunExecutionPlan> {
        let fixture = self.dry_run_fixture(fixture_id)?;
        Ok(V3DryRunExecutionPlan {
            fixture_id: fixture.fixture_id,
            server_id: fixture.server_id,
            method: fixture.method,
            path: fixture.path,
            terminal_effect: "no_network_send",
        })
    }

    pub fn status(&self) -> V3DebugResult<V3DebugStatusProjection> {
        let state = self.read_state()?;
        Ok(V3DebugStatusProjection {
            log_console: self.config.log_console,
            log_file: self.config.log_file.clone(),
            snapshots_enabled: self.config.snapshots_enabled,
            snapshot_stages: effective_v3_snapshot_stage_selector(
                self.config.snapshot_stages.as_deref(),
            )
            .to_string(),
            dry_run_enabled: self.config.dry_run_enabled,
            event_count: state.events.len(),
            raw_request_count: state.raw_requests.len(),
            raw_response_count: state.raw_responses.len(),
            snapshot_count: state.snapshots.len(),
            dry_run_fixture_count: state.dry_run_fixtures.len(),
        })
    }

    pub fn logs(&self) -> V3DebugResult<Vec<V3DebugEventProjection>> {
        Ok(self.read_state()?.events.iter().cloned().collect())
    }

    pub fn snapshots(&self) -> V3DebugResult<Vec<V3DebugSnapshotProjection>> {
        Ok(self.read_state()?.snapshots.iter().cloned().collect())
    }

    pub fn raw_requests(&self) -> V3DebugResult<Vec<V3DebugRawCaptureProjection>> {
        Ok(self.read_state()?.raw_requests.iter().cloned().collect())
    }

    pub fn raw_responses(&self) -> V3DebugResult<Vec<V3DebugRawCaptureProjection>> {
        Ok(self.read_state()?.raw_responses.iter().cloned().collect())
    }

    pub fn redact_projection(&self, value: Value) -> Value {
        redact_debug_value(&self.config.redaction, value)
    }

    fn write_state(&self) -> V3DebugResult<std::sync::RwLockWriteGuard<'_, V3DebugState>> {
        self.state
            .write()
            .map_err(|error| V3DebugError::Poisoned(error.to_string()))
    }

    fn read_state(&self) -> V3DebugResult<std::sync::RwLockReadGuard<'_, V3DebugState>> {
        self.state
            .read()
            .map_err(|error| V3DebugError::Poisoned(error.to_string()))
    }

    fn write_sink(&self, event: &V3DebugEventProjection) -> V3DebugResult<()> {
        let line =
            serde_json::to_string(event).map_err(|error| V3DebugError::Sink(error.to_string()))?;
        if self.config.log_console {
            println!("{line}");
        }
        if let Some(path) = self.config.log_file.as_deref() {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|error| V3DebugError::Sink(error.to_string()))?;
            writeln!(file, "{line}").map_err(|error| V3DebugError::Sink(error.to_string()))?;
        }
        Ok(())
    }
}

pub fn effective_v3_snapshot_stage_selector(selector: Option<&str>) -> &str {
    selector
        .map(str::trim)
        .filter(|selector| !selector.is_empty())
        .unwrap_or(V3_DEFAULT_SNAPSHOT_STAGE_SELECTOR)
}

pub fn should_capture_v3_snapshot_stage(selector: Option<&str>, stage: &str) -> bool {
    let normalized_stage = stage.trim().to_ascii_lowercase();
    if normalized_stage.is_empty() {
        return false;
    }
    let selector = effective_v3_snapshot_stage_selector(selector);
    let mut has_token = false;
    for token in selector
        .split(|character: char| character == ',' || character.is_ascii_whitespace())
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        has_token = true;
        let token = token.to_ascii_lowercase();
        if token == "*" || token == "all" {
            return true;
        }
        if let Some(prefix) = token.strip_suffix('*') {
            if !prefix.is_empty() && normalized_stage.starts_with(prefix) {
                return true;
            }
            continue;
        }
        if normalized_stage == token {
            return true;
        }
    }
    if !has_token {
        return should_capture_v3_snapshot_stage(None, &normalized_stage);
    }
    false
}

fn retain_latest<T>(values: &mut VecDeque<T>, limit: usize) {
    while values.len() > limit {
        values.pop_front();
    }
}

pub fn redact_debug_value(policy: &V3RedactionPolicy, value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if is_sensitive_key(policy, &key) {
                        (key, Value::String("[REDACTED]".to_string()))
                    } else {
                        (key, redact_debug_value(policy, value))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_debug_value(policy, value))
                .collect(),
        ),
        Value::String(text) if looks_like_secret_literal(&text) => {
            Value::String("[REDACTED]".to_string())
        }
        other => other,
    }
}

fn is_sensitive_key(policy: &V3RedactionPolicy, key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    policy
        .sensitive_key_fragments
        .iter()
        .any(|fragment| lower.contains(fragment))
}

fn looks_like_secret_literal(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("sk-")
        || trimmed.starts_with("Bearer ")
        || trimmed.starts_with("eyJ")
        || trimmed.contains("api_key=")
}
