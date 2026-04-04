use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::super::AdapterContext;

include!("request/core_utils.rs");
include!("request/tool_ids.rs");
include!("request/tools.rs");
include!("request/function_call_ids.rs");
include!("request/input_stringify.rs");
include!("request/pipeline.rs");

fn empty_adapter_context() -> AdapterContext {
    AdapterContext {
        compatibility_profile: None,
        provider_protocol: None,
        request_id: None,
        entry_endpoint: None,
        route_id: None,
        rt: None,
        captured_chat_request: None,
        deepseek: None,
        claude_code: None,
        anthropic_thinking: None,
        estimated_input_tokens: None,
        model_id: None,
        client_model_id: None,
        original_model_id: None,
        provider_id: None,
        provider_key: None,
        runtime_key: None,
        client_request_id: None,
        group_request_id: None,
        session_id: None,
        conversation_id: None,
    }
}

pub(crate) fn apply_lmstudio_responses_input_stringify_json(
    payload_json: String,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let adapter_context: AdapterContext = match adapter_context_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => empty_adapter_context(),
    };

    if let Some(root) = payload.as_object_mut() {
        apply_lmstudio_responses_input_stringify(root, &adapter_context);
    }

    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}
