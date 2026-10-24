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
use crate::nodes::{
    V3AttemptBudget, V3CommittedClientFrameSink, V3CommittedClientSseBuilder,
    V3CommittedClientSseStream,
};

/// Request-level decision for early Relay projection.
///
/// Relay runs its response governance (Resp01/02/03 and Chat Process) on the
/// complete canonical response. A request whose governance may still rewrite
/// text or tool shape keeps today's whole-attempt buffering, so its client bytes
/// stay identical. Only a request that provably has no such rewrite may commit
/// on the first business frame.
pub(crate) fn relay_client_stream_commit_eligible(
    client_wants_sse: bool,
    sink_present: bool,
    memory_raw_capture: bool,
    tool_thinking_enabled: bool,
) -> bool {
    client_wants_sse && sink_present && !memory_raw_capture && !tool_thinking_enabled
}

struct OpenReasoningItem {
    output_index: usize,
    item_id: String,
    text: String,
}

struct OpenMessageItem {
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
    arguments: String,
    added_emitted: bool,
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
pub(crate) struct V3RelayChatClientStreamProjector {
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
    /// The item id this stream handed the client for each output index. The
    /// terminal payload carries them, so a client that joins by item id sees
    /// one item and not two.
    streamed_item_ids: Vec<Option<String>>,
    reasoning: Option<OpenReasoningItem>,
    message: Option<OpenMessageItem>,
    tool_calls: Vec<OpenToolCallItem>,
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
            streamed_item_ids: Vec::new(),
            reasoning: None,
            message: None,
            tool_calls: Vec::new(),
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

    /// Commit once a business carrier exists. The certification matches the
    /// Direct predicate: visible output text or a named tool-call start.
    fn try_commit(&mut self) -> Result<(), String> {
        if self.committed {
            return Ok(());
        }
        let has_business = self
            .message
            .as_ref()
            .is_some_and(|message| !message.text.is_empty())
            || self
                .tool_calls
                .iter()
                .any(|call| call.added_emitted && !call.name.is_empty());
        if !has_business {
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
            if let Some(text) = delta
                .get("content")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                self.append_text(text)?;
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                self.append_reasoning(reasoning)?;
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.append_tool_call(call)?;
                }
            }
        }
        self.try_commit()
    }

    fn append_text(&mut self, text: &str) -> Result<(), String> {
        self.close_reasoning()?;
        if self.message.is_none() {
            let output_index = self.next_output_index;
            self.next_output_index += 1;
            let item_id = format!("msg_{output_index}");
            self.streamed_item_ids.push(Some(item_id.clone()));
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
            self.message = Some(OpenMessageItem {
                output_index,
                item_id,
                text: String::new(),
            });
        }
        let message = self
            .message
            .as_mut()
            .ok_or_else(|| "relay client stream lost its message item".to_string())?;
        message.text.push_str(text);
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
                "delta": text,
            }),
        ))
    }

    fn append_reasoning(&mut self, text: &str) -> Result<(), String> {
        if self.reasoning.is_none() {
            let output_index = self.next_output_index;
            self.next_output_index += 1;
            let item_id = format!("rs_{output_index}");
            self.streamed_item_ids.push(Some(item_id.clone()));
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
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.reasoning_summary_part.added",
                &json!({
                    "type": "response.reasoning_summary_part.added",
                    "response_id": self.response_id,
                    "output_index": output_index,
                    "item_id": item_id,
                    "summary_index": 0,
                    "part": {"type": "summary_text", "text": ""},
                }),
            ))?;
            self.reasoning = Some(OpenReasoningItem {
                output_index,
                item_id,
                text: String::new(),
            });
        }
        let reasoning = self
            .reasoning
            .as_mut()
            .ok_or_else(|| "relay client stream lost its reasoning item".to_string())?;
        reasoning.text.push_str(text);
        let output_index = reasoning.output_index;
        let item_id = reasoning.item_id.clone();
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.reasoning_summary_text.delta",
            &json!({
                "type": "response.reasoning_summary_text.delta",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "summary_index": 0,
                "delta": text,
            }),
        ))
    }

    fn append_tool_call(&mut self, call: &Value) -> Result<(), String> {
        self.close_message()?;
        self.close_reasoning()?;
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
                self.streamed_item_ids.push(None);
                self.tool_calls.push(OpenToolCallItem {
                    wire_index,
                    output_index,
                    item_id: String::new(),
                    call_id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
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
                call_entry.arguments.push_str(arguments);
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
        if let Some(slot) = self.streamed_item_ids.get_mut(call_entry.output_index) {
            *slot = Some(call_entry.item_id.clone());
        }
        let frame = super::build_v3_runtime_sse_json_frame(
            "response.output_item.added",
            &json!({
                "type": "response.output_item.added",
                "response_id": self.response_id,
                "output_index": call_entry.output_index,
                "item": {
                    "id": call_entry.item_id,
                    "type": "function_call",
                    "status": "in_progress",
                    "call_id": call_entry.call_id,
                    "name": call_entry.name,
                    "arguments": "",
                },
            }),
        );
        self.push(frame)
    }

    fn close_reasoning(&mut self) -> Result<(), String> {
        let Some(reasoning) = self.reasoning.take() else {
            return Ok(());
        };
        let output_index = reasoning.output_index;
        let item_id = reasoning.item_id;
        let text = reasoning.text;
        self.push(super::build_v3_runtime_sse_json_frame(
            "response.reasoning_summary_text.done",
            &json!({
                "type": "response.reasoning_summary_text.done",
                "response_id": self.response_id,
                "output_index": output_index,
                "item_id": item_id,
                "summary_index": 0,
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
                "summary_index": 0,
                "part": {"type": "summary_text", "text": text},
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
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": text}],
                    "content": [{"type": "reasoning_text", "text": text}],
                },
            }),
        ))
    }

    fn close_message(&mut self) -> Result<(), String> {
        let Some(message) = self.message.take() else {
            return Ok(());
        };
        let output_index = message.output_index;
        let item_id = message.item_id;
        let text = message.text;
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

    fn close_tool_calls(&mut self) -> Result<(), String> {
        for call in std::mem::take(&mut self.tool_calls) {
            if !call.added_emitted {
                continue;
            }
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.function_call_arguments.done",
                &json!({
                    "type": "response.function_call_arguments.done",
                    "response_id": self.response_id,
                    "output_index": call.output_index,
                    "call_id": call.call_id,
                    "arguments": call.arguments,
                }),
            ))?;
            self.push(super::build_v3_runtime_sse_json_frame(
                "response.output_item.done",
                &json!({
                    "type": "response.output_item.done",
                    "response_id": self.response_id,
                    "output_index": call.output_index,
                    "item": {
                        "id": call.item_id,
                        "type": "function_call",
                        "status": "completed",
                        "call_id": call.call_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    },
                }),
            ))?;
        }
        Ok(())
    }

    /// Close every open item and seal the attempt. The terminal frame is held
    /// past the acceptance boundary, so a failed seal cannot deliver it first.
    pub(crate) fn finish(
        &mut self,
        terminal: &Value,
    ) -> Result<V3CommittedClientSseStream, String> {
        self.close_reasoning()?;
        self.close_message()?;
        self.close_tool_calls()?;
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
        // The streamed item ids are the ones the client already holds. Without
        // them the terminal payload would describe the same business items a
        // second time under synthesized ids.
        if let Some(output) = terminal_response
            .get_mut("output")
            .and_then(Value::as_array_mut)
        {
            for (index, item) in output.iter_mut().enumerate() {
                let Some(Some(streamed_id)) = self.streamed_item_ids.get(index) else {
                    continue;
                };
                if let Some(object) = item.as_object_mut() {
                    object.insert("id".to_string(), Value::String(streamed_id.clone()));
                }
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
