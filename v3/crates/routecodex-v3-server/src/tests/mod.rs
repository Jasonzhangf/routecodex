use super::*;

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

static TEST_TZ_LOCK: StdMutex<()> = StdMutex::new(());

unsafe extern "C" {
    fn tzset();
}

struct TestTzGuard {
    previous_tz: Option<std::ffi::OsString>,
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
            snapshot_stages: None,
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
        request_counter: Arc::new(Mutex::new(V3RequestIdCounter::new())),
        responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
        responses_relay_local_continuation: Arc::new(
            V3ResponsesRelayLocalContinuationState::default(),
        ),
        responses_relay_stopless_control: Arc::new(V3ResponsesRelayStoplessControlState::default()),
        provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
            &manifest,
        )),
        responses_direct_transport: Arc::new(V3ResponsesRelayDefaultTransport::default()),
    })
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
    }
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
    assert_eq!(
        format_v3_console_monitor_prefix(
            "5555",
            "/v1/responses",
            resolve_v3_console_project_path(&headers, &payload).as_deref()
        ),
        format!(
            "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}]",
            "OneStop", "-", "-"
        )
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
fn console_scoped_prefix_is_compact_project_model_route_shape() {
    assert_eq!(
        format_v3_console_scoped_prefix(
            "5520",
            "responses",
            "xxxx",
            Some("/Users/fanzhang/Documents/github/rules"),
            "cc.gpt-5.5",
            "thinking",
        ),
        format!(
            "[5520:responses:sessionID:xxxx][{:<12}][{:<28}][{:<13}]",
            "rules", "cc.gpt-5.5", "thinking"
        )
    );
}

#[test]
fn console_scoped_line_aligns_project_model_route_and_content_columns() {
    let short = format_v3_console_scoped_line(
        "5520",
        "responses",
        "xxxx",
        Some("/Users/fanzhang/Documents/github/rules"),
        "cc.gpt-5.5",
        "thinking",
        "▶ [/v1/responses] req=a",
    );
    let long = format_v3_console_scoped_line(
        "5520",
        "responses",
        "xxxx",
        Some("/Volumes/extension/code/OneStop"),
        "glmrelay_openai.glm-5.2",
        "longcontext",
        "▶ [/v1/responses] req=b",
    );
    assert_eq!(
        short.find(" ▶ [/v1/responses]"),
        long.find(" ▶ [/v1/responses]"),
        "content column must stay aligned for normal project/model/route data: short={short:?} long={long:?}"
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
fn request_console_color_marks_scope_and_finish_reason_values_white() {
    let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
    std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
    let colored = colorize_v3_request_console_line(
        "[5520:responses:sessionID:xxxx][rules][cc.gpt-5.5][thinking] [usage] req=622580-3466 finish_reason=tool_calls",
        Some("xxxx"),
    );
    if let Some(previous) = previous {
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
    } else {
        std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
    }
    assert!(colored.contains(&format!("{ANSI_WHITE}5520{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}xxxx{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}rules{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}cc.gpt-5.5{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}thinking{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}622580-3466{ANSI_RESET}")));
    assert!(colored.contains(&format!("{ANSI_WHITE}tool_calls{ANSI_RESET}")));
    assert!(colored.contains("responses"));
    assert!(colored.contains("finish_reason="));
}

#[test]
fn console_timestamp_uses_local_timezone() {
    let _guard = TEST_TZ_LOCK.lock().unwrap();
    let _tz = TestTzGuard::set("Asia/Shanghai");
    let clock = super::request_id::v3_request_id_clock_now().unwrap();
    let local_hhmmss = clock.local_timestamp.get(9..15).unwrap();
    let expected = format!(
        "{}:{}:{}",
        &local_hhmmss[0..2],
        &local_hhmmss[2..4],
        &local_hhmmss[4..6]
    );
    assert_eq!(console_timestamp_hhmmss(), expected);
}

#[test]
fn console_prefix_orders_port_entry_cwd_before_content() {
    assert_eq!(format_v3_console_project_port(None, 5555), "-:5555");
    let line = format_v3_error_console_line_with_port(
        "5555",
        "responses",
        "req-prefix",
        500,
        &V3_ERROR_CHAIN_NODE_IDS,
        Some(&json!({
            "error": {
                "type": "runtime_error",
                "message": "controlled"
            }
        })),
        None,
    );
    assert!(
        line.starts_with(&format!(
            "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
            "-", "-", "-"
        )),
        "console prefix must be scoped port/protocol/session/project/model/route before content: {line}"
    );
    assert!(line.contains("❌ [responses]"));
    assert!(line.contains("req=req-prefix event=failed"));
}

#[test]
fn malformed_json_error_console_uses_header_project_path_not_server_cwd() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-routecodex-workdir",
        HeaderValue::from_static("/Volumes/extension/code/OneStop"),
    );
    let line = format_v3_error_console_line_with_port(
        "5555",
        "responses",
        "req-malformed",
        400,
        &V3_ERROR_CHAIN_NODE_IDS,
        Some(&json!({
            "error": {
                "code": "malformed_json",
                "message": "malformed JSON request body"
            }
        })),
        resolve_v3_console_project_path(&headers, &Value::Null).as_deref(),
    );

    assert!(
        line.starts_with(&format!(
            "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
            "OneStop", "-", "-"
        )),
        "malformed request line must preserve compact header project scope: {line}"
    );
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
fn error_console_prefix_can_preserve_request_project_path() {
    let line = format_v3_error_console_line_with_port(
        "5555",
        "responses",
        "req-project-cwd",
        500,
        &V3_ERROR_CHAIN_NODE_IDS,
        Some(&json!({
            "error": {
                "type": "runtime_error",
                "message": "controlled"
            }
        })),
        Some("/Volumes/extension/code/OneStop"),
    );
    assert!(
        line.starts_with(&format!(
            "[5555:responses:sessionID:-][{:<12}][{:<28}][{:<13}] ",
            "OneStop", "-", "-"
        )),
        "failed request line must preserve compact request project scope: {line}"
    );
    assert!(line.contains("req=req-project-cwd event=failed"));
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
    assert!(error_content.contains("provider=limited[key1].gpt-5.5"));
    assert!(error_content.contains("failures=3"));
    assert!(error_content.contains("health=cooldown"));
    assert!(error_content.contains("next=minimax[key1].MiniMax-M3"));
    assert!(error_content.contains("external=transport"));
    assert!(error_content.contains("externalCode=TRANSPORT_ERROR"));
    let switch_content = format_v3_provider_switch_console_content("req-provider-switch", &event);
    assert!(switch_content.contains("[provider-switch]"));
    assert!(switch_content.contains("from=limited[key1].gpt-5.5 to=minimax[key1].MiniMax-M3"));

    let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
    std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
    let colored = colorize_v3_error_console_line(&error_content);
    if let Some(previous) = previous {
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
    } else {
        std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
    }
    assert!(
        colored.starts_with(ANSI_ERROR_RED),
        "provider error console line must be red: {colored:?}"
    );
}

#[test]
fn direct_frame_console_emits_provider_switch_complete_and_usage() {
    let log_file = test_v3_console_log_file("direct-console-json");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-json",
        &headers,
        &json!({"model":"gpt-5.5"}),
    );
    let provider_failure = V3RuntimeProviderFailureObservation {
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
    };
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
        log.contains("▶ [/v1/responses]")
            && log.contains("[second.gpt-5.5")
            && !log.contains("[gpt-5.5")
            && !log.contains("[pending")
            && log.contains("❌ [provider-error]")
            && log.contains("[provider-switch]")
            && log.contains("[virtual-router-hit]")
            && log.contains("event=completed")
            && log.contains("[usage]")
            && log.contains("req=req-direct-console-json"),
        "direct JSON console must emit start/route/terminal lines from pipeline observability provider.model, not request model or pre-route pending scope: {log}"
    );
    let _ = std::fs::remove_file(&log_file);
}

#[test]
fn direct_frame_console_infers_stop_finish_reason_from_completed_json_status() {
    let log_file = test_v3_console_log_file("direct-console-json-infer-finish");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
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
    let context = build_v3_console_emission_context(
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
    let response = responses_direct_output_response_with_console(frame, finalizer);
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
    let context = build_v3_console_emission_context(
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
    let response = responses_direct_output_response_with_console(frame, finalizer);
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
async fn direct_sse_console_closeout_treats_drop_after_observed_completed_as_complete() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-after-completed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
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
            ..test_direct_observability(Vec::new())
        }),
        stream_observation: Some(test_runtime_stream_observation_from_provider_event_json(
            json!({"type":"response.completed","response":{"status":"completed"}}),
        )),
    };
    let finalizer = emit_v3_direct_frame_console_lines(&context, &frame, Instant::now());
    let mut stream = direct_frame::wrap_v3_direct_sse_console_stream(
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
    assert!(log.contains("event=completed"), "{log}");
    assert!(log.contains("status=201"), "{log}");
    assert!(log.contains("responseStatus=completed"), "{log}");
    assert!(log.contains("finish_reason=stop"), "{log}");
    assert!(!log.contains("event=failed"), "{log}");
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_keeps_499_when_drop_before_terminal_observation() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-before-terminal");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
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
    let mut stream = direct_frame::wrap_v3_direct_sse_console_stream(
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
async fn direct_sse_console_closeout_projects_observed_failed_terminal_as_provider_failure() {
    let log_file = test_v3_console_log_file("direct-console-sse-drop-after-failed");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
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
    let mut stream = direct_frame::wrap_v3_direct_sse_console_stream(
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
    assert!(
        log.contains("response SSE stream ended with terminal status failed"),
        "{log}"
    );
    assert!(!log.contains("client_disconnect"), "{log}");
    let _ = std::fs::remove_file(&log_file);
}

#[tokio::test]
async fn direct_sse_console_closeout_emits_failure_on_stream_error() {
    let log_file = test_v3_console_log_file("direct-console-sse-error");
    let _ = std::fs::remove_file(&log_file);
    let state = test_v3_listener_state(&log_file, 4444);
    let headers = test_direct_console_headers();
    let context = build_v3_console_emission_context(
        &state,
        "responses",
        "/v1/responses",
        "req-direct-console-sse-error",
        &headers,
        &json!({"model":"gpt-5.5","stream":true}),
    );
    let source = routecodex_v3_error::build_v3_error_01_source_raised(
        routecodex_v3_error::V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        "provider_stream_error",
        "provider stream broke",
    );
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
    let response = responses_direct_output_response_with_console(frame, finalizer);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("provider_stream_error"), "{text}");
    assert!(text.contains("provider stream broke"), "{text}");

    let raw_log = std::fs::read_to_string(&log_file).unwrap();
    let log = strip_test_ansi(&raw_log);
    assert!(
        raw_log.contains(ANSI_ERROR_RED) && log.contains("event=failed"),
        "direct SSE transport error must be visibly red in raw console log: {raw_log:?}"
    );
    assert!(
        log.contains("event=failed")
            && log.contains("sessionID:direct-console-test")
            && log.contains("second.gpt-5.5")
            && log.contains("[direct")
            && log.contains("status=502")
            && log.contains("subcode=provider_response_sse_stream")
            && log.contains("provider stream broke"),
        "direct SSE transport error must emit a visible terminal failed console line: {log}"
    );
    let _ = std::fs::remove_file(&log_file);
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
    let frame = execute_responses_direct_server_frame(
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
    )
    .await;
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
            snapshot_stages: None,
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
        responses_direct_continuation: Arc::new(V3ResponsesDirectContinuationState::default()),
        responses_relay_local_continuation: Arc::new(
            V3ResponsesRelayLocalContinuationState::default(),
        ),
        responses_relay_stopless_control: Arc::new(V3ResponsesRelayStoplessControlState::default()),
        provider_health: Arc::new(V3ResponsesRelayProviderHealthHandle::from_manifest(
            &manifest,
        )),
        responses_direct_transport: Arc::new(V3ResponsesRelayDefaultTransport::default()),
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
            error_chain: &V3_ERROR_CHAIN_NODE_IDS,
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
fn stopless_console_activation_requires_action_stop_and_uses_fixed_color() {
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

    let previous = std::env::var_os("ROUTECODEX_FORCE_LOG_COLOR");
    std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", "1");
    let colored = colorize_v3_stopless_console_line(
        "[5555:responses:sessionID:xxxx][rules][glmrelay_openai.glm-5.2][tools] 🧭 [stopless] 00:00:00 req=req event=activated hook=reasoningStop callId=call_stopless_reasoning action=exec_command finish_reason=stop transport=sse",
    );
    if let Some(previous) = previous {
        std::env::set_var("ROUTECODEX_FORCE_LOG_COLOR", previous);
    } else {
        std::env::remove_var("ROUTECODEX_FORCE_LOG_COLOR");
    }
    assert!(
        colored.starts_with(ANSI_STOPLESS_PURPLE),
        "stopless console line must use fixed purple color: {colored:?}"
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
async fn relay_sse_body_projects_stream_error_event_instead_of_abrupt_close() {
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
    };

    let response = responses_relay_output_response(output, None);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("provider_response_sse_stream"), "{text}");
    assert!(text.contains("provider relay boom"), "{text}");
}

#[tokio::test]
async fn relay_sse_closeout_emits_failure_once_on_provider_stream_error() {
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

    assert_eq!(
        *events.lock().unwrap(),
        vec![V3SseConsoleStreamTerminal::Failed(
            "provider boom".to_string()
        )]
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
