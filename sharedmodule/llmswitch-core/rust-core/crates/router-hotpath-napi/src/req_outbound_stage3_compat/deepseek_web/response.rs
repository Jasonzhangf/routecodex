use serde_json::Value;

use crate::resp_process_stage1_tool_governance::{
    govern_response, harvest_text_tool_calls_from_payload, ToolGovernanceInput,
};

use self::envelope::normalize_deepseek_business_envelope;
use self::tool_state::{
    count_tool_calls_from_choices, resolve_deepseek_options, resolve_tool_choice_required,
};
use super::markup::{
    ensure_finish_reason_tool_calls, harvest_function_results_markup,
    mark_function_results_harvested, write_deepseek_tool_state,
};
use super::usage::apply_usage_estimate;
use super::AdapterContext;

mod envelope;
mod tool_state;

fn set_skip_global_text_harvest(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    root.insert(
        "__rcc_tool_governance".to_string(),
        serde_json::json!({
            "skipTextHarvest": true
        }),
    );
}

fn strip_skip_global_text_harvest(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    root.remove("__rcc_tool_governance");
}

pub(crate) fn apply_deepseek_web_response_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Result<Value, String> {
    let mut normalized = normalize_deepseek_business_envelope(payload)?;
    let harvested_function_results = harvest_function_results_markup(&mut normalized);
    let before_count = count_tool_calls_from_choices(&normalized);
    harvest_text_tool_calls_from_payload(&mut normalized);
    set_skip_global_text_harvest(&mut normalized);

    let request_id = adapter_context
        .request_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "req_deepseek_web_compat".to_string());

    let mut governed = match govern_response(ToolGovernanceInput {
        payload: normalized.clone(),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id,
    }) {
        Ok(output) => output.governed_payload,
        Err(_) => {
            strip_skip_global_text_harvest(&mut normalized);
            normalized
        }
    };
    let (strict_tool_required, text_tool_fallback) = resolve_deepseek_options(adapter_context);
    ensure_finish_reason_tool_calls(&mut governed);
    if harvested_function_results {
        mark_function_results_harvested(&mut governed);
    }

    let after_count = count_tool_calls_from_choices(&governed);
    let (state, source) = if after_count <= 0 {
        ("no_tool_calls", "none")
    } else if before_count > 0 {
        ("native_tool_calls", "native")
    } else {
        ("text_tool_calls", "fallback")
    };
    write_deepseek_tool_state(&mut governed, state, source);
    apply_usage_estimate(&mut governed, adapter_context);

    let tool_choice_required = resolve_tool_choice_required(adapter_context);
    if tool_choice_required && strict_tool_required && after_count <= 0 {
        return Err(format!(
            "DeepSeek tool_choice=required but no valid tool call was produced (fallbackEnabled={}, strictToolRequired={})",
            text_tool_fallback, strict_tool_required
        ));
    }

    Ok(governed)
}
