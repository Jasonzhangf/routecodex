use super::{
    encode_v3_anthropic_request_as_responses_semantic, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubOpaquePayload, V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol,
    V3HubTransportIntent,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR: &str =
    "routecodex.v3.operation.normalize_request_losslessly";
const NORMALIZE_REQUEST_LOSSLESSLY_NODE: &str = "normalize_request_losslessly";
const NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR_VERSION: &str = "1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3HubAssistantItemContentRange {
    Empty,
    Parts { start: usize, end: usize },
    TextRange { byte_start: usize, byte_end: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3HubAssistantItemProvenance {
    pub(crate) source_input_order: Option<u64>,
    pub(crate) content_range: V3HubAssistantItemContentRange,
    pub(crate) id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct V3HubToolCallHistoryProvenance {
    pub(crate) source_input_order: Option<u64>,
    pub(crate) suppress_responses_hosted_call: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct V3HubMessageHistoryProvenance {
    pub(crate) message_input_order: Option<u64>,
    pub(crate) tool_calls: Vec<V3HubToolCallHistoryProvenance>,
    pub(crate) reasoning_item_orders: Vec<Option<u64>>,
    pub(crate) assistant_items: Vec<V3HubAssistantItemProvenance>,
    pub(crate) assistant_content_digest: Option<u64>,
    pub(crate) omit_tool_output_id: bool,
    pub(crate) preserve_native_tool_output_id: bool,
    pub(crate) decoder_native_tool_output: bool,
    pub(crate) decoder_captured_responses_tool_output: bool,
    pub(crate) preserve_orphan_tool_output_literal: bool,
    pub(crate) restore_responses_hosted_web_search: bool,
}

/// Decoder-owned request history provenance (`v3.operation_runner.explicit_history_pairing`).
///
/// Populated exclusively from native Responses inbound decoding at `ReqInbound02`.
/// Un-decoded legacy `messages` rows and non-Responses entries carry empty provenance
/// so client-supplied extension fields can never control `Req04` pairing or Outbound order.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct V3HubExplicitHistoryProvenance {
    pub(crate) message_entries: Vec<V3HubMessageHistoryProvenance>,
}

impl V3HubExplicitHistoryProvenance {
    pub(crate) fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn message_entry(
        &self,
        message_index: usize,
    ) -> Option<&V3HubMessageHistoryProvenance> {
        self.message_entries.get(message_index)
    }

    pub(crate) fn message_order(&self, message_index: usize) -> Option<u64> {
        self.message_entries
            .get(message_index)
            .and_then(|entry| entry.message_input_order)
    }

    pub(crate) fn tool_call_order(&self, message_index: usize, call_index: usize) -> Option<u64> {
        self.message_entries
            .get(message_index)
            .and_then(|entry| entry.tool_calls.get(call_index))
            .and_then(|call| call.source_input_order)
    }

    pub(crate) fn suppress_responses_hosted_call(
        &self,
        message_index: usize,
        call_index: usize,
    ) -> bool {
        self.message_entries
            .get(message_index)
            .and_then(|entry| entry.tool_calls.get(call_index))
            .is_some_and(|call| call.suppress_responses_hosted_call)
    }

    pub(crate) fn reasoning_item_order(
        &self,
        message_index: usize,
        item_index: usize,
    ) -> Option<u64> {
        self.message_entries.get(message_index).and_then(|entry| {
            entry
                .reasoning_item_orders
                .get(item_index)
                .copied()
                .flatten()
        })
    }

    pub(crate) fn assistant_items(
        &self,
        message_index: usize,
    ) -> Option<&[V3HubAssistantItemProvenance]> {
        self.message_entries
            .get(message_index)
            .map(|entry| entry.assistant_items.as_slice())
            .filter(|items| !items.is_empty())
    }

    pub(crate) fn preserve_orphan_tool_output_literal(&self, message_index: usize) -> bool {
        self.message_entries
            .get(message_index)
            .is_some_and(|entry| entry.preserve_orphan_tool_output_literal)
    }

    pub(crate) fn preserve_retained_for_refill(&self, retained: &Self) -> Self {
        let mut message_entries = retained.message_entries.clone();
        for (index, derived_entry) in self.message_entries.iter().enumerate() {
            if let Some(retained_entry) = message_entries.get_mut(index) {
                if derived_entry.tool_calls.len() > retained_entry.tool_calls.len() {
                    retained_entry.tool_calls.extend(
                        derived_entry.tool_calls[retained_entry.tool_calls.len()..]
                            .iter()
                            .cloned(),
                    );
                }
                if derived_entry.reasoning_item_orders.len()
                    > retained_entry.reasoning_item_orders.len()
                {
                    retained_entry.reasoning_item_orders.extend(
                        derived_entry.reasoning_item_orders
                            [retained_entry.reasoning_item_orders.len()..]
                            .iter()
                            .copied(),
                    );
                }
                if derived_entry.assistant_items.len() > retained_entry.assistant_items.len() {
                    let retained_len = retained_entry.assistant_items.len();
                    for (existing, derived) in retained_entry
                        .assistant_items
                        .iter_mut()
                        .zip(&derived_entry.assistant_items[..retained_len])
                    {
                        existing.content_range = derived.content_range;
                    }
                    retained_entry.assistant_items.extend(
                        derived_entry.assistant_items[retained_len..]
                            .iter()
                            .cloned(),
                    );
                    retained_entry.assistant_content_digest =
                        derived_entry.assistant_content_digest;
                }
            } else {
                message_entries.push(derived_entry.clone());
            }
        }
        Self { message_entries }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
    pub(crate) memory_raw_capture_guidance_injected: bool,
    pub(crate) explicit_history_pairing: V3HubExplicitHistoryProvenance,
}

/// Which request field carries the conversation history this stage will read.
///
/// Inbound canonicalization is the sole owner of that decision, because it
/// chooses the canonicalizer by entry protocol but also handles a Responses
/// request that carries the Chat shape. The refill continuation builder reads
/// this same answer, so a continuation always extends the field the next
/// execution will actually read instead of guessing from field names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3HubInboundHistoryField {
    /// The request carries both `input` and a derived Chat `messages` twin.
    /// `input` is the complete history, so the refill continuation keeps it and
    /// drops the twin instead of maintaining two competing representations.
    ResponsesDual,
    Messages,
    Input,
    Contents,
}

/// The single decision that maps a request to the field inbound will read as
/// the conversation history. Owned here so the canonicalizer and the refill
/// continuation construction cannot diverge.
pub(crate) fn v3_hub_inbound_history_field(
    entry_protocol: V3HubEntryProtocol,
    payload: &Value,
) -> V3HubInboundHistoryField {
    match entry_protocol {
        V3HubEntryProtocol::Gemini => V3HubInboundHistoryField::Contents,
        V3HubEntryProtocol::Anthropic | V3HubEntryProtocol::OpenAiChat => {
            V3HubInboundHistoryField::Messages
        }
        V3HubEntryProtocol::Responses => {
            let has_input = payload.get("input").is_some();
            let has_messages = payload.get("messages").and_then(Value::as_array).is_some();
            if has_input && has_messages {
                V3HubInboundHistoryField::ResponsesDual
            } else if has_input || !has_messages {
                V3HubInboundHistoryField::Input
            } else {
                V3HubInboundHistoryField::Messages
            }
        }
    }
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
        .expect("V3 ReqInbound02 normalization failed")
}

pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    let side_output = Arc::new(Mutex::new(None));
    let operator = NormalizeRequestLosslesslyOperator {
        entry_protocol: input.entry_protocol,
        invocation_source: input.invocation_source,
        transport_intent: input.transport_intent,
        side_output: Arc::clone(&side_output),
    };
    let payload = (*input.payload.0).clone();
    let runner_result = run_v3_single_node_operator(
        V3OperationGraph::Request,
        NORMALIZE_REQUEST_LOSSLESSLY_NODE,
        payload,
        operator,
    );
    let side_output = side_output
        .lock()
        .map_err(|_| "normalize_request_losslessly side-output holder is poisoned".to_string())?
        .take();
    match (runner_result, side_output) {
        (Err(_), Some(Err(error))) => Err(error),
        (Err(error), _) => Err(format!(
            "normalize_request_losslessly canonical execution failed: {error}"
        )),
        (Ok(canonical), Some(Ok(metadata))) => {
            input.payload.0 = Arc::new(canonical);
            Ok(V3HubReqInbound02Normalized {
                previous: input,
                semantic_protocol: metadata.semantic_protocol,
                canonicalized_from_responses: metadata.canonicalized_from_responses,
                memory_raw_capture_guidance_injected: metadata.memory_raw_capture_guidance_injected,
                explicit_history_pairing: metadata.explicit_history_pairing,
            })
        }
        (Ok(_), Some(Err(error))) => Err(error),
        (Ok(_), None) => Err(
            "normalize_request_losslessly operator completed without a typed side output"
                .to_string(),
        ),
    }
}

struct NormalizeRequestLosslesslySideOutput {
    semantic_protocol: V3HubRequestSemanticProtocol,
    canonicalized_from_responses: bool,
    memory_raw_capture_guidance_injected: bool,
    explicit_history_pairing: V3HubExplicitHistoryProvenance,
}

struct NormalizeRequestLosslesslyOperator {
    entry_protocol: V3HubEntryProtocol,
    invocation_source: V3HubInvocationSource,
    transport_intent: V3HubTransportIntent,
    side_output: Arc<Mutex<Option<Result<NormalizeRequestLosslesslySideOutput, String>>>>,
}

impl Operator for NormalizeRequestLosslesslyOperator {
    fn name(&self) -> &'static str {
        NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR
    }

    fn version(&self) -> &'static str {
        NORMALIZE_REQUEST_LOSSLESSLY_OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Any
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let raw = V3HubReqInbound01ClientRaw {
            payload: V3HubOpaquePayload(Arc::new(input)),
            entry_protocol: self.entry_protocol,
            invocation_source: self.invocation_source,
            transport_intent: self.transport_intent,
        };
        let normalized = normalize_v3_hub_req_inbound_02_payload(raw);
        match normalized {
            Ok(normalized) => {
                let payload = (*normalized.previous.payload.0).clone();
                let metadata = NormalizeRequestLosslesslySideOutput {
                    semantic_protocol: normalized.semantic_protocol,
                    canonicalized_from_responses: normalized.canonicalized_from_responses,
                    memory_raw_capture_guidance_injected: normalized
                        .memory_raw_capture_guidance_injected,
                    explicit_history_pairing: normalized.explicit_history_pairing,
                };
                *self.side_output.lock().map_err(|_| {
                    "normalize_request_losslessly side-output holder is poisoned".to_string()
                })? = Some(Ok(metadata));
                Ok(payload)
            }
            Err(error) => {
                *self.side_output.lock().map_err(|_| {
                    "normalize_request_losslessly side-output holder is poisoned".to_string()
                })? = Some(Err(error.clone()));
                Err(error)
            }
        }
    }
}

fn normalize_v3_hub_req_inbound_02_payload(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol == V3HubEntryProtocol::Responses
        && (input.payload.0.get("input").is_some()
            || input
                .payload
                .0
                .get("messages")
                .and_then(serde_json::Value::as_array)
                .is_none())
    {
        let raw = Arc::make_mut(&mut input.payload.0);
        let (canonical, explicit_history_pairing) = responses_merged_chat_canonical(raw)?;
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
            explicit_history_pairing,
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Anthropic {
        let source_payload = std::mem::replace(&mut input.payload.0, Arc::new(Value::Null));
        let source_payload = Arc::try_unwrap(source_payload).unwrap_or_else(|arc| (*arc).clone());
        let mut responses_semantic = if source_payload
            .get("input")
            .and_then(serde_json::Value::as_array)
            .is_some()
        {
            source_payload
        } else {
            encode_v3_anthropic_request_as_responses_semantic(source_payload)
                .map_err(|error| format!("Anthropic inbound semantic projection failed: {error}"))?
        };
        let mut anthropic_preserved_fields = Vec::new();
        let mut anthropic_reasoning_effort = None;
        let mut anthropic_request_extension = None;
        if let Some(object) = responses_semantic.as_object_mut() {
            anthropic_reasoning_effort = object.remove("reasoning_effort");
            anthropic_request_extension = object.remove("routecodex_chat_extension");
            for key in [
                "context_management",
                "output_config",
                "reasoning_budget_tokens",
                "reasoning_display_policy",
                "reasoning_thinking_mode",
            ] {
                if let Some(value) = object.remove(key) {
                    anthropic_preserved_fields.push((key.to_string(), value));
                }
            }
        }
        let mut canonical =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_semantic(
                &responses_semantic,
                input.entry_protocol,
            )
            .map_err(|error| format!("Anthropic inbound Chat canonicalization failed: {error}"))?;
        if let Some(canonical_object) = canonical.as_object_mut() {
            for (key, value) in anthropic_preserved_fields {
                canonical_object.insert(key, value);
            }
            if let Some(value) = anthropic_reasoning_effort {
                canonical_object.insert("reasoning_effort".to_string(), value);
            }
            if let Some(value) = anthropic_request_extension {
                if canonical_object.contains_key("routecodex_chat_extension") {
                    return Err(
                        "Anthropic inbound produced conflicting registered Chat extensions"
                            .to_string(),
                    );
                }
                canonical_object.insert("routecodex_chat_extension".to_string(), value);
            }
        }
        strip_client_history_provenance_fields(&mut canonical);
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
            explicit_history_pairing: V3HubExplicitHistoryProvenance::empty(),
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Gemini {
        // Gemini 客户端请求经相邻 production codec 无损归一化为 canonical Chat +
        // 已登记扩展。归一化后 standard outbound 直接消费 `messages`，不再需要
        // Gemini→X 成对 converter；工具历史交给既有 Chat Process 治理。
        let source_payload = std::mem::replace(&mut input.payload.0, Arc::new(Value::Null));
        let source_payload = Arc::try_unwrap(source_payload).unwrap_or_else(|arc| (*arc).clone());
        let mut canonical =
            super::gemini_request_normalization::build_v3_chat_canonical_request_from_gemini_payload(
                &source_payload,
            )
            .map_err(|error| format!("Gemini inbound Chat canonicalization failed: {error}"))?;
        strip_client_history_provenance_fields(&mut canonical);
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
            explicit_history_pairing: V3HubExplicitHistoryProvenance::empty(),
        });
    }
    if payload_has_client_history_provenance_fields(&input.payload.0) {
        strip_client_history_provenance_fields(Arc::make_mut(&mut input.payload.0));
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
        memory_raw_capture_guidance_injected: false,
        explicit_history_pairing: V3HubExplicitHistoryProvenance::empty(),
    })
}

fn payload_has_client_history_provenance_fields(payload: &Value) -> bool {
    payload
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().any(|message| {
                let msg_ext = message
                    .get("routecodex_chat_extension")
                    .and_then(Value::as_object);
                let has_msg_fields = msg_ext.is_some_and(|ext| {
                    ext.contains_key("responses_tool_input_order")
                        || ext.contains_key(
                            super::responses_openai_codec::RESPONSES_ASSISTANT_ITEMS_EXTENSION,
                        )
                        || ext
                            .get(super::responses_openai_codec::RESPONSES_REASONING_ITEMS_EXTENSION)
                            .and_then(Value::as_array)
                            .is_some_and(|items| {
                                items.iter().any(|entry| {
                                    entry
                                        .as_object()
                                        .is_some_and(|obj| obj.contains_key("source_input_order"))
                                })
                            })
                });
                let has_call_fields = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| {
                        calls.iter().any(|call| {
                            call.pointer("/routecodex_chat_extension/responses_tool_input_order")
                                .is_some()
                        })
                    });
                has_msg_fields || has_call_fields
            })
        })
}

fn strip_client_history_provenance_fields(payload: &mut Value) {
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            strip_client_history_provenance_fields_from_message(message);
        }
    }
}

fn strip_client_history_provenance_fields_from_message(message: &mut Value) {
    let Some(row) = message.as_object_mut() else {
        return;
    };
    let remove_empty_ext = if let Some(ext) = row
        .get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut)
    {
        ext.remove("responses_tool_input_order");
        ext.remove(super::responses_openai_codec::RESPONSES_ASSISTANT_ITEMS_EXTENSION);
        if let Some(items) = ext
            .get_mut(super::responses_openai_codec::RESPONSES_REASONING_ITEMS_EXTENSION)
            .and_then(Value::as_array_mut)
        {
            for entry in items {
                if let Some(obj) = entry.as_object_mut() {
                    obj.remove("source_input_order");
                }
            }
        }
        ext.is_empty()
    } else {
        false
    };
    if remove_empty_ext {
        row.remove("routecodex_chat_extension");
    }
    if let Some(calls) = row.get_mut("tool_calls").and_then(Value::as_array_mut) {
        for call in calls {
            let Some(call_obj) = call.as_object_mut() else {
                continue;
            };
            let remove_call_ext = if let Some(ext) = call_obj
                .get_mut("routecodex_chat_extension")
                .and_then(Value::as_object_mut)
            {
                ext.remove("responses_tool_input_order");
                ext.is_empty()
            } else {
                false
            };
            if remove_call_ext {
                call_obj.remove("routecodex_chat_extension");
            }
        }
    }
}

fn merge_responses_chat_histories(
    source: &[Value],
    decoded: &[Value],
    decoded_provenance: &V3HubExplicitHistoryProvenance,
) -> Result<(Vec<Value>, V3HubExplicitHistoryProvenance), String> {
    let mut sanitized_source = source.to_vec();
    for message in &mut sanitized_source {
        strip_client_history_provenance_fields_from_message(message);
    }
    let all_decoded_are_legacy_tool_outputs =
        decoded.iter().enumerate().all(|(dec_idx, message)| {
            message["role"] == "tool"
                || is_decoder_proven_named_tool_output(
                    message,
                    decoded_provenance.message_entries.get(dec_idx),
                )
        });
    if sanitized_source.len() == decoded.len() {
        let mut merged = Vec::with_capacity(sanitized_source.len());
        let mut all_matched = true;
        for (src, dec) in sanitized_source.iter().zip(decoded) {
            let is_named_or_search_receipt = tool_output_name(src).is_some()
                || tool_output_name(dec).is_some()
                || is_tool_search_output(src)
                || is_tool_search_output(dec);
            let is_ordinary_tool_receipt = src["role"] == "tool" || dec["role"] == "tool";
            let incompatible_receipt_item_id = if is_named_or_search_receipt
                || (is_ordinary_tool_receipt && all_decoded_are_legacy_tool_outputs)
            {
                tool_output_item_id(src) != tool_output_item_id(dec)
            } else if is_ordinary_tool_receipt {
                tool_output_item_id(src).is_some()
                    && tool_output_item_id(dec).is_some()
                    && tool_output_item_id(src) != tool_output_item_id(dec)
            } else {
                false
            };
            if incompatible_receipt_item_id {
                all_matched = false;
                break;
            }
            if let Some(value) = merge_equivalent_chat_value(src, dec) {
                merged.push(value);
            } else {
                all_matched = false;
                break;
            }
        }
        if all_matched {
            return Ok((merged, decoded_provenance.clone()));
        }
    }
    // Legacy public hook callers supply preceding Chat calls and current Responses
    // results. Decode the results first; Req04 still owns id/kind pairing.
    if all_decoded_are_legacy_tool_outputs {
        let original_source_len = sanitized_source.len();
        let mut source_reserved = vec![false; original_source_len];
        let mut reserved_source_for_decoded = vec![None; decoded.len()];
        for (dec_idx, result) in decoded.iter().enumerate() {
            let Some(incoming_id) = tool_output_item_id(result) else {
                continue;
            };
            if let Some(pos) = (0..original_source_len).find(|&idx| {
                !source_reserved[idx]
                    && same_legacy_tool_output_identity(&sanitized_source[idx], result)
                    && tool_output_item_id(&sanitized_source[idx]) == Some(incoming_id)
            }) {
                source_reserved[pos] = true;
                reserved_source_for_decoded[dec_idx] = Some(pos);
            }
        }
        let mut merged = sanitized_source;
        let mut merged_entries: Vec<V3HubMessageHistoryProvenance> = merged
            .iter()
            .map(|row| V3HubMessageHistoryProvenance {
                omit_tool_output_id: (row["role"] == "tool" || tool_output_name(row).is_some())
                    && tool_output_item_id(row).is_none(),
                preserve_native_tool_output_id: row["role"] == "tool"
                    || tool_output_name(row).is_some(),
                ..Default::default()
            })
            .collect();
        let mut matched_source_for_decoded = vec![None; decoded.len()];
        let mut decoded_entry_provenances = Vec::with_capacity(decoded.len());
        for (dec_idx, result) in decoded.iter().enumerate() {
            let result_provenance = decoded_provenance
                .message_entries
                .get(dec_idx)
                .cloned()
                .unwrap_or_default();
            decoded_entry_provenances.push(result_provenance.clone());
            let result_item_id = tool_output_item_id(result);
            let is_unreserved_candidate = |idx: usize| {
                !source_reserved[idx] && same_legacy_tool_output_identity(&merged[idx], result)
            };
            let matched_pos = if let Some(pos) = reserved_source_for_decoded[dec_idx] {
                Some(pos)
            } else if result_item_id.is_some() {
                None
            } else if tool_output_name(result).is_some() || is_tool_search_output(result) {
                (0..original_source_len).find(|&idx| {
                    is_unreserved_candidate(idx)
                        && tool_output_item_id(&merged[idx]).is_none()
                        && merge_equivalent_chat_value(&merged[idx], result).is_some()
                })
            } else {
                (0..original_source_len).find(|&idx| {
                    is_unreserved_candidate(idx) && tool_output_item_id(&merged[idx]).is_none()
                })
            };
            if let Some(pos) = matched_pos {
                source_reserved[pos] = true;
                let existing = &mut merged[pos];
                *existing = merge_equivalent_chat_value(existing, result).ok_or_else(|| {
                    "Responses inbound canonicalization failed: conflicting tool output representations".to_string()
                })?;
                merged_entries[pos] = result_provenance;
                matched_source_for_decoded[dec_idx] = Some(pos);
            }
        }
        let mut source_to_merged_pos: Vec<usize> = (0..original_source_len).collect();
        for (dec_idx, result) in decoded.iter().enumerate() {
            if matched_source_for_decoded[dec_idx].is_some() {
                continue;
            }
            let result_provenance = decoded_entry_provenances[dec_idx].clone();
            if let Some(next_source_idx) = matched_source_for_decoded[dec_idx + 1..]
                .iter()
                .flatten()
                .copied()
                .next()
            {
                let insert_at = source_to_merged_pos[next_source_idx];
                merged.insert(insert_at, result.clone());
                merged_entries.insert(insert_at, result_provenance);
                for pos in &mut source_to_merged_pos {
                    if *pos >= insert_at {
                        *pos += 1;
                    }
                }
            } else {
                merged.push(result.clone());
                merged_entries.push(result_provenance);
            }
        }
        return Ok((
            merged,
            V3HubExplicitHistoryProvenance {
                message_entries: merged_entries,
            },
        ));
    }
    Err(
        "Responses inbound canonicalization failed: conflicting input and messages representations"
            .to_string(),
    )
}

fn merge_equivalent_chat_value(source: &Value, decoded: &Value) -> Option<Value> {
    match (source, decoded) {
        (Value::Object(source), Value::Object(decoded)) => {
            let empty_assistant_content = |object: &serde_json::Map<String, Value>| {
                object.get("role").is_some_and(|role| role == "assistant")
                    && object
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| !calls.is_empty())
                    && object
                        .get("content")
                        .is_none_or(|content| content.is_null() || content.as_str() == Some(""))
            };
            let empty_assistant_reasoning = |object: &serde_json::Map<String, Value>| {
                object.get("role").is_some_and(|role| role == "assistant")
                    && object.get("reasoning_content").is_none_or(|reasoning| {
                        reasoning.is_null() || reasoning.as_str() == Some("")
                    })
            };
            let semantic_keys = |object: &serde_json::Map<String, Value>| {
                object
                    .keys()
                    .filter(|key| {
                        key.as_str() != "routecodex_chat_extension"
                            && !(key.as_str() == "content" && empty_assistant_content(object))
                            && !(key.as_str() == "reasoning_content"
                                && empty_assistant_reasoning(object))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if semantic_keys(source) != semantic_keys(decoded) {
                return None;
            }
            let mut merged = source.clone();
            for (key, value) in decoded {
                if key == "routecodex_chat_extension" {
                    let mut fields = match source.get(key) {
                        Some(source) => source.as_object()?.clone(),
                        None => serde_json::Map::new(),
                    };
                    for (field, value) in value.as_object()? {
                        if let Some(existing) = fields.get(field) {
                            if field
                                == super::responses_openai_codec::RESPONSES_REASONING_ITEMS_EXTENSION
                            {
                                fields.insert(
                                    field.clone(),
                                    merge_equivalent_responses_reasoning_items(existing, value)?,
                                );
                            } else if existing != value {
                                return None;
                            }
                        } else {
                            fields.insert(field.clone(), value.clone());
                        }
                    }
                    merged.insert(key.clone(), Value::Object(fields));
                } else if key == "content"
                    && empty_assistant_content(source)
                    && empty_assistant_content(decoded)
                {
                    // Chat assistant tool calls permit absent/null content; the
                    // Responses codec spells that same empty content as "".
                } else if key == "reasoning_content"
                    && empty_assistant_reasoning(source)
                    && empty_assistant_reasoning(decoded)
                {
                    // Encrypted-only Responses reasoning omits reasoning_content,
                    // while a Chat twin may carry empty/null reasoning_content.
                } else if key == "content"
                    && comparable_chat_content(&source[key]) == comparable_chat_content(value)
                {
                    // Preserve the source representation; only singleton plain text
                    // is equivalent to its scalar Chat spelling.
                } else if key == "content"
                    && source[key].is_string()
                    && decoded
                        .get("routecodex_chat_extension")
                        .and_then(|ext| ext.get("responses_tool_output_content"))
                        == Some(&source[key])
                {
                    // Retain the normalized content and let Req04 decide whether
                    // to restore the literal string for an orphaned output.
                    merged.insert(key.clone(), value.clone());
                } else {
                    merged.insert(
                        key.clone(),
                        merge_equivalent_chat_value(&source[key], value)?,
                    );
                }
            }
            Some(Value::Object(merged))
        }
        (Value::Array(source), Value::Array(decoded)) if source.len() == decoded.len() => source
            .iter()
            .zip(decoded)
            .map(|(source, decoded)| merge_equivalent_chat_value(source, decoded))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        _ if source == decoded => Some(source.clone()),
        _ => None,
    }
}

fn merge_equivalent_responses_reasoning_items(existing: &Value, decoded: &Value) -> Option<Value> {
    let (Some(existing_items), Some(decoded_items)) = (existing.as_array(), decoded.as_array())
    else {
        return None;
    };
    if existing_items.len() != decoded_items.len() {
        return None;
    }
    let mut merged = Vec::with_capacity(existing_items.len());
    for (existing_entry, decoded_entry) in existing_items.iter().zip(decoded_items) {
        let (Some(existing_obj), Some(decoded_obj)) =
            (existing_entry.as_object(), decoded_entry.as_object())
        else {
            return None;
        };
        let keys_match = existing_obj
            .iter()
            .filter(|(key, _)| key.as_str() != "source_input_order")
            .all(|(key, value)| decoded_obj.get(key) == Some(value))
            && decoded_obj
                .iter()
                .filter(|(key, _)| key.as_str() != "source_input_order")
                .all(|(key, value)| existing_obj.get(key) == Some(value));
        if !keys_match {
            return None;
        }
        let mut entry = existing_obj.clone();
        if let Some(order) = decoded_obj.get("source_input_order") {
            entry.insert("source_input_order".to_string(), order.clone());
        } else {
            entry.remove("source_input_order");
        }
        merged.push(Value::Object(entry));
    }
    Some(Value::Array(merged))
}

pub(super) fn comparable_chat_content(content: &Value) -> &Value {
    if let Some(parts) = content.as_array() {
        if parts.len() == 1
            && parts[0].as_object().is_some_and(|part| part.len() == 2)
            && parts[0]["type"] == "text"
            && parts[0]["text"].is_string()
        {
            return &parts[0]["text"];
        }
    }
    content
}

fn responses_merged_chat_canonical(
    raw: &Value,
) -> Result<(Value, V3HubExplicitHistoryProvenance), String> {
    let (mut canonical, mut provenance) =
        super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_merge_with_provenance(raw)
            .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
    if let Some(source) = raw.get("messages").filter(|value| !value.is_null()) {
        let source = source.as_array().ok_or_else(|| {
            "Responses inbound canonicalization failed: messages must be an array".to_string()
        })?;
        let decoded = canonical["messages"]
            .as_array()
            .expect("codec Chat messages");
        let has_synthetic_instructions_prefix = raw
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
            && decoded
                .first()
                .and_then(|msg| msg.get("role"))
                .and_then(Value::as_str)
                == Some("system")
            && source
                .first()
                .and_then(|msg| msg.get("role"))
                .and_then(Value::as_str)
                != Some("system");
        let (merged_messages, merged_provenance) = if has_synthetic_instructions_prefix {
            let tail_provenance = V3HubExplicitHistoryProvenance {
                message_entries: provenance.message_entries[1..].to_vec(),
            };
            let (mut tail_messages, mut tail_prov) =
                merge_responses_chat_histories(source, &decoded[1..], &tail_provenance)?;
            tail_messages.insert(0, decoded[0].clone());
            tail_prov
                .message_entries
                .insert(0, provenance.message_entries[0].clone());
            (tail_messages, tail_prov)
        } else {
            merge_responses_chat_histories(source, decoded, &provenance)?
        };
        canonical["messages"] = Value::Array(merged_messages);
        provenance = merged_provenance;
    }
    Ok((canonical, provenance))
}

fn tool_output_item_id(message: &Value) -> Option<&str> {
    message
        .pointer("/routecodex_chat_extension/responses_item_id")
        .or_else(|| message.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn tool_output_name(message: &Value) -> Option<&str> {
    message
        .pointer("/routecodex_chat_extension/responses_tool_output_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_tool_search_output(message: &Value) -> bool {
    message
        .pointer("/routecodex_chat_extension/responses_tool_output_type")
        .and_then(Value::as_str)
        == Some("tool_search_output")
}

fn tool_output_namespace(message: &Value) -> Option<&str> {
    message
        .pointer("/routecodex_chat_extension/responses_tool_output_namespace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_decoder_proven_named_tool_output(
    message: &Value,
    provenance: Option<&V3HubMessageHistoryProvenance>,
) -> bool {
    message["role"] == "user"
        && message.get("tool_call_id").is_none()
        && tool_output_name(message).is_some()
        && provenance.is_some_and(|entry| entry.decoder_native_tool_output)
}

fn same_legacy_tool_output_identity(source_row: &Value, decoded_row: &Value) -> bool {
    if decoded_row["role"] == "tool" {
        source_row["role"] == "tool"
            && source_row.get("tool_call_id") == decoded_row.get("tool_call_id")
    } else if let Some(decoded_name) = tool_output_name(decoded_row) {
        source_row["role"] == "user"
            && source_row.get("tool_call_id").is_none()
            && tool_output_name(source_row) == Some(decoded_name)
            && tool_output_namespace(source_row) == tool_output_namespace(decoded_row)
    } else {
        false
    }
}

/// The complete business contribution inbound accepts for a Responses payload.
///
/// A Responses request may carry both `input` and a `messages` twin. Which side
/// owns the history is not decidable from field presence: the merge in
/// [`merge_responses_chat_histories`] contributes business extensions from
/// either side, accepts a Chat history plus decoded tool results, and rejects
/// twins that are not equivalent. The decoded `input` also lifts declarations
/// that live only in its items, such as `additional_tools`, into the effective
/// tool set. Collapsing the dual representation into one must therefore carry
/// this whole contribution, not a single raw field.
pub(crate) struct V3HubResponsesAcceptedChatContribution {
    /// The merged Chat history ReqInbound02 accepts.
    pub(crate) messages: Vec<Value>,
    /// The effective tool declarations, including those lifted out of `input`
    /// items. `None` means the request declares no tools at all.
    pub(crate) tools: Option<Value>,
    /// Decoder-owned history provenance aligned 1-to-1 with `messages`.
    pub(crate) provenance: V3HubExplicitHistoryProvenance,
}

pub(crate) fn v3_hub_responses_accepted_chat_contribution(
    payload: &Value,
) -> Result<V3HubResponsesAcceptedChatContribution, String> {
    let (canonical, provenance) = responses_merged_chat_canonical(payload)?;
    let messages = canonical
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Responses accepted history must be an array".to_string())?;
    let tools = v3_hub_responses_effective_tool_declarations(payload, &canonical)?;
    Ok(V3HubResponsesAcceptedChatContribution {
        messages,
        tools,
        provenance,
    })
}

/// The effective tool declarations a collapsed dual Responses request must keep.
///
/// Two things have to hold at once. Hosted and MCP declarations carry no tool
/// identity, so they must be copied from every accepted declaration source;
/// the canonical Chat request already lifts them out of `additional_tools`
/// items and standalone `web_search` items, which is why they are read from
/// there. Declarations that do carry an identity must be emitted once with the
/// final refresh winning, because the next execution feeds the whole root
/// `tools` array in as a single source and rejects two schemas for one
/// identity. Resolving through the identity registry satisfies both, and the
/// result is re-entrant for the next round.
fn v3_hub_responses_effective_tool_declarations(
    payload: &Value,
    canonical: &Value,
) -> Result<Option<Value>, String> {
    let mut hosted: Vec<Value> = Vec::new();
    for tool in canonical
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if matches!(
            tool.get("type").and_then(Value::as_str),
            Some("namespace" | "function" | "custom")
        ) {
            continue;
        }
        if !hosted.iter().any(|seen| seen == tool) {
            hosted.push(tool.clone());
        }
    }
    let registry =
        provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
            payload,
            "openai-responses",
        )?;
    let declarations = registry.source_tools(&hosted);
    Ok((!declarations.is_empty()).then_some(Value::Array(declarations)))
}

pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol != V3HubEntryProtocol::Responses {
        return Err(
            "Responses inbound canonicalization requires the Responses entry protocol".to_string(),
        );
    }
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::{V3HubInvocationSource, V3HubTransportIntent};
    use serde_json::json;

    fn raw_request(
        payload: Value,
        entry_protocol: V3HubEntryProtocol,
        invocation_source: V3HubInvocationSource,
        transport_intent: V3HubTransportIntent,
    ) -> V3HubReqInbound01ClientRaw {
        super::super::build_v3_hub_req_inbound_01_client_raw(
            payload,
            entry_protocol,
            invocation_source,
            transport_intent,
        )
    }

    #[test]
    fn malformed_responses_inbound_canonicalization_failure_does_not_enter_chat_process() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "unsupported_provider_private_event",
                    "payload": {"query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let result =
            build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(raw);
        assert!(
            result.is_err(),
            "unsupported Responses inbound canonicalization must fail-fast before Chat Process instead of silently continuing as non-canonicalized Chat"
        );
    }

    #[test]
    fn responses_tool_history_is_normalized_to_chat_extension_without_raw_payload_carry() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "web_search_call",
                    "status": "failed",
                    "action": {"type": "search", "query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw).expect(
            "Responses inbound must normalize hosted tool history into Chat extension data",
        );
        assert!(normalized.canonicalized_from_responses);
        assert!(
            normalized.previous.payload.0.get("messages").is_some(),
            "ReqInbound must pass Chat-normalized data forward, not raw Responses payload"
        );
        assert!(
            normalized.previous.payload.0.get("input").is_none(),
            "raw Responses input must not be carried across ReqInbound after normalization"
        );
    }

    #[test]
    fn responses_request_data_fields_enter_typed_chat_extension_without_raw_field_carry() {
        let client_metadata = json!({
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1"
        });
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": "hello",
                "client_metadata": client_metadata,
                "prompt_cache_key": "session-1",
                "store": false,
                "text": {"verbosity": "high"}
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses request fields must normalize into Chat extension data");
        let payload = &normalized.previous.payload.0;
        let extension = &payload["routecodex_chat_extension"]["responses_request"];

        assert_eq!(extension["client_metadata"], client_metadata);
        assert_eq!(extension["prompt_cache_key"], "session-1");
        assert_eq!(extension["store"], false);
        assert_eq!(extension["text"], json!({"verbosity":"high"}));
        for raw_field in ["client_metadata", "prompt_cache_key", "store", "text"] {
            assert!(
                payload.get(raw_field).is_none(),
                "Responses field {raw_field} must not cross ReqInbound as a raw top-level payload field: {payload}"
            );
        }
    }

    #[test]
    fn responses_continuation_locator_does_not_enter_chat_canonical_payload() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_local_continuation",
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_lookup",
                    "output": "done"
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses continuation input must normalize to Chat");

        assert!(normalized.previous.payload.0.get("messages").is_some());
        assert!(
            normalized
                .previous
                .payload
                .0
                .get("previous_response_id")
                .is_none(),
            "continuation control locator must be consumed by its owner and never cross ReqInbound02 as Chat payload"
        );
    }

    #[test]
    fn anthropic_system_extension_survives_req02_chat_canonicalization() {
        let system = json!([
            {"type":"text","text":"dynamic system"},
            {"type":"text","text":"cached system","cache_control":{"type":"ephemeral"}}
        ]);
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model":"claude-test",
                "max_tokens":128,
                "system":system,
                "context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},
                "output_config":{"effort":"high"},
                "thinking":{"type":"enabled","budget_tokens":1024,"display":"omitted"},
                "messages":[{"role":"user","content":"hello"}]
            }),
            super::super::V3HubEntryProtocol::Anthropic,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Anthropic system data must survive non-destructive Req02 normalization");

        assert_eq!(
            normalized.previous.payload.0["routecodex_chat_extension"]["anthropic_request"]
                ["system"],
            system
        );
        assert_eq!(
            normalized.previous.payload.0["context_management"],
            json!({"edits":[{"type":"clear_thinking_20251015","keep":"all"}]})
        );
        assert_eq!(normalized.previous.payload.0["reasoning_effort"], "high");
        assert_eq!(
            normalized.previous.payload.0["reasoning_thinking_mode"],
            "enabled"
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_budget_tokens"],
            1024
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_display_policy"],
            "omitted"
        );
        assert!(
            normalized.previous.payload.0.get("output_config").is_none(),
            "Anthropic effort must normalize into Chat reasoning_effort before Chat Process"
        );
    }

    #[test]
    fn responses_history_image_and_opaque_tool_data_survive_req02_losslessly() {
        let historical_image = json!({
            "type": "input_image",
            "image_url": "data:image/png;base64,AAAA",
            "detail": "original",
            "future_sibling": {"keep": true}
        });
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "input": [
                    {"type":"message","role":"user","content":[
                        {"type":"input_text","text":"inspect the image"}
                    ]},
                    {"type":"message","role":"user","content":[historical_image.clone()]},
                    {"type":"function_call","call_id":"call_history","name":"lookup","arguments":"{\"q\":\"x\"}"},
                    {"type":"function_call_output","call_id":"call_history","output":"done","future_status":{"keep":true}},
                    {"type":"message","role":"user","content":[
                        {"type":"input_text","text":"compare with this image"},
                        {"type":"input_image","image_url":"data:image/png;base64,BBBB","detail":"high"}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Refill,
            V3HubTransportIntent::Sse,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Responses inbound normalization");
        assert_eq!(
            normalized.previous.entry_protocol,
            V3HubEntryProtocol::Responses
        );
        assert_eq!(
            normalized.previous.invocation_source,
            V3HubInvocationSource::Refill
        );
        assert_eq!(
            normalized.previous.transport_intent,
            V3HubTransportIntent::Sse
        );
        assert_eq!(
            normalized.semantic_protocol,
            V3HubRequestSemanticProtocol::Chat
        );
        assert!(normalized.canonicalized_from_responses);
        assert!(!normalized.memory_raw_capture_guidance_injected);
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[1]["content"][0]["image_url"]["url"], "data:image/png;base64,AAAA",
            "ReqInbound02 must not replace historical image source data: {messages:#?}"
        );
        assert_eq!(
            messages[1]["content"][0]["image_url"]["detail"], "original",
            "ReqInbound02 must retain mapped image metadata: {messages:#?}"
        );
        assert_eq!(
            messages[1]["content"][0]["future_sibling"],
            json!({"keep": true}),
            "ReqInbound02 must retain opaque fields on historical image parts: {messages:#?}"
        );
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[3]["tool_call_id"], "call_history");
        assert_eq!(messages[3]["content"], "done");
    }

    #[test]
    fn openai_chat_history_image_and_opaque_siblings_survive_req02_losslessly() {
        let payload = json!({
            "model": "gpt-5.5",
            "messages": [
                {"role":"user","content":[
                    {"type":"input_text","text":"inspect"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"},"future_sibling":{"keep":true}}
                ]},
                {"role":"assistant","tool_calls":[{
                    "id":"call_history",
                    "type":"function",
                    "function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}
                }]},
                {"role":"tool","tool_call_id":"call_history","content":"done"},
                {"role":"user","content":[
                    {"type":"text","text":"continue"},
                    {"type":"image_url","image_url":{"url":"data:image/png;base64,BBBB"}}
                ]}
            ]
        });
        let raw = raw_request(
            payload.clone(),
            V3HubEntryProtocol::OpenAiChat,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless OpenAI Chat inbound normalization");
        assert_eq!(*normalized.previous.payload.0, payload);
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["content"][1]["future_sibling"],
            json!({"keep": true})
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["id"],
            "call_history"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["function"]["name"],
            "lookup"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][2]["tool_call_id"],
            "call_history"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][2]["content"],
            "done"
        );
        assert!(!normalized.canonicalized_from_responses);
    }

    #[test]
    fn anthropic_history_image_and_paired_tool_history_survive_req02_losslessly() {
        let raw = raw_request(
            json!({
                "model":"claude-test",
                "max_tokens":128,
                "messages":[
                    {"role":"user","content":[
                        {"type":"text","text":"inspect"},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"},"future_sibling":{"keep":true}}
                    ]},
                    {"role":"assistant","content":[{"type":"tool_use","id":"call_history","name":"lookup","input":{"q":"x"}}]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_history","content":"done"}]},
                    {"role":"user","content":[
                        {"type":"text","text":"continue"},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"BBBB"}}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Anthropic,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Anthropic inbound normalization");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            messages[0]["content"][1]["future_sibling"],
            json!({"keep": true}),
            "Anthropic image siblings must remain associated with their source part"
        );
        assert_eq!(messages[1]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[2]["tool_call_id"], "call_history");
        assert_eq!(messages[2]["content"], "done");
        assert_eq!(
            messages[3]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BBBB"
        );
    }

    #[test]
    fn gemini_history_image_unknown_native_fields_and_tool_history_survive_req02_losslessly() {
        let raw = raw_request(
            json!({
                "model":"gemini-test",
                "contents":[
                    {"role":"user","parts":[
                        {"text":"inspect"},
                        {"inlineData":{"mimeType":"image/png","data":"AAAA"},"futureSibling":{"keep":true}}
                    ],"turnSibling":{"keep":"container"}},
                    {"role":"model","parts":[{"functionCall":{"id":"call_history","name":"lookup","args":{"q":"x"}}}]},
                    {"role":"user","parts":[{"functionResponse":{"id":"call_history","name":"lookup","response":{"result":"done"}}}]},
                    {"role":"user","parts":[
                        {"text":"continue"},
                        {"inlineData":{"mimeType":"image/png","data":"BBBB"}}
                    ]}
                ],
                "futureRequest":{"keep":true}
            }),
            V3HubEntryProtocol::Gemini,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("lossless Gemini inbound normalization");
        let payload = &normalized.previous.payload.0;
        let messages = payload["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            messages[0]["content"][1]["routecodex_chat_extension"]["gemini_native_fields"][0]
                ["fields"]["futureSibling"],
            json!({"keep": true})
        );
        assert_eq!(
            messages[0]["routecodex_chat_extension"]["gemini_native_fields"][0]["fields"]
                ["turnSibling"],
            json!({"keep": "container"})
        );
        assert_eq!(
            payload["routecodex_chat_extension"]["gemini_native_fields"][0]["fields"]
                ["futureRequest"],
            json!({"keep": true})
        );
        assert_eq!(messages[1]["tool_calls"][0]["id"], "call_history");
        assert_eq!(messages[1]["tool_calls"][0]["function"]["name"], "lookup");
        assert_eq!(
            messages[1]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(messages[2]["tool_call_id"], "call_history");
        assert_eq!(messages[2]["content"], "{\"result\":\"done\"}");
        assert_eq!(
            messages[3]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BBBB"
        );
    }

    #[test]
    fn canonical_execution_returns_the_operator_error_without_swallowing_it() {
        let raw = raw_request(
            json!({
                "model":"gpt-5.5",
                "input":[{"type":"unsupported_provider_private_event","payload":{"query":"x"}}]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let error = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect_err("unsupported Responses input must preserve the canonical execution error");
        assert_eq!(
            error,
            "Responses inbound canonicalization failed: unsupported Responses input item type for OpenAI Chat provider encoding: unsupported_provider_private_event"
        );
    }

    #[test]
    fn canonical_execution_does_not_mask_a_runner_error_after_operator_side_output() {
        let raw = raw_request(
            json!([]),
            V3HubEntryProtocol::OpenAiChat,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let error = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect_err("a canonical output-schema failure must not be masked by side output");
        assert!(
            error.contains("normalize_request_losslessly canonical execution failed"),
            "runner failure must remain explicit: {error}"
        );
    }

    #[test]
    fn responses_duplicate_image_urls_keep_their_occurrence_siblings() {
        let image_url = "data:image/png;base64,AAAA";
        let raw = raw_request(
            json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"message","role":"user","content":[
                        {"type":"input_image","image_url":image_url,"future_sibling":{"occurrence":1}}
                    ]},
                    {"type":"message","role":"user","content":[
                        {"type":"input_image","image_url":image_url,"future_sibling":{"occurrence":2}}
                    ]}
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("duplicate Responses image URLs must normalize losslessly");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(
            messages[0]["content"][0]["future_sibling"],
            json!({"occurrence":1})
        );
        assert_eq!(
            messages[1]["content"][0]["future_sibling"],
            json!({"occurrence":2}),
            "image siblings must follow source occurrence, not the first equal URL"
        );
    }

    #[test]
    fn req_inbound02_records_bool_provenance_without_resolving_orphan_literal() {
        let alias_image_json =
            r#"[{"type":"input_image","image_url":"https://example.com/a.png"}]"#;
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "tool_result",
                    "call_id": "call_orphan_alias",
                    "output": alias_image_json
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses tool_result alias must normalize at ReqInbound02");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert!(
            messages[0]["content"].is_array(),
            "ReqInbound02 must not resolve orphan literal before Req04: {}",
            messages[0]
        );
        assert_eq!(
            messages[0]["routecodex_chat_extension"]["responses_tool_output_content"],
            json!(alias_image_json)
        );
        let entry = normalized
            .explicit_history_pairing
            .message_entry(0)
            .expect("provenance entry");
        assert!(entry.decoder_native_tool_output);
        assert!(entry.decoder_captured_responses_tool_output);
        assert!(!entry.preserve_orphan_tool_output_literal);
        let provenance_debug = format!("{:?}", normalized.explicit_history_pairing);
        assert!(
            !provenance_debug.contains("https://example.com/a.png"),
            "V3HubExplicitHistoryProvenance must not hold a copy of tool output business payload: {provenance_debug}"
        );
    }

    #[test]
    fn dual_history_tool_search_output_matches_by_item_id_and_preserves_distinct_receipts() {
        let tool_one =
            json!([{"type": "function", "name": "tool_one", "parameters": {"type": "object"}}]);
        let tool_two =
            json!([{"type": "function", "name": "tool_two", "parameters": {"type": "object"}}]);
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": serde_json::to_string(&tool_one).unwrap(),
                    "routecodex_chat_extension": {
                        "responses_tool_output_type": "tool_search_output",
                        "responses_output_field": "tools",
                        "responses_item_id": "tso_1",
                        "responses_status": "completed",
                        "responses_execution": "client"
                    }
                }],
                "input": [{
                    "type": "tool_search_output",
                    "id": "tso_2",
                    "call_id": "call_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": tool_two
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("distinct tool_search_output item_ids sharing call_id must append cleanly");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(messages.len(), 2, "{messages:#?}");
        assert_eq!(
            messages[0]["routecodex_chat_extension"]["responses_item_id"],
            json!("tso_1")
        );
        assert_eq!(
            messages[1]["routecodex_chat_extension"]["responses_item_id"],
            json!("tso_2")
        );

        let conflicting_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": serde_json::to_string(&tool_one).unwrap(),
                    "routecodex_chat_extension": {
                        "responses_tool_output_type": "tool_search_output",
                        "responses_output_field": "tools",
                        "responses_item_id": "tso_1",
                        "responses_status": "completed",
                        "responses_execution": "client"
                    }
                }],
                "input": [{
                    "type": "tool_search_output",
                    "id": "tso_1",
                    "call_id": "call_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": tool_two
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let err = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(conflicting_raw)
            .expect_err(
                "same tool_call_id and same item_id with different tools must still conflict",
            );
        assert!(
            err.contains("conflicting tool output representations"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn dual_history_tool_string_matching_decoder_content_merges_with_and_without_parent_and_keeps_normalized_content(
    ) {
        let alias_image_json =
            r#"[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]"#;
        for include_parent in [false, true] {
            let (messages, input) = if include_parent {
                (
                    json!([
                        {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "call_dual_parent",
                                "type": "function",
                                "function": {"name": "read_image", "arguments": "{}"}
                            }]
                        },
                        {
                            "role": "tool",
                            "tool_call_id": "call_dual_parent",
                            "content": alias_image_json
                        }
                    ]),
                    json!([
                        {
                            "type": "function_call",
                            "call_id": "call_dual_parent",
                            "name": "read_image",
                            "arguments": "{}"
                        },
                        {
                            "type": "function_call_output",
                            "call_id": "call_dual_parent",
                            "output": alias_image_json
                        }
                    ]),
                )
            } else {
                (
                    json!([{
                        "role": "tool",
                        "tool_call_id": "call_dual_orphan",
                        "content": alias_image_json
                    }]),
                    json!([{
                        "type": "function_call_output",
                        "call_id": "call_dual_orphan",
                        "output": alias_image_json
                    }]),
                )
            };
            let raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": messages,
                    "input": input
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
                .unwrap_or_else(|error| {
                    panic!("equivalent dual history (include_parent={include_parent}) must merge cleanly at ReqInbound02: {error}")
                });
            let merged_messages = normalized.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            let tool_idx = usize::from(include_parent);
            assert!(
                merged_messages[tool_idx]["content"].is_array(),
                "ReqInbound02 must retain normalized image array regardless of parent presence (include_parent={include_parent}): {}",
                merged_messages[tool_idx]
            );
            assert_eq!(
                merged_messages[tool_idx]["routecodex_chat_extension"]
                    ["responses_tool_output_content"],
                json!(alias_image_json)
            );
        }

        // Legacy dual history (preceding assistant call in `messages`, tool output in both)
        let legacy_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [
                    {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_legacy_paired",
                            "type": "function",
                            "function": {"name": "read_image", "arguments": "{}"}
                        }]
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_legacy_paired",
                        "content": alias_image_json
                    }
                ],
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_legacy_paired",
                    "output": alias_image_json
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let legacy_normalized =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(legacy_raw)
                .expect("legacy dual history with preceding parent must merge cleanly");
        assert!(
            legacy_normalized.previous.payload.0["messages"][1]["content"].is_array(),
            "legacy dual merge must retain normalized image array: {}",
            legacy_normalized.previous.payload.0["messages"][1]
        );
    }

    #[test]
    fn dual_history_tool_search_output_prefers_exact_item_id_over_earlier_idless_row() {
        let tool_one =
            json!([{"type": "function", "name": "tool_one", "parameters": {"type": "object"}}]);
        let tool_two =
            json!([{"type": "function", "name": "tool_two", "parameters": {"type": "object"}}]);
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [
                    {
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": serde_json::to_string(&tool_one).unwrap(),
                        "routecodex_chat_extension": {
                            "responses_tool_output_type": "tool_search_output",
                            "responses_output_field": "tools",
                            "responses_status": "completed",
                            "responses_execution": "client"
                        }
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": serde_json::to_string(&tool_two).unwrap(),
                        "routecodex_chat_extension": {
                            "responses_tool_output_type": "tool_search_output",
                            "responses_output_field": "tools",
                            "responses_item_id": "tso_2",
                            "responses_status": "completed",
                            "responses_execution": "client"
                        }
                    }
                ],
                "input": [{
                    "type": "tool_search_output",
                    "id": "tso_2",
                    "call_id": "call_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": tool_two
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("exact item_id match must take precedence over earlier ID-less row");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(messages.len(), 2, "{messages:#?}");
        assert!(messages[0]["routecodex_chat_extension"]
            .get("responses_item_id")
            .is_none());
        assert_eq!(
            messages[0]["content"],
            json!(serde_json::to_string(&tool_one).unwrap())
        );
        assert_eq!(
            messages[1]["routecodex_chat_extension"]["responses_item_id"],
            json!("tso_2")
        );
        assert_eq!(
            messages[1]["content"],
            json!(serde_json::to_string(&tool_two).unwrap())
        );
    }

    #[test]
    fn dual_history_idless_input_before_exact_twin_tool_search_reserves_exact_item_id() {
        let tool_one =
            json!([{"type": "function", "name": "tool_one", "parameters": {"type": "object"}}]);
        let tool_two =
            json!([{"type": "function", "name": "tool_two", "parameters": {"type": "object"}}]);
        let raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": serde_json::to_string(&tool_two).unwrap(),
                    "routecodex_chat_extension": {
                        "responses_tool_output_type": "tool_search_output",
                        "responses_output_field": "tools",
                        "responses_item_id": "tso_2",
                        "responses_status": "completed",
                        "responses_execution": "client"
                    }
                }],
                "input": [
                    {
                        "type": "tool_search_output",
                        "call_id": "call_1",
                        "execution": "client",
                        "status": "completed",
                        "tools": tool_one
                    },
                    {
                        "type": "tool_search_output",
                        "id": "tso_2",
                        "call_id": "call_1",
                        "execution": "client",
                        "status": "completed",
                        "tools": tool_two
                    }
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("ID-less incoming receipt before exact twin must not steal exact item_id");
        let messages = normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(messages.len(), 2, "{messages:#?}");
        assert!(messages[0]["routecodex_chat_extension"]
            .get("responses_item_id")
            .is_none());
        assert_eq!(
            normalized.explicit_history_pairing.message_order(0),
            Some(0)
        );
        assert_eq!(
            messages[1]["routecodex_chat_extension"]["responses_item_id"],
            json!("tso_2")
        );
        assert_eq!(
            normalized.explicit_history_pairing.message_order(1),
            Some(1)
        );

        let with_trailing_user_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [
                    {
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": serde_json::to_string(&tool_two).unwrap(),
                        "routecodex_chat_extension": {
                            "responses_tool_output_type": "tool_search_output",
                            "responses_output_field": "tools",
                            "responses_item_id": "tso_2",
                            "responses_status": "completed",
                            "responses_execution": "client"
                        }
                    },
                    {
                        "role": "user",
                        "content": "follow up"
                    }
                ],
                "input": [
                    {
                        "type": "tool_search_output",
                        "call_id": "call_1",
                        "execution": "client",
                        "status": "completed",
                        "tools": tool_one
                    },
                    {
                        "type": "tool_search_output",
                        "id": "tso_2",
                        "call_id": "call_1",
                        "execution": "client",
                        "status": "completed",
                        "tools": tool_two
                    }
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let with_trailing_user =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(with_trailing_user_raw)
                .expect("ID-less incoming receipt before tso_2 with trailing Chat user row must preserve native order");
        let with_user_messages = with_trailing_user.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(with_user_messages.len(), 3, "{with_user_messages:#?}");
        assert!(with_user_messages[0]["routecodex_chat_extension"]
            .get("responses_item_id")
            .is_none());
        assert_eq!(
            with_trailing_user.explicit_history_pairing.message_order(0),
            Some(0)
        );
        assert_eq!(
            with_user_messages[1]["routecodex_chat_extension"]["responses_item_id"],
            json!("tso_2")
        );
        assert_eq!(
            with_trailing_user.explicit_history_pairing.message_order(1),
            Some(1)
        );
        assert_eq!(with_user_messages[2]["role"], json!("user"));
        assert_eq!(
            with_trailing_user.explicit_history_pairing.message_order(2),
            None
        );
    }

    #[test]
    fn dual_history_named_tool_output_merges_in_legacy_merge_and_respects_identity() {
        let encoded_image = r#"[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]"#;
        let empty_messages_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [],
                "input": [{
                    "type": "function_call_output",
                    "name": "send_message_to_thread",
                    "namespace": "codex_tui",
                    "output": encoded_image
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let empty_normalized =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(empty_messages_raw)
                .expect("named orphan output with empty messages must merge cleanly");
        let empty_merged = empty_normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(empty_merged.len(), 1, "{empty_merged:#?}");
        assert_eq!(empty_merged[0]["role"], "user");
        assert_eq!(
            empty_merged[0]["routecodex_chat_extension"]["responses_tool_output_name"],
            json!("send_message_to_thread")
        );
        assert_eq!(
            empty_merged[0]["routecodex_chat_extension"]["responses_tool_output_namespace"],
            json!("codex_tui")
        );
        let prov = empty_normalized
            .explicit_history_pairing
            .message_entry(0)
            .expect("named orphan provenance");
        assert!(prov.decoder_native_tool_output);
        assert!(prov.decoder_captured_responses_tool_output);
        assert_eq!(prov.message_input_order, Some(0));

        // Prior named output with exact item_id is reserved for exact incoming twin so an
        // earlier ID-less named output inserts before it without conflict.
        let twin_and_idless_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "user",
                    "content": "second-output",
                    "routecodex_chat_extension": {
                        "responses_tool_output_name": "send_message_to_thread",
                        "responses_tool_output_namespace": "codex_tui",
                        "responses_item_id": "fco_2"
                    }
                }],
                "input": [
                    {
                        "type": "function_call_output",
                        "name": "send_message_to_thread",
                        "namespace": "codex_tui",
                        "output": "first-output"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fco_2",
                        "name": "send_message_to_thread",
                        "namespace": "codex_tui",
                        "output": "second-output"
                    }
                ]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let twin_normalized =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(twin_and_idless_raw)
                .expect("named tool output exact item_id must reserve before ID-less match");
        let twin_messages = twin_normalized.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(twin_messages.len(), 2, "{twin_messages:#?}");
        assert_eq!(twin_messages[0]["content"], json!("first-output"));
        assert!(twin_messages[0]["routecodex_chat_extension"]
            .get("responses_item_id")
            .is_none());
        assert_eq!(
            twin_normalized.explicit_history_pairing.message_order(0),
            Some(0)
        );
        assert_eq!(twin_messages[1]["content"], json!("second-output"));
        assert_eq!(
            twin_messages[1]["routecodex_chat_extension"]["responses_item_id"],
            json!("fco_2")
        );
        assert_eq!(
            twin_normalized.explicit_history_pairing.message_order(1),
            Some(1)
        );

        // Existing named output fco_2 with only an ID-less distinct named output in `input`
        // must keep both receipts without falsely matching fco_2 by name/namespace alone.
        let idless_with_existing_fco_2_raw = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "user",
                    "content": "second-output",
                    "routecodex_chat_extension": {
                        "responses_tool_output_name": "send_message_to_thread",
                        "responses_tool_output_namespace": "codex_tui",
                        "responses_item_id": "fco_2"
                    }
                }],
                "input": [{
                    "type": "function_call_output",
                    "name": "send_message_to_thread",
                    "namespace": "codex_tui",
                    "output": "first-output"
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let idless_with_existing_fco_2 =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
                idless_with_existing_fco_2_raw,
            )
            .expect("ID-less named receipt must remain distinct from explicit fco_2 receipt");
        let distinct_messages = idless_with_existing_fco_2.previous.payload.0["messages"]
            .as_array()
            .expect("canonical Chat messages");
        assert_eq!(distinct_messages.len(), 2, "{distinct_messages:#?}");
        assert_eq!(distinct_messages[0]["content"], json!("second-output"));
        assert_eq!(
            distinct_messages[0]["routecodex_chat_extension"]["responses_item_id"],
            json!("fco_2")
        );
        assert_eq!(distinct_messages[1]["content"], json!("first-output"));
        assert!(distinct_messages[1]["routecodex_chat_extension"]
            .get("responses_item_id")
            .is_none());

        // Identical output text on fco_2 in `messages` and ID-less named receipt in `input`
        // (and vice versa) must bypass equal-length merge and keep both receipts.
        for (messages, input, first_id, second_id) in [
            (
                json!([{
                    "role": "user",
                    "content": "second-output",
                    "routecodex_chat_extension": {
                        "responses_tool_output_name": "send_message_to_thread",
                        "responses_tool_output_namespace": "codex_tui",
                        "responses_item_id": "fco_2"
                    }
                }]),
                json!([{
                    "type": "function_call_output",
                    "name": "send_message_to_thread",
                    "namespace": "codex_tui",
                    "output": "second-output"
                }]),
                Some("fco_2"),
                None,
            ),
            (
                json!([{
                    "role": "user",
                    "content": "second-output",
                    "routecodex_chat_extension": {
                        "responses_tool_output_name": "send_message_to_thread",
                        "responses_tool_output_namespace": "codex_tui"
                    }
                }]),
                json!([{
                    "type": "function_call_output",
                    "id": "fco_2",
                    "name": "send_message_to_thread",
                    "namespace": "codex_tui",
                    "output": "second-output"
                }]),
                None,
                Some("fco_2"),
            ),
        ] {
            let raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": messages,
                    "input": input
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
                .expect("equal-length named receipt with item_id mismatch must preserve both");
            let merged_messages = normalized.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            assert_eq!(merged_messages.len(), 2, "{merged_messages:#?}");
            assert_eq!(merged_messages[0]["content"], json!("second-output"));
            assert_eq!(
                merged_messages[0]["routecodex_chat_extension"]
                    .get("responses_item_id")
                    .and_then(Value::as_str),
                first_id
            );
            assert_eq!(merged_messages[1]["content"], json!("second-output"));
            assert_eq!(
                merged_messages[1]["routecodex_chat_extension"]
                    .get("responses_item_id")
                    .and_then(Value::as_str),
                second_id
            );
        }
    }

    #[test]
    fn dual_history_idless_tool_search_with_existing_explicit_tso_preserves_both_without_conflict()
    {
        let tool_one =
            json!([{"type": "function", "name": "tool_one", "parameters": {"type": "object"}}]);
        let tool_two =
            json!([{"type": "function", "name": "tool_two", "parameters": {"type": "object"}}]);
        for (input_tools, expected_second_tools) in [(&tool_one, &tool_one), (&tool_two, &tool_two)]
        {
            let raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": [{
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": serde_json::to_string(&tool_two).unwrap(),
                        "routecodex_chat_extension": {
                            "responses_tool_output_type": "tool_search_output",
                            "responses_output_field": "tools",
                            "responses_item_id": "tso_2",
                            "responses_status": "completed",
                            "responses_execution": "client"
                        }
                    }],
                    "input": [{
                        "type": "tool_search_output",
                        "call_id": "call_1",
                        "execution": "client",
                        "status": "completed",
                        "tools": input_tools
                    }]
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );

            let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
                .expect(
                    "ID-less tool_search_output with existing explicit tso_2 must preserve both",
                );
            let messages = normalized.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            assert_eq!(messages.len(), 2, "{messages:#?}");
            assert_eq!(
                messages[0]["routecodex_chat_extension"]["responses_item_id"],
                json!("tso_2")
            );
            assert_eq!(
                messages[0]["content"],
                json!(serde_json::to_string(&tool_two).unwrap())
            );
            assert!(messages[1]["routecodex_chat_extension"]
                .get("responses_item_id")
                .is_none());
            assert_eq!(
                messages[1]["content"],
                json!(serde_json::to_string(expected_second_tools).unwrap())
            );
        }

        // Non-tool-search call_id conflict must still fail.
        let non_tso_conflict = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "legacy-output"
                }],
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "different-output"
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let err = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(non_tso_conflict)
            .expect_err("non-tool-search conflicting outputs on same call_id must still fail");
        assert!(
            err.contains("conflicting tool output representations"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn dual_history_idless_function_output_with_existing_explicit_fco_preserves_both_without_conflict(
    ) {
        for incoming_output in ["second-output", "first-output"] {
            let raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": [{
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": "second-output",
                        "routecodex_chat_extension": {
                            "responses_item_id": "fco_2"
                        }
                    }],
                    "input": [{
                        "type": "function_call_output",
                        "call_id": "call_1",
                        "output": incoming_output
                    }]
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );

            let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
                .expect(
                    "ID-less function_call_output with existing explicit fco_2 must preserve both",
                );
            let messages = normalized.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            assert_eq!(messages.len(), 2, "{messages:#?}");
            assert_eq!(
                messages[0]["routecodex_chat_extension"]["responses_item_id"],
                json!("fco_2")
            );
            assert_eq!(messages[0]["content"], json!("second-output"));
            assert!(
                normalized
                    .explicit_history_pairing
                    .message_entry(0)
                    .is_some_and(|entry| entry.preserve_native_tool_output_id),
                "Responses-entry legacy tool output must retain preserve_native_tool_output_id"
            );
            assert!(messages[1]["routecodex_chat_extension"]
                .get("responses_item_id")
                .is_none());
            assert_eq!(messages[1]["content"], json!(incoming_output));

            // Inverse placement: ID-less legacy `messages` row + explicit `fco_2` in `input`
            // must also preserve both receipts for equal and unequal outputs.
            let inverse_raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": [{
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": "second-output"
                    }],
                    "input": [{
                        "type": "function_call_output",
                        "id": "fco_2",
                        "call_id": "call_1",
                        "output": incoming_output
                    }]
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let inverse_normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
                inverse_raw,
            )
            .expect("explicit fco_2 with existing ID-less legacy receipt must preserve both");
            let inverse_messages = inverse_normalized.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            assert_eq!(inverse_messages.len(), 2, "{inverse_messages:#?}");
            assert!(inverse_messages[0]
                .pointer("/routecodex_chat_extension/responses_item_id")
                .is_none());
            assert_eq!(inverse_messages[0]["content"], json!("second-output"));
            assert_eq!(
                inverse_messages[1]["routecodex_chat_extension"]["responses_item_id"],
                json!("fco_2")
            );
            assert_eq!(inverse_messages[1]["content"], json!(incoming_output));

            // Distinct item IDs (`fco_2` vs `fc_fco_2`) on same call_id must stay distinct.
            let distinct_ids_raw = raw_request(
                json!({
                    "model": "gpt-5.5",
                    "messages": [{
                        "role": "tool",
                        "tool_call_id": "call_1",
                        "content": "second-output",
                        "routecodex_chat_extension": {
                            "responses_item_id": "fco_2"
                        }
                    }],
                    "input": [{
                        "type": "function_call_output",
                        "id": "fc_fco_2",
                        "call_id": "call_1",
                        "output": incoming_output
                    }]
                }),
                V3HubEntryProtocol::Responses,
                V3HubInvocationSource::Client,
                V3HubTransportIntent::Json,
            );
            let distinct_ids =
                build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(distinct_ids_raw)
                    .expect("distinct fco_2 and fc_fco_2 receipts must preserve both");
            let distinct_messages = distinct_ids.previous.payload.0["messages"]
                .as_array()
                .expect("canonical Chat messages");
            assert_eq!(distinct_messages.len(), 2, "{distinct_messages:#?}");
            assert_eq!(
                distinct_messages[0]["routecodex_chat_extension"]["responses_item_id"],
                json!("fco_2")
            );
            assert!(distinct_ids
                .explicit_history_pairing
                .message_entry(0)
                .is_some_and(|entry| entry.preserve_native_tool_output_id));
            assert_eq!(
                distinct_messages[1]["routecodex_chat_extension"]["responses_item_id"],
                json!("fc_fco_2")
            );
            assert!(distinct_ids
                .explicit_history_pairing
                .message_entry(1)
                .is_some_and(|entry| entry.preserve_native_tool_output_id));
        }

        // Genuine twins sharing the same explicit item_id with conflicting outputs must still fail.
        let same_item_id_conflict = raw_request(
            json!({
                "model": "gpt-5.5",
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": "second-output",
                    "routecodex_chat_extension": {
                        "responses_item_id": "fco_2"
                    }
                }],
                "input": [{
                    "type": "function_call_output",
                    "id": "fco_2",
                    "call_id": "call_1",
                    "output": "first-output"
                }]
            }),
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let err =
            build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(same_item_id_conflict)
                .expect_err("same explicit item_id with conflicting outputs must still fail");
        assert!(
            err.contains("conflicting tool output representations"),
            "unexpected error: {err}"
        );
    }
}
