// V3 server error/client-frame projection shell.
// This module only projects Error06/foundation outputs into Server16 frames and
// response bodies. It must not own Error01-05 policy, provider health, routing,
// continuation, or provider protocol semantics.

use super::*;

pub(super) fn insert_v3_projection_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &str,
) {
    headers.insert(
        name,
        HeaderValue::from_str(value)
            .expect("V3 binding projection header value is validated ASCII"),
    );
}

pub(super) struct V3ErrorProjectionConsoleInput<'input> {
    pub(super) endpoint: &'input str,
    pub(super) request_id: &'input str,
    pub(super) status: u16,
    pub(super) error_chain: &'input [&'static str],
    pub(super) body: Option<&'input Value>,
    pub(super) project_path: Option<&'input str>,
}

pub(super) fn record_and_emit_v3_error_projection(
    state: &V3ListenerState,
    trace_scope: &routecodex_v3_debug::V3DebugTraceScope,
    input: V3ErrorProjectionConsoleInput<'_>,
) -> Option<Response<Body>> {
    if let Err(error) = state.debug.record_node_event(
        trace_scope,
        "V3Error06ClientProjected",
        "projected",
        Some(json!({
            "status": input.status,
            "error_chain": input.error_chain,
            "body": input.body
        })),
    ) {
        return Some(foundation_output_response(project_v3_debug_failure(
            "V3Error06ClientProjected",
            error,
        )));
    }
    emit_v3_error_console_line_for_state(
        state,
        input.endpoint,
        input.request_id,
        input.status,
        input.error_chain,
        input.body,
        input.project_path,
    );
    None
}

pub fn build_v3_server_16_http_frame_from_v3_error_06(
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> V3Server16HttpFrame {
    let body = projected.body;
    V3Server16HttpFrame {
        status: projected.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(body.clone()),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: projected.chain[5],
        error_chain: projected.chain.to_vec(),
        error_body: Some(body),
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    }
}

pub fn build_v3_server_16_http_frame_from_v3_foundation_output(
    output: V3FoundationRuntimeOutput,
) -> V3Server16HttpFrame {
    let error_body = if output.error_chain.is_empty() {
        None
    } else {
        Some(output.body.clone())
    };
    V3Server16HttpFrame {
        status: output.status,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(output.body),
        debug_node: output.debug_node,
        error_node: output.error_node,
        error_chain: output.error_chain,
        error_body,
        node_trace: output.node_trace,
        observability: None,
        stream_observation: None,
    }
}

pub(super) fn project_http_input_error(
    kind: V3HttpBoundaryErrorKind,
    message: impl Into<String>,
) -> routecodex_v3_error::V3Error06ClientProjected {
    project_v3_http_boundary_error(kind, message)
}

pub(super) fn error_output_response_for_server(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
) -> Response<Body> {
    error_output_response_for_server_with_project_path(
        server, endpoint, request_id, projected, None,
    )
}

pub(super) fn error_output_response_for_server_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(frame)
}

pub(super) fn error_output_response_for_responses_request_with_project_path(
    server: &V3ServerManifest,
    endpoint: &str,
    request_id: &str,
    projected: routecodex_v3_error::V3Error06ClientProjected,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
    project_path: Option<&str>,
) -> Response<Body> {
    let frame = build_v3_server_16_http_frame_from_v3_error_06(projected);
    emit_v3_frame_error_console_line(server, endpoint, request_id, &frame, project_path);
    responses_direct_output_response(project_v3_responses_error_frame_for_request_if_sse(
        frame,
        request_headers,
        payload,
    ))
}

pub(super) fn project_v3_responses_error_frame_for_request_if_sse(
    frame: V3Server16HttpFrame,
    request_headers: &HeaderMap,
    payload: Option<&Value>,
) -> V3Server16HttpFrame {
    let requested_stream = payload
        .and_then(|payload| payload.get("stream"))
        .and_then(Value::as_bool)
        == Some(true)
        || request_accepts_sse(request_headers);
    project_v3_responses_direct_stream_error_frame_if_requested(frame, requested_stream)
}
