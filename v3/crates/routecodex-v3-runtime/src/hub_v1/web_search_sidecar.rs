use super::web_search_hook_request::{
    build_v3_web_search_hook_request, V3WebSearchHookScopeSource,
};
use super::{V3ResponsesRelayRuntimeError, V3WebSearchCenterPhase, V3WebSearchCenterState};
use crate::V3RequestExecutionControl;
use routecodex_v3_error::{
    build_v3_error_01_source_raised_internal, V3Error01SourceRaised, V3ErrorSourceKind,
    V3InternalErrorCode,
};
use routecodex_v3_hooks::{ControlRequest, ControlResponse, PROTOCOL};
use serde_json::json;
use servertool_core::web_search_contract::{
    WebSearchFailure, WebSearchHookOutcome, WebSearchResult, WebSearchResultStatus,
};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WEB_SEARCH_POLICY_ID: &str = "metadata-center-local-search";

#[derive(Debug)]
enum WebSearchSidecarControlError {
    Message(String),
    Failed(WebSearchFailure),
}

impl std::fmt::Display for WebSearchSidecarControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => formatter.write_str(message),
            Self::Failed(failure) => write!(
                formatter,
                "web_search hooks sidecar failed [{}]: {}",
                failure.error.code, failure.error.message
            ),
        }
    }
}

pub(crate) fn web_search_sidecar_failure_source(
    call_id: &str,
    code: impl Into<String>,
    message: &str,
) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised_internal(
        V3ErrorSourceKind::RuntimeFailure,
        "V3DirectResp15ClientPayloadReady",
        code,
        format!("web_search hooks sidecar failed for call {call_id}: {message}"),
        V3InternalErrorCode::V3DirectResp15ClientPayloadReady,
    )
}

pub(crate) async fn execute_web_search_through_hooks_sidecar<
    S: V3WebSearchHookScopeSource + ?Sized,
>(
    socket_path: Option<&Path>,
    request_id: &str,
    scope: &S,
    execution_control: &V3RequestExecutionControl,
    state: &V3WebSearchCenterState,
) -> Result<V3WebSearchCenterState, V3ResponsesRelayRuntimeError> {
    let call_id = state
        .original_call_id()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
                "web_search sidecar dispatch requires the original call_id".to_string(),
            )
        })?;
    let query = state
        .query()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
                "web_search sidecar dispatch requires the observed query".to_string(),
            )
        })?;
    let request = build_v3_web_search_hook_request(
        request_id,
        call_id,
        query,
        state.count(),
        state.recency().map(str::to_string),
        state.content_types().to_vec(),
        scope,
        execution_control,
        WEB_SEARCH_POLICY_ID,
    )
    .map_err(|error| V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(error.to_string()))?;
    let socket_path = socket_path.map(Path::to_path_buf).ok_or_else(|| {
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
            "web_search hooks sidecar socket is not configured".to_string(),
        )
    })?;
    let expected_call_id = request.call_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        execute_web_search_control_request(&socket_path, request)
    })
    .await
    .map_err(|error| {
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(format!(
            "web_search hooks sidecar task failed: {error}"
        ))
    })?
    .map_err(|error| match error {
        WebSearchSidecarControlError::Message(message) => {
            V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(message)
        }
        WebSearchSidecarControlError::Failed(failure) => {
            V3ResponsesRelayRuntimeError::WebSearchSidecarFailed {
                call_id: failure.call_id,
                code: failure.error.code,
                message: failure.error.message,
                retryable: failure.error.retryable,
            }
        }
    })?;

    if result.call_id != expected_call_id {
        return Err(V3ResponsesRelayRuntimeError::WebSearchDispatchFailed(
            format!(
                "web_search hooks sidecar returned call_id {} for request call_id {}",
                result.call_id, expected_call_id
            ),
        ));
    }
    capture_sidecar_result(state, result)
}

fn execute_web_search_control_request(
    socket_path: &Path,
    request: servertool_core::web_search_contract::WebSearchHookRequest,
) -> Result<WebSearchResult, WebSearchSidecarControlError> {
    let deadline = absolute_deadline(&request)?;
    let stream = connect_unix_stream_until(socket_path, deadline)?;
    execute_web_search_control_stream(stream, request, deadline)
}

fn connect_unix_stream_until(
    socket_path: &Path,
    deadline: Instant,
) -> Result<UnixStream, WebSearchSidecarControlError> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let socket_path = socket_path.to_path_buf();
    std::thread::spawn(move || {
        let _ = sender.send(UnixStream::connect(socket_path));
    });
    match receiver.recv_timeout(remaining_until(deadline, "connect")?) {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar socket connect failed: {error}"
        ))),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(WebSearchSidecarControlError::Message(
                "web_search hooks sidecar connect deadline expired".to_string(),
            ))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err(WebSearchSidecarControlError::Message(
                "web_search hooks sidecar connect task failed".to_string(),
            ))
        }
    }
}

fn execute_web_search_control_stream(
    mut stream: UnixStream,
    request: servertool_core::web_search_contract::WebSearchHookRequest,
    deadline: Instant,
) -> Result<WebSearchResult, WebSearchSidecarControlError> {
    stream
        .set_write_timeout(Some(remaining_until(deadline, "write")?))
        .map_err(|error| {
            WebSearchSidecarControlError::Message(format!(
                "web_search hooks sidecar write timeout setup failed: {error}"
            ))
        })?;
    let control_request = ControlRequest::ExecuteWebSearch {
        request: Box::new(request.clone()),
    };
    serde_json::to_writer(&mut stream, &control_request).map_err(|error| {
        WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar request encoding failed: {error}"
        ))
    })?;
    stream.write_all(b"\n").map_err(|error| {
        WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar request write failed: {error}"
        ))
    })?;
    stream.flush().map_err(|error| {
        WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar request flush failed: {error}"
        ))
    })?;
    stream
        .set_read_timeout(Some(remaining_until(deadline, "read")?))
        .map_err(|error| {
            WebSearchSidecarControlError::Message(format!(
                "web_search hooks sidecar read timeout setup failed: {error}"
            ))
        })?;

    let mut response_line = String::new();
    BufReader::new(stream)
        .read_line(&mut response_line)
        .map_err(|error| {
            WebSearchSidecarControlError::Message(format!(
                "web_search hooks sidecar response read failed: {error}"
            ))
        })?;
    if response_line.trim().is_empty() {
        return Err(WebSearchSidecarControlError::Message(
            "web_search hooks sidecar returned an empty response".to_string(),
        ));
    }
    let response: ControlResponse =
        serde_json::from_str(response_line.trim()).map_err(|error| {
            WebSearchSidecarControlError::Message(format!(
                "web_search hooks sidecar returned malformed response: {error}"
            ))
        })?;
    validate_control_response(response, &request.call_id)
}

fn remaining_until(
    deadline: Instant,
    operation: &str,
) -> Result<Duration, WebSearchSidecarControlError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar request deadline expired before {operation}"
        )));
    }
    Ok(remaining)
}

fn validate_control_response(
    response: ControlResponse,
    expected_call_id: &str,
) -> Result<WebSearchResult, WebSearchSidecarControlError> {
    if response.protocol != PROTOCOL {
        return Err(WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar protocol mismatch: expected {PROTOCOL}, got {}",
            response.protocol
        )));
    }
    if !response.ok {
        return Err(WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar rejected execution: {}",
            response
                .error
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("unknown sidecar error")
        )));
    }
    let result = response.result.ok_or_else(|| {
        WebSearchSidecarControlError::Message(
            "web_search hooks sidecar response is missing result".to_string(),
        )
    })?;
    let outcome_value = result.get("outcome").cloned().ok_or_else(|| {
        WebSearchSidecarControlError::Message(
            "web_search hooks sidecar response is missing result.outcome".to_string(),
        )
    })?;
    let outcome: WebSearchHookOutcome = serde_json::from_value(outcome_value).map_err(|error| {
        WebSearchSidecarControlError::Message(format!(
            "web_search hooks sidecar outcome is malformed: {error}"
        ))
    })?;
    match outcome {
        WebSearchHookOutcome::NotApplicable => Err(WebSearchSidecarControlError::Message(
            "web_search hooks sidecar returned NotApplicable for an active web_search call"
                .to_string(),
        )),
        WebSearchHookOutcome::Completed(result) => {
            result.validate().map_err(|error| {
                WebSearchSidecarControlError::Message(format!(
                    "web_search hooks sidecar result is invalid: {error}"
                ))
            })?;
            if result.call_id != expected_call_id {
                return Err(WebSearchSidecarControlError::Message(format!(
                    "web_search hooks sidecar returned completed call_id {} for request call_id {}",
                    result.call_id, expected_call_id
                )));
            }
            if result.status != WebSearchResultStatus::Completed {
                return Err(WebSearchSidecarControlError::Message(
                    "web_search hooks sidecar completed outcome carried a failed result"
                        .to_string(),
                ));
            }
            Ok(result)
        }
        WebSearchHookOutcome::Failed(failure) => {
            failure.validate().map_err(|error| {
                WebSearchSidecarControlError::Message(format!(
                    "web_search hooks sidecar failure is invalid: {error}"
                ))
            })?;
            if failure.call_id != expected_call_id {
                return Err(WebSearchSidecarControlError::Message(format!(
                    "web_search hooks sidecar returned failed call_id {} for request call_id {}",
                    failure.call_id, expected_call_id
                )));
            }
            Err(WebSearchSidecarControlError::Failed(failure))
        }
    }
}

fn absolute_deadline(
    request: &servertool_core::web_search_contract::WebSearchHookRequest,
) -> Result<Instant, WebSearchSidecarControlError> {
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            WebSearchSidecarControlError::Message(format!(
                "web_search hooks sidecar clock failed: {error}"
            ))
        })?
        .as_millis() as u64;
    request
        .validate_at(now_unix_ms)
        .map_err(|error| WebSearchSidecarControlError::Message(error.to_string()))?;
    Ok(
        Instant::now()
            + Duration::from_millis(request.deadline_unix_ms.saturating_sub(now_unix_ms)),
    )
}

fn capture_sidecar_result(
    state: &V3WebSearchCenterState,
    result: WebSearchResult,
) -> Result<V3WebSearchCenterState, V3ResponsesRelayRuntimeError> {
    let query = state.query().unwrap_or_default();
    let prepared = state
        .transition_to(
            V3WebSearchCenterPhase::SearchDispatchPrepared,
            "hooks_sidecar_dispatch_prepared",
        )
        .and_then(|state| {
            state.transition_to(
                V3WebSearchCenterPhase::SearchInFlight,
                "hooks_sidecar_dispatch_in_flight",
            )
        })
        .and_then(|state| {
            state.transition_to(
                V3WebSearchCenterPhase::SearchResultCaptured,
                "hooks_sidecar_result_captured",
            )
        })
        .map_err(V3ResponsesRelayRuntimeError::WebSearchDispatchFailed)?;
    Ok(prepared.with_normalized_result(Some(json!({
        "query": query,
        "text_result": result.content,
        "sources": result.sources,
        "metadata": result.metadata
    }))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_v1::V3ResponsesRelayServerToolScope;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use serde_json::Value;
    use servertool_core::web_search_contract::{
        WebSearchError, WebSearchFailure, WebSearchHookRequest, WebSearchSource,
    };
    use std::thread;

    fn execution_control() -> V3RequestExecutionControl {
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.test]
bind = "127.0.0.1"
port = 5520
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = { attempt_max_bytes = 1048576, attempt_max_frames = 1024, request_max_bytes = 1048576, process_max_bytes = 1048576, residence_timeout_ms = 60000 }
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEST_KEY" }] }
[providers.test.models.test-model]
capabilities = ["text"]
[route_groups.default.pools.default]
targets = [{ kind = "provider_model", provider = "test", model = "test-model", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        V3RequestExecutionControl::from_manifest(&manifest, "test").unwrap()
    }

    fn scope() -> V3ResponsesRelayServerToolScope {
        V3ResponsesRelayServerToolScope::new(
            "/v1/responses",
            "session-1",
            "conversation-1",
            5520,
            "default",
        )
    }

    fn observed_state() -> V3WebSearchCenterState {
        V3WebSearchCenterState::new()
            .transition_to(
                V3WebSearchCenterPhase::LocalToolSurfaceActive,
                "test_active",
            )
            .unwrap()
            .transition_to(V3WebSearchCenterPhase::ToolCallObserved, "test_observed")
            .unwrap()
            .with_original_call_id(Some("call-web-search-1"))
            .with_query(Some("routecodex"))
            .with_count(Some(3))
    }

    fn request(deadline_unix_ms: u64) -> WebSearchHookRequest {
        WebSearchHookRequest {
            request_id: "req-1".to_string(),
            call_id: "call-web-search-1".to_string(),
            query: "routecodex".to_string(),
            count: Some(3),
            recency: None,
            content_types: vec!["text".to_string()],
            scope: scope().web_search_hook_scope(),
            deadline_unix_ms,
            policy_id: WEB_SEARCH_POLICY_ID.to_string(),
        }
    }

    fn future_deadline() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 10_000
    }

    fn serve_response(response: Value) -> (UnixStream, thread::JoinHandle<ControlRequest>) {
        let (client, mut server) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(server.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request = serde_json::from_str::<ControlRequest>(line.trim()).unwrap();
            writeln!(server, "{}", response).unwrap();
            request
        });
        (client, worker)
    }

    fn execute_response(
        stream: UnixStream,
    ) -> Result<WebSearchResult, WebSearchSidecarControlError> {
        let request = request(future_deadline());
        let deadline = absolute_deadline(&request)?;
        execute_web_search_control_stream(stream, request, deadline)
    }

    fn completed(call_id: &str) -> ControlResponse {
        ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::Completed(WebSearchResult {
                call_id: call_id.to_string(),
                status: WebSearchResultStatus::Completed,
                content: Some("typed result".to_string()),
                sources: vec![WebSearchSource {
                    ref_id: "source-1".to_string(),
                    url: Some("https://example.com".to_string()),
                    title: Some("Example".to_string()),
                }],
                metadata: None,
                error: None,
            })
        }))
    }

    fn failed(call_id: &str) -> ControlResponse {
        ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::Failed(WebSearchFailure {
                call_id: call_id.to_string(),
                error: WebSearchError {
                    code: "search_unavailable".to_string(),
                    message: "controlled failure".to_string(),
                    retryable: false,
                },
            })
        }))
    }

    #[test]
    fn web_search_hook_sidecar_accepts_completed_matching_call_id() {
        let (stream, worker) =
            serve_response(serde_json::to_value(completed("call-web-search-1")).unwrap());
        let result = execute_response(stream).unwrap();
        assert_eq!(result.call_id, "call-web-search-1");
        let control_request = worker.join().unwrap();
        let ControlRequest::ExecuteWebSearch { request } = control_request else {
            panic!("expected ExecuteWebSearch");
        };
        assert_eq!(request.query, "routecodex");
    }

    #[test]
    fn web_search_hook_sidecar_captures_sources_without_text_result() {
        let captured = capture_sidecar_result(
            &observed_state(),
            WebSearchResult {
                call_id: "call-web-search-1".to_string(),
                status: WebSearchResultStatus::Completed,
                content: None,
                sources: vec![WebSearchSource {
                    ref_id: "source-1".to_string(),
                    url: Some("https://example.com".to_string()),
                    title: Some("Example".to_string()),
                }],
                metadata: None,
                error: None,
            },
        )
        .expect("capture sources-only result");
        assert_eq!(
            captured.phase(),
            V3WebSearchCenterPhase::SearchResultCaptured
        );
        let normalized = captured.normalized_result().expect("normalized result");
        assert_eq!(normalized["text_result"], Value::Null);
        assert_eq!(normalized["sources"][0]["refId"], "source-1");
        assert_eq!(normalized["sources"][0]["title"], "Example");
        assert_eq!(normalized["sources"][0]["url"], "https://example.com");
        assert!(normalized.get("phase").is_none());
    }

    #[test]
    fn web_search_hook_sidecar_rejects_completed_mismatched_call_id() {
        let (stream, worker) =
            serve_response(serde_json::to_value(completed("call-other")).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("completed call_id call-other"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_failed_mismatched_call_id() {
        let (stream, worker) = serve_response(serde_json::to_value(failed("call-other")).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("failed call_id call-other"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_failed_outcome() {
        let (stream, worker) =
            serve_response(serde_json::to_value(failed("call-web-search-1")).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(matches!(
            error,
            WebSearchSidecarControlError::Failed(WebSearchFailure {
                ref call_id,
                error: ref failure,
            }) if call_id == "call-web-search-1"
                && failure.code == "search_unavailable"
                && failure.message == "controlled failure"
                && !failure.retryable
        ));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_preserves_failed_outcome_for_runtime_projection() {
        let (stream, worker) =
            serve_response(serde_json::to_value(failed("call-web-search-1")).unwrap());
        let error = execute_response(stream).unwrap_err();
        let WebSearchSidecarControlError::Failed(failure) = error else {
            panic!("expected typed sidecar failure");
        };
        let runtime_error = V3ResponsesRelayRuntimeError::WebSearchSidecarFailed {
            call_id: failure.call_id,
            code: failure.error.code,
            message: failure.error.message,
            retryable: failure.error.retryable,
        };
        assert_eq!(
            runtime_error.to_string(),
            "web_search hooks sidecar failed [search_unavailable] retryable=false: controlled failure"
        );
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_failure_source_preserves_code_and_response_lane_without_control_leak(
    ) {
        let source = web_search_sidecar_failure_source(
            "call-web-search-1",
            "search_unavailable",
            "controlled failure",
        );
        assert_eq!(source.source_stage, "V3DirectResp15ClientPayloadReady");
        assert_eq!(source.code, "search_unavailable");
        assert_eq!(
            source.message,
            "web_search hooks sidecar failed for call call-web-search-1: controlled failure"
        );
        assert!(!source.message.contains("retryable"));
        assert_eq!(
            source.internal_error.expect("internal response error").lane,
            routecodex_v3_error::V3InternalErrorLane::Response
        );
    }

    #[test]
    fn web_search_hook_sidecar_rejects_failed_outcome_with_empty_error_fields() {
        let response = ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::Failed(WebSearchFailure {
                call_id: "call-web-search-1".to_string(),
                error: WebSearchError {
                    code: String::new(),
                    message: String::new(),
                    retryable: false,
                },
            })
        }));
        let (stream, worker) = serve_response(serde_json::to_value(response).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("non-empty error code"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_ok_false() {
        let (stream, worker) = serve_response(
            serde_json::to_value(ControlResponse::err("adapter missing".to_string())).unwrap(),
        );
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("adapter missing"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_malformed_response() {
        let (stream, worker) = serve_response(json!({"protocol": PROTOCOL, "ok": true}));
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("missing result"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_protocol_mismatch() {
        let response = ControlResponse {
            protocol: "other-protocol".to_string(),
            ok: true,
            result: Some(json!({
                "outcome": WebSearchHookOutcome::NotApplicable
            })),
            error: None,
        };
        let (stream, worker) = serve_response(serde_json::to_value(response).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("protocol mismatch"));
        worker.join().unwrap();
    }

    #[test]
    fn web_search_hook_sidecar_rejects_not_applicable() {
        let response = ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::NotApplicable
        }));
        let (stream, worker) = serve_response(serde_json::to_value(response).unwrap());
        let error = execute_response(stream).unwrap_err();
        assert!(error.to_string().contains("NotApplicable"));
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn web_search_hook_sidecar_rejects_missing_socket() {
        let error = execute_web_search_through_hooks_sidecar(
            None,
            "req-1",
            &scope(),
            &execution_control(),
            &observed_state(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("socket is not configured"));
    }

    #[test]
    fn web_search_hook_sidecar_rejects_expired_deadline() {
        let error = execute_web_search_control_request(
            Path::new("/tmp/not-used-hooks-sidecar.sock"),
            request(1),
        )
        .unwrap_err();
        assert!(error.to_string().contains("deadline has expired"));
    }
}
