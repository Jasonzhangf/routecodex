use super::*;

pub(crate) fn allocate_v3_console_request_id(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<String, Box<Response<Body>>> {
    allocate_v3_console_request_identity(state, endpoint, payload)
        .map(|identity| identity.request_id)
}

pub(crate) fn allocate_v3_console_request_identity(
    state: &Arc<V3ListenerState>,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<V3AllocatedRequestIdentity, Box<Response<Body>>> {
    next_v3_console_request_identity(state, endpoint, payload).map_err(|message| {
        let output = project_v3_debug_failure(
            "V3RequestIdCounter01Allocated",
            V3DebugError::MalformedFixture(message),
        );
        emit_v3_error_console_line_for_state(
            state,
            endpoint,
            "request-id-unavailable",
            output.status,
            &output.error_chain,
            Some(&output.body),
            None,
        );
        Box::new(foundation_output_response(output))
    })
}

pub(crate) fn next_v3_console_request_identity(
    state: &V3ListenerState,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<V3AllocatedRequestIdentity, String> {
    let entry = format_v3_request_id_entry(endpoint);
    let provider = "router";
    let model = format_v3_request_id_token(
        payload
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
    );
    state
        .request_counter
        .lock()
        .map_err(|_| "V3 request id counter lock is poisoned".to_string())?
        .next_request_identity(&entry, provider, &model)
}

pub(crate) fn format_v3_request_id_entry(endpoint: &str) -> String {
    let raw = endpoint.to_ascii_lowercase();
    if raw.contains("/v1/responses") {
        "openai-responses".to_string()
    } else if raw.contains("/v1/messages") || raw.contains("/anthropic") {
        "anthropic-messages".to_string()
    } else {
        "openai-chat".to_string()
    }
}

pub(crate) fn format_v3_request_id_token(value: &str) -> String {
    let mut token: String = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
        .collect();
    if token
        .chars()
        .next()
        .is_some_and(|character| !character.is_ascii_alphabetic())
    {
        token.remove(0);
    }
    if token.is_empty() {
        "unknown".to_string()
    } else {
        token
    }
}
