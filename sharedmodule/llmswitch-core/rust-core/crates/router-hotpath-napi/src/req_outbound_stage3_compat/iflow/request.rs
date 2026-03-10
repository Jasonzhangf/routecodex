mod kimi;
mod search;
mod tool_text_fallback;

use serde_json::Value;

use super::super::AdapterContext;
use kimi::apply_iflow_kimi_request_compat;
use search::apply_iflow_web_search_request_transform;
use tool_text_fallback::apply_iflow_tool_text_fallback;
pub(crate) use tool_text_fallback::apply_iflow_tool_text_fallback_json;

pub(crate) fn apply_iflow_request_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };

    apply_iflow_web_search_request_transform(root, adapter_context);
    apply_iflow_tool_text_fallback(root, adapter_context, &["minimax-m2.5".to_string()]);
    if !apply_iflow_kimi_request_compat(root) {
        return payload;
    }
    payload
}
