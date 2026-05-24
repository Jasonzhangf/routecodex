use napi_derive::napi;

use crate::resp_process_stage1_tool_governance_blocks::napi_utilities::{
    collect_tool_names_from_candidate, normalize_apply_patch_arguments,
    resolve_requested_tool_names, validate_apply_patch_arguments,
};

/// Collect tool names from a candidate (array of tools) and return as JSON array.
#[napi]
pub fn collect_tool_names_from_candidate_json(candidate_json: String) -> napi::Result<String> {
    let candidate: serde_json::Value = serde_json::from_str(&candidate_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let names = collect_tool_names_from_candidate(&candidate);
    serde_json::to_string(&names)
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

/// Resolve requested tool names from multiple sources in one call.
#[napi]
pub fn resolve_requested_tool_names_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let names = resolve_requested_tool_names(&input);
    serde_json::to_string(&names)
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

#[napi]
pub fn normalize_apply_patch_arguments_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    serde_json::to_string(&normalize_apply_patch_arguments(&input))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

#[napi]
pub fn validate_apply_patch_arguments_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    serde_json::to_string(&validate_apply_patch_arguments(&input))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}
