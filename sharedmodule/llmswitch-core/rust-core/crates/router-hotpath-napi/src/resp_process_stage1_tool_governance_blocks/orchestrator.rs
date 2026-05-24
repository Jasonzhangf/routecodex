use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::resp_process_stage1_tool_governance_blocks::canonical_chat_completion::coerce_to_canonical_chat_completion;
use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    sanitize_payload_tool_markup_fields, strip_orphan_function_calls_tag,
};
use crate::resp_process_stage1_tool_governance_blocks::message_content::normalize_thinking_only_reasoning_content;
use crate::resp_process_stage1_tool_governance_blocks::napi_utilities::{
    collect_tool_names_from_candidate, normalize_apply_patch_arguments,
    resolve_requested_tool_names, validate_apply_patch_arguments,
};
use crate::resp_process_stage1_tool_governance_blocks::requested_tools::{
    copy_internal_tool_governance_state, inject_requested_tool_names_into_internal_governance,
    strip_internal_tool_governance_state,
};
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_detection::{
    detect_unharvested_text_tool_markup, resolve_text_harvest_enabled,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_call_governance::{
    count_normalized_tool_calls, drop_disallowed_tool_calls_from_payload,
    maybe_harvest_empty_tool_calls_from_json_content, normalize_apply_patch_tool_calls,
    remap_tool_calls_for_client_protocol,
};
use crate::resp_process_stage1_tool_governance_blocks::tool_call_entry::ensure_payload_tool_call_ids;

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceInput {
    pub payload: Value,
    pub client_protocol: String,
    pub entry_endpoint: String,
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceSummary {
    pub applied: bool,
    pub tool_calls_normalized: i64,
    pub apply_patch_repaired: i64,
    pub disallowed_tool_calls_dropped: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolGovernancePreparationSummary {
    pub converted: bool,
    pub shape_sanitized: bool,
    pub harvested_tool_calls: i64,
}

#[derive(Debug, Deserialize)]
struct GovernResponseJsonInput {
    pub payload: Value,
    pub client_protocol: String,
    pub entry_endpoint: String,
    pub request_id: String,
    #[serde(default)]
    pub prepared: bool,
    #[serde(default)]
    pub preparation_summary: Option<ToolGovernancePreparationSummary>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernancePreparationOutput {
    pub prepared_payload: Value,
    pub summary: ToolGovernancePreparationSummary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ToolGovernanceOutput {
    pub governed_payload: Value,
    pub summary: ToolGovernanceSummary,
}



#[napi]
pub fn strip_orphan_function_calls_tag_json(payload_json: String) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }
    let mut payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    strip_orphan_function_calls_tag(&mut payload);
    serde_json::to_string(&payload)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize payload: {}", e)))
}



pub(crate) fn prepare_payload_for_governance_with_requested_tool_names(
    payload: &Value,
    requested_tool_names: &[String],
) -> Result<ToolGovernancePreparationOutput, String> {
    let (mut prepared_payload, converted) = coerce_to_canonical_chat_completion(payload);
    copy_internal_tool_governance_state(payload, &mut prepared_payload);
    inject_requested_tool_names_into_internal_governance(
        &mut prepared_payload,
        requested_tool_names,
    );
    let harvested_tool_calls = if resolve_text_harvest_enabled(&prepared_payload) {
        maybe_harvest_empty_tool_calls_from_json_content(&mut prepared_payload)
    } else {
        0
    };
    let thinking_reasoning_normalized =
        normalize_thinking_only_reasoning_content(&mut prepared_payload);
    let sanitized_tool_markup = sanitize_payload_tool_markup_fields(&mut prepared_payload);
    let before_strip = prepared_payload.clone();
    strip_orphan_function_calls_tag(&mut prepared_payload);
    let shape_sanitized = harvested_tool_calls > 0
        || converted
        || thinking_reasoning_normalized > 0
        || sanitized_tool_markup > 0
        || prepared_payload != before_strip;

    Ok(ToolGovernancePreparationOutput {
        prepared_payload,
        summary: ToolGovernancePreparationSummary {
            converted,
            shape_sanitized,
            harvested_tool_calls,
        },
    })
}

pub(crate) fn prepare_payload_for_governance(
    payload: &Value,
) -> Result<ToolGovernancePreparationOutput, String> {
    prepare_payload_for_governance_with_requested_tool_names(payload, &[])
}

fn govern_prepared_payload(
    mut payload: Value,
    client_protocol: &str,
    request_id: &str,
    preparation_summary: Option<&ToolGovernancePreparationSummary>,
) -> Result<ToolGovernanceOutput, String> {
    let tool_call_ids_assigned = ensure_payload_tool_call_ids(&mut payload, request_id)?;

    let apply_patch_repaired = normalize_apply_patch_tool_calls(&mut payload);
    let disallowed_tool_calls_dropped = drop_disallowed_tool_calls_from_payload(&mut payload);
    if let Some(reason) = detect_unharvested_text_tool_markup(&payload) {
        return Err(format!(
            "unharvested_text_tool_markup: explicit tool payload/tool wrapper was emitted but no valid tool_calls were recovered ({})",
            reason
        ));
    }
    remap_tool_calls_for_client_protocol(&mut payload, client_protocol);
    strip_internal_tool_governance_state(&mut payload);
    let tool_calls_normalized = count_normalized_tool_calls(&payload);

    let prepared_applied = preparation_summary
        .map(|summary| summary.harvested_tool_calls > 0 || summary.shape_sanitized)
        .unwrap_or(false);
    let applied = prepared_applied
        || tool_call_ids_assigned > 0
        || tool_calls_normalized > 0
        || apply_patch_repaired > 0
        || disallowed_tool_calls_dropped > 0;

    Ok(ToolGovernanceOutput {
        governed_payload: payload,
        summary: ToolGovernanceSummary {
            applied,
            tool_calls_normalized,
            apply_patch_repaired,
            disallowed_tool_calls_dropped,
        },
    })
}

pub fn govern_response(input: ToolGovernanceInput) -> Result<ToolGovernanceOutput, String> {
    let prepared = prepare_payload_for_governance(&input.payload)?;
    let payload = prepared.prepared_payload;
    let preparation_summary = Some(prepared.summary);

    govern_prepared_payload(
        payload,
        input.client_protocol.as_str(),
        input.request_id.as_str(),
        preparation_summary.as_ref(),
    )
}

#[napi]
pub fn govern_response_json(input_json: String) -> napi::Result<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: GovernResponseJsonInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;
    let output = if input.prepared {
        govern_prepared_payload(
            input.payload,
            input.client_protocol.as_str(),
            input.request_id.as_str(),
            input.preparation_summary.as_ref(),
        )
    } else {
        govern_response(ToolGovernanceInput {
            payload: input.payload,
            client_protocol: input.client_protocol,
            entry_endpoint: input.entry_endpoint,
            request_id: input.request_id,
        })
    }
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[napi]
pub fn prepare_resp_process_tool_governance_payload_json(
    payload_json: String,
) -> napi::Result<String> {
    if payload_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Payload JSON is empty"));
    }
    let input: Value = serde_json::from_str(&payload_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse payload JSON: {}", e)))?;
    let (payload, requested_tool_names) = if let Some(root) = input.as_object() {
        if root.contains_key("payload") {
            let payload = root.get("payload").cloned().unwrap_or(Value::Null);
            let requested_tool_names = root
                .get("requested_tool_names")
                .or_else(|| root.get("requestedToolNames"))
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_string())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            (payload, requested_tool_names)
        } else {
            (input, Vec::new())
        }
    } else {
        (input, Vec::new())
    };
    let output = prepare_payload_for_governance_with_requested_tool_names(
        &payload,
        requested_tool_names.as_slice(),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}
