pub(crate) fn apply_lmstudio_request_compat(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    sanitize_lmstudio_tools(root);
    normalize_lmstudio_tool_choice(root);
    apply_lmstudio_responses_input_stringify(root, adapter_context);
    normalize_lmstudio_tool_call_ids(root);
    apply_lmstudio_responses_fc_ids(root);
}
