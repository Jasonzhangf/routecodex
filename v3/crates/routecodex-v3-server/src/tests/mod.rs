use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

static TEST_TZ_LOCK: StdMutex<()> = StdMutex::new(());
static TEST_HOME_LOCK: StdMutex<()> = StdMutex::new(());

unsafe extern "C" {
    fn tzset();
}

struct TestTzGuard {
    previous_tz: Option<std::ffi::OsString>,
}

struct TestHomeGuard {
    previous_home: Option<std::ffi::OsString>,
}

impl TestHomeGuard {
    fn set(path: &std::path::Path) -> Self {
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", path);
        Self { previous_home }
    }

    fn unset() -> Self {
        let previous_home = std::env::var_os("HOME");
        std::env::remove_var("HOME");
        Self { previous_home }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous_home) = self.previous_home.as_ref() {
            std::env::set_var("HOME", previous_home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

impl TestTzGuard {
    fn set(value: &str) -> Self {
        let previous_tz = std::env::var_os("TZ");
        std::env::set_var("TZ", value);
        unsafe {
            tzset();
        }
        Self { previous_tz }
    }
}

impl Drop for TestTzGuard {
    fn drop(&mut self) {
        if let Some(previous_tz) = self.previous_tz.take() {
            std::env::set_var("TZ", previous_tz);
        } else {
            std::env::remove_var("TZ");
        }
        unsafe {
            tzset();
        }
    }
}

fn strip_test_ansi(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars();
    while let Some(character) = chars.next() {
        if character == '\x1b' {
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }
    output
}

fn test_v3_console_log_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "routecodex-v3-{name}-{}-{}.log",
        std::process::id(),
        console_timestamp_hhmmss()
    ))
}

fn test_v3_listener_state(log_file: &std::path::Path, port: u16) -> Arc<V3ListenerState> {
    test_v3_listener_state_with_direct_snapshots(log_file, port, true)
}

fn test_v3_listener_state_with_direct_snapshots(
    log_file: &std::path::Path,
    port: u16,
    snapshot_direct: bool,
) -> Arc<V3ListenerState> {
    test_v3_listener_state_with_debug(log_file, port, false, true, None, snapshot_direct)
}

fn test_v3_listener_state_with_debug(
    log_file: &std::path::Path,
    port: u16,
    snapshots: bool,
    codex_samples: bool,
    snapshot_stages: Option<String>,
    snapshot_direct: bool,
) -> Arc<V3ListenerState> {
    let mut servers = BTreeMap::new();
    let server = V3ServerManifest {
        id: format!("server-{port}"),
        enabled: true,
        bind: "127.0.0.1".to_string(),
        port,
        routing_group: "controlled".to_string(),
        endpoints: vec!["responses".to_string()],
        features: BTreeMap::new(),
        execution: None,
        http_sse_keepalive_ms: 3_000,
        expose_models: Vec::new(),
    };
    servers.insert(server.id.clone(), server.clone());
    let manifest = Arc::new(V3Config05ManifestPublished {
        version: 3,
        hub_v1: None,
        servers,
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        route_groups: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: V3DebugManifest {
            log_console: false,
            log_file: Some(log_file.to_string_lossy().to_string()),
            snapshots,
            codex_samples,
            snapshot_stages,
            snapshot_direct,
            dry_run: false,
            retention: BTreeMap::new(),
        },
        error: routecodex_v3_config::V3ErrorManifest {
            policies: BTreeMap::new(),
            provider_error_action_policy: Vec::new(),
            client_error_projection_policy: Vec::new(),
        },
    });
    let debug = build_v3_debug_runtime_from_manifest(&manifest.debug).unwrap();
    Arc::new(V3ListenerState {
        server,
        manifest_version: manifest.version,
        manifest: Arc::clone(&manifest),
        debug,
        console_enabled: true,
        request_counter: Arc::new(Mutex::new(V3RequestIdCounter {
            state_file: log_file.with_extension("request-id-counter.json"),
            state: V3RequestCounterState::default(),
            loaded: false,
        })),
        codex_sample_persistence: Arc::new(Mutex::new(())),
        responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
        responses_direct_stopless_control: Arc::new(
            V3ResponsesDirectStoplessControlState::default(),
        ),
        responses_relay_local_continuation: Arc::new(
            V3ResponsesRelayLocalContinuationState::default(),
        ),
        responses_relay_stopless_control: Arc::new(V3ResponsesRelayStoplessControlState::default()),
        provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
            &manifest,
        )),
        responses_session_admission: Arc::new(V3ResponsesSessionAdmissionGate::default()),
    })
}

#[test]
fn test_listener_state_owns_request_counter_path_beside_log_file() {
    let log_file = test_v3_console_log_file("request-counter-isolation");
    let state = test_v3_listener_state(&log_file, 5555);

    assert_eq!(
        state.request_counter.lock().unwrap().state_file,
        log_file.with_extension("request-id-counter.json")
    );
}

#[test]
fn responses_protocol_plan_only_accepts_fresh_requests() {
    let fresh = V3ResponsesContinuationEntryFacts::project(&json!({
        "model": "client-test",
        "previous_response_id": null,
        "input": "fresh"
    }));
    assert!(responses_entry_facts_allow_fresh_protocol_plan(&fresh));

    let remote_continuation = V3ResponsesContinuationEntryFacts::project(&json!({
        "model": "client-test",
        "previous_response_id": "resp_remote",
        "input": "continue"
    }));
    assert!(!responses_entry_facts_allow_fresh_protocol_plan(
        &remote_continuation
    ));

    let relay_local_continuation = V3ResponsesContinuationEntryFacts::project(&json!({
        "model": "client-test",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_local",
            "output": "ok"
        }]
    }));
    assert!(!responses_entry_facts_allow_fresh_protocol_plan(
        &relay_local_continuation
    ));

    let paired_tool_turn = V3ResponsesContinuationEntryFacts::project(&json!({
        "model": "client-test",
        "input": [
            {
                "type": "function_call",
                "call_id": "call_inline",
                "name": "lookup",
                "arguments": "{}"
            },
            {
                "type": "function_call_output",
                "call_id": "call_inline",
                "output": "ok"
            }
        ]
    }));
    assert!(responses_entry_facts_allow_fresh_protocol_plan(
        &paired_tool_turn
    ));
}

#[test]
fn fresh_responses_preserves_pending_binding_and_wraps_implemented_modes() {
    let fresh = V3ResponsesContinuationEntryFacts::project(&json!({
        "model": "client-test",
        "input": "fresh"
    }));

    assert_eq!(
        responses_effective_execution_mode_for_entry_facts(
            V3EntryProtocolExecutionMode::PendingNotImplemented,
            &fresh,
        ),
        V3EntryProtocolExecutionMode::PendingNotImplemented,
        "Config-owned pending status must remain terminal for HTTP and WebSocket dispatch",
    );
    assert_eq!(
        responses_effective_execution_mode_for_entry_facts(
            V3EntryProtocolExecutionMode::Direct,
            &fresh,
        ),
        V3EntryProtocolExecutionMode::Relay,
    );
    assert_eq!(
        responses_effective_execution_mode_for_entry_facts(
            V3EntryProtocolExecutionMode::Relay,
            &fresh,
        ),
        V3EntryProtocolExecutionMode::Relay,
    );
}

#[test]
fn codex_sample_scope_blocks_direct_and_preserves_relay() {
    let log_file = std::env::temp_dir().join(format!(
        "routecodex-v3-sample-scope-{}.log",
        std::process::id()
    ));
    let relay_only = test_v3_listener_state_with_direct_snapshots(&log_file, 5555, false);

    assert!(!v3_codex_sample_scope_allows(
        &relay_only,
        V3EntryProtocolExecutionMode::Direct
    ));
    assert!(v3_codex_sample_scope_allows(
        &relay_only,
        V3EntryProtocolExecutionMode::Relay
    ));

    let debug_only = test_v3_listener_state_with_debug(&log_file, 5556, true, false, None, true);
    assert!(!v3_codex_sample_scope_allows(
        &debug_only,
        V3EntryProtocolExecutionMode::Direct
    ));
    assert!(!v3_codex_sample_scope_allows(
        &debug_only,
        V3EntryProtocolExecutionMode::Relay
    ));

    let _ = fs::remove_file(log_file);
}

#[test]
fn codex_sample_retention_keeps_exactly_latest_hundred_request_directories() {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-sample-retention-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();

    let oldest = root.join("request-000");
    fs::create_dir_all(&oldest).unwrap();
    fs::write(oldest.join("request.json"), b"{}\n").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    for index in 1..=100 {
        let request = root.join(format!("request-{index:03}"));
        fs::create_dir_all(&request).unwrap();
        fs::write(request.join("request.json"), b"{}\n").unwrap();
        fs::write(request.join("response.json"), b"{}\n").unwrap();
    }
    let current = root.join("request-100");

    enforce_v3_codex_sample_request_retention(
        &root,
        Some(&current),
        V3_CODEX_SAMPLE_REQUEST_RETENTION,
    )
    .unwrap();

    let retained = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .count();
    assert_eq!(retained, V3_CODEX_SAMPLE_REQUEST_RETENTION);
    assert!(!oldest.exists());
    assert!(current.join("request.json").exists());
    assert!(current.join("response.json").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_sample_persistence_and_startup_retention_reject_missing_home() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let _home = TestHomeGuard::unset();
    let log_file = std::env::temp_dir().join(format!(
        "routecodex-v3-missing-home-{}.log",
        std::process::id()
    ));
    let state = test_v3_listener_state_with_debug(&log_file, 5555, true, true, None, false);

    let persistence_error = persist_v3_codex_sample_payload(
        &state,
        "responses",
        "/v1/responses",
        "missing-home",
        "request.json",
        &json!({"input":"must fail explicitly"}),
    )
    .expect_err("missing HOME must not silently skip an authorized sample write");
    assert!(persistence_error.contains("HOME"), "{persistence_error}");

    let startup_error =
        enforce_v3_codex_sample_listener_retention(5555, V3_CODEX_SAMPLE_REQUEST_RETENTION)
            .expect_err("missing HOME must fail startup retention explicitly");
    assert!(startup_error.contains("HOME"), "{startup_error}");
}

#[tokio::test]
async fn direct_sse_http_projection_preserves_provider_bytes_with_keepalive_comment() {
    let provider_bytes =
        b"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n".to_vec();
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(stream::iter(vec![Ok::<
            Vec<u8>,
            V3Error01SourceRaised,
        >(
            provider_bytes.clone()
        )]))),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };

    let response =
        responses_direct_output_response_with_console(frame, None, Duration::from_millis(3_000));
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    // Direct SSE 投影前置 transport keepalive 注释，随后保真传输 provider 字节。
    let mut expected = b": keepalive\n\n".to_vec();
    expected.extend_from_slice(&provider_bytes);
    assert_eq!(body.as_ref(), expected.as_slice());
}

#[tokio::test]
async fn codex_sample_sse_recorders_persist_only_initial_and_terminal_artifacts() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-terminal-sse-sample-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let _home = TestHomeGuard::set(&root);
    let state = test_v3_listener_state_with_debug(
        &root.join("server.log"),
        5555,
        true,
        true,
        Some("client-response".to_string()),
        true,
    );
    let chunk = b"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n".to_vec();
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Bytes(Vec::new()),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };
    let recorder = V3LiveSnapDirectClientResponseSseRecorder::new(
        Arc::clone(&state),
        "responses".to_string(),
        "/v1/responses".to_string(),
        "terminal-only".to_string(),
        &frame,
    );
    recorder.persist_initial().unwrap();
    let response_path =
        root.join(".rcc/codex-samples/openai-responses/ports/5555/terminal-only/response.json");
    let initial: Value =
        serde_json::from_str(&fs::read_to_string(&response_path).unwrap()).unwrap();
    assert_eq!(initial["rawSse"], "");

    let mut stream = recorder.wrap(Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        V3Error01SourceRaised,
    >(chunk.clone())])));
    assert_eq!(stream.next().await.unwrap().unwrap(), chunk);
    let during_stream: Value =
        serde_json::from_str(&fs::read_to_string(&response_path).unwrap()).unwrap();
    assert_eq!(
        during_stream["rawSse"], "",
        "stream chunks must not trigger synchronous full-artifact rewrites"
    );
    assert!(stream.next().await.is_none());
    let terminal: Value =
        serde_json::from_str(&fs::read_to_string(&response_path).unwrap()).unwrap();
    assert!(terminal["rawSse"]
        .as_str()
        .is_some_and(|value| value.contains("response.completed")));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn relay_provider_snapshots_are_redacted_before_codex_sample_persistence() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-provider-snapshot-redaction-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let _home = TestHomeGuard::set(&root);
    let log_file = root.join("server.log");
    let state = test_v3_listener_state_with_debug(
        &log_file,
        5555,
        true,
        true,
        Some("provider-request,provider-response".to_string()),
        false,
    );
    let media = format!("data:image/png;base64,{}", "A".repeat(16_384));
    let mut output = V3ResponsesRelayRuntimeOutput {
        status: 200,
        client_body: V3ResponsesRelayClientBody::Json(json!({})),
        node_trace: Vec::new(),
        error_chain: None,
        observability: None,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: Some(routecodex_v3_runtime::V3ResponsesRelayProviderSnapshots {
            provider_request: Some(json!({
                "headers": {"authorization": "Bearer secret"},
                "body": {"input_image": media}
            })),
            provider_response: Some(json!({
                "output": [{"image_data": format!("data:image/png;base64,{}", "B".repeat(16_384))}]
            })),
        }),
        protocol_direct_handoff: None,
    };

    assert!(capture_v3_responses_relay_provider_snapshots(
        &state,
        "responses",
        "/v1/responses",
        "redaction-request",
        &mut output,
    )
    .is_none());

    let sample_dir = root.join(".rcc/codex-samples/openai-responses/ports/5555/redaction-request");
    let request = fs::read_to_string(sample_dir.join("provider-request.json")).unwrap();
    let response = fs::read_to_string(sample_dir.join("provider-response.json")).unwrap();
    assert!(request.contains("[REDACTED]"));
    assert!(request.contains("ROUTECODEX_DEBUG_MEDIA_PLACEHOLDER"));
    assert!(response.contains("ROUTECODEX_DEBUG_MEDIA_PLACEHOLDER"));
    assert!(!request.contains(&"A".repeat(4096)));
    assert!(!response.contains(&"B".repeat(4096)));
    assert_eq!(
        output
            .provider_snapshots
            .as_ref()
            .and_then(|snapshots| snapshots.provider_request.as_ref()),
        None,
        "consumed debug payload must be released after persistence"
    );

    fs::remove_dir_all(root).unwrap();
}

fn test_direct_console_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-routecodex-session-id",
        HeaderValue::from_static("direct-console-test"),
    );
    headers.insert(
        "x-routecodex-workdir",
        HeaderValue::from_static("/tmp/rules"),
    );
    headers
}

fn test_v3_console_emission_context(
    state: &Arc<V3ListenerState>,
    entry_protocol: &str,
    endpoint: &str,
    request_id: &str,
    headers: &HeaderMap,
    payload: &Value,
) -> V3ConsoleEmissionContext {
    let request_identity = V3AllocatedRequestIdentity {
        request_id: request_id.to_string(),
        total_count: 1,
        daily_count: 1,
    };
    build_v3_console_emission_context(
        state,
        entry_protocol,
        endpoint,
        &request_identity,
        headers,
        payload,
    )
}

fn test_provider_failure_observation() -> V3RuntimeProviderFailureObservation {
    V3RuntimeProviderFailureObservation {
        provider_key: "first:key:gpt-5.5".to_string(),
        provider_id: "first".to_string(),
        auth_alias: Some("key".to_string()),
        model_id: "gpt-5.5".to_string(),
        status: 502,
        error_type: Some("provider_error".to_string()),
        external_error_kind: None,
        external_error_code: None,
        external_error_status: None,
        internal_code: None,
        message: "upstream failed once".to_string(),
        failure_count: 1,
        health_state: "healthy".to_string(),
        cooldown_until_ms: None,
        action: "switch_provider".to_string(),
        next_provider_key: Some("second:key:gpt-5.5".to_string()),
        wait_ms: None,
    }
}

fn test_direct_observability(
    provider_failure_events: Vec<V3RuntimeProviderFailureObservation>,
) -> V3RuntimeObservability {
    V3RuntimeObservability {
        entry_protocol: "responses".to_string(),
        execution_mode: "direct".to_string(),
        transport: "json".to_string(),
        routing_group_id: Some("coding".to_string()),
        pool_id: Some("direct".to_string()),
        provider_id: Some("second".to_string()),
        auth_alias: Some("key".to_string()),
        provider_key: Some("second:key:gpt-5.5".to_string()),
        provider_type: Some("openai-responses".to_string()),
        model_id: Some("gpt-5.5".to_string()),
        wire_model: Some("gpt-5.5".to_string()),
        provider_status: Some(200),
        response_status: Some("completed".to_string()),
        finish_reason: Some("stop".to_string()),
        stopless_activation: false,
        attempts: Some(2),
        unavailable_candidates: Vec::new(),
        provider_failure_events,
        target_path: vec!["direct".to_string(), "second".to_string()],
        usage: Some(V3RuntimeUsageSummary {
            input_tokens: Some(10),
            output_tokens: Some(2),
            total_tokens: Some(12),
            cached_tokens: Some(5),
        }),
        timing: Some(V3RuntimeTimingSummary {
            runtime_total: std::time::Duration::from_millis(25),
            external: std::time::Duration::from_millis(20),
            internal: std::time::Duration::from_millis(5),
        }),
    }
}

#[test]
fn direct_to_relay_handoff_preserves_failure_event_order() {
    let direct_event = test_provider_failure_observation();
    let mut relay_event = test_provider_failure_observation();
    relay_event.provider_key = "second:key:gpt-5.5".to_string();
    relay_event.provider_id = "second".to_string();
    relay_event.next_provider_key = Some("third:key:gpt-5.5".to_string());
    let mut output = V3ResponsesRelayRuntimeOutput {
        status: 200,
        client_body: V3ResponsesRelayClientBody::Json(json!({"status":"completed"})),
        node_trace: Vec::new(),
        error_chain: None,
        observability: Some(test_direct_observability(vec![relay_event])),
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    };

    merge_v3_direct_handoff_provider_failure_events(&mut output, vec![direct_event]);

    let events = &output
        .observability
        .expect("handoff observability")
        .provider_failure_events;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].provider_id, "first");
    assert_eq!(events[1].provider_id, "second");
}

#[test]
fn nested_relay_to_direct_handoff_uses_governed_handoff_payload() {
    let source = include_str!("../responses_direct_server_outcome.rs");
    let nested_handoff_block = source
        .split("if let Some(next_handoff) = relay_output.protocol_direct_handoff.take()")
        .nth(1)
        .expect("nested Relay-to-Direct handoff block")
        .split("Some(&next_handoff.plan)")
        .next()
        .expect("nested Direct recursive call");

    assert!(
        nested_handoff_block.contains("next_handoff.request_payload.clone(),"),
        "nested Direct handoff must consume Relay-owned governed request payload"
    );
    assert!(
        !nested_handoff_block.contains("\n                payload,\n"),
        "nested Direct handoff must not reuse the stale outer Direct payload"
    );
}

fn test_runtime_stream_observation_from_provider_event_json(
    event: Value,
) -> V3RuntimeStreamObservation {
    let observation = V3RuntimeStreamObservation::default();
    observation
        .record_provider_event_json(&event)
        .expect("test provider event JSON observation must record");
    observation
}

#[test]
fn usage_summary_prints_cache_hit_rate() {
    let summary = V3RuntimeUsageSummary {
        input_tokens: Some(59_842),
        output_tokens: Some(822),
        total_tokens: Some(60_664),
        cached_tokens: Some(41_984),
    };
    assert_eq!(
        format_v3_console_usage_summary(Some(&summary)),
        "usage_in=59842 usage_out=822 usage_cache=41984/59842(70.2%) usage_total=60664"
    );
}

#[test]
fn usage_summary_adds_separately_reported_cache_reads_to_input_and_total() {
    let summary = V3RuntimeUsageSummary {
        input_tokens: Some(184),
        output_tokens: Some(448),
        total_tokens: Some(632),
        cached_tokens: Some(147_840),
    };
    assert_eq!(
        format_v3_console_usage_summary(Some(&summary)),
        "usage_in=148024 usage_out=448 usage_cache=147840/148024(99.9%) usage_total=148472"
    );
    assert_eq!(
        format_v3_console_human_usage_summary(Some(&summary)).as_deref(),
        Some("usage_in=148024 usage_out=448 usage_cache=147840/148024(99.9%) usage_total=148472")
    );
}

#[test]
fn usage_summary_does_not_add_cache_already_in_input_tokens() {
    let summary = V3RuntimeUsageSummary {
        input_tokens: Some(59_842),
        output_tokens: Some(822),
        total_tokens: Some(60_664),
        cached_tokens: Some(41_984),
    };
    assert_eq!(
        format_v3_console_usage_summary(Some(&summary)),
        "usage_in=59842 usage_out=822 usage_cache=41984/59842(70.2%) usage_total=60664"
    );
}

#[test]
fn usage_summary_preserves_no_cache_and_missing_usage_fields() {
    let no_cache = V3RuntimeUsageSummary {
        input_tokens: Some(12),
        output_tokens: Some(3),
        total_tokens: Some(15),
        cached_tokens: None,
    };
    assert_eq!(
        format_v3_console_usage_summary(Some(&no_cache)),
        "usage_in=12 usage_out=3 usage_cache=0 usage_total=15"
    );
    assert_eq!(format_v3_console_usage_summary(None), "usage=unreported");
    assert_eq!(format_v3_console_human_usage_summary(None), None);
}

#[test]
fn usage_summary_extracts_cached_read_hit_tokens() {
    let summary = extract_v3_console_usage_summary(&json!({
        "usage": {
            "input_tokens": 59_842,
            "input_tokens_details": {
                "cached_read_tokens": 41_984,
                "cached_write_tokens": 7
            },
            "output_tokens": 822,
            "total_tokens": 60_664
        }
    }))
    .expect("usage summary");
    assert_eq!(summary.cached_tokens, Some(41_984));
    assert_eq!(
        format_v3_console_usage_summary(Some(&summary)),
        "usage_in=59842 usage_out=822 usage_cache=41984/59842(70.2%) usage_total=60664"
    );
}

fn format_v3_console_project_port(project_path: Option<&str>, port: u16) -> String {
    format!("{}:{port}", format_v3_console_project_name(project_path))
}

#[test]
fn console_project_path_reads_codex_environment_context_cwd() {
    let payload = json!({
        "model":"gpt-5.5",
        "client_metadata": {
            "x-codex-turn-metadata": "{\"workspaces\":{\"/Volumes/extension/code\":{\"associated_remote_urls\":{\"origin\":\"https://github.com/Jasonzhangf/OneStop.git\"}}}}"
        },
        "input": [{
            "type":"message",
            "role":"user",
            "content": [{
                "type":"input_text",
                "text":"<environment_context>\n  <cwd>/Volumes/extension/code/OneStop</cwd>\n  <shell>zsh</shell>\n  <filesystem><workspace_roots><root>/Volumes/extension/code/OneStop</root></workspace_roots></filesystem>\n</environment_context>"
            }]
        }]
    });
    let headers = HeaderMap::new();

    assert_eq!(
        resolve_v3_console_project_path(&headers, &payload).as_deref(),
        Some("/Volumes/extension/code/OneStop")
    );
}

#[test]
fn console_project_path_reads_injected_workspace_cwd_from_chat_system() {
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{
            "role": "system",
            "content": "You are a coding agent.\n\nCurrent workspace: \"/Users/fanzhang/github/routecodex\"\n\n## Environment\n\n- OS: darwin/arm64\n- Shell: bash"
        }, {
            "role": "user",
            "content": "ping"
        }]
    });
    let headers = HeaderMap::new();

    assert_eq!(
        resolve_v3_console_project_path(&headers, &payload).as_deref(),
        Some("/Users/fanzhang/github/routecodex")
    );
}

#[test]
fn console_project_path_prefers_header_over_injected_workspace_cwd() {
    let mut headers = HeaderMap::new();
    headers.insert("x-routecodex-workdir", HeaderValue::from_static("/from/header"));
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{
            "role": "system",
            "content": "Current workspace: \"/from/injected\""
        }]
    });

    assert_eq!(
        resolve_v3_console_project_path(&headers, &payload).as_deref(),
        Some("/from/header")
    );
}

#[test]
fn request_id_tokens_are_stable_and_path_safe() {
    assert_eq!(
        format_v3_request_id_entry("/v1/responses"),
        "openai-responses"
    );
    assert_eq!(format_v3_request_id_token("GPT-5.5 / SOL:β"), "GPT-5.5SOL");
}

#[test]
fn request_identity_allocation_keeps_persisted_and_typed_counts_atomic() {
    let state_file = std::env::temp_dir().join(format!(
        "routecodex-v3-request-counter-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut counter = V3RequestIdCounter {
        state_file: state_file.clone(),
        state: V3RequestCounterState::default(),
        loaded: false,
    };

    let first = counter
        .next_request_identity("openai-responses", "router", "gpt-5.5")
        .unwrap();
    let second = counter
        .next_request_identity("openai-responses", "router", "gpt-5.5")
        .unwrap();

    assert_eq!((first.total_count, first.daily_count), (1, 1));
    assert_eq!((second.total_count, second.daily_count), (2, 2));
    assert!(
        first
            .request_id
            .ends_with(&format!("-{}-{}", first.total_count, first.daily_count)),
        "{first:?}"
    );
    assert!(
        second
            .request_id
            .ends_with(&format!("-{}-{}", second.total_count, second.daily_count)),
        "{second:?}"
    );

    let mut reloaded = V3RequestIdCounter {
        state_file: state_file.clone(),
        state: V3RequestCounterState::default(),
        loaded: false,
    };
    let third = reloaded
        .next_request_identity("openai-responses", "router", "gpt-5.5")
        .unwrap();
    assert_eq!((third.total_count, third.daily_count), (3, 3));

    std::fs::remove_file(state_file).unwrap();
}

#[test]
fn v3_console_v2_usage_request_id_and_project_helpers_are_stable() {
    assert_eq!(
        format_v3_usage_request_id("openai-responses-router-test-20260721T000000000-12-3"),
        "12-3"
    );
    assert_eq!(format_v3_usage_request_id("req_123_456"), "123-456");
    assert_eq!(format_v3_usage_request_id("abcdef123456"), "ef123456");
    assert_eq!(
        format_v3_console_project_port(Some("/Users/fanzhang/Documents/github/routecodex"), 5555),
        "routecodex:5555"
    );
}

#[test]
fn console_timed_content_aligns_tags_by_terminal_display_width() {
    assert_eq!(v3_console_char_display_width('▶'), 1);
    assert_eq!(v3_console_char_display_width('✅'), 2);
    assert_eq!(v3_console_char_display_width('❌'), 2);
    assert_eq!(v3_console_char_display_width('🧭'), 2);

    let started = format_v3_console_timed_content("▶ [/v1/responses]", "req=a");
    let completed = format_v3_console_timed_content("✅ [/v1/responses]", "req=b");
    let failed = format_v3_console_timed_content("❌ [provider-error]", "req=e");
    let stopless = format_v3_console_timed_content("🧭 [stopless]", "req=c");
    let usage = format_v3_console_timed_content("[usage]", "req=d");

    let data_columns = [&started, &completed, &failed, &stopless, &usage].map(|line| {
        let boundary = line.find(" req=").expect("timed content must contain req");
        v3_console_display_width(&line[..boundary])
    });
    assert!(
        data_columns.windows(2).all(|pair| pair[0] == pair[1]),
        "timed content data columns must align by terminal display width: {data_columns:?}"
    );
}

#[test]
fn console_human_prefix_uses_fixed_terminal_columns() {
    let short = format_v3_console_human_prefix(
        "5520",
        "/v1/responses",
        Some("/tmp/OpenMinis"),
        "gpt-5.6-sol",
        "longcontext",
    );
    let cjk = format_v3_console_human_prefix(
        "10000",
        "/v1/messages",
        Some("/tmp/中文项目"),
        "claude-fable-5",
        "default",
    );
    let oversized_ascii = format_v3_console_human_prefix(
        "12345678901234567890",
        "/v1/chat/completions",
        Some("/tmp/project-name-that-exceeds-twenty-columns"),
        "provider-and-model-name-that-exceeds-thirty-six-columns",
        "route-name-that-also-exceeds-thirty-six-columns",
    );
    let oversized_cjk = format_v3_console_human_prefix(
        "端口端口端口端口端口端口端口",
        "/v1/responses",
        Some("/tmp/超长中文项目名称超过二十列"),
        "超长模型名称超长模型名称超长模型名称",
        "超长路由名称超长路由名称超长路由名称",
    );

    for prefix in [&short, &cjk, &oversized_ascii, &oversized_cjk] {
        let scopes = prefix
            .strip_prefix('[')
            .expect("prefix starts with scope")
            .strip_suffix(']')
            .expect("prefix ends with scope")
            .split("][")
            .collect::<Vec<_>>();
        assert_eq!(scopes.len(), 3, "{prefix}");
        assert_eq!(
            v3_console_display_width(scopes[0]),
            V3_CONSOLE_PREFIX_PORT_PROTOCOL_COLUMN_WIDTH,
            "{prefix}"
        );
        assert_eq!(
            v3_console_display_width(scopes[1]),
            V3_CONSOLE_PREFIX_PROJECT_COLUMN_WIDTH,
            "{prefix}"
        );
        assert_eq!(
            v3_console_display_width(scopes[2]),
            V3_CONSOLE_PREFIX_ROUTE_MODEL_COLUMN_WIDTH,
            "{prefix}"
        );
    }
    assert!(oversized_ascii.contains("..."), "{oversized_ascii}");
    assert!(oversized_cjk.contains("..."), "{oversized_cjk}");
}

#[test]
#[should_panic(expected = "v3 console route projection requires pool_id or routing_group_id")]
fn console_route_projection_rejects_missing_route_truth() {
    let _ = resolve_v3_console_route_projection(&V3RuntimeObservability::default());
}

#[test]
#[should_panic(
    expected = "provider-request dry-run must terminate before V3 console observability emission"
)]
fn console_route_projection_rejects_retired_dry_run_observability() {
    let _ = resolve_v3_console_route_projection(&V3RuntimeObservability {
        pool_id: Some("dry_run".to_string()),
        ..Default::default()
    });
}

#[test]
fn console_human_prefix_is_bright_while_debug_stays_dim() {
    let prefix = format_v3_console_human_prefix(
        "5520",
        "/v1/responses",
        Some("/tmp/OpenMinis"),
        "gpt-5.6-sol",
        "longcontext",
    );
    let colored = colorize_v3_layered_console_line(
        V3ConsoleLayeredBlock::new(
            &prefix,
            "▶ [/v1/responses] 13:27:35 route=longcontext",
            "req=req-1 event=started providerSwitchReason=pool:longcontext",
            "session-1",
        ),
        ANSI_REQUEST_CYAN,
        ANSI_DEBUG_DIM,
    );

    assert!(colored.starts_with(ANSI_REQUEST_CYAN), "{colored:?}");
    assert!(
        !colored.starts_with(ANSI_DEBUG_DIM),
        "human prefix must not use debug gray: {colored:?}"
    );
    assert!(
        !colored
            .split("\n\n")
            .next()
            .expect("human line")
            .contains(ANSI_DEBUG_DIM),
        "human line must not contain debug gray: {colored:?}"
    );
    assert!(
        colored.contains(&format!("\n\n{ANSI_DEBUG_DIM}")),
        "diagnostic layer must stay dim: {colored:?}"
    );
}

#[test]
fn console_plain_layer_has_one_blank_separator_and_one_diagnostic_line() {
    let prefix = format_v3_console_human_prefix(
        "5520",
        "/v1/responses",
        Some("/tmp/OpenMinis"),
        "gpt-5.6-sol",
        "longcontext",
    );
    let plain = format_v3_console_layered_block_plain(V3ConsoleLayeredBlock::new(
        &prefix,
        "▶ [/v1/responses] 13:27:35 route=longcontext",
        "req=req-1 event=started providerSwitchReason=pool:longcontext",
        "session-1",
    ));

    let lines = plain.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 3, "{plain:?}");
    assert!(lines[0].contains("▶ [/v1/responses]"), "{plain:?}");
    assert!(lines[1].is_empty(), "{plain:?}");
    let expected_scope = align_v3_console_display_width(
        "[sessionID:session-1]",
        V3_CONSOLE_DEBUG_SCOPE_COLUMN_WIDTH,
    );
    assert_eq!(
        lines[2],
        format!("  {expected_scope} req=req-1 event=started providerSwitchReason=pool:longcontext")
    );
}

#[test]
fn console_machine_fields_start_at_one_column_across_session_lengths() {
    let short = format_v3_console_layered_block_plain(V3ConsoleLayeredBlock::new(
        "",
        "headline",
        "req=short event=started",
        "s1",
    ));
    let long = format_v3_console_layered_block_plain(V3ConsoleLayeredBlock::new(
        "",
        "headline",
        "req=long event=started",
        "7a41-a44c-948f9ec6cf66",
    ));
    let oversized_session =
        "session-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let oversized_plain = format_v3_console_layered_block_plain(V3ConsoleLayeredBlock::new(
        "",
        "headline",
        "req=oversized-plain event=started",
        oversized_session,
    ));
    let oversized_color = strip_test_ansi(&colorize_v3_layered_console_line(
        V3ConsoleLayeredBlock::new(
            "",
            "headline",
            "req=oversized-color event=started",
            oversized_session,
        ),
        ANSI_REQUEST_CYAN,
        ANSI_DEBUG_DIM,
    ));

    let columns = [&short, &long, &oversized_plain, &oversized_color].map(|block| {
        let debug = block.lines().nth(2).expect("diagnostic line");
        let req = debug.find("req=").expect("machine field");
        v3_console_display_width(&debug[..req])
    });
    assert_eq!(columns[0], columns[1], "{short:?}\n{long:?}");
    assert_eq!(columns[0], columns[2], "{short:?}\n{oversized_plain:?}");
    assert_eq!(columns[0], columns[3], "{short:?}\n{oversized_color:?}");
    assert!(
        oversized_plain.contains(&format!("sessionIDFull={oversized_session}")),
        "{oversized_plain:?}"
    );
    assert!(
        oversized_color.contains(&format!("sessionIDFull={oversized_session}")),
        "{oversized_color:?}"
    );
}

#[test]
fn startup_console_uses_the_same_layered_builder() {
    let block = strip_test_ansi(&format_v3_startup_console_block(&[]));

    let lines = block.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 3, "{block:?}");
    assert!(lines[0].contains("[server:startup"), "{block}");
    assert!(lines[0].contains("✅ [RouteCodexV3]"), "{block}");
    assert!(lines[1].is_empty(), "{block:?}");
    assert!(lines[2].contains("event=started"), "{block}");
    assert!(lines[2].contains("version="), "{block}");
    assert!(lines[2].contains("binary="), "{block}");
}

#[test]
fn console_layering_keeps_request_debug_fields_off_human_headline() {
    let request_identity = V3AllocatedRequestIdentity {
        request_id: "openai-responses-router-gpt-5.5-sample-669944-7581".to_string(),
        total_count: 669_944,
        daily_count: 7_581,
    };
    let headline = render_v3_request_console_block(&V3ConsoleRequestHeadline {
        endpoint: "/v1/responses",
        route: "longcontext",
        target: "cc-sol[key1].gpt-5.6-sol",
        reason: "pool:longcontext",
        request_identity: &request_identity,
    });
    let debug = format_v3_console_timed_content(
        "▶ [/v1/responses]",
        "req=req-1 event=started stream=true acceptsSse=true rawInputItems=31 preparedInputItems=31 plannedEntryMode=none",
    );

    for machine_only in [
        "req=",
        "event=",
        "stream=",
        "acceptsSse=",
        "rawInputItems=",
        "preparedInputItems=",
        "plannedEntryMode=",
    ] {
        assert!(!headline.contains(machine_only), "{headline}");
        assert!(debug.contains(machine_only), "{debug}");
    }
    assert!(headline.contains("route=longcontext"), "{headline}");
    assert!(
        headline.contains("target=cc-sol[key1].gpt-5.6-sol"),
        "{headline}"
    );
    assert!(headline.contains("[#669944/7581]"), "{headline}");
}

#[test]
fn console_request_count_keeps_following_human_fields_aligned() {
    let short = V3AllocatedRequestIdentity {
        request_id: "short".to_string(),
        total_count: 1,
        daily_count: 1,
    };
    let current = V3AllocatedRequestIdentity {
        request_id: "current".to_string(),
        total_count: 669_944,
        daily_count: 7_581,
    };
    let oversized = V3AllocatedRequestIdentity {
        request_id: "oversized".to_string(),
        total_count: 12_345_678_901_234,
        daily_count: 123_456,
    };

    let short_cell = format_v3_console_request_count(&short);
    let current_cell = format_v3_console_request_count(&current);
    let oversized_cell = format_v3_console_request_count(&oversized);

    assert_eq!(
        v3_console_display_width(&short_cell),
        V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH
    );
    assert_eq!(
        v3_console_display_width(&current_cell),
        V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH
    );
    assert!(
        v3_console_display_width(&oversized_cell) > V3_CONSOLE_REQUEST_COUNT_COLUMN_WIDTH,
        "oversized counts must remain complete instead of being truncated: {oversized_cell:?}"
    );
    assert!(short_cell.contains("[#1/1]"), "{short_cell:?}");
    assert!(current_cell.contains("[#669944/7581]"), "{current_cell:?}");
    assert!(
        oversized_cell.contains("[#12345678901234/123456]"),
        "{oversized_cell:?}"
    );
}

#[test]
fn console_layering_promotes_response_facts_before_debug_details() {
    let request_identity = V3AllocatedRequestIdentity {
        request_id: "openai-responses-router-gpt-5.5-sample-669944-7581".to_string(),
        total_count: 669_944,
        daily_count: 7_581,
    };
    let headline = render_v3_response_console_block(&V3ConsoleResponseHeadline {
        endpoint: "/v1/responses",
        status: 200,
        response_status: "completed",
        finish_reason: "stop",
        elapsed_ms: 1234.5,
        reason: "pool:longcontext",
        usage: Some("usage_in=100 usage_out=20 usage_cache=0 usage_total=120"),
        internal_timing: "5.0ms",
        external_timing: "20.0ms",
        transport: "sse",
        request_identity: &request_identity,
    });
    let debug = format_v3_console_timed_content(
        "✅ [/v1/responses]",
        "req=req-1 event=completed nodes=16 providerStatus=200",
    );

    for human_fact in [
        "[#669944/7581]",
        "status=200",
        "responseStatus=completed",
        "finish_reason=stop",
        "elapsedMs=1234.5",
        "time_i=5.0ms",
        "time_e=20.0ms",
        "transport=sse",
    ] {
        assert!(headline.contains(human_fact), "{headline}");
    }
    for machine_only in ["req=", "event=", "nodes="] {
        assert!(!headline.contains(machine_only), "{headline}");
        assert!(debug.contains(machine_only), "{debug}");
    }

    let headline_without_usage = render_v3_response_console_block(&V3ConsoleResponseHeadline {
        endpoint: "/v1/responses",
        status: 200,
        response_status: "completed",
        finish_reason: "stop",
        elapsed_ms: 1234.5,
        reason: "pool:longcontext",
        usage: None,
        internal_timing: "5.0ms",
        external_timing: "20.0ms",
        transport: "sse",
        request_identity: &request_identity,
    });
    assert!(!headline_without_usage.contains("usage="));
    assert!(!headline_without_usage.contains("unreported"));
}

#[test]
fn console_timestamp_uses_local_timezone() {
    let _guard = TEST_TZ_LOCK.lock().unwrap();
    let _tz = TestTzGuard::set("Asia/Shanghai");
    let clock = v3_request_id_clock_now().unwrap();
    let local_hhmmss = clock.local_timestamp.get(9..15).unwrap();
    let expected = format!(
        "{}:{}:{}",
        &local_hhmmss[0..2],
        &local_hhmmss[2..4],
        &local_hhmmss[4..6]
    );
    assert_eq!(console_timestamp_hhmmss(), expected);
}

#[tokio::test]
async fn malformed_json_error_includes_body_length_without_raw_payload() {
    let request = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_LENGTH, "27")
        .body(Body::from(r#"{"model":"gpt-5.5","input":"#))
        .unwrap();

    let projected = read_json_payload(request)
        .await
        .expect_err("truncated JSON must fail at the HTTP boundary");

    assert_eq!(projected.status, 400);
    assert_eq!(projected.body["error"]["code"], "malformed_json");
    let message = projected.body["error"]["message"].as_str().unwrap();
    assert!(message.contains("malformed JSON request body"));
    assert!(message.contains("EOF"));
    assert!(message.contains("body_bytes=27"));
    assert!(message.contains("content_length=27"));
    assert!(
        !message.contains("gpt-5.5") && !message.contains("input"),
        "malformed JSON diagnostics must not echo raw client payload: {message}"
    );
}

#[test]
fn provider_failure_scope_uses_existing_session_header() {
    let log_file = test_v3_console_log_file("provider-failure-session-header");
    let state = test_v3_listener_state(&log_file, 5555);
    let mut headers = HeaderMap::new();
    headers.insert(
        "session-id",
        HeaderValue::from_static("existing-session-id"),
    );
    let scope = build_v3_provider_failure_session_scope_for_request(&state.server, &headers)
        .expect("existing session header must construct the control scope");

    assert_eq!(scope.session_id(), "existing-session-id");
    let _ = fs::remove_file(log_file);
}

#[test]
fn provider_failure_scope_uses_internal_request_id_without_client_session_header() {
    let log_file = test_v3_console_log_file("provider-failure-session-header-missing");
    let state = test_v3_listener_state(&log_file, 5555);
    let scope =
        get_failure_session_scope(&state.server, &HeaderMap::new(), "responses", "request-123")
            .expect("ordinary requests do not require a client session header");

    assert_eq!(scope.session_id(), "request-local-request-123");
    let _ = fs::remove_file(log_file);
}

#[test]
fn console_color_identity_reads_reasonix_root_session_id() {
    let payload = serde_json::json!({
        "sessionID": "reasonix-session-42",
        "model": "deepseek-v4-flash",
        "input": "hello"
    });
    let color_key = resolve_v3_log_session_color_key(
        &HeaderMap::new(),
        &payload,
        "request-should-not-be-used",
    );

    assert_eq!(color_key.as_deref(), Some("reasonix-session-42"));
}

#[test]
fn console_color_identity_uses_injected_project_when_session_is_absent() {
    let payload = serde_json::json!({
        "model": "deepseek-v4-flash",
        "messages": [{
            "role": "system",
            "content": "Current workspace: \"/Users/fanzhang/github/routecodex\""
        }]
    });
    let color_key = resolve_v3_log_session_color_key(
        &HeaderMap::new(),
        &payload,
        "request-should-not-be-used",
    );

    assert!(color_key
        .as_deref()
        .is_some_and(|key| key.contains("routecodex")));
    assert!(!color_key
        .as_deref()
        .is_some_and(|key| key.contains("request:")));
}

#[test]
fn responses_continuation_scope_reads_codex_turn_metadata_header() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-codex-turn-metadata",
        HeaderValue::from_static(
            r#"{"session_id":"codex-session","thread_id":"codex-thread","turn_id":"turn-1"}"#,
        ),
    );

    let (session_id, conversation_id) =
        responses_control_scope_headers(&headers).expect("codex turn metadata header");

    assert_eq!(session_id.as_deref(), Some("codex-session"));
    assert_eq!(conversation_id.as_deref(), Some("codex-thread"));
}

#[test]
fn responses_continuation_scope_prefers_explicit_headers_over_codex_turn_metadata() {
    let mut headers = HeaderMap::new();
    headers.insert("session-id", HeaderValue::from_static("explicit-session"));
    headers.insert("thread-id", HeaderValue::from_static("explicit-thread"));
    headers.insert(
        "x-codex-turn-metadata",
        HeaderValue::from_static(
            r#"{"session_id":"codex-session","thread_id":"codex-thread","turn_id":"turn-1"}"#,
        ),
    );

    let (session_id, conversation_id) =
        responses_control_scope_headers(&headers).expect("explicit continuation headers");

    assert_eq!(session_id.as_deref(), Some("explicit-session"));
    assert_eq!(conversation_id.as_deref(), Some("explicit-thread"));
}

#[test]
fn v3_console_v2_provider_target_uses_auth_alias_and_wire_model() {
    let observability = V3RuntimeObservability {
        provider_id: Some("test".to_string()),
        auth_alias: Some("key".to_string()),
        model_id: Some("test".to_string()),
        wire_model: Some("wire-test".to_string()),
        ..Default::default()
    };
    assert_eq!(
        format_v3_console_provider_target(&observability),
        "test[key].wire-test"
    );
}

#[test]
fn provider_failure_console_content_exposes_red_error_and_switch() {
    let event = V3RuntimeProviderFailureObservation {
        provider_key: "limited:key1:gpt-5.5".to_string(),
        provider_id: "limited".to_string(),
        auth_alias: Some("key1".to_string()),
        model_id: "gpt-5.5".to_string(),
        status: 502,
        error_type: Some("provider_error".to_string()),
        external_error_kind: Some("transport".to_string()),
        external_error_code: Some("TRANSPORT_ERROR".to_string()),
        external_error_status: None,
        internal_code: None,
        message: "provider response event codec failed".to_string(),
        failure_count: 3,
        health_state: "cooldown".to_string(),
        cooldown_until_ms: Some(903_000),
        action: "switch_provider".to_string(),
        next_provider_key: Some("minimax:key1:MiniMax-M3".to_string()),
        wait_ms: None,
    };
    let error_content = format_v3_provider_failure_console_content("req-provider-switch", &event);
    assert!(error_content.contains("❌ [provider-error]"));
    assert!(error_content.contains("[switch to:minimax[key1].MiniMax-M3]"));
    assert!(error_content.contains("[switch from:limited[key1].gpt-5.5]"));
    assert!(error_content.contains("result=switch_provider"));
    assert!(
        error_content
            .find("[switch to:minimax[key1].MiniMax-M3]")
            .unwrap()
            < error_content.find("causeStatus=502").unwrap()
    );
    assert!(
        error_content
            .find("[switch from:limited[key1].gpt-5.5]")
            .unwrap()
            < error_content.find("causeStatus=502").unwrap()
    );
    assert!(error_content.contains("failures=3"));
    assert!(error_content.contains("health=cooldown"));
    assert!(error_content.contains("external=transport"));
    assert!(error_content.contains("externalCode=TRANSPORT_ERROR"));
    let switch_content = format_v3_provider_switch_console_content("req-provider-switch", &event);
    assert!(switch_content.contains("[provider-switch]"));
    assert!(switch_content.contains(
        "[switch to:minimax[key1].MiniMax-M3] [switch from:limited[key1].gpt-5.5] result=switch_provider"
    ));
    assert!(
        switch_content
            .find("[switch to:minimax[key1].MiniMax-M3]")
            .unwrap()
            < switch_content.find("reason=provider_failure").unwrap()
    );
    // switch 行必须自带错误详情，单行即可观测切换原因
    assert!(switch_content.contains("causeStatus=502"));
    assert!(switch_content.contains("failures=3"));
    assert!(switch_content.contains("health=cooldown"));
    assert!(switch_content.contains("message=provider response event codec failed"));

    let colored = colorize_v3_layered_console_line(
        V3ConsoleLayeredBlock::new("", &error_content, &error_content, ""),
        ANSI_ERROR_RED,
        ANSI_DEBUG_DIM,
    );
    assert!(
        colored.starts_with(ANSI_ERROR_RED),
        "provider error console line must be red: {colored:?}"
    );
    assert!(
        colored.contains(&format!("\n\n{ANSI_DEBUG_DIM}")),
        "provider error diagnostic line must be dim gray: {colored:?}"
    );

    let terminal_event = V3RuntimeProviderFailureObservation {
        action: "terminal_default_floor_exhausted".to_string(),
        next_provider_key: None,
        ..event
    };
    let terminal_content =
        format_v3_provider_failure_console_content("req-provider-terminal", &terminal_event);
    assert!(terminal_content.contains("target=limited[key1].gpt-5.5"));
    assert!(terminal_content.contains("result=terminal_default_floor_exhausted"));
    assert!(terminal_content.contains("next=-"));
    assert!(!terminal_content.contains("[switch to:"));
    assert!(!terminal_content.contains("[switch from:"));
}

#[test]
fn direct_frame_console_emits_provider_switch_complete_and_usage() {
    let log_file = test_v3_console_log_file("direct-console-json");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-json",
        &headers,
        &json!({"model":"gpt-5.5"}),
    );
    let provider_failure = test_provider_failure_observation();
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(json!({
            "status": "completed",
            "finish_reason": "stop",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 2,
                "total_tokens": 12,
                "cached_tokens": 5
            }
        })),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(test_direct_observability(vec![provider_failure])),
        stream_observation: None,
    };

    assert!(emit_v3_direct_frame_console_lines(&context, &frame, Instant::now()).is_none());

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(
        log.contains("[virtual-router-hit]")
            && log.contains("[direct:second.gpt-5.5")
            && !log.contains("[gpt-5.5")
            && !log.contains("[pending")
            && log.contains("❌ [provider-error]")
            && log.contains("[provider-switch]")
            && log.contains("event=route_selected")
            && log.contains("event=completed")
            && log.contains("[usage]")
            && log.contains("req=req-direct-console-json"),
        "direct JSON console must emit route/terminal lines from pipeline observability provider.model, not request model or pre-route pending scope: {log}"
    );
    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn realtime_provider_failure_sink_prints_before_final_and_final_dedupes() {
    let log_file = test_v3_console_log_file("provider-failure-realtime-dedupe");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5555);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-provider-realtime",
        &headers,
        &json!({"model":"gpt-5.5"}),
    );
    let provider_failure = test_provider_failure_observation();
    let observability = test_direct_observability(vec![provider_failure.clone()]);
    let route_sink = build_v3_route_selection_event_sink(&context);
    let sink = build_v3_provider_failure_event_sink(&context);

    route_sink(&observability);
    sink(&observability, &provider_failure);
    let after_realtime = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(
        after_realtime.contains("❌ [provider-error]"),
        "{after_realtime}"
    );
    let provider_error_line = after_realtime
        .lines()
        .find(|line| {
            line.contains("❌ [provider-error]")
                && line.contains("[switch from:first[key].gpt-5.5]")
        })
        .unwrap_or_else(|| {
            panic!("missing provider-error line for failed provider: {after_realtime}")
        });
    assert!(
        provider_error_line.contains("[direct:first.gpt-5.5"),
        "provider failure prefix must name the failed provider, not the selected next provider: {provider_error_line}"
    );
    assert!(
        !provider_error_line.contains("[direct:second.gpt-5.5"),
        "provider failure line must not be displayed under the next provider target: {provider_error_line}"
    );
    assert!(
        provider_error_line.contains("[switch to:second[key].gpt-5.5]"),
        "provider failure line must label the selected next provider: {provider_error_line}"
    );
    assert!(
        after_realtime.contains("[provider-switch]"),
        "{after_realtime}"
    );
    assert!(
        !after_realtime.contains("event=completed"),
        "{after_realtime}"
    );

    let realtime_route_hits = after_realtime.matches("[virtual-router-hit]").count();
    let realtime_provider_errors = after_realtime.matches("❌ [provider-error]").count();
    let realtime_provider_switches = after_realtime.matches("[provider-switch]").count();
    emit_v3_provider_observability_console_lines(&context, &observability);
    let after_final = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert_eq!(
        after_final.matches("[virtual-router-hit]").count(),
        realtime_route_hits,
        "final observability must not reprint realtime route-selected blocks: {after_final}"
    );
    assert_eq!(
        after_final.matches("❌ [provider-error]").count(),
        realtime_provider_errors,
        "final observability must not reprint realtime provider-error blocks: {after_final}"
    );
    assert_eq!(
        after_final.matches("[provider-switch]").count(),
        realtime_provider_switches,
        "final observability must not reprint realtime provider-switch blocks: {after_final}"
    );
    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn routed_observability_emits_exactly_one_request_block() {
    let log_file = test_v3_console_log_file("routed-console-one-request-block");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5520);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-responses",
        &headers,
        &json!({"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}),
    );
    emit_v3_observability_console_lines(
        &context,
        200,
        &["V3Resp15ClientPayload"],
        &test_direct_observability(Vec::new()),
        Instant::now(),
        false,
    );

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert_eq!(
        log.matches("[virtual-router-hit]").count(),
        1,
        "the route-hit marker belongs only to the diagnostic line: {log}"
    );
    assert!(
        log.contains("▶ [/v1/responses]") && log.contains("route=direct"),
        "the single human request headline must carry endpoint and routed truth: {log}"
    );
    assert_eq!(
        log.matches("\n\n").count(),
        1,
        "the request must emit one block with one blank separator: {log}"
    );
    assert!(!log.contains("[pending"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn response_console_rejects_missing_terminal_summary_instead_of_showing_unreported() {
    let log_file = test_v3_console_log_file("response-console-unreported-status");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5520);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-unreported-status",
        &headers,
        &json!({"model":"gpt-5.5","input":[{"role":"user","content":"hi"}]}),
    );
    let mut observability = test_direct_observability(Vec::new());
    observability.response_status = None;
    observability.finish_reason = None;

    let missing_status_error = emit_v3_request_complete_console_line(
        &context,
        200,
        &["V3Resp15ClientPayload"],
        &observability,
        std::time::Duration::from_millis(1),
    )
    .expect_err("missing response_status must fail the success projection");
    assert!(missing_status_error.contains("missing response_status"));

    observability.response_status = Some("completed".to_string());
    let completed_result = emit_v3_request_complete_console_line(
        &context,
        200,
        &["V3Resp15ClientPayload"],
        &observability,
        std::time::Duration::from_millis(1),
    );
    assert!(
        completed_result.is_ok(),
        "finish_reason missing with response_status=completed must infer stop, not fail: {:?}",
        completed_result
    );

    observability.response_status = Some("in_progress".to_string());
    let missing_finish_error = emit_v3_request_complete_console_line(
        &context,
        200,
        &["V3Resp15ClientPayload"],
        &observability,
        std::time::Duration::from_millis(1),
    )
    .expect_err("finish_reason missing with non-inferrable response_status must fail");
    assert!(missing_finish_error.contains("missing finish_reason"));

    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn direct_frame_console_infers_stop_finish_reason_from_completed_json_status() {
    let log_file = test_v3_console_log_file("direct-console-json-infer-finish");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-json-infer-finish",
        &headers,
        &json!({"model":"gpt-5.5"}),
    );
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(json!({
            "status": "completed",
            "usage": {
                "input_tokens": 41,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens": 38,
                "total_tokens": 79
            }
        })),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            response_status: None,
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: None,
    };

    assert!(emit_v3_direct_frame_console_lines(&context, &frame, Instant::now()).is_none());

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=completed"), "{log}");
    assert!(log.contains("responseStatus=completed"), "{log}");
    assert!(log.contains("finish_reason=stop"), "{log}");
    assert!(log.contains("usage_in=41 usage_out=38"), "{log}");
    assert!(log.contains("usage_total=79"), "{log}");
    assert!(!log.contains("finish_reason=unreported"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_fails_when_terminal_success_missing() {
    let log_file = test_v3_console_log_file("direct-console-sse-complete");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n".to_vec(),
    )]));
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(stream),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: None,
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let response = responses_direct_output_response_with_console(
        frame,
        finalizer,
        Duration::from_millis(3_000),
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("response.failed"));

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(
        log.contains("[virtual-router-hit]")
            && log.contains("event=failed")
            && log.contains("status=502")
            && log.contains("subcode=provider_response_sse_stream")
            && log.contains("provider response SSE stream ended before terminal event")
            && !log.contains("event=completed"),
        "direct SSE closeout must not synthesize success when runtime observation has no terminal success: {log}"
    );
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_uses_runtime_stream_observation_for_usage_and_finish() {
    let log_file = test_v3_console_log_file("direct-console-sse-observed-usage");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-observed",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":17,\"input_tokens_details\":{\"cached_tokens\":5},\"output_tokens\":3,\"total_tokens\":20}}}\n\ndata: [DONE]\n\n".to_vec(),
    )]));
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(stream),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
            json!({
                "type":"response.completed",
                "response":{
                    "status":"completed",
                    "usage":{
                        "input_tokens":17,
                        "input_tokens_details":{"cached_tokens":5},
                        "output_tokens":3,
                        "total_tokens":20
                    }
                }
            }),
        )),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let response = responses_direct_output_response_with_console(
        frame,
        finalizer,
        Duration::from_millis(3_000),
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("response.completed"));

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=completed"), "{log}");
    assert!(log.contains("responseStatus=completed"), "{log}");
    assert!(log.contains("finish_reason=stop"), "{log}");
    assert!(log.contains("usage_in=17 usage_out=3"), "{log}");
    assert!(log.contains("usage_cache=5/17(29.4%)"), "{log}");
    assert!(log.contains("usage_total=20"), "{log}");
    assert!(!log.contains("usage=unreported"), "{log}");
    assert!(!log.contains("finish_reason=unreported"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_clean_eof_exposes_missing_runtime_timing_contract() {
    let log_file = test_v3_console_log_file("direct-console-sse-clean-eof-missing-timing");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-clean-eof-missing-timing",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
    )]));
    let frame = V3Server16HttpFrame {
        status: 201,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(stream),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            timing: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
            json!({"type":"response.completed","response":{"status":"completed"}}),
        )),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let response = responses_direct_output_response_with_console(
        frame,
        finalizer,
        Duration::from_millis(3_000),
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(std::str::from_utf8(&bytes)
        .unwrap()
        .contains("response.completed"));

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=failed"), "{log}");
    assert!(log.contains("status=500"), "{log}");
    assert!(
        log.contains("subcode=runtime_observability_contract"),
        "{log}"
    );
    assert!(
        log.contains("successful V3 Runtime observability is missing timing"),
        "{log}"
    );
    assert!(!log.contains("event=completed"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_does_not_fabricate_success_or_error_before_runtime_eof() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-after-completed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-drop-completed",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let provider = stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
    )])
    .chain(stream::pending::<Result<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >>());
    let frame = V3Server16HttpFrame {
        status: 201,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(provider)),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            timing: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
            json!({"type":"response.completed","response":{"status":"completed"}}),
        )),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let mut stream = wrap_v3_direct_sse_console_stream(
        match frame.body {
            V3Server16Body::Sse(stream) => stream,
            _ => unreachable!("test frame owns SSE body"),
        },
        finalizer,
    );
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.completed"));
    drop(stream);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(!log.contains("event=completed"), "{log}");
    assert!(!log.contains("event=failed"), "{log}");
    assert!(!log.contains("status=500"), "{log}");
    assert!(!log.contains("runtime_observability_contract"), "{log}");
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_abruptly_closes_without_fabricating_error06() {
    let log_file = test_v3_console_log_file("direct-console-sse-abrupt-no-error06");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-abrupt-no-error06",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Err::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        raise_v3_sse_provider_failure("provider_response_sse_stream", "abrupt direct stream close"),
    )]));
    let frame = V3Server16HttpFrame {
        status: 201,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(stream),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            timing: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: None,
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let mut client = wrap_v3_direct_sse_console_stream(
        match frame.body {
            V3Server16Body::Sse(stream) => stream,
            _ => unreachable!("test frame owns SSE body"),
        },
        finalizer,
    );
    assert!(client.next().await.unwrap().is_err());
    drop(client);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap_or_default());
    assert!(!log.contains("V3Error06ClientProjected"), "{log}");
    assert!(!log.contains("event=failed"), "{log}");
    assert!(!log.contains("provider_response_sse_stream"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_keeps_499_when_drop_before_terminal_observation() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-before-terminal");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-drop-before-terminal",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let provider = stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
    )])
    .chain(stream::pending::<Result<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >>());
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(provider)),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(V3RuntimeStreamObservation::default()),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let mut stream = wrap_v3_direct_sse_console_stream(
        match frame.body {
            V3Server16Body::Sse(stream) => stream,
            _ => unreachable!("test frame owns SSE body"),
        },
        finalizer,
    );
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.output_text.delta"));
    drop(stream);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=failed"), "{log}");
    assert!(log.contains("status=499"), "{log}");
    assert!(log.contains("subcode=client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_projects_observed_failed_terminal_before_drop() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-after-failed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-drop-failed",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let provider = stream::iter(vec![Ok::<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream terminal failure\"}}}\n\n".to_vec(),
    )])
    .chain(stream::pending::<Result<
        Vec<u8>,
        routecodex_v3_error::V3Error01SourceRaised,
    >>());
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(provider)),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
            json!({"type":"response.failed","response":{"status":"failed"}}),
        )),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let mut stream = wrap_v3_direct_sse_console_stream(
        match frame.body {
            V3Server16Body::Sse(stream) => stream,
            _ => unreachable!("test frame owns SSE body"),
        },
        finalizer,
    );
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.failed"));
    drop(stream);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=failed"), "{log}");
    assert!(log.contains("status=502"), "{log}");
    assert!(
        log.contains("subcode=provider_response_sse_terminal_failure"),
        "{log}"
    );
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn relay_sse_console_closeout_treats_drop_after_observed_completed_as_complete() {
    let log_file = test_v3_console_log_file("relay-console-sse-drop-after-completed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5520);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-relay-console-sse-drop-completed",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let provider = stream::iter(vec![Ok::<Vec<u8>, String>(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
    )])
    .chain(stream::pending::<Result<Vec<u8>, String>>());
    let stream_observation = test_runtime_stream_observation_from_provider_event_json(
        json!({"type":"response.completed","response":{"status":"completed"}}),
    );
    let mut observability = test_direct_observability(Vec::new());
    observability.execution_mode = "relay".to_string();
    observability.pool_id = Some("relay".to_string());
    let finalizer = V3SseConsoleFinalizer {
        context,
        status: 201,
        node_trace: vec!["V3HubRespOutbound05ClientSemantic"],
        observability,
        stream_observation,
        started_at: Instant::now(),
    };
    let mut stream = wrap_v3_relay_sse_console_stream(Box::pin(provider), Some(finalizer));
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.completed"));
    drop(stream);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=completed"), "{log}");
    assert!(log.contains("status=201"), "{log}");
    assert!(log.contains("responseStatus=completed"), "{log}");
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn relay_sse_console_closeout_projects_observed_failed_terminal_before_drop() {
    let log_file = test_v3_console_log_file("relay-console-sse-drop-after-failed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 5520);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-relay-console-sse-drop-failed",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let provider = stream::iter(vec![Ok::<Vec<u8>, String>(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n".to_vec(),
    )])
    .chain(stream::pending::<Result<Vec<u8>, String>>());
    let stream_observation = test_runtime_stream_observation_from_provider_event_json(
        json!({"type":"response.failed","response":{"status":"failed"}}),
    );
    let mut observability = test_direct_observability(Vec::new());
    observability.execution_mode = "relay".to_string();
    observability.pool_id = Some("relay".to_string());
    let finalizer = V3SseConsoleFinalizer {
        context,
        status: 200,
        node_trace: vec!["V3HubRespOutbound05ClientSemantic"],
        observability,
        stream_observation,
        started_at: Instant::now(),
    };
    let mut stream = wrap_v3_relay_sse_console_stream(Box::pin(provider), Some(finalizer));
    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.failed"));
    drop(stream);

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap());
    assert!(log.contains("event=failed"), "{log}");
    assert!(log.contains("status=502"), "{log}");
    assert!(
        log.contains("subcode=provider_response_sse_terminal_failure"),
        "{log}"
    );
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_body_error_projects_502_error_event_frame() {
    let log_file = test_v3_console_log_file("direct-console-sse-error");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = test_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-error",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let source = raise_v3_sse_provider_failure("provider_stream_error", "provider stream broke");
    let stream: V3ClientSseStream = Box::pin(stream::iter(vec![Err::<Vec<u8>, _>(source)]));
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(stream),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Resp15ClientPayload"],
        observability: Some(V3RuntimeObservability {
            transport: "sse".to_string(),
            response_status: Some("streaming".to_string()),
            finish_reason: None,
            usage: None,
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: None,
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let response = responses_direct_output_response_with_console(
        frame,
        finalizer,
        Duration::from_millis(3_000),
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(
        text.contains("event: error") && text.contains("\"status\":502"),
        "direct SSE provider failure must project a 502 error event frame, got: {text}"
    );
    assert!(text.contains("provider_stream_error"), "{text}");
    assert!(text.contains("provider stream broke"), "{text}");

    let log = strip_test_ansi(&std::fs::read_to_string(&log_file).unwrap_or_default());
    assert!(!log.contains("event=failed"), "{log}");
    assert!(!log.contains("V3Error06ClientProjected"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_provider_idle_timeout_projects_502_error_event_frame() {
    let stream: V3ClientSseStream = Box::pin(stream::unfold((), |()| async {
        futures_util::future::pending::<
            Option<(Result<Vec<u8>, V3Error01SourceRaised>, ())>,
        >()
        .await
    }));
    let body = v3_client_sse_body(
        stream,
        None,
        Some(Duration::from_millis(50)),
    );
    let mut client = body.into_data_stream();
    let frame = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("idle timeout must fire")
        .unwrap()
        .unwrap();
    let text = std::str::from_utf8(&frame).unwrap();
    assert!(
        text.contains("event: error") && text.contains("\"status\":502"),
        "idle provider SSE must project a 502 error event frame, got: {text}"
    );
    assert!(
        text.contains("provider_response_sse_idle_timeout"),
        "{text}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), client.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn direct_sse_keepalive_15s_heartbeat_emitted_for_idle_provider_stream() {
    let stream: V3ClientSseStream = Box::pin(stream::unfold((), |()| async {
        futures_util::future::pending::<
            Option<(Result<Vec<u8>, V3Error01SourceRaised>, ())>,
        >()
        .await
    }));
    let body = v3_client_sse_body(
        stream,
        Some(Duration::from_millis(50)),
        None,
    );
    let mut client = body.into_data_stream();
    let first = tokio::time::timeout(Duration::from_secs(1), client.next())
        .await
        .expect("initial keepalive must be emitted")
        .unwrap()
        .unwrap();
    assert_eq!(first.as_ref(), b": keepalive\n\n");
    let second = tokio::time::timeout(Duration::from_secs(1), client.next())
        .await
        .expect("keepalive heartbeat must be emitted while provider is idle")
        .unwrap()
        .unwrap();
    assert_eq!(second.as_ref(), b": keepalive\n\n");
}

#[test]
fn error_observability_does_not_emit_green_completed_line() {
    let mut observability = V3RuntimeObservability {
        response_status: Some("error".to_string()),
        ..Default::default()
    };
    assert!(!should_emit_v3_request_complete_console_line(
        429,
        &observability
    ));
    assert!(!should_emit_v3_request_complete_console_line(
        200,
        &observability
    ));

    observability.response_status = Some("streaming".to_string());
    assert!(should_emit_v3_request_complete_console_line(
        200,
        &observability
    ));
}

#[tokio::test]
async fn direct_stream_request_error06_projects_sse_error_not_json() {
    let frame = V3Server16HttpFrame {
        status: 429,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(json!({
            "error": {
                "code": "HTTP_429",
                "message": "Rate limited by upstream provider"
            }
        })),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "V3Error06ClientProjected",
        error_chain: vec!["V3Error01SourceRaised", "V3Error06ClientProjected"],
        error_body: None,
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };

    let projected = project_v3_responses_direct_stream_error_frame_if_requested(frame, true);
    assert_eq!(projected.status, 429);
    assert_eq!(projected.content_type, "text/event-stream");
    match projected.body {
        V3Server16Body::Sse(mut stream) => {
            let first = stream.next().await.unwrap().unwrap();
            let text = std::str::from_utf8(&first).unwrap();
            assert!(text.contains("event: error"), "{text}");
            assert!(text.contains("HTTP_429"), "{text}");
            assert!(text.contains("Rate limited by upstream provider"), "{text}");
            assert!(stream.next().await.is_none());
        }
        other => panic!("stream request Error06 must project SSE body, got {other:?}"),
    }
}

#[tokio::test]
async fn direct_continuation_scope_error_for_stream_request_projects_sse_not_json() {
    let log_file = test_v3_console_log_file("direct-continuation-scope-sse-error");
    let state = test_v3_listener_state(&log_file, 5555);
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("text/event-stream"));
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    let outcome = execute_responses_direct_server_outcome(
        state.as_ref(),
        &headers,
        "POST".to_string(),
        "/v1/responses".to_string(),
        "req-direct-sse-scope-error".to_string(),
        "exec-direct-sse-scope-error".to_string(),
        json!({
            "model":"gpt-5.5",
            "stream":true,
            "previous_response_id":"never_committed",
            "input":[{"type":"function_call_output","call_id":"call_1","output":"ok"}]
        }),
        None,
        None,
        None,
        None,
    )
    .await;
    let frame = match outcome {
        V3ResponsesDirectServerOutcome::DirectFrame(frame) => frame,
        V3ResponsesDirectServerOutcome::RelayOutput(_) => {
            panic!("direct continuation scope error must not relay")
        }
    };
    assert_eq!(frame.status, 400);
    assert_eq!(frame.content_type, "text/event-stream");
    assert_eq!(
        v3_server_frame_error_body_for_console(&frame)
            .and_then(|body| body.pointer("/error/code"))
            .and_then(Value::as_str),
        Some("malformed_json")
    );
    assert!(format_v3_error_console_content(
        "/v1/responses",
        "req-direct-sse-scope-error",
        frame.status,
        &frame.error_chain,
        v3_server_frame_error_body_for_console(&frame),
    )
    .contains("Responses continuation requires"));
    match frame.body {
        V3Server16Body::Sse(mut stream) => {
            let first = stream.next().await.unwrap().unwrap();
            let text = std::str::from_utf8(&first).unwrap();
            assert!(text.contains("event: error"), "{text}");
            assert!(text.contains("malformed_json"), "{text}");
            assert!(text.contains("Responses continuation requires"), "{text}");
            assert!(stream.next().await.is_none());
        }
        other => panic!("stream continuation scope error must project SSE body, got {other:?}"),
    }
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn accept_sse_error06_without_payload_projects_sse_error_not_json() {
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("text/event-stream"));
    let frame = V3Server16HttpFrame {
        status: 400,
        content_type: "application/json".to_string(),
        body: V3Server16Body::Json(json!({
            "error": {
                "code": "malformed_json",
                "message": "malformed JSON request body"
            }
        })),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "V3Error06ClientProjected",
        error_chain: vec!["V3Error01SourceRaised", "V3Error06ClientProjected"],
        error_body: None,
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };

    let projected = project_v3_responses_error_frame_for_request_if_sse(frame, &headers, None);
    assert_eq!(projected.content_type, "text/event-stream");
    match projected.body {
        V3Server16Body::Sse(mut stream) => {
            let first = stream.next().await.unwrap().unwrap();
            let text = std::str::from_utf8(&first).unwrap();
            assert!(text.contains("event: error"), "{text}");
            assert!(text.contains("malformed_json"), "{text}");
            assert!(text.contains("malformed JSON request body"), "{text}");
            assert!(stream.next().await.is_none());
        }
        other => panic!("Accept SSE Error06 must project SSE body, got {other:?}"),
    }
}

#[test]
fn error_projection_appends_human_console_failure_line() {
    let log_file = std::env::temp_dir().join(format!(
        "routecodex-v3-error-console-{}-{}.log",
        std::process::id(),
        console_timestamp_hhmmss()
    ));
    let _ = std::fs::remove_file(&log_file);
    let mut servers = BTreeMap::new();
    let server = V3ServerManifest {
        id: "server".to_string(),
        enabled: true,
        bind: "127.0.0.1".to_string(),
        port: 5555,
        routing_group: "controlled".to_string(),
        endpoints: vec!["responses".to_string()],
        features: BTreeMap::new(),
        execution: None,
        http_sse_keepalive_ms: 3_000,
        expose_models: Vec::new(),
    };
    servers.insert(server.id.clone(), server.clone());
    let manifest = Arc::new(V3Config05ManifestPublished {
        version: 3,
        hub_v1: None,
        servers,
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        route_groups: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: V3DebugManifest {
            log_console: false,
            log_file: Some(log_file.to_string_lossy().to_string()),
            snapshots: false,
            codex_samples: false,
            snapshot_stages: None,
            snapshot_direct: true,
            dry_run: false,
            retention: BTreeMap::new(),
        },
        error: routecodex_v3_config::V3ErrorManifest {
            policies: BTreeMap::new(),
            provider_error_action_policy: Vec::new(),
            client_error_projection_policy: Vec::new(),
        },
    });
    let debug = build_v3_debug_runtime_from_manifest(&manifest.debug).unwrap();
    let state = V3ListenerState {
        server,
        manifest_version: manifest.version,
        manifest: Arc::clone(&manifest),
        debug: debug.clone(),
        console_enabled: true,
        request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),
        codex_sample_persistence: Arc::new(Mutex::new(())),
        responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
        responses_direct_stopless_control: Arc::new(
            V3ResponsesDirectStoplessControlState::default(),
        ),
        responses_relay_local_continuation: Arc::new(
            V3ResponsesRelayLocalContinuationState::default(),
        ),
        responses_relay_stopless_control: Arc::new(V3ResponsesRelayStoplessControlState::default()),
        provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
            &manifest,
        )),
        responses_session_admission: Arc::new(V3ResponsesSessionAdmissionGate::default()),
    };
    let trace_scope = state
        .debug
        .start_trace("server", "req-error-console", "exec-error-console")
        .unwrap();

    let response = record_and_emit_v3_error_projection(
        &state,
        &trace_scope,
        V3ErrorProjectionConsoleInput {
            endpoint: "/v1/responses",
            request_id: "req-error-console",
            status: 500,
            error_chain: &routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS,
            body: Some(&json!({
                "error": {
                    "type":"runtime_error",
                    "message":"controlled error"
                }
            })),
            project_path: None,
        },
    );

    assert!(response.is_none());
    let log = std::fs::read_to_string(&log_file).unwrap();
    let plain_log = strip_test_ansi(&log);
    assert!(
        plain_log.contains("❌ [/v1/responses]")
            && plain_log.contains("req=req-error-console event=failed")
            && plain_log.contains("message=controlled error"),
        "human console log must include the visible failed line, not only JSON debug events: {log}"
    );
    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn stopless_console_activation_requires_action_stop_and_uses_fixed_orange() {
    let active = V3RuntimeObservability {
        response_status: Some("requires_action".to_string()),
        finish_reason: Some("tool_calls".to_string()),
        stopless_activation: true,
        ..Default::default()
    };
    assert!(is_v3_stopless_console_activation(&active));

    let completed = V3RuntimeObservability {
        response_status: Some("completed".to_string()),
        finish_reason: Some("stop".to_string()),
        stopless_activation: false,
        ..Default::default()
    };
    assert!(!is_v3_stopless_console_activation(&completed));

    let stopless_content = "[5555:responses:sessionID:xxxx][rules][glmrelay_openai.glm-5.2][tools] 🧭 [stopless] 00:00:00 req=req event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason=stop transport=sse";
    let colored = colorize_v3_layered_console_line(
        V3ConsoleLayeredBlock::new("", stopless_content, stopless_content, ""),
        ANSI_STOPLESS_ORANGE,
        ANSI_DEBUG_DIM,
    );
    assert!(
        colored.starts_with(ANSI_STOPLESS_ORANGE),
        "stopless console line must use fixed orange color: {colored:?}"
    );
    assert!(
        colored.contains(&format!("\n\n{ANSI_DEBUG_DIM}")),
        "stopless diagnostic line must be dim gray: {colored:?}"
    );
    assert!(colored.contains("hook="));
    assert!(colored.contains("reasoningStop"));
    assert!(colored.contains("callId="));
    assert!(colored.contains("call_stopless_reasoning"));
}

#[tokio::test]
async fn relay_sse_closeout_emits_complete_once_on_stream_eof_without_semantic_parsing() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let mut stream = wrap_v3_relay_sse_closeout_stream(
        Box::pin(futures_util::stream::iter(vec![Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()
        )])),
        move |terminal| recorded.lock().unwrap().push(terminal),
    );

    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec()
    );
    assert!(stream.next().await.is_none());
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Completed]
    );
}

#[tokio::test]
async fn relay_sse_closeout_treats_requires_action_as_opaque_payload_until_eof() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let mut stream = wrap_v3_relay_sse_closeout_stream(
        Box::pin(futures_util::stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"status\":\"requires_action\"}}\n\n".to_vec()),
            Ok(b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"status\":\"requires_action\",\"output\":[{\"type\":\"custom_tool_call\",\"call_id\":\"call_1\",\"name\":\"exec\",\"input\":\"{}\"}]}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ])),
        move |terminal| recorded.lock().unwrap().push(terminal),
    );

    let chunks = stream.by_ref().collect::<Vec<_>>().await;
    assert_eq!(chunks.len(), 3);
    assert!(chunks.iter().all(Result::is_ok));
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Completed]
    );
}

#[tokio::test]
async fn relay_sse_closeout_does_not_fail_by_parsing_nonterminal_payload() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let mut stream = wrap_v3_relay_sse_closeout_stream(
        Box::pin(futures_util::stream::iter(vec![Ok(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
        )])),
        move |terminal| recorded.lock().unwrap().push(terminal),
    );

    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()
    );
    assert!(stream.next().await.is_none());
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Completed]
    );
}

#[tokio::test]
async fn relay_sse_closeout_does_not_parse_response_failed_terminal_payload() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let mut stream = wrap_v3_relay_sse_closeout_stream(
        Box::pin(futures_util::stream::iter(vec![Ok(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream stream failed\"}}}\n\n".to_vec(),
        )])),
        move |terminal| recorded.lock().unwrap().push(terminal),
    );

    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.failed"));
    assert!(stream.next().await.is_none());
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Completed]
    );
}

#[tokio::test]
async fn relay_sse_body_error_propagates_without_fabricated_error_event() {
    let output = V3ResponsesRelayRuntimeOutput {
        status: 200,
        client_body: V3ResponsesRelayClientBody::Sse(Box::pin(futures_util::stream::iter(vec![
            Err("provider relay boom".to_string()),
        ]))),
        node_trace: vec!["V3HubRespOutbound05ClientSemantic"],
        error_chain: None,
        observability: None,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    };

    let response = responses_relay_output_response(output, None, Duration::from_millis(3_000));
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let result = to_bytes(response.into_body(), usize::MAX).await;
    assert!(
        result.is_err(),
        "relay SSE body failure must propagate as body error, not fabricated event:error bytes"
    );
}

#[tokio::test]
async fn relay_sse_body_abruptly_closes_without_fabricating_error_event() {
    let output = V3ResponsesRelayRuntimeOutput {
        status: 200,
        client_body: V3ResponsesRelayClientBody::Sse(Box::pin(futures_util::stream::iter(vec![
            Err("abrupt relay stream close".to_string()),
        ]))),
        node_trace: vec!["V3HubRespOutbound05ClientSemantic"],
        error_chain: None,
        observability: None,
        stream_observation: None,
        finalized_response: None,
        provider_snapshots: None,
        protocol_direct_handoff: None,
    };

    let response = responses_relay_output_response(output, None, Duration::from_millis(3_000));
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let result = to_bytes(response.into_body(), usize::MAX).await;
    assert!(
        result.is_err(),
        "relay SSE transport/body failure must propagate as abrupt body close, not fabricated event:error bytes: {:?}",
        result.ok().and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
    );
}

#[tokio::test]
async fn successful_responses_sse_emits_immediate_and_idle_periodic_keepalive_comments() {
    let provider = futures_util::stream::pending::<Result<Vec<u8>, io::Error>>();
    let body = v3_io_sse_body(Box::pin(provider), Some(Duration::from_millis(10)));
    let mut client = body.into_data_stream();

    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b": keepalive\n\n"
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(100), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .as_ref(),
        b": keepalive\n\n"
    );
}

#[tokio::test]
async fn completed_responses_sse_reaches_eof_without_late_keepalive_comments() {
    let provider = futures_util::stream::iter(vec![Ok::<Vec<u8>, io::Error>(
        b"event: response.completed\ndata: {}\n\n".to_vec(),
    )]);
    let body = v3_io_sse_body(Box::pin(provider), Some(Duration::from_millis(10)));
    let mut client = body.into_data_stream();

    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b": keepalive\n\n"
    );
    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b"event: response.completed\ndata: {}\n\n"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), client.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn responses_sse_relay_provider_stream_error_projects_502_error_event_frame() {
    let provider =
        futures_util::stream::iter(vec![Err::<Vec<u8>, String>("controlled error".into())]);
    let body = v3_guarded_relay_sse_body(
        Box::pin(provider),
        Some(Duration::from_millis(10)),
        Some(Duration::from_secs(300)),
        Arc::new(|message| v3_sse_error_event_chunk(502, "provider_sse_stream_error", message)),
    );
    let mut client = body.into_data_stream();

    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b": keepalive\n\n"
    );
    let frame = client.next().await.unwrap().unwrap();
    let text = std::str::from_utf8(&frame).unwrap();
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("\"status\":502"), "{text}");
    assert!(text.contains("controlled error"), "{text}");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), client.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn dropping_responses_sse_body_releases_source_and_keepalive_timer_state() {
    struct DropProbe(Arc<std::sync::atomic::AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let provider =
        futures_util::stream::unfold(DropProbe(Arc::clone(&dropped)), |probe| async move {
            futures_util::future::pending::<()>().await;
            Some((Ok::<Vec<u8>, io::Error>(Vec::new()), probe))
        });
    let body = v3_io_sse_body(Box::pin(provider), Some(Duration::from_millis(10)));
    let mut client = body.into_data_stream();
    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b": keepalive\n\n"
    );
    drop(client);

    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test]
async fn successful_direct_responses_sse_preserves_provider_bytes_without_keepalive() {
    let frame = V3Server16HttpFrame {
        status: 200,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: response.created\ndata: {}\n\n".to_vec(),
        )]))),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "none",
        error_chain: Vec::new(),
        error_body: None,
        node_trace: vec!["V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };
    let response = responses_direct_output_response(frame, Duration::from_millis(3_000));
    let mut client = response.into_body().into_data_stream();

    assert_eq!(
        client.next().await.unwrap().unwrap().as_ref(),
        b"event: response.created\ndata: {}\n\n"
    );
}

#[tokio::test]
async fn error06_responses_sse_starts_with_error_and_never_receives_keepalive() {
    let frame = V3Server16HttpFrame {
        status: 409,
        content_type: "text/event-stream".to_string(),
        body: V3Server16Body::Sse(Box::pin(stream::iter(vec![Ok::<
            Vec<u8>,
            routecodex_v3_error::V3Error01SourceRaised,
        >(
            b"event: error\ndata: {\"code\":\"request_in_flight\"}\n\n".to_vec(),
        )]))),
        debug_node: "V3Debug01NodeEventRegistered",
        error_node: "V3Error06ClientProjected",
        error_chain: vec!["V3Error01SourceRaised", "V3Error06ClientProjected"],
        error_body: None,
        node_trace: vec!["V3Error06ClientProjected", "V3Server16HttpFrame"],
        observability: None,
        stream_observation: None,
    };
    let response = responses_direct_output_response(frame, Duration::from_millis(10));
    let mut client = response.into_body().into_data_stream();

    let first = client.next().await.unwrap().unwrap();
    assert!(
        std::str::from_utf8(&first)
            .unwrap()
            .starts_with("event: error\n"),
        "{}",
        std::str::from_utf8(&first).unwrap()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), client.next())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn relay_sse_closeout_stream_error_does_not_fabricate_terminal() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let mut stream = wrap_v3_relay_sse_closeout_stream(
        Box::pin(futures_util::stream::iter(vec![Err(
            "provider boom".to_string()
        )])),
        move |terminal| recorded.lock().unwrap().push(terminal),
    );

    assert_eq!(stream.next().await.unwrap().unwrap_err(), "provider boom");
    drop(stream);

    assert!(
        events.lock().unwrap().is_empty(),
        "relay SSE body transport error must not fabricate semantic closeout terminal"
    );
}

#[tokio::test]
async fn relay_sse_closeout_emits_drop_when_client_disconnects_before_terminal() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let provider = futures_util::stream::iter(vec![Ok(b"data: first\n\n".to_vec())])
        .chain(futures_util::stream::pending::<Result<Vec<u8>, String>>());
    let mut stream = wrap_v3_relay_sse_closeout_stream(Box::pin(provider), move |terminal| {
        recorded.lock().unwrap().push(terminal)
    });

    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        b"data: first\n\n".to_vec()
    );
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Dropped]
    );
}

#[tokio::test]
async fn relay_sse_closeout_treats_drop_after_semantic_terminal_frame_as_transport_drop() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let provider = futures_util::stream::iter(vec![Ok(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n".to_vec(),
    )])
    .chain(futures_util::stream::pending::<Result<Vec<u8>, String>>());
    let mut stream = wrap_v3_relay_sse_closeout_stream(Box::pin(provider), move |terminal| {
        recorded.lock().unwrap().push(terminal)
    });

    let chunk = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&chunk)
        .unwrap()
        .contains("response.completed"));
    drop(stream);

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Dropped]
    );
}

#[test]
fn console_finish_reason_inferred_when_missing_on_completed_response() {
    let log_file = test_v3_console_log_file("console-finish-reason-infer");
    let state = test_v3_listener_state(&log_file, 1);
    let context = test_v3_console_emission_context(
        &state,
        "openai_chat",
        "/v1/chat/completions",
        "req-console-finish-reason-infer",
        &HeaderMap::new(),
        &serde_json::Value::Null,
    );
    let observability = V3RuntimeObservability {
        routing_group_id: Some("controlled".to_string()),
        pool_id: Some("default".to_string()),
        response_status: Some("completed".to_string()),
        finish_reason: None,
        timing: Some(V3RuntimeTimingSummary {
            runtime_total: std::time::Duration::from_millis(2),
            external: std::time::Duration::from_millis(1),
            internal: std::time::Duration::from_millis(1),
        }),
        ..V3RuntimeObservability::default()
    };
    let result = emit_v3_request_complete_console_line(
        &context,
        200,
        &["HubRespOutbound04ClientSemantic"],
        &observability,
        std::time::Duration::from_millis(1),
    );
    assert!(
        result.is_ok(),
        "finish_reason missing with response_status=completed must infer stop, not fail: {result:?}"
    );
}
