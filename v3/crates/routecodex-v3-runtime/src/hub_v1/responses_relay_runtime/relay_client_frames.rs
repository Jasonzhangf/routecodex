//! Relay client stream projection (P2).
//!
//! The Relay execution mode reduces a provider SSE attempt into a canonical
//! response and only then projects the client frames, so a Responses client sees
//! the whole answer at the provider terminal. This owner projects the client
//! frames as the provider events arrive, under the same commit contract as the
//! Direct path: nothing reaches the client before the first committable business
//! frame, that frame commits the attempt, and every later frame is append-only.
//!
//! Only carriers whose client projection cannot be rewritten by a later
//! whole-attempt owner are projected early: visible text increments, reasoning
//! summary increments, and the start of a named tool call. Tool arguments stay
//! gated until their item completes, and the terminal frame stays held until the
//! attempt seals.

use super::*;
use crate::direct_response_hooks::{
    V3DirectPrefixCommitProbe, V3GovernedTextMarker, V3GovernedTextScope,
};
use crate::hub_v1::V3HubProviderWireProtocol;
use crate::nodes::{
    V3AttemptBudget, V3CommittedClientFrameSink, V3CommittedClientSseBuilder,
    V3CommittedClientSseStream,
};
use crate::shared_direct_thinking_compat::{
    find_unprotected, incomplete_protected_text_start, protected_text_ranges, THINKING_CLOSE,
    THINKING_OPEN,
};

/// Request-level decision for early Relay projection.
///
/// Relay runs its response governance (Resp01/02/03 and Chat Process) on the
struct OpenReasoningItem {
    output_index: usize,
    item_id: String,
    source: ReasoningSource,
    /// One summary part per harvested block. Provider increments continue the
    /// last part, mirroring the whole-attempt owner.
    parts: Vec<String>,
    /// Number of `reasoning_summary_part.added` frames already emitted.
    announced: usize,
    /// The complete reasoning item fields the provider supplied. `summary` and
    /// `content` are rebuilt from the streamed plaintext; opaque business
    /// fields such as `encrypted_content` must be kept for the terminal ledger
    /// and the client's next-turn echo.
    payload: serde_json::Map<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReasoningSource {
    Think,
    Thinking,
    Provider,
}

struct OpenMessageItem {
    output_index: usize,
    item_id: String,
    text: String,
    /// A governed prefix can identify a message before the complete-attempt
    /// owner confirms that the round has any visible message text. Keep those
    /// bytes private until that decision so a stripped control marker cannot
    /// create an empty client item.
    announced: bool,
    /// Bytes of this item that have already crossed the client channel. A
    /// governed suffix is buffered until the complete-attempt owner decides it,
    /// so the terminal reconciliation must compare only this prefix.
    delivered_text: String,
}

struct OpenRefusalItem {
    output_index: usize,
    item_id: String,
    text: String,
}

struct OpenToolCallItem {
    wire_index: usize,
    output_index: usize,
    item_id: String,
    call_id: String,
    name: String,
    arguments: Option<String>,
    added_emitted: bool,
}

/// One announced business item, recorded so the terminal payload can repeat it
/// exactly as the client already received it.
#[derive(Debug, Clone)]
struct StreamedItem {
    output_index: usize,
    item_id: String,
    item: Value,
    /// Which owner produced this item. Reasoning blocks harvested from
    /// `<think>`/`<thinking>` must not be confused with provider reasoning that
    /// happens to carry the same plaintext.
    source: Option<ReasoningSource>,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThinkTagKind {
    ThinkOpen,
    ThinkClose,
    ThinkingOpen,
    ThinkingClose,
}

struct ThinkTag {
    position: usize,
    length: usize,
    kind: ThinkTagKind,
}

fn next_think_tag(text: &str) -> Option<ThinkTag> {
    let protected = protected_text_ranges(text);
    // A `<thinking>` marker inside an unclosed protected region cannot be
    // classified until the region closes; hold from its start instead.
    let stable_end = incomplete_protected_text_start(text).unwrap_or(text.len());
    let mut candidates = Vec::new();
    for (needle, kind) in [
        (THINK_OPEN, ThinkTagKind::ThinkOpen),
        (THINK_CLOSE, ThinkTagKind::ThinkClose),
    ] {
        if let Some(position) = text.find(needle) {
            if position < stable_end {
                candidates.push(ThinkTag {
                    position,
                    length: needle.len(),
                    kind,
                });
            }
        }
    }
    for (needle, kind) in [
        (THINKING_OPEN, ThinkTagKind::ThinkingOpen),
        (THINKING_CLOSE, ThinkTagKind::ThinkingClose),
    ] {
        if let Some(position) = find_unprotected(text, needle, 0, &protected) {
            if position < stable_end {
                candidates.push(ThinkTag {
                    position,
                    length: needle.len(),
                    kind,
                });
            }
        }
    }
    candidates.into_iter().min_by(|left, right| {
        left.position
            .cmp(&right.position)
            .then_with(|| right.length.cmp(&left.length))
    })
}

/// The whole-attempt Relay governance owner for tool-free Chat text.
///
/// Relay always runs `harvest_v3_think_text` on the completed payload and, on
/// the complete attempt, removes standalone DSML control labels through the
/// same `scan_tool_markup` grammar. The commit probe derives its marker set
/// from those two owners so a committed client prefix can never carry text
/// that a later whole-attempt rewrite would change.
fn relay_governed_text_markers() -> Vec<V3GovernedTextMarker> {
    let mut markers: Vec<V3GovernedTextMarker> = crate::tool_markup_parser::governed_text_markers()
        .into_iter()
        .map(|text| V3GovernedTextMarker {
            text,
            scope: V3GovernedTextScope::Line,
        })
        .collect();
    markers.push(V3GovernedTextMarker {
        text: THINK_OPEN,
        scope: V3GovernedTextScope::Inline,
    });
    markers.push(V3GovernedTextMarker {
        text: THINK_CLOSE,
        scope: V3GovernedTextScope::Inline,
    });
    markers
}

/// Longest suffix of `text` that is a proper prefix of a think marker. Holding
/// it keeps a marker split across provider frames from reaching the client.
fn held_marker_suffix_len(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut held = 0usize;
    for marker in [THINK_OPEN, THINK_CLOSE, THINKING_OPEN, THINKING_CLOSE] {
        let marker = marker.as_bytes();
        for len in 1..marker.len() {
            if bytes.len() >= len && bytes[bytes.len() - len..] == marker[..len] {
                held = held.max(len);
            }
        }
    }
    held
}

fn relay_function_call_item(call: &OpenToolCallItem, status: &str) -> Value {
    let mut item = json!({
        "id": call.item_id,
        "type": "function_call",
        "status": status,
        "call_id": call.call_id,
        "name": call.name,
    });
    if status != "in_progress" {
        if let Some(arguments) = &call.arguments {
            item.as_object_mut()
                .expect("relay function call item is an object")
                .insert("arguments".to_string(), Value::String(arguments.clone()));
        }
    }
    item
}

/// Shared handle for the request-scoped client stream projection.
///
/// The Relay refill loop runs one provider execution per round and replaces the
/// round's client body with the projection of the merged response once a refill
/// happened. A round that already committed its first business frames therefore
/// must keep them: the handle survives the rounds, each round continues the same
/// append-only frame sequence, and the refill owner seals the single tail over
/// the merged response.
pub(crate) type V3RelayClientProjectionHandle =
    std::sync::Arc<std::sync::Mutex<Option<V3RelayChatClientStreamProjector>>>;

/// Projects Chat-protocol provider increments into Responses client frames and
/// commits them at the first business frame.
pub struct V3RelayChatClientStreamProjector {
    sink: V3CommittedClientFrameSink,
    budget: V3AttemptBudget,
    builder: Option<V3CommittedClientSseBuilder>,
    /// Frames produced before the commit point. They stay droppable with the
    /// attempt until a business frame certifies it.
    pending: Vec<Vec<u8>>,
    committed: bool,
    started: bool,
    response_id: String,
    model: String,
    created_at: u64,
    next_output_index: usize,
    /// Every item this stream already announced, in output order. Once the
    /// client holds a business frame the delivered bytes cannot be rewritten,
    /// so the terminal response is rebuilt from these items instead of from the
    /// provider payload.
    streamed_items: Vec<StreamedItem>,
    reasoning: Option<OpenReasoningItem>,
    message: Option<OpenMessageItem>,
    refusal: Option<OpenRefusalItem>,
    tool_calls: Vec<OpenToolCallItem>,
    governance: V3DirectPrefixCommitProbe,
    post_commit_governed: bool,
    /// Item boundaries for the current refill round. The projector's ledger is
    /// request-wide for the final terminal, but governance decisions are
    /// round-local.
    round_streamed_item_start: usize,
    /// Chat Process harvests `<think>` and `<thinking>` blocks out of the
    /// visible content on the whole attempt. A committed stream cannot rewrite
    /// bytes it already sent, so the projector applies the same rule while the
    /// text arrives: the block never reaches the client as output text and
    /// becomes reasoning instead. Text that might be the head of a marker is
    /// held until it is decided.
    think_pending: String,
    think_open: Option<ReasoningSource>,
    /// Whether a `<thinking>` block was harvested for the current message item.
    /// The whole-attempt `<thinking>` owner only turns an unclosed tail into
    /// reasoning when no visible text and no prior `<thinking>` block exists.
    thinking_reasoning_seen: bool,
}

impl V3RelayChatClientStreamProjector {
    pub(crate) fn new(sink: V3CommittedClientFrameSink, budget: V3AttemptBudget) -> Self {
        Self {
            sink,
            budget,
            builder: None,
            pending: Vec::new(),
            committed: false,
            started: false,
            response_id: String::new(),
            model: String::new(),
            created_at: 0,
            next_output_index: 0,
            streamed_items: Vec::new(),
            reasoning: None,
            message: None,
            refusal: None,
            tool_calls: Vec::new(),
            governance: V3DirectPrefixCommitProbe::new_with_governed_markers(
                V3HubProviderWireProtocol::Responses,
                relay_governed_text_markers(),
            ),
            post_commit_governed: false,
            round_streamed_item_start: 0,
            think_pending: String::new(),
            think_open: None,
            thinking_reasoning_seen: false,
        }
    }

    pub(crate) fn is_committed(&self) -> bool {
        self.committed
    }

    fn push(&mut self, frame: Vec<u8>) -> Result<(), String> {
        if self.committed {
            let builder = self
                .builder
                .as_mut()
                .ok_or_else(|| "relay client stream lost its committed builder".to_string())?;
            return builder.push(frame).map_err(|error| error.to_string());
        }
        self.pending.push(frame);
        Ok(())
    }

    fn mark_post_commit_governed_if_needed(&mut self) {
        if self.committed && self.governance.governed_text_pending() {
            self.post_commit_governed = true;
            if let Some(builder) = self.builder.as_mut() {
                builder.hold_client_flush();
            }
        }
    }

    /// Commit once a business carrier exists. The certification matches the
    /// Direct predicate: visible output text or a named tool-call start.
    fn try_commit(&mut self) -> Result<(), String> {
        if self.committed {
            return Ok(());
        }
        if !self.governance.is_committable() {
            return Ok(());
        }
        let mut builder = V3CommittedClientSseBuilder::with_budget(self.budget.clone())
            .map_err(|error| error.to_string())?;
        for frame in std::mem::take(&mut self.pending) {
            builder.push(frame).map_err(|error| error.to_string())?;
        }
        builder.commit_client_stream(self.sink.clone());
        self.builder = Some(builder);
        self.committed = true;
        Ok(())
    }

    fn observe_text(&mut self, output_index: usize, text: &str) {
        self.governance.observe_event(&json!({
            "type": "response.output_text.delta",
            "output_index": output_index,
            "content_index": 0,
            "delta": text,
        }));
    }

    fn observe_tool_start(&mut self, output_index: usize, item: &Value) {
        self.governance.observe_event(&json!({
            "type": "response.output_item.added",
            "output_index": output_index,
            "item": item,
        }));
    }

    fn observe_item_done(&mut self, output_index: usize, item: &Value) {
        self.governance.observe_event(&json!({
            "type": "response.output_item.done",
            "output_index": output_index,
            "item": item,
        }));
    }

    fn reasoning_payload_from_delta(delta: &Value) -> Option<Value> {
        let delta = delta.as_object()?;
        if !delta.contains_key("reasoning_content")
            && !delta.contains_key("reasoning_text")
            && !delta.contains_key("reasoning")
        {
            return None;
        }
        let mut item = super::build_v3_responses_reasoning_item_from_openai_chat_message(delta)
            .unwrap_or_else(|| json!({"type": "reasoning"}));
        if let Some(reasoning) = delta.get("reasoning") {
            Self::merge_reasoning_payload(
                item.as_object_mut()
                    .expect("relay reasoning item is an object"),
                reasoning,
            );
        }
        Some(item)
    }

    fn reasoning_summary_parts(item: &Value) -> Vec<String> {
        item.get("summary")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn merge_reasoning_payload(target: &mut serde_json::Map<String, Value>, incoming: &Value) {
        let Some(incoming) = incoming.as_object() else {
            return;
        };
        for (key, value) in incoming {
            if matches!(key.as_str(), "id" | "type" | "summary" | "content") {
                continue;
            }
            target.insert(key.clone(), value.clone());
        }
    }

    fn finished_reasoning_item(
        item_id: String,
        parts: Vec<String>,
        mut payload: serde_json::Map<String, Value>,
    ) -> Value {
        payload.remove("id");
        payload.insert("type".to_string(), Value::String("reasoning".to_string()));
        payload.insert("id".to_string(), Value::String(item_id));
        let parts: Vec<&str> = parts
            .iter()
            .map(String::as_str)
            .filter(|text| !text.is_empty())
            .collect();
        if !parts.is_empty() {
            let summary = parts
                .iter()
                .map(|text| json!({"type": "summary_text", "text": text}))
                .collect();
            let content = parts
                .iter()
                .map(|text| json!({"type": "reasoning_text", "text": text}))
                .collect();
            payload.insert("summary".to_string(), Value::Array(summary));
            payload.insert("content".to_string(), Value::Array(content));
        }
        Value::Object(payload)
    }

    fn reasoning_item_has_business_payload(item: &Value) -> bool {
        let has_parts = |key: &str| {
            item.get(key)
                .and_then(Value::as_array)
                .is_some_and(|parts| !parts.is_empty())
        };
        has_parts("summary")
            || has_parts("content")
            || item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .is_some_and(|cipher| !cipher.is_empty())
            || item.as_object().is_some_and(|object| {
                object.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "id" | "type" | "status" | "summary" | "content"
                    )
                })
            })
    }

    fn merge_terminal_reasoning_fields(streamed: &mut Value, terminal: &Value) {
        let Some(streamed) = streamed.as_object_mut() else {
            return;
        };
        let Some(terminal) = terminal.as_object() else {
            return;
        };
        for (key, value) in terminal {
            if matches!(key.as_str(), "id" | "type" | "summary" | "content" | "text") {
                continue;
            }
            streamed.insert(key.clone(), value.clone());
        }
    }

    fn post_commit_governed_consistent_with_terminal(&self, terminal_items: &[Value]) -> bool {
        if !self.post_commit_governed {
            return true;
        }
        let round_start = self
            .round_streamed_item_start
            .min(self.streamed_items.len());
        self.streamed_items[round_start..].iter().all(|streamed| {
            let kind = streamed.item.get("type").and_then(Value::as_str);
            match kind {
                Some("message" | "function_call" | "custom_tool_call" | "mcp_call") => {
                    terminal_items.iter().any(|terminal| {
                        Self::streamed_item_matches_terminal_item(streamed, terminal)
                    })
                }
                _ => true,
            }
        })
    }

    fn push_response_prefix_frames(&mut self) -> Result<(), String> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        let response = json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "model": self.model,
            "status": "in_progress",
            "output": [],
            "usage": Value::Null,
            "incomplete_details": Value::Null,
        });
        for event in ["response.created", "response.in_progress"] {
            self.push(super::build_v3_runtime_sse_json_frame(
                event,
                &json!({"type": event, "response": response}),
            ))?;
        }
        Ok(())
    }

    /// One post-governance Chat chunk. Only increments that the client can never
    /// have to retract are projected here.
    pub(crate) fn on_chat_chunk(&mut self, chunk: &Value) -> Result<(), String> {
        if !self.started {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                self.response_id = id.to_string();
            }
            if let Some(model) = chunk.get("model").and_then(Value::as_str) {
                self.model = model.to_string();
            }
            if let Some(created) = chunk.get("created").and_then(Value::as_u64) {
                self.created_at = created;
            }
            self.push_response_prefix_frames()?;
        }
        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return Ok(());
        };
        for choice in choices {
            let Some(delta) = choice.get("delta") else {
                continue;
            };
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.append_text(text)?;
            }
            if let Some(reasoning) = Self::reasoning_payload_from_delta(delta) {
                self.append_reasoning_payload(&reasoning)?;
            }
            if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
                self.append_refusal(refusal)?;
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.append_tool_call(call)?;
                }
            }
        }
        self.try_commit()
    }

    /// Split provider content into visible text and harvested reasoning, the way
    /// Chat Process does on the whole attempt. The client never sees a `think`
    /// block as output text, and a marker that is still partial is held.
    fn append_text(&mut self, text: &str) -> Result<(), String> {
        self.think_pending.push_str(text);
        loop {
            // The whole-attempt `<thinking>` owner returns opaque invocation
            // text unchanged, so no block should be harvested inside one.
            if self.think_open.is_none()
                && crate::tool_markup_parser::scan_tool_markup(
                    &self.think_pending,
                    &crate::tool_markup_parser::ToolMarkupDeclarations::default(),
                )
                .opaque_invocation
            {
                let pending = std::mem::take(&mut self.think_pending);
                self.append_visible_text(&pending)?;
                return Ok(());
            }
            if let Some(source) = self.think_open {
                let position = match source {
                    ReasoningSource::Think => self.think_pending.find(THINK_CLOSE),
                    ReasoningSource::Thinking => {
                        let protected = protected_text_ranges(&self.think_pending);
                        find_unprotected(&self.think_pending, THINKING_CLOSE, 0, &protected)
                    }
                    ReasoningSource::Provider => {
                        return Err(
                            "relay think scanner opened a provider reasoning block".to_string()
                        )
                    }
                };
                let close_len = if source == ReasoningSource::Thinking {
                    THINKING_CLOSE.len()
                } else {
                    THINK_CLOSE.len()
                };
                let Some(position) = position else {
                    return Ok(());
                };
                let block = self.think_pending[..position].to_string();
                self.think_pending = self.think_pending[position + close_len..].to_string();
                self.think_open = None;
                self.append_reasoning_block(block.trim(), source)?;
                continue;
            }
            let incomplete = incomplete_protected_text_start(&self.think_pending);
            let stable_end = incomplete.unwrap_or(self.think_pending.len());
            match next_think_tag(&self.think_pending) {
                Some(tag) if tag.position < stable_end => {
                    let visible = self.think_pending[..tag.position].to_string();
                    self.think_pending =
                        self.think_pending[tag.position + tag.length..].to_string();
                    self.append_visible_text(&visible)?;
                    match tag.kind {
                        ThinkTagKind::ThinkOpen => self.think_open = Some(ReasoningSource::Think),
                        ThinkTagKind::ThinkingOpen => {
                            self.think_open = Some(ReasoningSource::Thinking)
                        }
                        ThinkTagKind::ThinkClose | ThinkTagKind::ThinkingClose => {}
                    }
                }
                _ => {
                    let mut release = stable_end;
                    if release == self.think_pending.len() {
                        release =
                            release.saturating_sub(held_marker_suffix_len(&self.think_pending));
                    }
                    let visible = self.think_pending[..release].to_string();
                    self.think_pending = self.think_pending[release..].to_string();
                    self.append_visible_text(&visible)?;
                    return Ok(());
                }
            }
        }
    }

    /// Release whatever the think scanner still holds: an unclosed block keeps
    /// its content as raw visible text, exactly like the whole-attempt harvest,
    /// and a held partial marker is ordinary text once the stream ended. The
    /// `<thinking>` owner makes one exception: a bare unclosed block with no
    /// visible text and no reasoning before it becomes reasoning when the
    /// attempt has no complete tools. Mirror it here.
    fn flush_think_pending(&mut self) -> Result<(), String> {
        let pending = std::mem::take(&mut self.think_pending);
        let source = self.think_open.take();
        match source {
            Some(ReasoningSource::Thinking) => {
                if self
                    .message
                    .as_ref()
                    .is_none_or(|message| message.text.is_empty())
                    && !self.thinking_reasoning_seen
                    && self.tool_calls.is_empty()
                {
                    let block = pending.trim();
                    if !block.is_empty() {
                        return self.append_reasoning_block(block, ReasoningSource::Thinking);
                    }
                    return Ok(());
                }
                self.append_visible_text(&pending)
            }
            _ => self.append_visible_text(&pending),
        }
    }

    fn append_visible_text(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        // Provider-native reasoning increments are separate business carriers;
        // visible text between them closes the current one. The terminal
        // reconciliation later consumes several delivered reasoning segments
        // against one complete terminal reasoning item when the whole-attempt
        // reducer joined them.
        if self
            .reasoning
            .as_ref()
            .is_some_and(|reasoning| reasoning.source == ReasoningSource::Provider)
        {
            self.close_reasoning()?;
        }
        if self.message.is_none() {
            let output_index = self.next_output_index;
            self.next_output_index += 1;
            self.message = Some(OpenMessageItem {
                output_index,
                item_id: format!("msg_{output_index}"),
                text: String::new(),
                announced: false,
                delivered_text: String::new(),
            });
        }
        let output_index = self
            .message
            .as_ref()
            .map(|message| message.output_index)
            .ok_or_else(|| "relay client stream lost its message item".to_string())?;
        self.observe_text(output_index, text);
        self.mark_post_commit_governed_if_needed();
        let message = self
            .message
            .as_mut()
            .ok_or_else(|| "relay client stream lost its message item".to_string())?;
        message.text.push_str(text);
        // Once a governed marker is pending after the commit point, the tail
        // stays buffered until the complete-attempt owner decides it. The raw
        // bytes are not pushed now; the round closeout or `finish` emits the
        // governed suffix from the finalized response instead.
        if self.post_commit_governed {
            return Ok(());
        }
        if !crate::hub_v1::v3_text_has_visible_content(&message.text) {
            return Ok(());
        }
        let was_announced = message.announced;
        let buffered_text = message.text.clone();
        self.ensure_message_announced()?;
        let delta = if was_announced {
            text.to_string()
        } else {
            buffered_text
        };
        let message = self
            .message
            .as_mut()
            .ok_or_else(|| "relay client stream lost its message item".to_string())?;
        message.delivered_text.push_str(&delta);
        let output_index = message.output_index;
        let item_id = message.item_id.clone();
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_text.delta",
            &json!({
                "type": "response.output_text.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "delta": delta,
            }),
        ))
    }

    fn ensure_message_announced(&mut self) -> Result<(), String> {
        let Some(message) = self.message.as_mut() else {
            return Ok(());
        };
        if message.announced {
            return Ok(());
        }
        let output_index = message.output_index;
        let item_id = message.item_id.clone();
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_item.added",
            &json!({
                "type": "response.output_item.added",
                "response_id": self.response_id,
                "output_index": output_index,
                "item": {
                    "id": item_id,
                    "type": "message",
                    "status": "in_progress",
                    "role": "assistant",
                    "content": [],
                },
            }),
        ))?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.content_part.added",
            &json!({
                "type": "response.content_part.added",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "part": {"type": "output_text", "text": ""},
            }),
        ))?;
        if let Some(message) = self.message.as_mut() {
            message.announced = true;
        }
        Ok(())
    }

    fn ensure_reasoning_open(&mut self, source: ReasoningSource) -> Result<(), String> {
        if let Some(reasoning) = &self.reasoning {
            if reasoning.source == source {
                return Ok(());
            }
            self.close_reasoning()?;
        }
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let item_id = format!("rs_{output_index}");
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_item.added",
            &json!({
                "type": "response.output_item.added",
                "response_id": self.response_id,
                "output_index": output_index,
                "item": {
                    "id": item_id,
                    "type": "reasoning",
                    "summary": [],
                    "content": [],
                },
            }),
        ))?;
        self.reasoning = Some(OpenReasoningItem {
            output_index,
            item_id,
            source,
            parts: Vec::new(),
            announced: 0,
            payload: serde_json::Map::new(),
        });
        Ok(())
    }

    fn push_reasoning_part_added(
        &mut self,
        output_index: usize,
        item_id: &str,
        summary_index: usize,
    ) -> Result<(), String> {
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.reasoning_summary_part.added",
            &json!({
                "type": "response.reasoning_summary_part.added",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "summary_index": summary_index,
                "part": {"type": "summary_text", "text": ""},
            }),
        ))
    }

    /// One harvested `<think>` or `<thinking>` block. Each block is its own
    /// summary part, matching the Resp03 owner (`v3_resp03_reasoning_item`).
    fn append_reasoning_block(
        &mut self,
        text: &str,
        source: ReasoningSource,
    ) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        if source == ReasoningSource::Thinking {
            self.thinking_reasoning_seen = true;
        }
        self.ensure_reasoning_open(source)?;
        let reasoning = self
            .reasoning
            .as_mut()
            .ok_or_else(|| "relay client stream lost its reasoning item".to_string())?;
        let summary_index = reasoning.parts.len();
        reasoning.parts.push(text.to_string());
        reasoning.announced = reasoning.announced.max(summary_index + 1);
        let output_index = reasoning.output_index;
        let item_id = reasoning.item_id.clone();
        self.push_reasoning_part_added(output_index, &item_id, summary_index)?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.reasoning_summary_text.delta",
            &json!({
                "type": "response.reasoning_summary_text.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "summary_index": summary_index,
                "delta": text,
            }),
        ))
    }

    /// Provider-supplied reasoning increments continue one accumulated summary
    /// part, the same carrier the provider streamed.
    fn append_provider_reasoning_text(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        self.ensure_reasoning_open(ReasoningSource::Provider)?;
        let (summary_index, announced) = {
            let reasoning = self
                .reasoning
                .as_mut()
                .ok_or_else(|| "relay client stream lost its reasoning item".to_string())?;
            let summary_index = if reasoning.parts.is_empty() {
                reasoning.parts.push(String::new());
                0
            } else {
                reasoning.parts.len() - 1
            };
            let announced = reasoning.announced;
            reasoning.announced = reasoning.announced.max(summary_index + 1);
            (summary_index, announced)
        };
        if summary_index >= announced {
            let (output_index, item_id) = {
                let reasoning = self
                    .reasoning
                    .as_ref()
                    .ok_or_else(|| "relay client stream lost its reasoning item".to_string())?;
                (reasoning.output_index, reasoning.item_id.clone())
            };
            self.push_reasoning_part_added(output_index, &item_id, summary_index)?;
        }
        let (output_index, item_id) = {
            let reasoning = self
                .reasoning
                .as_mut()
                .ok_or_else(|| "relay client stream lost its reasoning item".to_string())?;
            reasoning.parts[summary_index].push_str(text);
            (reasoning.output_index, reasoning.item_id.clone())
        };
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.reasoning_summary_text.delta",
            &json!({
                "type": "response.reasoning_summary_text.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "summary_index": summary_index,
                "delta": text,
            }),
        ))
    }

    /// Project one provider reasoning increment. The client carrier is built
    /// from the streamed plaintext, but any opaque business field the provider
    /// attached (notably `encrypted_content`) must survive into the item done
    /// event and the terminal ledger so the client can echo the item next turn.
    fn append_reasoning_payload(&mut self, item: &Value) -> Result<(), String> {
        if !Self::reasoning_item_has_business_payload(item) {
            return Ok(());
        }
        self.ensure_reasoning_open(ReasoningSource::Provider)?;
        if let Some(reasoning) = self.reasoning.as_mut() {
            Self::merge_reasoning_payload(&mut reasoning.payload, item);
        }
        let parts = Self::reasoning_summary_parts(item);
        if parts.is_empty() {
            return Ok(());
        }
        if parts.len() == 1 {
            // A single provider summary part is an increment: continue the
            // accumulated provider part, mirroring how the whole-attempt owner
            // concatenates streamed `reasoning_content`.
            return self.append_provider_reasoning_text(&parts[0]);
        }
        // A provider summary array carries explicit block boundaries. Keep one
        // summary part per entry instead of joining them into one part.
        for part in parts {
            self.append_reasoning_block(&part, ReasoningSource::Provider)?;
        }
        Ok(())
    }

    fn append_refusal(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        // A governed tail is still waiting for the complete-attempt owner to
        // decide its final text. Closing the message now would freeze the raw
        // governed marker into the ledger and strand the buffered tail, so the
        // refusal must open beside the pending message instead of sealing it.
        if !self.post_commit_governed {
            self.close_message()?;
        }
        self.close_reasoning()?;
        if self.refusal.is_none() {
            let output_index = self.next_output_index;
            self.next_output_index += 1;
            let item_id = format!("msg_{output_index}");
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.output_item.added",
                &json!({
                    "type": "response.output_item.added",
                    "response_id": self.response_id,
                    "output_index": output_index,
                    "item": {
                        "id": item_id,
                        "type": "message",
                        "status": "in_progress",
                        "role": "assistant",
                        "content": [],
                    },
                }),
            ))?;
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.content_part.added",
                &json!({
                    "type": "response.content_part.added",
                    "response_id": self.response_id,
                    "output_index": output_index,
                    "item_id": item_id,
                    "content_index": 0,
                    "part": {"type": "refusal", "refusal": ""},
                }),
            ))?;
            self.refusal = Some(OpenRefusalItem {
                output_index,
                item_id,
                text: String::new(),
            });
        }
        let refusal = self
            .refusal
            .as_mut()
            .ok_or_else(|| "relay client stream lost its refusal item".to_string())?;
        refusal.text.push_str(text);
        let output_index = refusal.output_index;
        let item_id = refusal.item_id.clone();
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.refusal.delta",
            &json!({
                "type": "response.refusal.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "delta": text,
            }),
        ))
    }

    fn append_tool_call(&mut self, call: &Value) -> Result<(), String> {
        if !self.post_commit_governed {
            self.close_message()?;
        }
        self.close_reasoning()?;
        self.close_refusal()?;
        let wire_index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let position = self
            .tool_calls
            .iter()
            .position(|entry| entry.wire_index == wire_index);
        let position = match position {
            Some(position) => position,
            None => {
                let output_index = self.next_output_index;
                self.next_output_index += 1;
                self.tool_calls.push(OpenToolCallItem {
                    wire_index,
                    output_index,
                    item_id: String::new(),
                    call_id: String::new(),
                    name: String::new(),
                    arguments: None,
                    added_emitted: false,
                });
                self.tool_calls.len() - 1
            }
        };
        let call_entry = &mut self.tool_calls[position];
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            let id = id.trim();
            if !id.is_empty() {
                call_entry.call_id = id.to_string();
            }
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
            {
                call_entry.name = name.to_string();
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                call_entry
                    .arguments
                    .get_or_insert_with(String::new)
                    .push_str(arguments);
            }
        }
        if call_entry.added_emitted || call_entry.name.is_empty() {
            return Ok(());
        }
        // A named tool call is a business carrier: emit its start now and keep
        // the arguments gated until the item completes.
        call_entry.added_emitted = true;
        call_entry.item_id = if call_entry.call_id.is_empty() {
            format!("fc_{}", call_entry.output_index)
        } else {
            call_entry.call_id.clone()
        };
        let start_item = relay_function_call_item(call_entry, "in_progress");
        let output_index = call_entry.output_index;
        let response_id = self.response_id.clone();
        let frame_item = start_item.clone();
        let frame = super::build_v3_runtime_sse_json_frame(
            "response.output_item.added",
            &json!({
                "type": "response.output_item.added",
                "response_id": response_id,
                "output_index": output_index,
                "item": frame_item,
            }),
        );
        self.observe_tool_start(output_index, &start_item);
        self.mark_post_commit_governed_if_needed();
        self.push(frame)
    }

    /// Record one announced item at its output index. The terminal frame
    /// rebuilds its `output` array from this record, so a late governance rewrite
    /// can never contradict bytes the client already holds.
    fn record_streamed_item(
        &mut self,
        output_index: usize,
        item_id: &str,
        item: Value,
        source: Option<ReasoningSource>,
    ) {
        self.streamed_items.push(StreamedItem {
            output_index,
            item_id: item_id.to_string(),
            item,
            source,
        });
    }

    fn close_reasoning(&mut self) -> Result<(), String> {
        let Some(reasoning) = self.reasoning.take() else {
            return Ok(());
        };
        let output_index = reasoning.output_index;
        let item_id = reasoning.item_id;
        let source = reasoning.source;
        let parts = reasoning.parts;
        let item = Self::finished_reasoning_item(item_id.clone(), parts.clone(), reasoning.payload);
        self.record_streamed_item(output_index, &item_id, item.clone(), Some(source));
        for (summary_index, text) in parts.iter().enumerate() {
            if text.is_empty() {
                continue;
            }
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.reasoning_summary_text.done",
                &json!({
                    "type": "response.reasoning_summary_text.done",
                    "response_id": self.response_id,
                    "output_index": output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "text": text,
                }),
            ))?;
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.reasoning_summary_part.done",
                &json!({
                    "type": "response.reasoning_summary_part.done",
                    "response_id": self.response_id,
                    "output_index": output_index,
                    "item_id": item_id,
                    "summary_index": summary_index,
                    "part": {"type": "summary_text", "text": text},
                }),
            ))?;
        }
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_item.done",
            &json!({
                "type": "response.output_item.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item": item,
            }),
        ))
    }

    fn close_message(&mut self) -> Result<(), String> {
        let Some(message) = self.message.take() else {
            return Ok(());
        };
        if !message.announced {
            return Ok(());
        }
        let output_index = message.output_index;
        let item_id = message.item_id;
        let text = message.text;
        self.record_streamed_item(
            output_index,
            &item_id,
            json!({
                "id": item_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }),
            None,
        );
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_text.done",
            &json!({
                "type": "response.output_text.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "text": text,
            }),
        ))?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.content_part.done",
            &json!({
                "type": "response.content_part.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "part": {"type": "output_text", "text": text},
            }),
        ))?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_item.done",
            &json!({
                "type": "response.output_item.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item": {
                    "id": item_id,
                    "type": "message",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                },
            }),
        ))
    }

    fn close_refusal(&mut self) -> Result<(), String> {
        let Some(refusal) = self.refusal.take() else {
            return Ok(());
        };
        let output_index = refusal.output_index;
        let item_id = refusal.item_id;
        let text = refusal.text;
        let item = json!({
            "id": item_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "refusal", "refusal": text}],
        });
        self.record_streamed_item(output_index, &item_id, item.clone(), None);
        self.observe_item_done(output_index, &item);
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.refusal.done",
            &json!({
                "type": "response.refusal.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "refusal": text,
            }),
        ))?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.content_part.done",
            &json!({
                "type": "response.content_part.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "part": {"type": "refusal", "refusal": text},
            }),
        ))?;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_item.done",
            &json!({
                "type": "response.output_item.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item": item,
            }),
        ))
    }

    fn close_tool_calls(&mut self) -> Result<(), String> {
        for call in std::mem::take(&mut self.tool_calls) {
            if !call.added_emitted {
                continue;
            }
            self.record_streamed_item(
                call.output_index,
                &call.item_id,
                relay_function_call_item(&call, "completed"),
                None,
            );
            let mut arguments_done = json!({
                "type": "response.function_call_arguments.done",
                "response_id": self.response_id,
                "output_index": call.output_index,
                "call_id": call.call_id,
            });
            if let Some(arguments) = &call.arguments {
                arguments_done
                    .as_object_mut()
                    .expect("relay function arguments event is an object")
                    .insert("arguments".to_string(), Value::String(arguments.clone()));
            }
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.function_call_arguments.done",
                &arguments_done,
            ))?;
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.output_item.done",
                &json!({
                    "type": "response.output_item.done",
                    "response_id": self.response_id,
                    "output_index": call.output_index,
                    "item": relay_function_call_item(&call, "completed"),
                }),
            ))?;
        }
        Ok(())
    }

    /// Close the open items at a refill round boundary.
    ///
    /// A refill is a separate provider response and the delivered payload keeps
    /// its items as separate entries. The client therefore receives one item per
    /// round; the next round opens new items at the next output indices. Each
    /// round ran its own complete governance, so the think scanner must release
    /// this round's unclosed block or partial marker before the boundary instead
    /// of carrying it into a different provider response.
    pub(crate) fn close_round(&mut self) -> Result<(), String> {
        self.close_round_with_finalized(None)
    }

    /// Close a refill round with the round's own finalized response.
    ///
    /// A committed round can hold a governed suffix until the complete-attempt
    /// owner decides it. At a refill boundary that round still needs the suffix
    /// before its items are recorded and sealed; otherwise the raw control text
    /// leaks into the finished item and the final round cannot reconcile it.
    pub(crate) fn close_round_with_finalized(
        &mut self,
        finalized: Option<&Value>,
    ) -> Result<(), String> {
        self.flush_think_pending()?;
        self.thinking_reasoning_seen = false;
        if let Some(finalized) = finalized {
            let terminal_items = finalized
                .get("output")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            self.release_governed_message_tail(&terminal_items)?;
        }
        self.close_reasoning()?;
        self.close_message()?;
        self.close_refusal()?;
        self.close_tool_calls()?;
        if let Some(finalized) = finalized {
            let terminal_items = finalized
                .get("output")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if self.post_commit_governed
                && self.governance.confirmed_governed_marker()
                && !self.post_commit_governed_consistent_with_terminal(terminal_items)
            {
                return Err(
                    "relay governed round tail could not be reconciled at the refill boundary"
                        .to_string(),
                );
            }
        }
        self.reset_governed_round_state();
        self.round_streamed_item_start = self.streamed_items.len();
        Ok(())
    }

    /// Reset the per-round governed state after a committed refill round closes.
    ///
    /// The governance probe and the held-tail flag describe one provider
    /// response. Once that round is reconciled and its items are sealed, the
    /// next refill must start a fresh probe and resume live per-event
    /// projection; otherwise a stale `post_commit_governed` keeps buffering
    /// every later round and lets the tail matcher scan an earlier round's
    /// message.
    fn reset_governed_round_state(&mut self) {
        self.post_commit_governed = false;
        self.governance = V3DirectPrefixCommitProbe::new_with_governed_markers(
            V3HubProviderWireProtocol::Responses,
            relay_governed_text_markers(),
        );
        if let Some(builder) = self.builder.as_mut() {
            builder.release_client_flush();
        }
    }

    /// Release a governed suffix the committed channel held back.
    ///
    /// Once `post_commit_governed` is set, `append_visible_text` keeps the tail
    /// in the open message without pushing it. The complete-attempt owner's
    /// finalized message is the source of truth: when it still starts with the
    /// already-delivered prefix, the remaining governed text is emitted as the
    /// missing deltas and the open message is sealed with that exact text.
    fn release_governed_message_tail(&mut self, terminal_items: &[Value]) -> Result<(), String> {
        if !self.post_commit_governed {
            return Ok(());
        }
        let Some(delivered_text) = self
            .message
            .as_ref()
            .map(|message| message.delivered_text.clone())
        else {
            return Ok(());
        };
        let Some(governed_text) = terminal_items
            .iter()
            .rev()
            .filter_map(Self::terminal_message_text)
            .find(|text| {
                crate::hub_v1::v3_text_has_visible_content(text)
                    && text.starts_with(&delivered_text)
            })
        else {
            return Ok(());
        };
        let Some(suffix) = governed_text.strip_prefix(&delivered_text) else {
            return Ok(());
        };
        let (output_index, item_id) = self
            .message
            .as_ref()
            .map(|message| (message.output_index, message.item_id.clone()))
            .ok_or_else(|| "relay client stream lost its message item".to_string())?;
        let was_announced = self
            .message
            .as_ref()
            .is_some_and(|message| message.announced);
        self.ensure_message_announced()?;
        if let Some(message) = self.message.as_mut() {
            message.text = governed_text.clone();
            message.delivered_text = governed_text.clone();
        }
        if suffix.is_empty() && was_announced {
            return Ok(());
        }
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.output_text.delta",
            &json!({
                "type": "response.output_text.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "content_index": 0,
                "delta": suffix,
            }),
        ))
    }

    fn output_text_from_items(items: &[Value]) -> String {
        let mut text = String::new();
        for item in items {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(part) = part.get("text").and_then(Value::as_str) {
                            text.push_str(part);
                        }
                    }
                }
            }
        }
        text
    }

    /// Visible output text of one terminal `message` item. A message without a
    /// `content` array or `output_text` part is still a message and therefore
    /// contributes an empty text, so a delivered empty prefix can reconcile.
    fn terminal_message_text(item: &Value) -> Option<String> {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            return None;
        }
        let mut text = String::new();
        if let Some(content) = item.get("content").and_then(Value::as_array) {
            for part in content {
                if part.get("type").and_then(Value::as_str) == Some("output_text") {
                    if let Some(part) = part.get("text").and_then(Value::as_str) {
                        text.push_str(part);
                    }
                }
            }
        }
        Some(text)
    }

    /// True when two output items represent the same delivered business item.
    /// The delivered copy already carries the exact bytes and identity the client
    /// holds, so identity and terminal labels are ignored; only the business
    /// carriers must match.
    /// Plaintext reasoning parts of one reasoning item. Prefer `summary`, then
    /// `content`, so a provider that only carried `content` still reconciles.
    fn reasoning_text_parts(item: &Value) -> Vec<String> {
        for key in ["summary", "content"] {
            let parts: Vec<String> = item
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect();
            if !parts.is_empty() {
                return parts;
            }
        }
        Vec::new()
    }

    /// Plaintext of one reasoning item with its parts joined without a
    /// separator. The whole-attempt owner concatenates a streamed
    /// `reasoning_content` carrier directly, so this matches delivered
    /// provider segments against the complete terminal reasoning text.
    fn reasoning_plaintext(item: &Value) -> String {
        Self::reasoning_text_parts(item).join("")
    }

    /// Indices of unconsumed provider reasoning segments whose joined plaintext
    /// equals one complete terminal reasoning text. Provider reasoning can be
    /// split across visible text, so one terminal reasoning item may correspond
    /// to several already-delivered items that must not be appended again.
    fn joined_reasoning_indices(
        ordered: &[&StreamedItem],
        consumed: &[bool],
        terminal_text: &str,
    ) -> Option<Vec<usize>> {
        if terminal_text.is_empty() {
            return None;
        }
        let mut running = String::new();
        let mut indices = Vec::new();
        for (index, streamed) in ordered.iter().enumerate() {
            if consumed[index] {
                continue;
            }
            if !matches!(streamed.source, Some(ReasoningSource::Provider)) {
                continue;
            }
            let part = Self::reasoning_plaintext(&streamed.item);
            if part.is_empty() {
                continue;
            }
            running.push_str(&part);
            indices.push(index);
            if running == terminal_text {
                return Some(indices);
            }
            if running.len() > terminal_text.len() {
                return None;
            }
        }
        None
    }

    /// True when two output items represent the same delivered business item.
    /// The delivered copy already carries the exact bytes and identity the client
    /// holds, so identity and terminal labels are ignored; only the business
    /// carriers must match.
    fn streamed_item_matches_terminal_item(streamed: &StreamedItem, terminal: &Value) -> bool {
        let streamed_type = streamed.item.get("type").and_then(Value::as_str);
        if streamed_type != terminal.get("type").and_then(Value::as_str) {
            return false;
        }
        match streamed_type {
            Some("message") => streamed.item.get("content") == terminal.get("content"),
            Some("function_call" | "custom_tool_call" | "mcp_call") => {
                streamed.item.get("call_id") == terminal.get("call_id")
                    && streamed.item.get("name") == terminal.get("name")
                    && streamed.item.get("arguments") == terminal.get("arguments")
            }
            Some("reasoning") => {
                if streamed.item.get("summary") == terminal.get("summary")
                    || streamed.item.get("content") == terminal.get("content")
                {
                    return true;
                }
                // A streamed part and a terminal part for the same block can
                // split or join differently. The concatenated plaintext is the
                // same business reasoning when the source family matches.
                let streamed_text = Self::reasoning_plaintext(&streamed.item);
                let terminal_text = Self::reasoning_plaintext(terminal);
                !streamed_text.is_empty()
                    && !terminal_text.is_empty()
                    && streamed_text == terminal_text
                    && streamed.source.is_some()
            }
            _ => &streamed.item == terminal,
        }
    }

    /// Reconcile the terminal `output` with the delivered ledger.
    ///
    /// Delivered items keep their exact bytes and ids. A terminal-only legal
    /// item is appended exactly once; a reasoning item the client never saw is
    /// kept when the complete-attempt owner returned a representable business
    /// payload for it, so the terminal never drops reasoning the provider
    /// delivered. The finalized governed response is the source for that
    /// terminal-only tail.
    fn terminal_output_items_reconciled(&self, terminal_response: &Value) -> Vec<Value> {
        let mut ordered: Vec<&StreamedItem> = self.streamed_items.iter().collect();
        ordered.sort_by_key(|entry| entry.output_index);
        let mut output: Vec<Value> = ordered
            .iter()
            .map(|entry| {
                let mut item = entry.item.clone();
                if let Some(object) = item.as_object_mut() {
                    object.insert("id".to_string(), Value::String(entry.item_id.clone()));
                }
                item
            })
            .collect();
        let mut consumed = vec![false; output.len()];
        let terminal_items = terminal_response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for terminal_item in terminal_items {
            let matched = ordered.iter().enumerate().find_map(|(index, streamed)| {
                (!consumed[index]
                    && Self::streamed_item_matches_terminal_item(streamed, &terminal_item))
                .then_some(index)
            });
            if let Some(index) = matched {
                consumed[index] = true;
                let streamed = &mut output[index];
                if streamed.get("type").and_then(Value::as_str) == Some("reasoning") {
                    Self::merge_terminal_reasoning_fields(streamed, &terminal_item);
                }
                continue;
            }
            if terminal_item.get("type").and_then(Value::as_str) == Some("reasoning") {
                if let Some(indices) = Self::joined_reasoning_indices(
                    &ordered,
                    &consumed,
                    &Self::reasoning_plaintext(&terminal_item),
                ) {
                    for index in indices.iter().copied() {
                        consumed[index] = true;
                    }
                    if let Some(first) = indices.first().copied() {
                        Self::merge_terminal_reasoning_fields(&mut output[first], &terminal_item);
                    }
                    continue;
                }
            }
            if terminal_item.get("type").and_then(Value::as_str) == Some("reasoning")
                && !Self::reasoning_item_has_business_payload(&terminal_item)
            {
                // A reasoning item with no business payload has no content the
                // client could hold or echo, so introducing it would only
                // describe an empty carrier.
                continue;
            }
            output.push(terminal_item);
        }
        output
    }

    /// Close every open item and seal the attempt. The terminal frame is held
    /// past the acceptance boundary, so a failed seal cannot deliver it first.
    ///
    /// `terminal` is the request-level merged response: its `output` starts with
    /// every prior refill round's business items, then this round's own items.
    /// A round that never committed drops its projector, so the projector
    /// cannot reconstruct that prefix by itself; the caller passes the
    /// request-level accumulated item count as `current_round_start`.
    pub(crate) fn finish(
        &mut self,
        terminal: &Value,
        current_round_start: usize,
    ) -> Result<V3CommittedClientSseStream, String> {
        self.flush_think_pending()?;
        let terminal_items = terminal
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let current_round_start = current_round_start.min(terminal_items.len());
        let current_round_items = &terminal_items[current_round_start..];
        self.release_governed_message_tail(current_round_items)?;
        self.close_reasoning()?;
        self.close_message()?;
        self.close_refusal()?;
        self.close_tool_calls()?;
        // The commit probe only knows that some governed marker appeared after
        // the channel committed; it does not know the complete-attempt owner's
        // protected ranges. A fenced or quoted marker is legal business text
        // the owner returns unchanged, so hold is not a failure by itself.
        // Terminate only when the items already carried by the projector cannot
        // be reconciled with the finalized governed response.
        if self.post_commit_governed
            && self.governance.confirmed_governed_marker()
            && !self.post_commit_governed_consistent_with_terminal(current_round_items)
        {
            return Err(
                "relay governed text arrived after the client channel was committed".to_string(),
            );
        }
        let mut builder = self
            .builder
            .take()
            .ok_or_else(|| "relay client stream did not commit".to_string())?;
        builder.hold_client_flush();
        let status = terminal.get("status").and_then(Value::as_str);
        let event = match status {
            Some("incomplete") => "response.incomplete",
            Some("in_progress") => "response.in_progress",
            _ => "response.completed",
        };
        let mut terminal_response = super::project_v3_responses_client_completed_response(terminal);
        // The client learned this response id from `response.created`. A refill
        // round carries a different provider id, so pin the streamed one.
        if !self.response_id.is_empty() {
            if let Some(object) = terminal_response.as_object_mut() {
                object.insert("id".to_string(), Value::String(self.response_id.clone()));
            }
        }
        let terminal_output = self.terminal_output_items_reconciled(&terminal_response);
        if let Some(object) = terminal_response.as_object_mut() {
            object.insert("output".to_string(), Value::Array(terminal_output.clone()));
            // The aggregate text is a second view of the same business content.
            // Chat Process recomputes it after governance, so leaving the
            // governed value here would contradict the announced items.
            if object.contains_key("output_text") {
                object.insert(
                    "output_text".to_string(),
                    Value::String(Self::output_text_from_items(&terminal_output)),
                );
            }
        }
        let frame = super::build_v3_runtime_sse_json_frame(
            event,
            &json!({
                "type": event,
                "response": terminal_response,
            }),
        );
        builder.push(frame).map_err(|error| error.to_string())?;
        builder
            .mark_last_frame_as_terminal()
            .map_err(|error| error.to_string())?;
        builder
            .seal_after_validated_terminal()
            .map_err(|error| error.to_string())
    }
}
