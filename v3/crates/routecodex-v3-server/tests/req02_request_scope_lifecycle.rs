//! REQ02 request-scope lifecycle regression.
//!
//! These cases exercise only the public Runtime/Config consumer surface: the
//! real request factory (`V3RequestExecutionControl::new`), the shared opaque
//! request handle, the invocation identity, the single non-cloneable finalizer
//! guard, and the committed-SSE terminal observer the Front uses to release the
//! request scope on EOF or Drop.

use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_runtime::operation_runner::{
    RequestInvocationContext, RequestOriginKind, V3RequestContextHandle,
};
use routecodex_v3_runtime::V3RequestExecutionControl;
use serde_json::json;

fn test_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
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
    .unwrap()
}

fn control(request_id: &str) -> V3RequestExecutionControl {
    V3RequestExecutionControl::new(&test_manifest(), "test", request_id, "responses")
        .expect("real request factory must accept the request identity")
}

/// A live request scope accepts slot mutations; a released one rejects them with
/// the typed "scope already released" reason. This is the public observable for
/// request terminal release (the Runtime keeps `release_events` test-only).
fn assert_active(handle: &V3RequestContextHandle) {
    handle
        .record_failed_attempt("attempt-active", "request still running")
        .expect("live request scope must accept slot mutations");
}

fn assert_released(handle: &V3RequestContextHandle) {
    let error = handle
        .record_failed_attempt("attempt-after-terminal", "request already released")
        .expect_err("released request scope must reject further slot mutations");
    assert!(
        error.contains("scope already released"),
        "unexpected release error: {error}"
    );
}

#[test]
fn factory_binds_real_request_identity_and_distinct_invocation_identity() {
    let control = control("req-identity-1");
    let handle = control.request_context().clone();
    assert_eq!(handle.request_id(), "req-identity-1");
    assert_eq!(handle.entry_protocol(), "responses");
    assert!(control.request_context().same_scope(&handle));

    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "invocation-1".to_string(),
        "attempt-1".to_string(),
        RequestOriginKind::ClientEntry,
    );
    assert_eq!(invocation.invocation_id(), "invocation-1");
    assert_eq!(invocation.attempt_id(), "attempt-1");
    assert_ne!(invocation.invocation_id(), handle.request_id());
    assert_ne!(invocation.attempt_id(), invocation.invocation_id());
    assert!(invocation.request_handle().same_scope(&handle));
}

#[test]
fn factory_rejects_missing_request_identity() {
    let manifest = test_manifest();
    assert!(V3RequestExecutionControl::new(&manifest, "test", "", "responses").is_err());
    assert!(V3RequestExecutionControl::new(&manifest, "test", "req-1", "  ").is_err());
}

#[test]
fn two_requests_keep_isolated_scopes() {
    let first = control("req-isolation-a");
    let second = control("req-isolation-b");
    assert!(!first.request_context().same_scope(second.request_context()));

    assert_active(first.request_context());
    assert_active(second.request_context());

    drop(first.take_request_finalizer().expect("first guard"));
    assert_released(first.request_context());
    assert_active(second.request_context());
}

#[test]
fn handoff_clone_shares_scope_and_guard_is_unique() {
    let control = control("req-handoff");
    let handoff_control = control.clone();
    assert!(
        control
            .request_context()
            .same_scope(handoff_control.request_context()),
        "handoff must move the same request scope, not create a new pair"
    );

    let guard = control.take_request_finalizer().expect("first guard take");
    let error = handoff_control
        .take_request_finalizer()
        .expect_err("the guard must only be taken once");
    assert!(error.contains("already moved"), "unexpected error: {error}");

    // A plain clone dropping must not release the scope while the guard lives.
    drop(handoff_control);
    assert_active(control.request_context());

    drop(guard);
    assert_released(control.request_context());
}

#[test]
fn success_json_terminal_releases_request_scope() {
    let control = control("req-json-success");
    let handle = control.request_context().clone();
    let guard = control.take_request_finalizer().expect("guard take");
    assert_active(&handle);
    // JSON bodies are fully materialized before the response is returned, so the
    // Front drops the guard at the terminal frame.
    drop(guard);
    assert_released(&handle);
}

#[test]
fn error_terminal_releases_request_scope() {
    let control = control("req-error");
    let handle = control.request_context().clone();
    let guard = control.take_request_finalizer().expect("guard take");
    assert_active(&handle);
    guard.finalize().expect("explicit error terminal finalize");
    assert_released(&handle);
}

#[test]
fn cancelled_future_releases_request_scope_without_terminal() {
    let control = control("req-cancel");
    let handle = control.request_context().clone();
    assert_active(&handle);
    // Cancellation / future drop never reaches a terminal output; the shared
    // execution control dropping its last clone still releases the scope.
    drop(control);
    assert_released(&handle);
}

#[tokio::test]
async fn committed_sse_releases_request_scope_on_eof_and_drop() {
    let build_stream = || {
        routecodex_v3_runtime::hub_v1::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
            json!({
                "id": "resp_req02_scope",
                "status": "completed",
                "output": [],
            }),
        )
        .expect("committed SSE projection")
    };

    // EOF: the observer fires Completed when the replay is fully drained.
    let eof_control = control("req-sse-eof");
    let eof_handle = eof_control.request_context().clone();
    let eof_guard = eof_control.take_request_finalizer().expect("eof guard");
    let mut observed = build_stream().observe(|_| {}, move |_terminal| drop(eof_guard));
    assert_active(&eof_handle);
    while observed.next().await.is_some() {}
    assert_released(&eof_handle);

    // Drop: a client disconnect drops the replay before its terminal frame.
    let drop_control = control("req-sse-drop");
    let drop_handle = drop_control.request_context().clone();
    let drop_guard = drop_control.take_request_finalizer().expect("drop guard");
    let observed = build_stream().observe(|_| {}, move |_terminal| drop(drop_guard));
    assert_active(&drop_handle);
    drop(observed);
    assert_released(&drop_handle);
}
