//! Real Responses entry: a failed Direct attempt must retain its own wire evidence.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();
const PRIVATE: &str = "OWNED_885BB74_UPSTREAM_FAILURE";

fn failure_body(sensitive: bool) -> Value {
    let mut body = json!({"error":{"type":"owned885","message":PRIVATE}});
    if sensitive {
        body["api_key"] = "owned885-private-body-key".into();
    }
    body
}

#[derive(Clone)]
struct Peer {
    fail: bool,
    requests: Arc<Mutex<Vec<Value>>>,
}

async fn upstream(
    State(peer): State<Peer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    assert_eq!(headers["authorization"], "Bearer owned885-secret");
    assert_eq!(body["model"], "wire885");
    assert_eq!(body["tools"][0]["name"], "lookup");
    assert!(body["input"].to_string().contains("OWNED885_REQUEST"));
    peer.requests.lock().unwrap().push(body.clone());
    if peer.fail {
        return (
            StatusCode::BAD_GATEWAY,
            [
                ("x-owned-wire", "primary885"),
                ("x-request-id", "upstream885"),
                ("set-cookie", "private885-cookie"),
            ],
            Json(failure_body(body["stream"] == true)),
        )
            .into_response();
    }
    let response = json!({"id":"resp885","object":"response","status":"completed","model":"wire885",
        "output":[{"id":"msg885","type":"message","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":"RECOVERED885","annotations":[]}]}]});
    if body["stream"] == true {
        let wire = format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed","response":response})
        );
        ([("content-type", "text/event-stream")], wire).into_response()
    } else {
        Json(response).into_response()
    }
}

async fn peer(fail: bool) -> (u16, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Peer {
            fail,
            requests: requests.clone(),
        });
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, requests, task)
}

fn manifest(
    port: u16,
    primary: u16,
    fallback: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("evidence885");
    let mut source = format!(
        r#"
version = 3
{declaration}
[servers.evidence885]
bind = "127.0.0.1"
port = {port}
routing_group = "evidence885"
endpoints = ["responses"]
{execution}
"#
    );
    for (id, peer) in [("primary885", primary), ("fallback885", fallback)] {
        source.push_str(&format!(
            r#"
[providers.{id}]
type = "responses"
base_url = "http://127.0.0.1:{peer}/v1"
default_model = "wire885"
auth = {{type="api_key", entries=[{{alias="key1",env="OWNED885_KEY"}}]}}
health = {{enabled=false, failure_threshold=1,cooldown_ms=5000}}
[providers.{id}.models.wire885]
wire_name = "wire885"
capabilities = ["text","tools"]
supports_streaming = true
"#
        ));
    }
    source.push_str(
        r#"
[route_groups.evidence885.pools.default]
selection = {strategy="priority"}
targets = [
 {kind="provider_model",provider="primary885",model="wire885",key="key1",priority=2},
 {kind="provider_model",provider="fallback885",model="wire885",key="key1",priority=1}
]
[debug]
log_console = false
snapshots = true
codex_samples = true
"#,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn issue885bb74_responses_failure_sink_matches_final_observation() {
    use routecodex_v3_runtime::{
        build_v3_server_03_http_request_raw,
        execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug,
        register_responses_direct_hooks, V3ProviderFailureRuntimeHealth,
        V3ResponsesDirectRuntimeSharedState, V3ResponsesDirectServerToolScope,
        V3ResponsesDirectServerToolState, V3RuntimeProviderFailureEventSink,
    };
    let (_home, _lock) = LOCK.lock().await;
    std::env::set_var("OWNED885_KEY", "owned885-secret");
    let (primary, a, primary_task) = peer(true).await;
    let (fallback, b, fallback_task) = peer(false).await;
    let port = test_ports::free_port();
    let manifest = manifest(port, primary, fallback);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();
    let sink: V3RuntimeProviderFailureEventSink = Arc::new(move |_, event| {
        captured.lock().unwrap().push(event.clone());
    });
    let state = V3ResponsesDirectServerToolState::default();
    let shared = V3ResponsesDirectRuntimeSharedState::new(
        &state,
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
    )
    .with_provider_failure_event_sink(Some(sink));
    let scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "evidence885",
        "evidence885",
        "session885",
    )
    .unwrap()
    .with_transport_handoff_scope("pipeline885", port, 1)
    .unwrap();
    let mut raw = build_v3_server_03_http_request_raw(
        "evidence885".into(),
        scope,
        "request885".into(),
        "execution885".into(),
        "POST".into(),
        "/v1/responses".into(),
        json!({"model":"auto","stream":false,"input":"OWNED885_REQUEST_SINK",
            "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{}}}]}),
    );
    raw.port = Some(port);
    raw.pipeline_id = Some("pipeline885".into());
    let debug = routecodex_v3_debug::V3DebugRuntime::new(Default::default()).unwrap();
    let output =
        execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug(
            shared,
            &manifest,
            raw,
            V3ResponsesDirectServerToolScope::new(
                "/v1/responses",
                "session885",
                "conversation885",
                port,
                "evidence885",
            ),
            register_responses_direct_hooks(),
            &debug,
            1000,
        )
        .await;
    assert_eq!(a.lock().unwrap().len(), 1);
    assert_eq!(b.lock().unwrap().len(), 1);
    let events = seen.lock().unwrap();
    assert_eq!(events.len(), 1);
    let immediate = events[0]
        .failed_attempt_evidence
        .as_ref()
        .expect("sink evidence");
    let final_events = &output
        .observability
        .as_ref()
        .expect("final observation")
        .provider_failure_events;
    assert_eq!(final_events.len(), 1);
    assert_eq!(
        Some(immediate),
        final_events[0].failed_attempt_evidence.as_ref()
    );
    assert_eq!(immediate.attempt, 1);
    assert_eq!(immediate.provider_response["status"], 502);
    primary_task.abort();
    fallback_task.abort();
}

#[tokio::test]
async fn issue885bb74_responses_direct_http502_recovers_with_wire_evidence_json_and_sse() {
    let (_home, _lock) = LOCK.lock().await;
    std::env::set_var("OWNED885_KEY", "owned885-secret");
    let mut diagnostics = Vec::new();
    for stream in [false, true] {
        let (primary, a, primary_task) = peer(true).await;
        let (fallback, b, fallback_task) = peer(false).await;
        let port = test_ports::free_port();
        let handle = spawn_v3_server_aggregate(manifest(port, primary, fallback))
            .await
            .unwrap();
        let marker = format!("OWNED885_REQUEST_{stream}");
        let response = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap()
            .post(format!("http://127.0.0.1:{port}/v1/responses"))
            .json(&json!({"model":"auto","stream":stream,"input":marker,
                "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{}}}]}))
            .send().await.unwrap();
        assert_eq!(response.status(), 200);
        let wire = response.text().await.unwrap();
        assert!(wire.contains("RECOVERED885"), "{wire}");
        for private in [
            PRIVATE,
            "owned885-secret",
            "failed_attempt_evidence",
            "network_error",
            "response.failed",
        ] {
            assert!(!wire.contains(private), "private/error data leaked: {wire}");
        }
        assert_eq!(a.lock().unwrap().len(), 1);
        assert_eq!(b.lock().unwrap().len(), 1);
        handle.wait_for_codex_sample_persistence().await.unwrap();
        let samples = PathBuf::from(std::env::var_os("HOME").unwrap())
            .join(format!(".rcc/codex-samples/openai-responses/ports/{port}"));
        let dirs: Vec<_> = std::fs::read_dir(&samples)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                std::fs::read_to_string(path.join("request.json"))
                    .is_ok_and(|text| text.contains(&marker))
            })
            .collect();
        assert_eq!(dirs.len(), 1);
        let artifact: Value = serde_json::from_slice(
            &std::fs::read(dirs[0].join("provider-failed-attempts.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(artifact["attempts"].as_array().unwrap().len(), 1);
        let attempt = &artifact["attempts"][0];
        assert_eq!(attempt["provider_id"], "primary885");
        assert_eq!(attempt["auth_alias"], "key1");
        assert_eq!(attempt["status"], 502);
        let evidence = &attempt["failed_attempt_evidence"];
        if evidence.is_null() {
            diagnostics.push(format!(
                "stream={stream}: failed attempt wire evidence is null"
            ));
        } else {
            assert_eq!(evidence["attempt"], 1);
            assert_eq!(evidence["provider_request"]["body"], a.lock().unwrap()[0]);
            assert_eq!(evidence["provider_response"]["status"], 502);
            let headers = evidence["provider_response"]["headers"].as_array().unwrap();
            assert!(headers
                .iter()
                .any(|header| header["name"] == "x-owned-wire" && header["value"] == "primary885"));
            assert!(headers
                .iter()
                .any(|header| header["name"] == "set-cookie" && header["value"] == "[REDACTED]"));
            let bytes: Vec<u8> = evidence["provider_response"]["body"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect();
            let mut expected = failure_body(stream);
            if stream {
                expected["api_key"] = "[REDACTED]".into();
            } else {
                assert_eq!(bytes, serde_json::to_vec(&expected).unwrap());
            }
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
            assert_eq!(evidence["provider_response"]["body"]["redacted"], stream);
            assert!(!evidence.to_string().contains("owned885-secret"));
        }
        handle.shutdown().await;
        primary_task.abort();
        fallback_task.abort();
    }
    assert!(diagnostics.is_empty(), "{}", diagnostics.join("\n"));
}
