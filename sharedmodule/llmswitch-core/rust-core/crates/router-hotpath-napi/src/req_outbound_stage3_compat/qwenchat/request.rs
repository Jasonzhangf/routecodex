use super::tool_definitions::normalize_qwenchat_tool_definitions;
use serde_json::{Map, Value};

pub(crate) fn apply_qwenchat_request_compat(root: &Map<String, Value>) -> Value {
    let mut next = root.clone();
    if let Some(normalized_tools) = normalize_qwenchat_tool_definitions(root) {
        next.insert("tools".to_string(), normalized_tools);
    }
    Value::Object(next)
}
