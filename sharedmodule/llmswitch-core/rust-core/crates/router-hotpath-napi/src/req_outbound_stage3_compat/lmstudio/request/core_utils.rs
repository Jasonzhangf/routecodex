use crate::shared_tool_call_id_core::normalize_prefixed_tool_call_id;

fn provider_protocol_matches(protocol: Option<&String>, expected: &str) -> bool {
    if let Some(protocol) = protocol {
        return protocol.trim().eq_ignore_ascii_case(expected);
    }
    false
}

fn read_rt_bool(adapter_context: &AdapterContext, key: &str) -> Option<bool> {
    adapter_context
        .rt
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|row| row.get(key))
        .and_then(|value| value.as_bool())
}

fn normalize_with_fallback(call_id: Option<&str>, fallback: Option<&str>, prefix: &str) -> String {
    normalize_prefixed_tool_call_id(call_id, fallback, prefix)
}

fn normalize_responses_call_id(call_id: Option<&str>, fallback: Option<&str>) -> String {
    normalize_with_fallback(call_id, fallback, "call_")
}

fn normalize_function_call_id(call_id: Option<&str>, fallback: Option<&str>) -> String {
    normalize_with_fallback(call_id, fallback, "fc_")
}
