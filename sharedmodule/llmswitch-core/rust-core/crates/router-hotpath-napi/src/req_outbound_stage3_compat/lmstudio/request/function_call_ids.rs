fn apply_lmstudio_responses_fc_ids(root: &mut Map<String, Value>) {
    let Some(input) = root.get_mut("input").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let mut call_counter: usize = 0;
    for item in input {
        let Some(item_obj) = item.as_object_mut() else {
            continue;
        };
        let item_type = item_obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "function_call" && item_type != "function_call_output" {
            continue;
        }
        call_counter += 1;
        let raw_call_id = pick_trimmed_string_values(&[
            item_obj.get("call_id"),
            item_obj.get("tool_call_id"),
            item_obj.get("id"),
        ]);
        let fallback_call = format!("call_{}", call_counter);
        let normalized_call_id =
            normalize_responses_call_id(raw_call_id.as_deref(), Some(fallback_call.as_str()));
        item_obj.insert(
            "call_id".to_string(),
            Value::String(normalized_call_id.clone()),
        );
        if item_type == "function_call" {
            let fallback_item_id = format!("fc_{}", normalized_call_id);
            let normalized_item_id = normalize_function_call_id(
                Some(normalized_call_id.as_str()),
                Some(fallback_item_id.as_str()),
            );
            item_obj.insert("id".to_string(), Value::String(normalized_item_id));
            continue;
        }
        let existing_id = pick_trimmed_string_values(&[item_obj.get("id")]);
        let fallback_output_id = existing_id
            .clone()
            .unwrap_or_else(|| format!("fc_tool_{}", call_counter));
        let normalized_output_id = normalize_function_call_id(
            Some(normalized_call_id.as_str()),
            Some(fallback_output_id.as_str()),
        );
        item_obj.insert("id".to_string(), Value::String(normalized_output_id));
    }
}
