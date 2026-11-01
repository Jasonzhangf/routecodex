//! Real /v1/responses terminal regressions. Strict captured Gemini upstream;
//! separately yielded SSE chunks; no live credentials or providers.
use axum::{
    body::Body,
    extract::State,
    http::{StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, path::PathBuf, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};
#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: Mutex<()> = Mutex::const_new(());
const KEY: &str = "V3_GEMINI_TERMINAL_PUBLIC_KEY";
const ARGS: &str = r#"{"left":17,"right":25,"note":"terminal association"}"#;

struct Home {
    home: Option<OsString>,
    key: Option<OsString>,
    path: PathBuf,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("rcc-gemini-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let value = Self {
            home: std::env::var_os("HOME"),
            key: std::env::var_os(KEY),
            path,
        };
        std::env::set_var("HOME", &value.path);
        std::env::set_var(KEY, "synthetic-fixture-key");
        value
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        for (name, value) in [("HOME", &self.home), (KEY, &self.key)] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

#[derive(Clone)]
struct Peer {
    frames: Vec<Value>,
    json: bool,
    captures: mpsc::UnboundedSender<Value>,
}
async fn upstream(State(peer): State<Peer>, uri: Uri, Json(body): Json<Value>) -> Response<Body> {
    let expected = if peer.json {
        ":generateContent"
    } else {
        ":streamGenerateContent"
    };
    let names: Vec<_> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|t| t["functionDeclarations"].as_array().into_iter().flatten())
        .filter_map(|d| d["name"].as_str())
        .collect();
    let forced = body
        .pointer("/toolConfig/functionCallingConfig/allowedFunctionNames/0")
        .and_then(Value::as_str);
    let valid = uri.path().ends_with(expected)
        && body.get("messages").is_none()
        && body["contents"].is_array()
        && names.len() == 1
        && forced == names.first().copied();
    peer.captures
        .send(json!({"path":uri.path(),"valid":valid,"body":body}))
        .unwrap();
    if !valid {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("strict Gemini shape refused"))
            .unwrap();
    }
    let wire_name = names[0].to_string();
    let frames: Vec<_> = peer
        .frames
        .iter()
        .cloned()
        .map(|mut frame| {
            for candidate in frame
                .get_mut("candidates")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                for part in candidate
                    .get_mut("content")
                    .and_then(|c| c.get_mut("parts"))
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    if let Some(call) = part.get_mut("functionCall") {
                        call["name"] = json!(wire_name);
                    }
                }
            }
            frame
        })
        .collect();
    if peer.json {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(frames[0].to_string()))
            .unwrap()
    } else {
        let chunks = futures_util::stream::iter(frames).then(|frame| async move {
            tokio::task::yield_now().await;
            Ok::<_, std::io::Error>(format!("data: {frame}\n\n"))
        });
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(chunks))
            .unwrap()
    }
}

fn manifest(
    port: u16,
    base: &str,
    json: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration().replace(direct, relay);
    let execution = hub_v1_fixture::hub_v1_server_execution("terminal");
    let streaming = if json { "never" } else { "always" };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.terminal]
bind = "127.0.0.1"
port = {port}
routing_group = "terminal"
endpoints = ["responses"]
{execution}
[providers.terminal]
type = "gemini"
base_url = "{base}"
default_model = "terminal-wire"
auth = {{ type = "api_key", entries = [{{ alias = "fixture", env = "{KEY}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "{streaming}" }}
[providers.terminal.models.terminal-wire]
wire_name = "terminal-wire"
aliases = ["terminal-client"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.terminal.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["terminal-client"] }}
targets = [{{ kind = "provider_model", provider = "terminal", model = "terminal-wire", key = "fixture", priority = 1 }}]
[route_groups.terminal.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "terminal", model = "terminal-wire", key = "fixture", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn request(stream: bool) -> Value {
    json!({"model":"terminal-client","stream":stream,"input":[{"role":"user","content":"terminal regression"}],
        "tools":[{"type":"namespace","name":"terminal_ops","tools":[{"type":"function","name":"evaluate","parameters":{"type":"object","properties":{"left":{"type":"integer"},"right":{"type":"integer"}}}}]}],
        "tool_choice":{"type":"function","name":"terminal_ops.evaluate"}})
}

async fn run(
    frames: Vec<Value>,
    json_provider: bool,
    expected: Option<&str>,
    outcomes: &[(&str, u64)],
) {
    run_checked(frames, json_provider, expected, outcomes, None, None).await;
}

async fn run_checked(
    frames: Vec<Value>,
    json_provider: bool,
    expected: Option<&str>,
    outcomes: &[(&str, u64)],
    association: Option<(&[Vec<usize>], &[Value])>,
    business: Option<(&[Value], &Value)>,
) {
    let (tx, mut captures) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1beta", listener.local_addr().unwrap());
    let (shutdown, done) = oneshot::channel();
    let app = Router::new()
        .route("/v1beta/models/:operation", post(upstream))
        .with_state(Peer {
            frames,
            json: json_provider,
            captures: tx,
        });
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = done.await;
            })
            .await
            .unwrap();
    });
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &base, json_provider))
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let mut failures = Vec::new();
    // Repeat successful business terminals with health enabled. A filter must
    // not exclude its exact provider key or prevent the next identical attempt.
    for _ in 0..if expected.is_some() { 2 } else { 1 } {
        let answer = client
            .post(&endpoint)
            .json(&request(!json_provider))
            .send()
            .await;
        let mut bytes = Vec::new();
        if let Ok(answer) = answer {
            assert_eq!(answer.status(), StatusCode::OK);
            let mut stream = answer.bytes_stream();
            while let Some(Ok(chunk)) = stream.next().await {
                bytes.extend_from_slice(&chunk);
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let events = if json_provider {
            Vec::new()
        } else {
            text.lines()
                .filter_map(|l| l.strip_prefix("data: "))
                .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                .collect::<Vec<_>>()
        };
        if !json_provider && expected.is_some() {
            for event_type in ["response.created", "response.in_progress"] {
                let snapshots = events
                    .iter()
                    .filter(|event| event["type"] == event_type)
                    .collect::<Vec<_>>();
                if snapshots.len() != 1 {
                    failures.push(format!("expected one {event_type} snapshot: {snapshots:?}"));
                }
                for snapshot in snapshots {
                    if snapshot["response"]["output"] != json!([])
                        || snapshot["response"]["status"] != "in_progress"
                        || snapshot["response"]
                            .get("gemini_candidate_outcomes")
                            .is_some()
                    {
                        failures.push(format!("{event_type} exposes terminal candidate outcomes before output: {snapshot}"));
                    }
                }
            }
        }
        let response = if json_provider {
            serde_json::from_slice::<Value>(&bytes).ok()
        } else {
            events
                .iter()
                .find(|e| {
                    matches!(
                        e["type"].as_str(),
                        Some("response.completed" | "response.incomplete")
                    )
                })
                .map(|e| e["response"].clone())
        };
        let mut attempts = Vec::new();
        while let Ok(Some(capture)) =
            tokio::time::timeout(Duration::from_millis(300), captures.recv()).await
        {
            attempts.push(capture);
        }
        eprintln!("EVIDENCE_TERMINAL_UPSTREAM={attempts:?} CLIENT={text}");
        assert!(
            !attempts.is_empty(),
            "fixture did not reach upstream; not behavioral RED"
        );
        assert!(
            attempts.iter().all(|c| c["valid"] == true),
            "strict upstream refused request"
        );
        match expected {
            None => {
                if response.is_some() {
                    failures.push(format!(
                        "undeliverable attempt committed a business terminal: {response:?}"
                    ));
                }
            }
            Some(reason) => {
                assert_eq!(attempts.len(), 1, "business terminal triggered recovery");
                match response {
                    None => failures.push("legal terminal did not deliver".into()),
                    Some(response) => {
                        if let Some((output, outcome)) = business {
                            assert_eq!(
                                response["output"],
                                json!(output),
                                "opaque business changed"
                            );
                            assert_eq!(
                                response["gemini_candidate_outcomes"],
                                json!([outcome]),
                                "business terminal changed"
                            );
                        }
                        let status = if reason == "STOP" {
                            "completed"
                        } else {
                            "incomplete"
                        };
                        if response["status"] != status {
                            failures.push(format!("wrong aggregate status: {response}"));
                        }
                        if reason != "STOP" && response["incomplete_details"]["reason"] != reason {
                            failures.push(format!("wrong incomplete reason: {response}"));
                        }
                        if let Some((indices, output)) = association {
                            let rows = response["gemini_candidate_outcomes"].as_array().unwrap();
                            assert_eq!(rows.len(), indices.len());
                            for (index, expected_indices) in indices.iter().enumerate() {
                                let row =
                                    rows.iter().find(|r| r["candidate_index"] == index).unwrap();
                                assert_eq!(row["finishReason"], "STOP");
                                assert_eq!(row["metadata"], json!({"origin":index}));
                                assert_eq!(row["content"]["role"], "model");
                                if row["output_indices"] != json!(expected_indices) {
                                    failures.push(format!("candidate {index} wrong final association: {row}; output={}", response["output"]));
                                }
                            }
                            assert_eq!(
                                response["output"],
                                json!(output),
                                "business output changed"
                            );
                        }
                        for (terminal, index) in outcomes {
                            let outcome = response["gemini_candidate_outcomes"]
                                .as_array()
                                .and_then(|rows| {
                                    rows.iter().find(|r| r["candidate_index"] == *index)
                                });
                            match outcome {
                                Some(row) if row["finishReason"] == *terminal => {
                                    let output =
                                        row["output_indices"][0].as_u64().unwrap() as usize;
                                    let call = &response["output"][output];
                                    if call["namespace"] != "terminal_ops"
                                        || call["name"] != "evaluate"
                                        || call["type"] != "function_call"
                                        || call["arguments"] != ARGS
                                        || call["call_id"] != format!("candidate_{index}")
                                    {
                                        failures.push(format!("candidate association or call semantics lost: {row} {call}"));
                                    }
                                }
                                _ => failures.push(format!(
                                    "candidate {index} original {terminal} lost: {response}"
                                )),
                            }
                        }
                    }
                }
            }
        }
        if !failures.is_empty() {
            break;
        }
    }
    assert!(handle.shutdown().await.is_empty());
    shutdown.send(()).unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

async fn unfinished(reason: Option<&str>, feedback: &str) {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    let mut last = json!({"promptFeedback":{"blockReason":feedback}});
    if let Some(reason) = reason {
        last["candidates"] = json!([{"index":0,"finishReason":reason}]);
    }
    run(
        vec![
            json!({"candidates":[{"index":0,"content":{"parts":[{"text":"unfinished"}]}}]}),
            last,
        ],
        false,
        None,
        &[],
    )
    .await;
}
#[tokio::test]
async fn gemini_empty_finish_reason_public() {
    unfinished(Some(""), "").await;
}
#[tokio::test]
async fn gemini_unspecified_finish_reason_public() {
    unfinished(Some("FINISH_REASON_UNSPECIFIED"), "").await;
}
#[tokio::test]
async fn gemini_default_feedback_unfinished_public() {
    unfinished(None, "BLOCK_REASON_UNSPECIFIED").await;
}
#[tokio::test]
async fn gemini_genuine_prompt_block_with_unfinished_candidate_public() {
    unfinished(None, "SAFETY").await;
}
#[tokio::test]
async fn gemini_genuine_terminal_controls_public() {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    for json_provider in [false, true] {
        run(vec![json!({"candidates":[{"index":0,"finishReason":"STOP","content":{"parts":[{"text":"done"}]}}]})], json_provider, Some("STOP"), &[]).await;
        run(
            vec![json!({"promptFeedback":{"blockReason":"SAFETY"}})],
            json_provider,
            Some("content_filter"),
            &[],
        )
        .await;
        for reason in [
            "IMAGE_RECITATION",
            "MODEL_ARMOR",
            "IMAGE_PROHIBITED_CONTENT",
        ] {
            run(
                vec![json!({"candidates":[{"index":0,"finishReason":reason}]})],
                json_provider,
                Some("content_filter"),
                &[],
            )
            .await;
        }
    }
}

#[tokio::test]
async fn gemini_model_tool_error_terminal_preserves_business_public() {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    for json_provider in [false, true] {
        for reason in [
            "MALFORMED_FUNCTION_CALL",
            "UNEXPECTED_TOOL_CALL",
            "TOO_MANY_TOOL_CALLS",
            "OTHER",
        ] {
            let candidate = json!({"index":0,"finishReason":reason,"finishMessage":"invalid generated call","content":{"parts":[]}});
            let outcome = json!({"index":0,"candidate_index":0,"finishReason":reason,"finishMessage":"invalid generated call","output_indices":[]});
            run_checked(
                vec![json!({"candidates":[candidate]})],
                json_provider,
                Some("STOP"),
                &[],
                None,
                Some((&[], &outcome)),
            )
            .await;
        }
    }
}

#[tokio::test]
async fn gemini_opaque_part_preserves_business_public() {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    let part = json!({"thought":false,"fileData":{"mimeType":"image/png","fileUri":"https://example.test/result.png"},"opaque":{"original":[false,17]}});
    let output = [json!({"type":"message","role":"assistant","content":[part.clone()]})];
    let outcome = json!({"index":0,"candidate_index":0,"finishReason":"STOP","output_indices":[0]});
    for json_provider in [false, true] {
        run_checked(vec![json!({"candidates":[{"index":0,"finishReason":"STOP","content":{"parts":[part.clone()]}}]})], json_provider, Some("STOP"), &[], None, Some((&output, &outcome))).await;
    }
}

#[tokio::test]
async fn gemini_empty_text_thought_flag_is_not_business_public() {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    for json_provider in [false, true] {
        for thought in [false, true] {
            run(
                vec![json!({"candidates":[{"index":0,"finishReason":"STOP","content":{"parts":[{"text":"","thought":thought}]}}]})],
                json_provider,
                None,
                &[],
            )
            .await;
        }
    }
}
async fn mixed(reason: &str, json_provider: bool) {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    for reversed in [false, true] {
        let mut candidates = vec![
            json!({"index":7,"finishReason":reason,"content":{"parts":[{"functionCall":{"id":"candidate_7","name":"placeholder","args":ARGS}}]}}),
            json!({"index":3,"finishReason":"STOP","content":{"parts":[{"functionCall":{"id":"candidate_3","name":"placeholder","args":ARGS}}]}}),
        ];
        if reversed {
            candidates.reverse();
        }
        let frames = if json_provider {
            vec![json!({"candidates":candidates})]
        } else {
            candidates
                .into_iter()
                .map(|c| json!({"candidates":[c]}))
                .collect()
        };
        run(
            frames,
            json_provider,
            Some(if reason == "MAX_TOKENS" {
                "max_output_tokens"
            } else {
                "content_filter"
            }),
            &[(reason, 7), ("STOP", 3)],
        )
        .await;
    }
}
#[tokio::test]
async fn gemini_safety_stop_sse_both_orders_public() {
    mixed("SAFETY", false).await;
}
#[tokio::test]
async fn gemini_max_tokens_stop_sse_both_orders_public() {
    mixed("MAX_TOKENS", false).await;
}
#[tokio::test]
async fn gemini_safety_stop_json_both_orders_public() {
    mixed("SAFETY", true).await;
}
#[tokio::test]
async fn gemini_max_tokens_stop_json_both_orders_public() {
    mixed("MAX_TOKENS", true).await;
}

async fn transformed_association(json_provider: bool, think: bool) {
    let _serial = LOCK.lock().await;
    let _home = Home::new();
    let text = if think {
        "before<think>candidate zero reasoning</think>after"
    } else {
        ""
    };
    let candidates = vec![
        json!({"index":0,"finishReason":"STOP","metadata":{"origin":0},"content":{"role":"model","parts":[{"text":text}]}}),
        json!({"index":1,"finishReason":"STOP","metadata":{"origin":1},"content":{"role":"model","parts":[{"thoughtSignature":"candidate-one-signature","functionCall":{"id":"candidate_1","name":"placeholder","args":ARGS}}]}}),
    ];
    let frames = if json_provider {
        vec![json!({"candidates":candidates})]
    } else {
        candidates
            .into_iter()
            .map(|c| json!({"candidates":[c]}))
            .collect()
    };
    let mut output = Vec::new();
    let indices = if think {
        output.push(json!({"type":"reasoning","summary":[{"type":"summary_text","text":"candidate zero reasoning"}]}));
        output.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"beforeafter"}]}));
        vec![vec![0, 1], vec![2]]
    } else {
        vec![vec![], vec![0]]
    };
    output.push(json!({"type":"function_call","namespace":"terminal_ops","name":"evaluate","arguments":ARGS,"id":"candidate_1","call_id":"candidate_1","thought_signature":"candidate-one-signature"}));
    run_checked(
        frames,
        json_provider,
        Some("STOP"),
        &[],
        Some((&indices, &output)),
        None,
    )
    .await;
}

#[tokio::test]
async fn gemini_association_empty_text_json_public() {
    transformed_association(true, false).await;
}
#[tokio::test]
async fn gemini_association_empty_text_sse_public() {
    transformed_association(false, false).await;
}
#[tokio::test]
async fn gemini_association_think_split_json_public() {
    transformed_association(true, true).await;
}
#[tokio::test]
async fn gemini_association_think_split_sse_public() {
    transformed_association(false, true).await;
}
