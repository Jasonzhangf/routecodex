//! Typed Direct response lifecycle and target-selected compatibility plan.
//!
//! This module owns hook ordering, compat selection and registered Direct
//! payload projection. It does not parse SSE frames, classify provider errors
//! or observe continuation. Those operations remain adjacent stage owners.

use crate::hub_v1::V3HubProviderWireProtocol;
use crate::hub_v1::V3ToolThinkingTurnContext;
use crate::runtime_timing::V3RuntimeTimingState;
use routecodex_v3_config::V3Config05ManifestPublished;

/// JSON admission has already decoded and accepted the complete provider
/// attempt. Publish that attempt and invert its actual declaration emission
/// through the registered Direct owner, before client payload commitment.
pub(crate) fn apply_v3_direct_json_successful_attempt_hook(
    payload: &mut serde_json::Value,
    protocol: V3HubProviderWireProtocol,
    request: &crate::operation_runner::V3RequestContextHandle,
    attempt: &crate::operation_runner::AttemptContext,
) -> Result<(), routecodex_v3_error::V3Error01SourceRaised> {
    let mut inverse = || -> Result<(), String> {
        request.publish_successful_attempt(attempt.clone())?;
        let view = crate::operation_runner::ResponseProjectionView::from_successful_attempt(
            request, attempt,
        )?;
        match protocol {
            V3HubProviderWireProtocol::Responses =>
                crate::hub_v1::restore_v3_responses_normalized_tool_identities_with_successful_attempt(payload, &view),
            V3HubProviderWireProtocol::OpenAiChat =>
                crate::hub_v1::restore_v3_chat_tool_identities_with_successful_attempt(payload, &view),
            _ => Ok(()),
        }.map_err(|error| format!("{error:?}"))
    };
    inverse().map_err(|error| routecodex_v3_error::build_v3_error_01_source_raised_internal(
        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
        "V3DirectResp15ClientPayloadReady",
        "direct_successful_attempt_inverse_failed",
        error,
        routecodex_v3_error::V3InternalErrorCode::V3DirectResp15ClientPayloadReady,
    ))
}

/// SSE admission has already buffered the complete provider terminal. Publish
/// the same actual attempt and invert the admitted client events through the
/// registered Direct owner before the sealed stream can commit.
pub(crate) fn apply_v3_direct_sse_successful_attempt_hook(
    builder: &mut crate::execution_control::V3CommittedClientSseBuilder,
    protocol: V3HubProviderWireProtocol,
    request: &crate::operation_runner::V3RequestContextHandle,
    attempt: &crate::operation_runner::AttemptContext,
) -> Result<(), routecodex_v3_error::V3Error01SourceRaised> {
    let mut inverse = || -> Result<(), String> {
        request.publish_successful_attempt(attempt.clone())?;
        let view = crate::operation_runner::ResponseProjectionView::from_successful_attempt(
            request, attempt,
        )?;
        let mut identities = DirectSseResponsesItemIdentities::default();
        builder
            .rewrite_frames_with_growth(|frame, writer| {
                rewrite_direct_sse_success_frame(frame, writer, protocol, &view, &mut identities)
            })
            .map_err(|error| error.to_string())
    };
    inverse().map_err(|error| routecodex_v3_error::build_v3_error_01_source_raised_internal(
        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
        "V3DirectResp15ClientPayloadReady",
        "direct_sse_successful_attempt_inverse_failed",
        error,
        routecodex_v3_error::V3InternalErrorCode::V3DirectResp15ClientPayloadReady,
    ))
}

fn rewrite_direct_sse_success_frame(
    frame: &[u8],
    writer: &mut dyn std::io::Write,
    protocol: V3HubProviderWireProtocol,
    view: &crate::operation_runner::ResponseProjectionView,
    identities: &mut DirectSseResponsesItemIdentities,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    crate::kernel::direct_runtime_helpers_stream::rewrite_direct_sse_frame_with_writer(
        frame,
        writer,
        |mut value| {
            let rewritten = match protocol {
                V3HubProviderWireProtocol::Responses => {
                    rewrite_direct_sse_responses_success_event(&mut value, view, identities)
                }
                V3HubProviderWireProtocol::OpenAiChat => {
                    rewrite_direct_sse_chat_success_event(&mut value, view, identities)
                }
                _ => Ok(()),
            };
            rewritten.map(|_| value)
        },
    )
}

/// Identity observed on the already-admitted Responses event stream. Argument
/// and custom-input events frequently omit `name`, so the preceding
/// `output_item.*` event supplies the emitted name by `item_id`/`output_index`.
#[derive(Default)]
struct DirectSseResponsesItemIdentities {
    by_item_id: std::collections::HashMap<String, String>,
    by_output_index: std::collections::HashMap<u64, String>,
    freeform_input: std::collections::HashMap<String, DirectFreeformInputCursor>,
}

/// Incremental decoder for the emitted free-form custom-tool envelope
/// `{"input": "<raw>"}`. A provider may split that JSON text at any byte, so the
/// hook keeps the raw bytes seen so far and the decoded raw-string prefix it has
/// already published to the client.
#[derive(Default)]
struct DirectFreeformInputCursor {
    raw: String,
    published: usize,
}

impl DirectFreeformInputCursor {
    /// Append one raw provider fragment and return the newly decoded raw
    /// characters that are safe to publish as the client delta.
    fn advance(&mut self, fragment: &str) -> String {
        self.raw.push_str(fragment);
        let decoded = decode_direct_freeform_input_prefix(&self.raw).unwrap_or_default();
        let published = self.published.min(decoded.chars().count());
        let delta: String = decoded.chars().skip(published).collect();
        self.published = published + delta.chars().count();
        delta
    }
}

/// Decode the free-form string already available in a possibly truncated
/// provider arguments payload. The emitted envelope is `{"input": "..."}`, but a
/// provider may also return a bare JSON string or ignore the envelope and return
/// the raw text itself, exactly as `parse_v3_openai_chat_custom_tool_input`
/// accepts those shapes.
fn decode_direct_freeform_input_prefix(raw: &str) -> Option<String> {
    let trimmed = raw.trim_start();
    match trimmed.as_bytes().first()? {
        b'"' => decode_direct_json_string_prefix(&trimmed[1..]),
        b'{' => {
            let key = trimmed.find("\"input\"")?;
            let rest = trimmed.get(key + "\"input\"".len()..)?.trim_start();
            let rest = rest.strip_prefix(':')?.trim_start();
            decode_direct_json_string_prefix(rest.strip_prefix('"')?)
        }
        _ => Some(trimmed.to_string()),
    }
}

/// Decode the JSON string body prefix available in `body`. The body may end in
/// the middle of the string, of an escape, or of a UTF-16 surrogate pair; only
/// characters that are already unambiguous are returned.
fn decode_direct_json_string_prefix(body: &str) -> Option<String> {
    let mut decoded = String::new();
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(decoded),
            '\\' => {
                let Some(escape) = chars.next() else {
                    return Some(decoded);
                };
                match escape {
                    '"' => decoded.push('"'),
                    '\\' => decoded.push('\\'),
                    '/' => decoded.push('/'),
                    'b' => decoded.push('\u{0008}'),
                    'f' => decoded.push('\u{000C}'),
                    'n' => decoded.push('\n'),
                    'r' => decoded.push('\r'),
                    't' => decoded.push('\t'),
                    'u' => {
                        let hex: String = chars.by_ref().take(4).collect();
                        if hex.len() < 4 {
                            return Some(decoded);
                        }
                        let Ok(code) = u16::from_str_radix(&hex, 16) else {
                            return Some(decoded);
                        };
                        if (0xD800..=0xDBFF).contains(&code) {
                            let mut pair = chars.clone();
                            if pair.next() != Some('\\') || pair.next() != Some('u') {
                                return Some(decoded);
                            }
                            let low_hex: String = pair.by_ref().take(4).collect();
                            if low_hex.len() < 4 {
                                return Some(decoded);
                            }
                            let Ok(low) = u16::from_str_radix(&low_hex, 16) else {
                                return Some(decoded);
                            };
                            let Some(combined) =
                                char::decode_utf16([code, low]).next().and_then(Result::ok)
                            else {
                                return Some(decoded);
                            };
                            decoded.push(combined);
                            chars = pair;
                        } else {
                            let Some(decoded_char) = char::from_u32(u32::from(code)) else {
                                return Some(decoded);
                            };
                            decoded.push(decoded_char);
                        }
                    }
                    _ => return Some(decoded),
                }
            }
            _ => decoded.push(ch),
        }
    }
    Some(decoded)
}

impl DirectSseResponsesItemIdentities {
    fn freeform_input_cursor(&mut self, key: String) -> &mut DirectFreeformInputCursor {
        self.freeform_input.entry(key).or_default()
    }

    fn event_freeform_key(value: &serde_json::Value) -> Option<String> {
        value
            .get("item_id")
            .and_then(serde_json::Value::as_str)
            .map(|item_id| format!("item:{item_id}"))
            .or_else(|| {
                value
                    .get("output_index")
                    .and_then(serde_json::Value::as_u64)
                    .map(|output_index| format!("index:{output_index}"))
            })
    }

    fn observe_item(&mut self, item: &serde_json::Value) {
        let Some(name) = item.get("name").and_then(serde_json::Value::as_str) else {
            return;
        };
        if let Some(item_id) = item.get("id").and_then(serde_json::Value::as_str) {
            self.by_item_id.insert(item_id.to_string(), name.to_string());
        }
    }

    fn observe_event_item(&mut self, value: &serde_json::Value) {
        let Some(item) = value.get("item") else {
            return;
        };
        if let (Some(output_index), Some(name)) = (
            value.get("output_index").and_then(serde_json::Value::as_u64),
            item.get("name").and_then(serde_json::Value::as_str),
        ) {
            self.by_output_index
                .insert(output_index, name.to_string());
        }
        self.observe_item(item);
    }

    fn emitted_name_for_event(&self, value: &serde_json::Value) -> Option<String> {
        value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                value
                    .get("item_id")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|item_id| self.by_item_id.get(item_id))
                    .cloned()
            })
            .or_else(|| {
                value
                    .get("output_index")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|output_index| self.by_output_index.get(&output_index))
                    .cloned()
            })
    }
}

fn rewrite_direct_sse_responses_success_event(
    value: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    identities: &mut DirectSseResponsesItemIdentities,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str);
    match event_type {
        Some("response.output_item.added") => {
            identities.observe_event_item(value);
            if let Some(item) = value.get_mut("item") {
                restore_direct_responses_sse_item(item, view, false)?;
            }
        }
        Some("response.output_item.done") => {
            identities.observe_event_item(value);
            if let Some(item) = value.get_mut("item") {
                restore_direct_responses_sse_item(item, view, true)?;
            }
        }
        Some("response.function_call_arguments.delta") => {
            restore_direct_responses_sse_argument_identity(value, view, identities, false)?;
        }
        Some("response.function_call_arguments.done") => {
            restore_direct_responses_sse_argument_identity(value, view, identities, true)?;
        }
        Some("response.custom_tool_call_input.delta") => {
            restore_direct_responses_sse_custom_identity(value, view, identities, false)?;
        }
        Some("response.custom_tool_call_input.done") => {
            restore_direct_responses_sse_custom_identity(value, view, identities, true)?;
        }
        Some("response.completed" | "response.done" | "response.incomplete") => {
            if let Some(output) = value
                .get("response")
                .and_then(|response| response.get("output"))
                .and_then(serde_json::Value::as_array)
            {
                for item in output {
                    identities.observe_item(item);
                }
            }
            if let Some(output) = value
                .get_mut("response")
                .and_then(serde_json::Value::as_object_mut)
                .and_then(|response| response.get_mut("output"))
                .and_then(serde_json::Value::as_array_mut)
            {
                for item in output {
                    restore_direct_responses_sse_item(item, view, true)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn restore_direct_responses_sse_item(
    item: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    complete: bool,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    crate::hub_v1::restore_v3_responses_output_item_identity_with_successful_attempt(
        item, view, complete,
    )
    .map_err(|error| {
        crate::execution_control::V3AttemptStoreError::InvalidAttemptState(error.to_string())
    })
}

fn restore_direct_responses_sse_argument_identity(
    value: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    identities: &mut DirectSseResponsesItemIdentities,
    complete: bool,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    let Some(emitted_name) = identities.emitted_name_for_event(value) else {
        return Ok(());
    };
    let Some(kind) = crate::hub_v1::declared_tool_kind_for_emitted_name(view, &emitted_name) else {
        return Ok(());
    };
    let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
        return Ok(());
    };
    let event_type = event_type.to_string();
    let original_name = declared_original_name(view, &emitted_name).ok_or_else(|| {
        crate::execution_control::V3AttemptStoreError::InvalidAttemptState(format!(
            "successful attempt mapping for `{emitted_name}` has no declaration record"
        ))
    })?;
    let complete = complete
        || value
            .get("arguments")
            .and_then(serde_json::Value::as_str)
            .is_some();
    match kind {
        crate::hub_v1::V3DeclaredToolKind::Function => {
            if complete {
                value["type"] = serde_json::Value::String(
                    "response.function_call_arguments.done".to_string(),
                );
            } else if event_type == "response.function_call_arguments.delta" {
                value["type"] = serde_json::Value::String(
                    "response.function_call_arguments.delta".to_string(),
                );
            }
            value["name"] = serde_json::Value::String(original_name);
        }
        crate::hub_v1::V3DeclaredToolKind::Custom => {
            value["type"] = serde_json::Value::String(if complete {
                "response.custom_tool_call_input.done".to_string()
            } else {
                "response.custom_tool_call_input.delta".to_string()
            });
            if complete {
                let arguments = value
                    .get("arguments")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let input = crate::hub_v1::parse_v3_openai_chat_custom_tool_input(
                    &emitted_name, &arguments,
                )
                .map_err(|error| {
                    crate::execution_control::V3AttemptStoreError::InvalidAttemptState(
                        error.to_string(),
                    )
                })?;
                value.as_object_mut().unwrap().remove("arguments");
                value["input"] = serde_json::Value::String(input);
            } else if crate::hub_v1::declared_custom_tool_emitted_as_function_envelope(
                view,
                &emitted_name,
            ) {
                // The provider streams this runtime's free-form envelope inside
                // `function_call_arguments` deltas. Publish the raw free-form
                // characters that are already unambiguous, not the envelope JSON.
                if let Some(fragment) = value
                    .get("delta")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                {
                    if let Some(key) = DirectSseResponsesItemIdentities::event_freeform_key(value) {
                        let decoded = identities.freeform_input_cursor(key).advance(&fragment);
                        value["delta"] = serde_json::Value::String(decoded);
                    }
                }
            }
            value["name"] = serde_json::Value::String(original_name);
        }
    }
    restore_declared_namespace(value, view, &emitted_name);
    Ok(())
}

fn restore_direct_responses_sse_custom_identity(
    value: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    identities: &DirectSseResponsesItemIdentities,
    complete: bool,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    let Some(emitted_name) = identities.emitted_name_for_event(value) else {
        return Ok(());
    };
    let Some(kind) = crate::hub_v1::declared_tool_kind_for_emitted_name(view, &emitted_name) else {
        return Ok(());
    };
    let original_name = declared_original_name(view, &emitted_name).ok_or_else(|| {
        crate::execution_control::V3AttemptStoreError::InvalidAttemptState(format!(
            "successful attempt mapping for `{emitted_name}` has no declaration record"
        ))
    })?;
    if kind != crate::hub_v1::V3DeclaredToolKind::Custom {
        value["type"] = serde_json::Value::String(if complete {
            "response.function_call_arguments.done".to_string()
        } else {
            "response.function_call_arguments.delta".to_string()
        });
        if complete {
            if let Some(input) = value.get("input").cloned() {
                value.as_object_mut().unwrap().remove("input");
                value["arguments"] = input;
            }
        } else {
            value.as_object_mut().unwrap().remove("input");
        }
    }
    value["name"] = serde_json::Value::String(original_name);
    restore_declared_namespace(value, view, &emitted_name);
    Ok(())
}

fn declared_original_name(
    view: &crate::operation_runner::ResponseProjectionView,
    emitted_name: &str,
) -> Option<String> {
    let mapping = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name))?;
    view.request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)?
        .name
        .clone()
}

fn restore_declared_namespace(
    value: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    emitted_name: &str,
) {
    let Some(mapping) = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name))
    else {
        return;
    };
    let Some(declaration) = view
        .request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)
    else {
        return;
    };
    match declaration.namespace.clone() {
        Some(namespace) => {
            value["namespace"] = namespace;
        }
        None => {
            value.as_object_mut().unwrap().remove("namespace");
        }
    }
}

fn rewrite_direct_sse_chat_success_event(
    value: &mut serde_json::Value,
    view: &crate::operation_runner::ResponseProjectionView,
    identities: &mut DirectSseResponsesItemIdentities,
) -> Result<(), crate::execution_control::V3AttemptStoreError> {
    let Some(choices) = value.get_mut("choices").and_then(serde_json::Value::as_array_mut) else {
        return Ok(());
    };
    for choice in choices {
        for container in ["delta", "message"] {
            let Some(calls) = choice
                .get_mut(container)
                .and_then(serde_json::Value::as_object_mut)
                .and_then(|object| object.get_mut("tool_calls"))
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let observed_name = call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| {
                        call.get("custom")
                            .and_then(|custom| custom.get("name"))
                            .and_then(serde_json::Value::as_str)
                    });
                let emitted_name = match observed_name {
                    Some(name)
                        if crate::hub_v1::declared_tool_kind_for_emitted_name(view, name).is_some() =>
                    {
                        identities
                            .by_output_index
                            .insert(index, name.to_string());
                        name.to_string()
                    }
                    _ => match identities.by_output_index.get(&index) {
                        Some(name) => name.clone(),
                        None => continue,
                    },
                };
                let custom_input = match call
                    .get("custom")
                    .and_then(|custom| custom.get("input"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                {
                    Some(input) => Some(input),
                    None => call
                        .get("function")
                        .and_then(|function| function.get("arguments"))
                        .and_then(serde_json::Value::as_str)
                        .filter(|_| {
                            crate::hub_v1::declared_custom_tool_emitted_as_function_envelope(
                                view,
                                &emitted_name,
                            )
                        })
                        .map(str::to_owned)
                        .map(|arguments| {
                            // The provider streams this runtime's free-form
                            // envelope inside `function.arguments` deltas. Publish
                            // the raw free-form characters already unambiguous.
                            identities
                                .freeform_input_cursor(format!("chat:{container}:{index}"))
                                .advance(&arguments)
                        }),
                };
                crate::hub_v1::restore_v3_chat_streamed_tool_call_identity_with_successful_attempt(
                    call,
                    view,
                    &emitted_name,
                    custom_input.as_deref(),
                )
                .map_err(|error| {
                    crate::execution_control::V3AttemptStoreError::InvalidAttemptState(
                        error.to_string(),
                    )
                })?;
            }
        }
    }
    Ok(())
}

/// The sole Direct response payload hook for protocol-neutral response cleanup.
/// Both buffered JSON and SSE consumers call this owner; neither transport
/// layer may reimplement response-id or cipher projection.
pub(crate) fn apply_v3_direct_response_projection_hooks(
    payload: &mut serde_json::Value,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
) {
    if !retain_response_cipher {
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(payload, false);
    }
    if strip_client_response_id {
        crate::shared::strip_v3_response_id_from_json_body(payload);
    }
}

pub(crate) fn apply_v3_memory_raw_capture_json_payload(
    payload: &mut serde_json::Value,
    manifest: &V3Config05ManifestPublished,
    request_id: &str,
) {
    if !manifest.memory_raw_capture.enabled {
        return;
    }
    let host_id = routecodex_v3_agent_memory::stable_host_id(&format!(
        "{}{}",
        manifest.memory_raw_capture.host_id_prefix, request_id
    ));
    let report =
        match routecodex_v3_agent_memory::capture_responses_json(payload, &host_id, request_id) {
            Ok(report) => report,
            Err(error) => {
                eprintln!("memory capture diagnostic request_id={request_id}: {error}");
                return;
            }
        };
    if report.memory_unit_found {
        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_payload(payload, &report);
        for captured in &report.captured {
            if let Err(error) = routecodex_v3_agent_memory::publish_l3_entry(
                &manifest.memory_raw_capture.project_root,
                captured,
            ) {
                eprintln!("memory l3 publication diagnostic request_id={request_id}: {error}");
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3DirectResponseCompatBlock {
    Passthrough,
    ThinkingTags,
    DeepseekConsoleGoResponseShape,
    /// Provider-private response compatibility (the `chat:*` / other
    /// non-`responses:*` profiles). The payload rewrite itself is owned by the
    /// single provider response compat owner
    /// (`provider_resp_compat_02_provider_compat` -> `run_resp_inbound_stage3_compat`),
    /// never by this Direct plan. This block only records that the Direct
    /// response path must invoke that owner with the configured profile.
    ProviderResponseCompat,
}

#[derive(Debug, Clone)]
pub struct V3DirectResponseCompatFacts<'a> {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: &'a str,
    pub model_capabilities: &'a [&'a str],
    pub compatibility_profile: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectResponseCompatPlan {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: String,
    pub blocks: Vec<V3DirectResponseCompatBlock>,
    /// Configured provider-private compat profile carried for the
    /// `ProviderResponseCompat` block. `None` when the plan does not select it.
    pub provider_compat_profile: Option<String>,
}

impl V3DirectResponseCompatPlan {
    pub fn has_block(&self, block: V3DirectResponseCompatBlock) -> bool {
        self.blocks.contains(&block)
    }

    /// The provider-private compat profile the Direct response path must pass
    /// to the provider response compat owner. Only present when the plan
    /// selected `ProviderResponseCompat`.
    pub fn provider_response_compat_profile(&self) -> Option<&str> {
        self.provider_compat_profile.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct V3DirectResponseCompatContext {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: String,
    pub model_capabilities: Vec<String>,
    pub compatibility_profile: Option<String>,
    pub tool_thinking_enabled: bool,
    pub toolreason_client_projection: bool,
    pub toolreason_observation_session_id: Option<String>,
    pub tool_thinking_turn_context: V3ToolThinkingTurnContext,
    pub(crate) runtime_timing: V3RuntimeTimingState,
}

impl V3DirectResponseCompatContext {
    pub(crate) fn with_runtime_timing(mut self, runtime_timing: V3RuntimeTimingState) -> Self {
        self.runtime_timing = runtime_timing;
        self
    }

    pub fn compile_plan(&self) -> Result<V3DirectResponseCompatPlan, String> {
        let capabilities = self
            .model_capabilities
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: self.provider_protocol,
            canonical_model_id: &self.canonical_model_id,
            model_capabilities: &capabilities,
            compatibility_profile: self.compatibility_profile.as_deref(),
        })
    }
}

pub fn compile_direct_response_compat_plan(
    facts: V3DirectResponseCompatFacts<'_>,
) -> Result<V3DirectResponseCompatPlan, String> {
    let profile = facts
        .compatibility_profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let supports_reasoning = facts
        .model_capabilities
        .iter()
        .any(|capability| matches!(capability.trim(), "reasoning" | "thinking"));
    let block = match profile.as_deref() {
        None => V3DirectResponseCompatBlock::Passthrough,
        // `chat:openai` is a declared Chat provider profile whose provider
        // response compat is a no-op; keep the fast path PR #236 added so the
        // plan stays Passthrough instead of routing a no-op through the owner.
        Some("chat:openai") if facts.provider_protocol == V3HubProviderWireProtocol::OpenAiChat => {
            V3DirectResponseCompatBlock::Passthrough
        }
        // Explicit no-op profile: resolving it through the provider response
        // compat owner would also yield passthrough, so keep it local.
        Some("compat:passthrough") => V3DirectResponseCompatBlock::Passthrough,
        Some("responses:thinking-tags" | "responses:cc" | "responses:deepseek-console-go")
            if facts.provider_protocol != V3HubProviderWireProtocol::Responses =>
        {
            return Err(format!(
                "unsupported direct response compatibility profile {} for protocol {:?} model {}",
                profile.as_deref().unwrap_or_default(),
                facts.provider_protocol,
                facts.canonical_model_id
            ));
        }
        Some("responses:thinking-tags" | "responses:cc")
            if facts.provider_protocol == V3HubProviderWireProtocol::Responses
                && supports_reasoning =>
        {
            V3DirectResponseCompatBlock::ThinkingTags
        }
        Some("responses:deepseek-console-go")
            if facts.provider_protocol == V3HubProviderWireProtocol::Responses
                && supports_reasoning =>
        {
            V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape
        }
        Some("responses:thinking-tags" | "responses:cc" | "responses:deepseek-console-go") => {
            return Err(format!(
                "direct response compatibility profile requires reasoning capability for model {}",
                facts.canonical_model_id
            ));
        }
        // Everything else is provider-private compat: the `chat:*` profiles and
        // any `responses:*` profile without a Direct-local Responses event
        // rewriter (for example `responses:lmstudio`). Relay applies all of
        // these through the single provider response compat owner; Direct must
        // reach the same owner instead of rejecting the request or
        // reimplementing the rewrite. The `responses:thinking-tags` /
        // `responses:cc` / `responses:deepseek-console-go` rewriters above are
        // already handled locally and never fall through, so this arm cannot
        // double-apply them.
        Some(_) => V3DirectResponseCompatBlock::ProviderResponseCompat,
    };
    Ok(V3DirectResponseCompatPlan {
        provider_protocol: facts.provider_protocol,
        canonical_model_id: facts.canonical_model_id.to_string(),
        blocks: vec![block],
        provider_compat_profile: (block == V3DirectResponseCompatBlock::ProviderResponseCompat)
            .then(|| profile.unwrap_or_default().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn successful_responses_sse_view(
        request_id: &str,
        raw: serde_json::Value,
    ) -> (
        crate::operation_runner::V3RequestContextHandle,
        crate::operation_runner::ResponseProjectionView,
    ) {
        use crate::operation_runner::{
            execute_v3_operation_runner_request_capture_client_json,
            execute_v3_operation_runner_request_normalize_losslessly, AttemptContext,
            AttemptDeclarationMap, AttemptProjectionContext, CurrentFieldAssociations,
            RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
            ResponseProjectionView, V3RequestContextHandle,
        };

        let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            format!("{request_id}-invocation"),
            format!("{request_id}-attempt"),
            RequestOriginKind::ClientEntry,
        );
        let captured = execute_v3_operation_runner_request_capture_client_json(raw)
            .expect("capture the client request");
        let canonical = execute_v3_operation_runner_request_normalize_losslessly(
            &handle,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("normalize the client request");
        let pair = handle.original_pair().expect("published inverse pair");
        let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        let (_wire, mappings) =
            crate::hub_v1::build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
                &canonical,
                &pair.inverse_context,
                &current,
            )
            .expect("emit Responses provider declarations");
        let attempt_id = format!("{request_id}-attempt");
        let attempt = AttemptContext {
            attempt_id: attempt_id.clone(),
            projection: AttemptProjectionContext {
                attempt_id: attempt_id.clone(),
                provider_protocol: "responses".to_string(),
                provider_model: "provider-model".to_string(),
                paths: Vec::new(),
            },
            declarations: AttemptDeclarationMap {
                attempt_id: attempt_id.clone(),
                provider_protocol: "responses".to_string(),
                provider_model: "provider-model".to_string(),
                tool_mappings: mappings,
            },
        };
        handle
            .publish_successful_attempt(attempt.clone())
            .expect("publish the successful attempt");
        let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt)
            .expect("build the successful attempt view");
        (handle, view)
    }

    fn emitted_tool_name(
        view: &crate::operation_runner::ResponseProjectionView,
        original_name: &str,
    ) -> String {
        let declaration = view
            .request_inverse_context()
            .tool_declarations
            .iter()
            .find(|declaration| declaration.name.as_deref() == Some(original_name))
            .unwrap_or_else(|| panic!("missing declaration for {original_name}"));
        view.attempt()
            .declarations
            .tool_mappings
            .iter()
            .find(|mapping| mapping.declaration_record_id == declaration.record_id)
            .and_then(|mapping| mapping.emitted_name.clone())
            .unwrap_or_else(|| panic!("missing emitted name for {original_name}"))
    }

    #[tokio::test]
    async fn direct_sse_inverse_restores_declared_tool_identity_after_terminal() {
        let (_handle, view) = successful_responses_sse_view(
            "req-direct-sse-inverse",
            json!({
                "model": "client-model",
                "input": [{"role": "user", "content": "use the declared tools"}],
                "tools": [
                    {
                        "type": "namespace",
                        "name": "functions",
                        "tools": [{
                            "type": "custom",
                            "name": "apply_patch",
                            "format": {"type": "text"}
                        }]
                    },
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}}
                        }
                    }
                ]
            }),
        );
        let custom_emitted = emitted_tool_name(&view, "apply_patch");
        let function_emitted = emitted_tool_name(&view, "exec_command");
        let function_arguments = "{\"cmd\":\"pwd\"}";
        let function_arguments_json =
            serde_json::to_string(function_arguments).expect("escape the function arguments");
        let frames = format!(
            "event: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"id\":\"call_custom\",\"type\":\"function_call\",\"name\":\"{custom_emitted}\",\"call_id\":\"call_custom\",\"arguments\":\"\"}}}}\n\n\
event: response.function_call_arguments.done\ndata: {{\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"item_id\":\"call_custom\",\"arguments\":\"{{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}}\"}}\n\n\
event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"id\":\"call_custom\",\"type\":\"custom_tool_call\",\"name\":\"apply_patch\",\"namespace\":\"functions\",\"call_id\":\"call_custom\",\"input\":\"*** Begin Patch\\n*** End Patch\"}}}}\n\n\
event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{{\"id\":\"call_function\",\"type\":\"function_call\",\"name\":\"{function_emitted}\",\"call_id\":\"call_function\",\"arguments\":{function_arguments_json}}}}}\n\n\
event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp-direct-sse-inverse\",\"status\":\"completed\",\"output\":[]}}}}\n\n"
        );
        let mut builder =
            crate::execution_control::V3CommittedClientSseBuilder::new();
        builder.push(frames.into_bytes()).expect("buffer the admitted frames");
        builder
            .mark_last_frame_as_terminal()
            .expect("mark the buffered terminal");
        let mut identities = DirectSseResponsesItemIdentities::default();
        builder
            .rewrite_frames_with_growth(|frame, writer| {
                rewrite_direct_sse_success_frame(
                    frame,
                    writer,
                    V3HubProviderWireProtocol::Responses,
                    &view,
                    &mut identities,
                )
            })
            .expect("rewrite the admitted client frames");
        let stream = builder
            .seal_after_validated_terminal()
            .expect("seal the rewritten attempt");
        let mut stream = stream;
        let mut rewritten = Vec::new();
        while let Some(frame) = futures_util::StreamExt::next(&mut stream).await {
            rewritten.extend_from_slice(&frame);
        }
        let rewritten = String::from_utf8(rewritten).expect("rewritten SSE is UTF-8");
        assert!(rewritten.contains(r#""type":"custom_tool_call""#), "{rewritten}");
        assert!(rewritten.contains(r#""name":"apply_patch""#), "{rewritten}");
        assert!(rewritten.contains(r#""namespace":"functions""#), "{rewritten}");
        assert!(
            rewritten.contains(r#""type":"response.custom_tool_call_input.done""#),
            "custom argument event must use the declared kind: {rewritten}"
        );
        assert!(rewritten.contains(r#""name":"exec_command""#), "{rewritten}");
        let function_frame = rewritten
            .split("\n\n")
            .find(|segment| segment.contains(r#""name":"exec_command""#))
            .expect("rewritten function frame");
        let function_value: serde_json::Value = serde_json::from_str(
            function_frame
                .split_once("data: ")
                .expect("function frame data")
                .1
                .trim(),
        )
        .expect("rewritten function frame is JSON");
        assert_eq!(
            function_value["item"]["arguments"], function_arguments,
            "function exact arguments must be preserved: {rewritten}"
        );
    }

    #[test]
    fn compat_plan_uses_configured_profile_and_canonical_model() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::Responses,
            canonical_model_id: "gpt-5.6-sol",
            model_capabilities: &["text", "reasoning"],
            compatibility_profile: Some("responses:thinking-tags"),
        })
        .expect("configured profile must compile");
        assert_eq!(plan.canonical_model_id, "gpt-5.6-sol");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::ThinkingTags]);
    }

    #[test]
    fn compat_plan_does_not_guess_from_provider_or_model() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::Responses,
            canonical_model_id: "cc-sol-looking-model",
            model_capabilities: &["text"],
            compatibility_profile: None,
        })
        .expect("missing profile must remain passthrough");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::Passthrough]);
    }

    #[test]
    fn compat_plan_accepts_chat_wire_profiles_for_direct() {
        // chat-wire same-protocol providers are routed through the Direct
        // kernel. Their configured profile is a provider-response-compat
        // profile (chat:*), not a Responses event rewriter; the plan must
        // carry it to the sole provider-response-compat owner instead of
        // rejecting the request. `chat:openai` is the one declared no-op: its
        // provider response compat is a passthrough, so the plan keeps it local
        // (asserted separately in
        // `chat_direct_accepts_openai_compat_profile_without_response_rewrite`).
        for profile in [
            "chat:glm",
            "chat:glm-unsupported-prompt-cache-key-verbosity",
            "chat:minimax",
            "chat:gemini",
            "chat:lmstudio",
        ] {
            let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
                provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
                canonical_model_id: "deepseek-v4.1-flash",
                model_capabilities: &["text"],
                compatibility_profile: Some(profile),
            })
            .unwrap_or_else(|error| panic!("chat-wire profile {profile} must compile: {error}"));
            assert_eq!(
                plan.blocks,
                vec![V3DirectResponseCompatBlock::ProviderResponseCompat],
                "profile {profile} must route through the provider response compat owner"
            );
            assert_eq!(
                plan.provider_compat_profile.as_deref(),
                Some(profile),
                "profile {profile} must be carried to the owner verbatim"
            );
        }
    }

    #[test]
    fn compat_plan_routes_unknown_responses_profile_to_owner_not_err() {
        // A `responses:*` profile without a Direct-local Responses event
        // rewriter (for example `responses:lmstudio`) must reach the single
        // provider response compat owner instead of hard-failing the Direct
        // path; the Responses event rewriters above keep their Err contract.
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::Responses,
            canonical_model_id: "lmstudio-model",
            model_capabilities: &["text"],
            compatibility_profile: Some("responses:lmstudio"),
        })
        .expect("responses:lmstudio must compile through the owner");
        assert_eq!(
            plan.blocks,
            vec![V3DirectResponseCompatBlock::ProviderResponseCompat]
        );
        assert_eq!(
            plan.provider_compat_profile.as_deref(),
            Some("responses:lmstudio")
        );
    }

    #[test]
    fn compat_plan_keeps_passthrough_for_compat_passthrough() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "glm-5.2",
            model_capabilities: &["text"],
            compatibility_profile: Some("compat:passthrough"),
        })
        .expect("compat:passthrough must compile");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::Passthrough]);
    }

    #[test]
    fn compat_plan_rejects_profile_protocol_mismatch() {
        let error = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "gpt-5.6-sol",
            model_capabilities: &["text"],
            compatibility_profile: Some("responses:thinking-tags"),
        })
        .expect_err("responses profile must not attach to Chat direct");
        assert!(error.contains("unsupported direct response compatibility profile"));
    }

    #[test]
    fn chat_direct_accepts_openai_compat_profile_without_response_rewrite() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "deepseek-v4.1-flash",
            model_capabilities: &["text", "tools"],
            compatibility_profile: Some("chat:openai"),
        })
        .expect("chat:openai is a declared Chat provider profile");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::Passthrough]);
        let mixed_case = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "deepseek-v4.1-flash",
            model_capabilities: &["text", "tools"],
            compatibility_profile: Some("chat:OpenAI"),
        })
        .expect("profile matching follows request compat normalization");
        assert_eq!(
            mixed_case.blocks,
            vec![V3DirectResponseCompatBlock::Passthrough]
        );
    }

    #[test]
    fn direct_response_projection_preserves_function_output_cipher_only() {
        let mut payload = json!({
            "output": [
                {
                    "type": "reasoning",
                    "encrypted_content": "rsn_reasoning_cipher"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "encrypted_content": "rsn_opaque_function_output"
                }
            ]
        });

        apply_v3_direct_response_projection_hooks(&mut payload, false, false);

        assert!(payload["output"][0].get("encrypted_content").is_none());
        assert_eq!(
            payload["output"][1]["encrypted_content"],
            "rsn_opaque_function_output"
        );
    }
}
