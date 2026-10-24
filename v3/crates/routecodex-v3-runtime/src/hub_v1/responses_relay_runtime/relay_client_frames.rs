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
use crate::direct_response_hooks::V3DirectPrefixCommitProbe;
use crate::hub_v1::V3HubProviderWireProtocol;
use crate::nodes::{
    V3AttemptBudget, V3CommittedClientFrameSink, V3CommittedClientSseBuilder,
    V3CommittedClientSseStream,
};

/// Request-level decision for early Relay projection.
///
/// Relay runs its response governance (Resp01/02/03 and Chat Process) on the
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
            governance: V3DirectPrefixCommitProbe::new(V3HubProviderWireProtocol::Responses),
            post_commit_governed: false,
        }
    }

    pub(crate) fn is_committed(&self) -> bool {
        self.committed
    }

    fn push(&mut self, frame: Vec<u8>) -> Result<(), String> {
        if self.post_commit_governed {
            return Ok(());
        }
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
        self.governance
            .observe_event(&json!({
                "type": "response.output_text.delta",
                "output_index": output_index,
                "content_index": 0,
                "delta": text,
            }));
    }

    fn observe_tool_start(&mut self, output_index: usize, item: &Value) {
        self.governance
            .observe_event(&json!({
                "type": "response.output_item.added",
                "output_index": output_index,
                "item": item,
            }));
    }

    fn observe_item_added(&mut self, output_index: usize, item: &Value) {
        self.governance
            .observe_event(&json!({
                "type": "response.output_item.added",
                "output_index": output_index,
                "item": item,
            }));
    }

    fn observe_item_done(&mut self, output_index: usize, item: &Value) {
        self.governance
            .observe_event(&json!({
                "type": "response.output_item.done",
                "output_index": output_index,
                "item": item,
            }));
    }

    fn reasoning_text_from_delta(delta: &Value) -> Option<String> {
        let delta = delta.as_object()?;
        if !delta.contains_key("reasoning_content")
            && !delta.contains_key("reasoning_text")
            && !delta.contains_key("reasoning")
        {
            return None;
        }
        let item = super::build_v3_responses_reasoning_item_from_openai_chat_message(delta)?;
        let summary = item.get("summary").and_then(Value::as_array)?;
        let text = summary
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        (!text.is_empty()).then_some(text)
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
        if self.post_commit_governed {
            return Ok(());
        }
        for choice in choices {
            let Some(delta) = choice.get("delta") else {
                continue;
            };
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.append_text(text)?;
            }
            if let Some(reasoning) = Self::reasoning_text_from_delta(delta) {
                self.append_reasoning(&reasoning)?;
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

    fn append_text(&mut self, text: &str) -> Result<(), String> {
        if self.post_commit_governed {
            return Ok(());
        }
        self.close_reasoning()?;
        self.observe_text(
            self.message.as_ref().map(|message| message.output_index).unwrap_or(self.next_output_index),
            text,
        );
        self.mark_post_commit_governed_if_needed();
        if self.post_commit_governed {
            return Ok(());
        }
        if self.message.is_none() {
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
        if self.post_commit_governed {
            return Ok(());
        }
        if self.reasoning.is_none() {
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

    fn append_refusal(&mut self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        if self.post_commit_governed {
            return Ok(());
        }
        self.close_message()?;
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
        if self.post_commit_governed {
            return Ok(());
        }
        self.close_message()?;
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
        if self.post_commit_governed {
            return Ok(());
        }
        self.push(frame)
    }

    /// Record one announced item at its output index. The terminal frame
    /// rebuilds its `output` array from this record, so a late governance rewrite
    /// can never contradict bytes the client already holds.
    fn record_streamed_item(&mut self, output_index: usize, item_id: &str, item: Value) {
        self.streamed_items.push(StreamedItem {
            output_index,
            item_id: item_id.to_string(),
            item,
        });
    }

    fn close_reasoning(&mut self) -> Result<(), String> {
        let Some(reasoning) = self.reasoning.take() else {
            return Ok(());
        };
        if self.post_commit_governed {
            return Ok(());
        }
        let output_index = reasoning.output_index;
        let item_id = reasoning.item_id;
        let text = reasoning.text;
        self.record_streamed_item(
            output_index,
            &item_id,
            json!({
                "id": item_id,
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": text}],
                "content": [{"type": "reasoning_text", "text": text}],
            }),
        );
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
        if self.post_commit_governed {
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
        if self.post_commit_governed {
            return Ok(());
        }
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
        self.record_streamed_item(output_index, &item_id, item.clone());
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
        if self.post_commit_governed {
            self.tool_calls.clear();
            return Ok(());
        }
        for call in std::mem::take(&mut self.tool_calls) {
            if !call.added_emitted {
                continue;
            }
            self.record_streamed_item(
                call.output_index,
                &call.item_id,
                relay_function_call_item(&call, "completed"),
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
    /// round; the next round opens new items at the next output indices.
    pub(crate) fn close_round(&mut self) -> Result<(), String> {
        self.close_reasoning()?;
        self.close_message()?;
        self.close_refusal()?;
        self.close_tool_calls()
    }

    /// The aggregate text the client can reconstruct from the announced items.
    fn terminal_output_text(&self) -> String {
        let mut ordered: Vec<&StreamedItem> = self.streamed_items.iter().collect();
        ordered.sort_by_key(|entry| entry.output_index);
        let mut text = String::new();
        for entry in ordered {
            if let Some(content) = entry.item.get("content").and_then(Value::as_array) {
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

    /// Rebuild the terminal `output` from the announced items, ordered by output
    /// index. Items close in arrival order, which interleaves a long message with
    /// the reasoning items around it; the protocol orders `output` by index.
    fn terminal_output_items(&self) -> Vec<Value> {
        let mut ordered: Vec<&StreamedItem> = self.streamed_items.iter().collect();
        ordered.sort_by_key(|entry| entry.output_index);
        ordered
            .into_iter()
            .map(|entry| {
                let mut item = entry.item.clone();
                if let Some(object) = item.as_object_mut() {
                    object.insert("id".to_string(), Value::String(entry.item_id.clone()));
                }
                item
            })
            .collect()
    }

    /// Close every open item and seal the attempt. The terminal frame is held
    /// past the acceptance boundary, so a failed seal cannot deliver it first.
    pub(crate) fn finish(
        &mut self,
        terminal: &Value,
    ) -> Result<V3CommittedClientSseStream, String> {
        self.close_reasoning()?;
        self.close_message()?;
        self.close_refusal()?;
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
        // The client learned this response id from `response.created`. A refill
        // round carries a different provider id, so pin the streamed one.
        if !self.response_id.is_empty() {
            if let Some(object) = terminal_response.as_object_mut() {
                object.insert("id".to_string(), Value::String(self.response_id.clone()));
            }
        }
        if let Some(object) = terminal_response.as_object_mut() {
            object.insert(
                "output".to_string(),
                Value::Array(self.terminal_output_items()),
            );
            // The aggregate text is a second view of the same business content.
            // Chat Process recomputes it after governance, so leaving the
            // governed value here would contradict the announced items.
            if object.contains_key("output_text") {
                object.insert(
                    "output_text".to_string(),
                    Value::String(self.terminal_output_text()),
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
