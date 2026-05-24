use serde_json::Value;

fn is_canonical_chat_completion(payload: &Value) -> bool {
    let Some(row) = payload.as_object() else {
        return false;
    };
    let Some(choices) = row.get("choices").and_then(|v| v.as_array()) else {
        return false;
    };
    let Some(first) = choices.first().and_then(|v| v.as_object()) else {
        return false;
    };
    first.get("message").and_then(|v| v.as_object()).is_some()
}

pub(crate) fn coerce_to_canonical_chat_completion(payload: &Value) -> (Value, bool) {
    if is_canonical_chat_completion(payload) {
        return (payload.clone(), false);
    }

    let Ok(payload_json) = serde_json::to_string(payload) else {
        return (payload.clone(), false);
    };
    let Ok(raw) = crate::shared_responses_response_utils::build_chat_response_from_responses_json(
        payload_json,
    ) else {
        return (payload.clone(), false);
    };
    let Ok(coerced) = serde_json::from_str::<Value>(&raw) else {
        return (payload.clone(), false);
    };
    if is_canonical_chat_completion(&coerced) {
        return (coerced, true);
    }
    (payload.clone(), false)
}
