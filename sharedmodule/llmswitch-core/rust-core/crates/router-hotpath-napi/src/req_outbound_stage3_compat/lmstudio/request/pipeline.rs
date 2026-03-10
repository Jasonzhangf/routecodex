pub(crate) fn apply_lmstudio_request_compat(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    apply_lmstudio_responses_input_stringify(root, adapter_context);
    normalize_lmstudio_tool_call_ids(root);
    apply_lmstudio_responses_fc_ids(root);
    if root.get("tool_choice").map(|v| v.is_object()).unwrap_or(false) {
        root.insert(
            "tool_choice".to_string(),
            Value::String("required".to_string()),
        );
    }
}
