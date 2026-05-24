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

fn lmstudio_stringify_input_enabled(adapter_context: &AdapterContext) -> bool {
    if let Some(override_value) = read_rt_bool(adapter_context, "lmstudioStringifyInputEnabled")
    {
        return override_value;
    }
    matches!(
        std::env::var("LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT").ok().as_deref(),
        Some("1")
    ) || matches!(
        std::env::var("ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT").ok().as_deref(),
        Some("1")
    )
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
