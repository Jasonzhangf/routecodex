use crate::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

const NATIVE_TRANSPORT_TIMEOUT: Duration = Duration::from_secs(15);
// A native App Server frame is a JSON-RPC response. The advertised payload
// length is untrusted input: reject it before allocating so a peer on the
// local socket cannot force an unbounded allocation.
const NATIVE_MAX_FRAME_PAYLOAD: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeAppServerMethod {
    Initialize,
    ThreadRead,
    ThreadLoadedList,
    ThreadQueueAdd,
    ThreadQueueStart,
    ThreadTimelineList,
    ThreadTurnsList,
}

impl NativeAppServerMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::ThreadRead => "thread/read",
            Self::ThreadLoadedList => "thread/loaded/list",
            Self::ThreadQueueAdd => "thread/queue/add",
            Self::ThreadQueueStart => "thread/queue/start",
            Self::ThreadTimelineList => "thread/timeline/list",
            Self::ThreadTurnsList => "thread/turns/list",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeBaselineState {
    Read,
    Empty,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeBaselineSnapshot {
    pub state: NativeBaselineState,
    #[serde(default)]
    pub items: Vec<NativeThreadItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl NativeBaselineSnapshot {
    pub fn item_ids(&self) -> Vec<String> {
        self.items
            .iter()
            .filter_map(|item| item.id.clone())
            .collect()
    }
}

pub fn native_initialize_params(
    client_name: &str,
    title: &str,
    version: &str,
) -> serde_json::Value {
    json!({
        "clientInfo": {
            "name": client_name,
            "title": title,
            "version": version
        },
        "capabilities": { "experimentalApi": true }
    })
}

pub fn native_thread_read_params(thread_id: &str) -> serde_json::Value {
    json!({ "threadId": thread_id })
}

pub fn native_thread_read_params_with_turns(thread_id: &str) -> serde_json::Value {
    json!({ "threadId": thread_id, "includeTurns": true })
}

pub fn native_thread_loaded_list_params() -> serde_json::Value {
    json!({})
}

pub fn native_thread_queue_add_params(
    thread_id: &str,
    body: &str,
    client_user_message_id: &str,
) -> serde_json::Value {
    json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": body }],
        "clientUserMessageId": client_user_message_id
    })
}

pub fn native_thread_queue_start_params(
    thread_id: &str,
    queued_submission_id: &str,
) -> serde_json::Value {
    json!({
        "threadId": thread_id,
        "queuedSubmissionId": queued_submission_id
    })
}

pub fn native_thread_items_list_params(
    thread_id: &str,
    limit: usize,
    sort_direction: &str,
) -> serde_json::Value {
    json!({
        "threadId": thread_id,
        "limit": limit,
        "sortDirection": sort_direction
    })
}

pub fn native_thread_timeline_list_params(thread_id: &str, limit: usize) -> serde_json::Value {
    json!({
        "threadId": thread_id,
        "limit": limit
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NativeThreadItem {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub client_user_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub text: Option<String>,
}

impl NativeThreadItem {
    pub fn from_entry(entry: &serde_json::Value) -> Self {
        let item = entry.get("item").unwrap_or(entry);
        let outer_turn_id = entry
            .get("turnId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        Self {
            id: item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    item.get("clientUserMessageId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                }),
            kind: item
                .get("type")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            client_user_message_id: item
                .get("clientUserMessageId")
                .or_else(|| item.get("clientId"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            turn_id: outer_turn_id.or_else(|| {
                item.get("turnId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            }),
            text: item
                .get("text")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        }
    }

    pub fn is_receipt_for(&self, intent_id: &str) -> bool {
        matches!(
            self.kind.as_deref(),
            Some("userMessage") | Some("user_message")
        ) && (self.client_user_message_id.as_deref() == Some(intent_id)
            || self.id.as_deref() == Some(intent_id))
    }

    pub fn is_reply(&self) -> bool {
        // Only an assistant reply proves the target responded. A tool message
        // is execution evidence, not a reply, so promoting `accepted` to
        // `replied` on a tool message would overstate the observed protocol
        // state.
        matches!(
            self.kind.as_deref(),
            Some("agentMessage") | Some("assistantMessage")
        )
    }
}

pub fn normalize_session_state(raw: &serde_json::Value) -> SessionState {
    let state = raw
        .get("type")
        .or_else(|| raw.get("state"))
        .unwrap_or(raw)
        .as_str()
        .unwrap_or("unknown")
        .replace("active", "working")
        .replace("systemError", "failed");
    match state.as_str() {
        "idle" => SessionState::Idle,
        "working" => SessionState::Working,
        "stopping" => SessionState::Stopping,
        "disconnected" => SessionState::Disconnected,
        "unknown" | "notLoaded" => SessionState::Unknown,
        _ => SessionState::Unknown,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppServerSocketConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_tui: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_app: Option<String>,
}

impl AppServerSocketConfig {
    pub fn single(socket_path: impl Into<String>) -> Self {
        Self {
            default: Some(socket_path.into()),
            codex_tui: None,
            codex_app: None,
        }
    }

    fn for_namespace(&self, namespace: Namespace) -> Option<&str> {
        match namespace {
            Namespace::CodexTui => self.codex_tui.as_deref().or(self.default.as_deref()),
            Namespace::CodexApp => self.codex_app.as_deref().or(self.default.as_deref()),
        }
    }

    pub fn has_any_socket(&self) -> bool {
        self.default.is_some() || self.codex_tui.is_some() || self.codex_app.is_some()
    }
}

pub struct NativeAppServerTransport {
    sockets: AppServerSocketConfig,
    baseline_cache: BTreeMap<String, NativeBaselineSnapshot>,
}

impl NativeAppServerTransport {
    pub fn new(socket_path: impl Into<String>) -> Self {
        Self::with_sockets(AppServerSocketConfig::single(socket_path))
    }

    pub fn with_sockets(sockets: AppServerSocketConfig) -> Self {
        Self {
            sockets,
            baseline_cache: BTreeMap::new(),
        }
    }

    fn client_for(&mut self, namespace: Namespace) -> Result<UnixWsJsonRpc, AppServerError> {
        let socket_path = self.sockets.for_namespace(namespace).ok_or_else(|| {
            AppServerError::SocketMissing(format!("{} app server socket", namespace.as_str()))
        })?;
        let mut client = UnixWsJsonRpc::connect(Path::new(socket_path))?;
        client.call(
            "initialize",
            native_initialize_params("rccv3-hooksd", "RCC Hooks Sidecar", "0.1.0"),
        )?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    pub fn call(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AppServerError> {
        let mut client = self.client_for(Namespace::CodexApp)?;
        client.call(method, params)
    }

    pub fn loaded_threads(&mut self) -> Result<Vec<String>, AppServerError> {
        self.loaded_threads_for(Namespace::CodexApp)
    }

    pub fn loaded_threads_for(
        &mut self,
        namespace: Namespace,
    ) -> Result<Vec<String>, AppServerError> {
        let mut client = self.client_for(namespace)?;
        let result = client.call("thread/loaded/list", native_thread_loaded_list_params())?;
        result
            .get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                AppServerError::Transport("thread/loaded/list returned no data array".to_string())
            })?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    AppServerError::Transport(
                        "thread/loaded/list data entry is not a string".to_string(),
                    )
                })
            })
            .collect()
    }

    pub fn snapshot_items(
        &mut self,
        namespace: Namespace,
        thread_id: &str,
    ) -> Result<NativeBaselineSnapshot, AppServerError> {
        let mut client = self.client_for(namespace)?;
        let read_with_turns = client.call(
            "thread/read",
            native_thread_read_params_with_turns(thread_id),
        );
        let (thread, read_turns_error) = match read_with_turns {
            Ok(read) => {
                let thread = read.get("thread").ok_or_else(|| {
                    AppServerError::Transport("thread/read returned no thread".to_string())
                })?;
                (thread.clone(), None)
            }
            Err(error) => {
                let read = client.call("thread/read", native_thread_read_params(thread_id))?;
                let thread = read.get("thread").ok_or_else(|| {
                    AppServerError::Transport("thread/read returned no thread".to_string())
                })?;
                (thread.clone(), Some(error.to_string()))
            }
        };
        let actual_thread_id = thread.get("id").and_then(serde_json::Value::as_str);
        if actual_thread_id != Some(thread_id) {
            return Err(AppServerError::Transport(format!(
                "thread/read identity mismatch for {thread_id}"
            )));
        }
        let status = SessionStatus {
            state: normalize_session_state(thread.get("status").unwrap_or(&thread)),
            input_active: false,
        };
        if let Some(turns) = thread
            .get("turns")
            .and_then(serde_json::Value::as_array)
            .filter(|turns| !turns.is_empty())
        {
            let items = turns
                .iter()
                .flat_map(|turn| {
                    let turn_id = turn.get("id").and_then(serde_json::Value::as_str);
                    turn.get("items")
                        .and_then(serde_json::Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|item| {
                            let mut wrapped = json!({ "item": item });
                            if let Some(turn_id) = turn_id {
                                wrapped["turnId"] = json!(turn_id);
                            }
                            NativeThreadItem::from_entry(&wrapped)
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            return Ok(NativeBaselineSnapshot {
                state: NativeBaselineState::Read,
                items,
                reason: None,
            });
        }
        let items_result = client.call(
            "thread/timeline/list",
            native_thread_timeline_list_params(thread_id, 100),
        );
        match items_result {
            Ok(result) => snapshot_from_timeline_page(&result),
            Err(timeline_error) => {
                let items_result = client.call(
                    "thread/items/list",
                    native_thread_items_list_params(thread_id, 100, "desc"),
                );
                match items_result {
                    Ok(result) => snapshot_from_history_page(&result, "thread/items/list"),
                    Err(items_error) => {
                        let turns_result = client.call(
                            "thread/turns/list",
                            native_thread_items_list_params(thread_id, 100, "desc"),
                        );
                        match turns_result {
                            Ok(result) => snapshot_from_history_page(&result, "thread/turns/list"),
                            Err(turns_error) => {
                                let reason = match read_turns_error {
                                    Some(read_turns_error) => format!(
                                        "thread history read is unavailable: read_turns={read_turns_error}; timeline={timeline_error}; items={items_error}; turns={turns_error}"
                                    ),
                                    None => format!(
                                        "thread history read is unavailable: timeline={timeline_error}; items={items_error}; turns={turns_error}"
                                    ),
                                };
                                if is_unmaterialized_history_read_error(&reason, &status) {
                                    Ok(NativeBaselineSnapshot {
                                        state: NativeBaselineState::Empty,
                                        items: Vec::new(),
                                        reason: Some(reason),
                                    })
                                } else {
                                    // The default App Server may expose queue
                                    // submission without exposing rollout
                                    // history. Keep the send path usable, but
                                    // preserve the missing observation so
                                    // delivery evidence cannot be fabricated.
                                    Ok(NativeBaselineSnapshot {
                                        state: NativeBaselineState::Unavailable,
                                        items: Vec::new(),
                                        reason: Some(reason),
                                    })
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn delivery_evidence_from_native(
        &mut self,
        intent: &MessageIntent,
        baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        let snapshot = self.snapshot_items(intent.target.namespace, &intent.target.thread_id)?;
        if snapshot.state == NativeBaselineState::Unavailable {
            return Err(AppServerError::DeliveryUnresolved(
                snapshot
                    .reason
                    .unwrap_or_else(|| "native history is unavailable".to_string()),
            ));
        }
        let baseline_for_intent = if baseline.is_empty() {
            self.baseline_for_evidence(&intent.intent_id, None)?
        } else {
            if let Some(cached) = self.baseline_cache.get(&intent.intent_id) {
                if cached.state == NativeBaselineState::Unavailable {
                    return Err(AppServerError::DeliveryUnresolved(
                        cached.reason.clone().unwrap_or_else(|| {
                            format!("baseline history unavailable for {}", intent.intent_id)
                        }),
                    ));
                }
            }
            baseline.to_vec()
        };
        correlate_delivery_evidence(&intent.intent_id, &baseline_for_intent, &snapshot.items)
    }

    fn baseline_for_evidence(
        &self,
        intent_id: &str,
        baseline: Option<&NativeBaselineSnapshot>,
    ) -> Result<Vec<String>, AppServerError> {
        let baseline = baseline
            .map(std::borrow::Cow::Borrowed)
            .or_else(|| {
                self.baseline_cache
                    .get(intent_id)
                    .map(std::borrow::Cow::Borrowed)
            })
            .ok_or_else(|| {
                AppServerError::DeliveryUnresolved(
                    "baseline evidence missing for intent".to_string(),
                )
            })?;
        if baseline.state == NativeBaselineState::Unavailable {
            return Err(AppServerError::DeliveryUnresolved(
                baseline
                    .reason
                    .clone()
                    .unwrap_or_else(|| format!("baseline history unavailable for {intent_id}")),
            ));
        }
        Ok(baseline.item_ids())
    }
}

fn snapshot_from_history_page(
    result: &serde_json::Value,
    method: &str,
) -> Result<NativeBaselineSnapshot, AppServerError> {
    let data = result
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| AppServerError::Transport(format!("{method} returned no data array")))?;
    Ok(NativeBaselineSnapshot {
        state: NativeBaselineState::Read,
        items: data.iter().map(NativeThreadItem::from_entry).collect(),
        reason: None,
    })
}

fn is_unmaterialized_history_read_error(reason: &str, status: &SessionStatus) -> bool {
    status.state == SessionState::Idle
        && !status.input_active
        && (reason.contains("not materialized") || reason.contains("before first user message"))
}

impl AppServerTransport for NativeAppServerTransport {
    fn session_status(&mut self, target: &SessionTarget) -> Result<SessionStatus, AppServerError> {
        let mut client = self.client_for(target.namespace)?;
        let result = client.call("thread/read", native_thread_read_params(&target.thread_id))?;
        let thread = result.get("thread").ok_or_else(|| {
            AppServerError::Transport("thread/read returned no thread".to_string())
        })?;
        let state = thread
            .get("status")
            .or_else(|| thread.get("state"))
            .or_else(|| thread.get("type"))
            .ok_or_else(|| AppServerError::Transport("thread state missing".to_string()))?;
        Ok(SessionStatus {
            state: normalize_session_state(state),
            input_active: false,
        })
    }

    fn send_message(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        self.send_message_with_baseline(intent)
            .map(|attempt| attempt.delivery)
    }

    fn send_message_with_baseline(
        &mut self,
        intent: &MessageIntent,
    ) -> Result<SendAttemptEvidence, AppServerError> {
        let baseline = self.snapshot_items(intent.target.namespace, &intent.target.thread_id)?;
        self.baseline_cache
            .insert(intent.intent_id.clone(), baseline);
        let mut client = self.client_for(intent.target.namespace)?;
        let result = client.call(
            "thread/queue/add",
            native_thread_queue_add_params(
                &intent.target.thread_id,
                &intent.body,
                &intent.intent_id,
            ),
        )?;
        let queued_submission_id = result
            .get("queuedSubmission")
            .and_then(|submission| submission.get("id"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppServerError::Transport(
                    "thread/queue/add returned no queuedSubmission.id".to_string(),
                )
            })?;
        let start_result = client.call(
            "thread/queue/start",
            native_thread_queue_start_params(&intent.target.thread_id, queued_submission_id),
        );
        let mut start_error = None;
        if let Err(error) = start_result {
            if !is_queued_submission_already_dispatched(&error, queued_submission_id) {
                // thread/queue/add already accepted the submission; a
                // queue/start error cannot make this a pre-acceptance failure.
                // Preserve accepted state and the exact error so delivery
                // evidence remains unresolved instead of a failed intent.
                start_error = Some(error.to_string());
            }
        }
        let message_id = queued_submission_id.to_string();
        Ok(SendAttemptEvidence {
            delivery: DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id,
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: start_error.clone(),
            },
            baseline: self.baseline_cache.get(&intent.intent_id).cloned(),
            start_error,
        })
    }

    fn delivery_evidence(
        &mut self,
        intent: &MessageIntent,
        baseline: &[String],
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        self.delivery_evidence_from_native(intent, baseline)
    }

    fn delivery_evidence_with_baseline(
        &mut self,
        intent: &MessageIntent,
        baseline: Option<&NativeBaselineSnapshot>,
    ) -> Result<DeliveryEvidenceRecord, AppServerError> {
        let baseline_for_intent = self.baseline_for_evidence(&intent.intent_id, baseline)?;
        let snapshot = self.snapshot_items(intent.target.namespace, &intent.target.thread_id)?;
        if snapshot.state == NativeBaselineState::Unavailable {
            return Err(AppServerError::DeliveryUnresolved(
                snapshot
                    .reason
                    .unwrap_or_else(|| "native history is unavailable".to_string()),
            ));
        }
        correlate_delivery_evidence(&intent.intent_id, &baseline_for_intent, &snapshot.items)
    }
}

fn is_queued_submission_already_dispatched(
    error: &AppServerError,
    queued_submission_id: &str,
) -> bool {
    match error {
        AppServerError::Transport(message) => message.ends_with(&format!(
            "queued submission not found: {queued_submission_id}\"}}"
        )),
        _ => false,
    }
}

fn snapshot_from_timeline_page(
    result: &serde_json::Value,
) -> Result<NativeBaselineSnapshot, AppServerError> {
    let data = result
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            AppServerError::Transport("thread/timeline/list returned no data array".to_string())
        })?;
    let items = data
        .iter()
        .filter(|entry| entry.get("type").and_then(serde_json::Value::as_str) == Some("item"))
        .map(NativeThreadItem::from_entry)
        .collect();
    Ok(NativeBaselineSnapshot {
        state: NativeBaselineState::Read,
        items,
        reason: None,
    })
}

pub fn correlate_delivery_evidence(
    intent_id: &str,
    baseline: &[String],
    items: &[NativeThreadItem],
) -> Result<DeliveryEvidenceRecord, AppServerError> {
    let baseline_set = baseline.iter().collect::<std::collections::HashSet<_>>();
    let receipt = items.iter().find(|item| {
        item.is_receipt_for(intent_id)
            && item
                .id
                .as_ref()
                .is_some_and(|id| !baseline_set.contains(id))
    });
    let reply = receipt.and_then(|receipt| {
        items.iter().find(|item| {
            item.is_reply()
                && item
                    .id
                    .as_ref()
                    .is_some_and(|id| !baseline_set.contains(id))
                && match (receipt.turn_id.as_deref(), item.turn_id.as_deref()) {
                    (Some(receipt_turn), Some(item_turn)) => receipt_turn == item_turn,
                    _ => true,
                }
        })
    });
    let Some(receipt) = receipt else {
        return Err(AppServerError::DeliveryUnresolved(format!(
            "no native receipt found for {intent_id}"
        )));
    };
    let message_id = receipt.id.clone().unwrap_or_else(|| intent_id.to_string());
    let state = match reply {
        Some(_) => DeliveryState::Replied,
        None => DeliveryState::Delivered,
    };
    Ok(DeliveryEvidenceRecord {
        intent_id: intent_id.to_string(),
        message_id,
        state,
        cursor: None,
        read_item_id: None,
        start_error: None,
    })
}

struct UnixWsJsonRpc {
    stream: UnixStream,
    next_id: u64,
}

impl UnixWsJsonRpc {
    fn connect(socket_path: &Path) -> Result<Self, AppServerError> {
        let mut stream = UnixStream::connect(socket_path)
            .map_err(|error| AppServerError::SocketMissing(format!("{socket_path:?}: {error}")))?;
        stream
            .set_read_timeout(Some(NATIVE_TRANSPORT_TIMEOUT))
            .map_err(io_transport_error)?;
        stream
            .set_write_timeout(Some(NATIVE_TRANSPORT_TIMEOUT))
            .map_err(io_transport_error)?;
        upgrade_websocket(&mut stream)?;
        Ok(Self { stream, next_id: 1 })
    }

    fn call(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AppServerError> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({ "id": id, "method": method, "params": params });
        write_client_frame(
            &mut self.stream,
            0x1,
            &serde_json::to_vec(&payload).map_err(transport_error)?,
        )?;
        loop {
            let frame = read_server_frame(&mut self.stream)?;
            match frame.opcode {
                0x8 => {
                    return Err(AppServerError::Transport(
                        "app server closed websocket".to_string(),
                    ))
                }
                0x9 => {
                    write_client_frame(&mut self.stream, 0xa, &frame.payload)?;
                    continue;
                }
                0x1 => {
                    let value: serde_json::Value = serde_json::from_slice(&frame.payload)
                        .map_err(|error| AppServerError::Transport(error.to_string()))?;
                    if value["id"] != json!(id) {
                        continue;
                    }
                    if let Some(error) = value.get("error") {
                        return Err(AppServerError::Transport(format!(
                            "app server RPC {method} failed: {error}"
                        )));
                    }
                    return Ok(value["result"].clone());
                }
                _ => continue,
            }
        }
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), AppServerError> {
        let payload = json!({ "method": method, "params": params });
        write_client_frame(
            &mut self.stream,
            0x1,
            &serde_json::to_vec(&payload).map_err(transport_error)?,
        )?;
        Ok(())
    }
}

fn upgrade_websocket(stream: &mut UnixStream) -> Result<(), AppServerError> {
    let request = concat!(
        "GET / HTTP/1.1\r\n",
        "Host: localhost\r\n",
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        "Sec-WebSocket-Version: 13\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(io_transport_error)?;
    stream.flush().map_err(io_transport_error)?;
    // Read the HTTP upgrade response directly from the byte stream. A
    // `BufReader` here can over-read past the terminating blank line and buffer
    // the first WebSocket frame when the server coalesces the 101 response and
    // the first frame into one write; dropping that reader would discard the
    // buffered frame and corrupt the first JSON-RPC reply. Reading one byte at
    // a time leaves every post-handshake byte on the socket for the frame
    // decoder.
    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        let read = stream.read(&mut byte).map_err(io_transport_error)?;
        if read == 0 {
            return Err(AppServerError::Transport(
                "app server websocket handshake ended early".to_string(),
            ));
        }
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") || response.ends_with(b"\n\n") {
            break;
        }
    }
    let response = String::from_utf8_lossy(&response);
    if !response.starts_with("HTTP/1.1 101 ") && !response.starts_with("HTTP/1.0 101 ") {
        return Err(AppServerError::Transport(format!(
            "app server websocket upgrade rejected: {response}"
        )));
    }
    Ok(())
}

fn write_client_frame(
    stream: &mut UnixStream,
    opcode: u8,
    payload: &[u8],
) -> Result<(), AppServerError> {
    let mask = [0x11, 0x22, 0x33, 0x44];
    let mut masked = payload.to_vec();
    for (index, byte) in masked.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    let mut header = vec![0x80 | opcode];
    let len = payload.len();
    if len < 126 {
        header.push(0x80 | len as u8);
    } else if len < 65_536 {
        header.push(0x80 | 126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(0x80 | 127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    header.extend_from_slice(&mask);
    stream.write_all(&header).map_err(io_transport_error)?;
    stream.write_all(&masked).map_err(io_transport_error)?;
    stream.flush().map_err(io_transport_error)
}

#[cfg(test)]
fn write_server_control(
    stream: &mut UnixStream,
    opcode: u8,
    payload: &[u8],
) -> Result<(), AppServerError> {
    let mut header = vec![0x80 | opcode];
    let len = payload.len();
    if len < 126 {
        header.push(len as u8);
    } else if len < 65_536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header).map_err(io_transport_error)?;
    stream.write_all(payload).map_err(io_transport_error)?;
    stream.flush().map_err(io_transport_error)
}

#[derive(Debug)]
struct Frame {
    opcode: u8,
    payload: Vec<u8>,
}

fn read_server_frame(stream: &mut UnixStream) -> Result<Frame, AppServerError> {
    let mut first = [0_u8; 2];
    stream.read_exact(&mut first).map_err(io_transport_error)?;
    let opcode = first[0] & 0x0f;
    let masked = first[1] & 0x80 != 0;
    let mut len = (first[1] & 0x7f) as usize;
    if len == 126 {
        let mut extended = [0_u8; 2];
        stream
            .read_exact(&mut extended)
            .map_err(io_transport_error)?;
        len = u16::from_be_bytes(extended) as usize;
    } else if len == 127 {
        let mut extended = [0_u8; 8];
        stream
            .read_exact(&mut extended)
            .map_err(io_transport_error)?;
        let advertised = u64::from_be_bytes(extended);
        if advertised > NATIVE_MAX_FRAME_PAYLOAD as u64 {
            return Err(AppServerError::Transport(format!(
                "native frame payload {advertised} exceeds the {} byte native frame limit",
                NATIVE_MAX_FRAME_PAYLOAD
            )));
        }
        len = advertised as usize;
    }
    if len > NATIVE_MAX_FRAME_PAYLOAD {
        return Err(AppServerError::Transport(format!(
            "native frame payload {len} exceeds the {} byte native frame limit",
            NATIVE_MAX_FRAME_PAYLOAD
        )));
    }
    let mask = if masked {
        let mut key = [0_u8; 4];
        stream.read_exact(&mut key).map_err(io_transport_error)?;
        Some(key)
    } else {
        None
    };
    let mut payload = vec![0_u8; len];
    stream
        .read_exact(&mut payload)
        .map_err(io_transport_error)?;
    if let Some(key) = mask {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[index % 4];
        }
    }
    Ok(Frame { opcode, payload })
}

fn transport_error(error: impl std::fmt::Display) -> AppServerError {
    AppServerError::Transport(error.to_string())
}

fn io_transport_error(error: std::io::Error) -> AppServerError {
    match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            AppServerError::TransportTimeout(error.to_string())
        }
        _ => AppServerError::Transport(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_method_names_match_reference_adapter() {
        assert_eq!(NativeAppServerMethod::Initialize.as_str(), "initialize");
        assert_eq!(NativeAppServerMethod::ThreadRead.as_str(), "thread/read");
        assert_eq!(
            NativeAppServerMethod::ThreadQueueAdd.as_str(),
            "thread/queue/add"
        );
        assert_eq!(
            NativeAppServerMethod::ThreadLoadedList.as_str(),
            "thread/loaded/list"
        );
    }

    #[test]
    fn native_queue_add_keeps_control_identity_out_of_body() {
        let params = native_thread_queue_add_params("thread-1", "wake", "message-1");
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["clientUserMessageId"], "message-1");
        assert_eq!(params["input"][0]["text"], "wake");
    }

    #[test]
    fn timeline_page_extracts_canonical_items_and_turn_identity() {
        let snapshot = snapshot_from_timeline_page(&json!({
            "data": [
                { "type": "turnStarted", "turn_id": "turn-1", "position": 0 },
                {
                    "type": "item",
                    "turnId": "turn-1",
                    "position": 1,
                    "item": {
                        "id": "receipt-1",
                        "type": "userMessage",
                        "clientUserMessageId": "intent-1",
                        "text": "wake"
                    }
                },
                {
                    "type": "item",
                    "turnId": "turn-1",
                    "position": 2,
                    "item": {
                        "id": "reply-1",
                        "type": "agentMessage",
                        "text": "done"
                    }
                }
            ]
        }))
        .unwrap();
        assert_eq!(snapshot.state, NativeBaselineState::Read);
        assert_eq!(snapshot.items.len(), 2);
        assert!(snapshot.items[0].is_receipt_for("intent-1"));
        assert_eq!(snapshot.items[0].turn_id.as_deref(), Some("turn-1"));
        assert!(snapshot.items[1].is_reply());
        assert_eq!(snapshot.items[1].turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn unavailable_history_is_not_a_readable_baseline() {
        let snapshot = NativeBaselineSnapshot {
            state: NativeBaselineState::Unavailable,
            items: Vec::new(),
            reason: Some("timeline unavailable".to_string()),
        };
        assert_eq!(snapshot.item_ids(), Vec::<String>::new());
        assert_eq!(snapshot.state, NativeBaselineState::Unavailable);
    }

    #[test]
    fn session_state_normalization_maps_active_and_absent_to_known_states() {
        assert_eq!(
            normalize_session_state(&serde_json::json!("active")),
            SessionState::Working
        );
        assert_eq!(
            normalize_session_state(&serde_json::json!("idle")),
            SessionState::Idle
        );
        assert_eq!(
            normalize_session_state(&serde_json::Value::Null),
            SessionState::Unknown
        );
    }

    #[test]
    fn session_state_normalization_reads_nested_status_objects() {
        assert_eq!(
            normalize_session_state(&serde_json::json!({ "type": "idle" })),
            SessionState::Idle
        );
        assert_eq!(
            normalize_session_state(&serde_json::json!({ "state": "stopping" })),
            SessionState::Stopping
        );
    }

    #[test]
    fn empty_baseline_requires_idle_unmaterialized_native_read() {
        let idle = SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        };
        assert!(is_unmaterialized_history_read_error(
            "thread history read is unsupported: items=thread/items/list is not supported yet; \
             turns=thread thread-1 is not materialized yet; \
             thread/turns/list is unavailable before first user message",
            &idle
        ));
        assert!(!is_unmaterialized_history_read_error(
            "thread history read is unsupported: items=thread/items/list is not supported yet; \
             turns=thread/turns/list unsupported",
            &idle
        ));
        assert!(!is_unmaterialized_history_read_error(
            "thread history read is unsupported: thread thread-1 is not materialized yet",
            &SessionStatus {
                state: SessionState::Working,
                input_active: false,
            }
        ));
    }

    #[test]
    fn websocket_client_frames_encode_and_decode_over_unix_pair() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        write_client_frame(&mut client, 0x1, b"hello websocket").unwrap();
        let frame = read_server_frame(&mut server).unwrap();
        assert_eq!(frame.opcode, 0x1);
        assert_eq!(frame.payload, b"hello websocket");

        write_server_control(&mut server, 0x1, br#"{"id":1,"result":{"ok":true}}"#).unwrap();
        let reply = read_server_frame(&mut client).unwrap();
        assert_eq!(reply.payload, br#"{"id":1,"result":{"ok":true}}"#);
    }

    #[test]
    fn websocket_ping_gets_masked_pong() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        write_client_frame(&mut client, 0xa, b"heartbeat").unwrap();

        let mut header = [0_u8; 2];
        server.read_exact(&mut header).unwrap();
        assert_eq!(header[0] & 0x0f, 0xa);
        assert_ne!(header[1] & 0x80, 0, "client control frames must be masked");
        let mut mask = [0_u8; 4];
        server.read_exact(&mut mask).unwrap();
        let mut payload = [0_u8; 9];
        server.read_exact(&mut payload).unwrap();
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
        assert_eq!(&payload, b"heartbeat");
    }

    #[test]
    fn websocket_upgrade_preserves_first_frame_coalesced_with_handshake() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        // The server writes the 101 response and the first WebSocket frame in a
        // single write, which a buffered header reader would over-read and
        // discard. The frame must survive the handshake for the frame decoder.
        let mut coalesced = Vec::new();
        coalesced.extend_from_slice(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        {
            let mut frame = Vec::new();
            let payload = br#"{"id":1,"result":{"ok":true}}"#;
            frame.push(0x81);
            frame.push(payload.len() as u8);
            frame.extend_from_slice(payload);
            coalesced.extend_from_slice(&frame);
        }
        server.write_all(&coalesced).unwrap();
        server.flush().unwrap();

        upgrade_websocket(&mut client).expect("handshake with coalesced first frame");
        let frame = read_server_frame(&mut client).expect("first frame preserved");
        assert_eq!(frame.opcode, 0x1);
        assert_eq!(frame.payload, br#"{"id":1,"result":{"ok":true}}"#);
    }

    #[test]
    fn socket_timeout_is_typed_as_transport_timeout() {
        let error = io_transport_error(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "read timed out",
        ));
        assert_eq!(
            error,
            AppServerError::TransportTimeout("read timed out".to_string())
        );
    }

    #[test]
    fn oversized_advertised_native_frame_is_rejected_before_allocation() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        // 64-bit extended length far above the native limit.
        client.write_all(&[0x81, 0xff]).unwrap();
        client.write_all(&(u64::MAX).to_be_bytes()).unwrap();
        client.flush().unwrap();
        let error = read_server_frame(&mut server).expect_err("oversized frame must fail closed");
        match error {
            AppServerError::Transport(detail) => {
                assert!(detail.contains("exceeds"), "unexpected detail: {detail}");
                assert!(
                    detail.contains("native frame limit"),
                    "unexpected detail: {detail}"
                );
            }
            other => panic!("expected a typed transport error, got {other:?}"),
        }
    }

    #[test]
    fn in_limit_native_frame_is_accepted() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let payload = vec![b'a'; 300];
        write_client_frame(&mut client, 0x1, &payload).unwrap();
        let frame = read_server_frame(&mut server).expect("in-limit frame still decodes");
        assert_eq!(frame.payload, payload);
    }

    #[test]
    fn delivery_evidence_maps_receipt_and_reply_without_promoting_baseline_to_read() {
        let intent_id = "intent-1";
        let baseline = vec!["old-user".to_string(), "old-agent".to_string()];
        let items = vec![
            NativeThreadItem {
                id: Some("old-user".to_string()),
                kind: Some("userMessage".to_string()),
                client_user_message_id: Some("intent-0".to_string()),
                turn_id: Some("turn-0".to_string()),
                text: Some("old".to_string()),
            },
            NativeThreadItem {
                id: Some("receipt-1".to_string()),
                kind: Some("userMessage".to_string()),
                client_user_message_id: Some(intent_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                text: Some("probe".to_string()),
            },
            NativeThreadItem {
                id: Some("reply-1".to_string()),
                kind: Some("agentMessage".to_string()),
                client_user_message_id: None,
                turn_id: Some("turn-1".to_string()),
                text: Some("reply".to_string()),
            },
        ];
        let evidence = correlate_delivery_evidence(intent_id, &baseline, &items).unwrap();
        assert_eq!(evidence.state, DeliveryState::Replied);
        assert_eq!(evidence.message_id, "receipt-1");
        assert!(evidence.cursor.is_none());
        assert!(evidence.read_item_id.is_none());
    }

    #[test]
    fn delivery_evidence_does_not_promote_pagination_cursor_to_read() {
        let intent_id = "intent-page";
        let page = json!({
            "data": [
                {
                    "id": "receipt-page",
                    "type": "userMessage",
                    "clientUserMessageId": intent_id,
                    "turnId": "turn-page",
                    "text": "probe"
                },
                {
                    "id": "reply-page",
                    "type": "agentMessage",
                    "turnId": "turn-page",
                    "text": "reply"
                }
            ],
            "backwardsCursor": "cursor-page"
        });
        let snapshot = snapshot_from_history_page(&page, "thread/items/list").unwrap();
        let evidence = correlate_delivery_evidence(intent_id, &[], &snapshot.items).unwrap();
        assert_eq!(evidence.state, DeliveryState::Replied);
        assert!(evidence.cursor.is_none());
        assert!(evidence.read_item_id.is_none());
    }

    #[test]
    fn delivery_evidence_does_not_claim_read_without_reply() {
        let intent_id = "intent-no-reply";
        let baseline = vec![];
        let items = vec![NativeThreadItem {
            id: Some("receipt-no-reply".to_string()),
            kind: Some("userMessage".to_string()),
            client_user_message_id: Some(intent_id.to_string()),
            turn_id: Some("turn-no-reply".to_string()),
            text: Some("probe".to_string()),
        }];
        let evidence = correlate_delivery_evidence(intent_id, &baseline, &items).unwrap();
        assert_eq!(evidence.state, DeliveryState::Delivered);
        assert!(evidence.cursor.is_none());
        assert!(evidence.read_item_id.is_none());
    }

    #[test]
    fn delivery_evidence_keeps_receipt_only_as_delivered_not_reply() {
        let intent_id = "intent-2";
        let baseline = vec![];
        let items = vec![NativeThreadItem {
            id: Some("receipt-2".to_string()),
            kind: Some("userMessage".to_string()),
            client_user_message_id: Some(intent_id.to_string()),
            turn_id: Some("turn-2".to_string()),
            text: Some("probe".to_string()),
        }];
        let evidence = correlate_delivery_evidence(intent_id, &baseline, &items).unwrap();
        assert_eq!(evidence.state, DeliveryState::Delivered);
        assert!(evidence.cursor.is_none());
        assert!(evidence.read_item_id.is_none());
    }

    #[test]
    fn delivery_evidence_does_not_promote_tool_message_to_reply() {
        let intent_id = "intent-tool";
        let baseline = vec![];
        let items = vec![
            NativeThreadItem {
                id: Some("receipt-tool".to_string()),
                kind: Some("userMessage".to_string()),
                client_user_message_id: Some(intent_id.to_string()),
                turn_id: Some("turn-tool".to_string()),
                text: Some("probe".to_string()),
            },
            NativeThreadItem {
                id: Some("tool-1".to_string()),
                kind: Some("toolMessage".to_string()),
                client_user_message_id: None,
                turn_id: Some("turn-tool".to_string()),
                text: Some("tool output".to_string()),
            },
        ];
        let evidence = correlate_delivery_evidence(intent_id, &baseline, &items).unwrap();
        assert_eq!(
            evidence.state,
            DeliveryState::Delivered,
            "a tool message is execution evidence, not an assistant reply"
        );
    }

    #[test]
    fn delivery_evidence_fails_closed_without_native_receipt() {
        let intent_id = "intent-missing";
        let baseline = vec![];
        let items = vec![NativeThreadItem {
            id: Some("other".to_string()),
            kind: Some("userMessage".to_string()),
            client_user_message_id: Some("intent-other".to_string()),
            turn_id: Some("turn-other".to_string()),
            text: Some("other".to_string()),
        }];
        assert_eq!(
            correlate_delivery_evidence(intent_id, &baseline, &items)
                .unwrap_err()
                .to_string(),
            "delivery unresolved: no native receipt found for intent-missing"
        );
    }
}
