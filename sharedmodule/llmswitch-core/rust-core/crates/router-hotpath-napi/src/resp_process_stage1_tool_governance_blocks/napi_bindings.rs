use napi_derive::napi;

use crate::resp_process_stage1_tool_governance_blocks::napi_utilities::{
    normalize_apply_patch_arguments, validate_apply_patch_arguments,
};

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
