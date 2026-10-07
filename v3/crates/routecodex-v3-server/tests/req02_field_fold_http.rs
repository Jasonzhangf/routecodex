use axum::{extract::State, routing::post, Json, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_default_transport, V3ResponsesRelayClientBody,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    time::{timeout, Duration},
};

struct ProviderState {
    expected: Value,
    captures: mpsc::UnboundedSender<Value>,
}

async fn provider(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    state.captures.send(body.clone()).unwrap();
    if body["messages"] != state.expected || body.get("input").is_some() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":{"message":"provider received changed history"}})),
        );
    }
    (
        axum::http::StatusCode::OK,
        Json(json!({
            "id":"fold-http-response","object":"chat.completion","model":"fold-wire",
            "choices":[{"index":0,"message":{"role":"assistant","content":"fold-http-complete"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
        })),
    )
}

async fn assert_public_relay_http(raw: Value, expected: Value, request_id: &str) {
    std::env::set_var("REQ02_FOLD_HTTP_KEY", "fold-test-key");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures, mut received) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/chat/completions", post(provider))
        .with_state(Arc::new(ProviderState { expected, captures }));
    let (shutdown, stopped) = oneshot::channel::<()>();
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let config = format!(
        r#"
version = 3
[servers.fold]
bind = "127.0.0.1"
port = 45444
routing_group = "fold"
endpoints = ["responses"]
[servers.fold.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.fold]
type = "openai_chat"
base_url = "http://{address}/v1"
default_model = "fold-wire"
auth = {{type="api_key",entries=[{{alias="key",env="REQ02_FOLD_HTTP_KEY"}}]}}
[providers.fold.models.fold-wire]
capabilities = ["text", "tools"]
[route_groups.fold.pools.default]
selection = {{strategy="priority"}}
targets = [{{kind="provider_model",provider="fold",model="fold-wire",key="key",priority=1}}]
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&config).unwrap()).unwrap();
    let result = timeout(
        Duration::from_secs(5),
        execute_v3_responses_relay_runtime_with_default_transport(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "fold".into(),
                request_id: request_id.into(),
                payload: raw,
                failure_session_scope: V3ProviderFailureSessionScope::new(
                    "fold", "fold", request_id,
                )
                .unwrap(),
            },
        ),
    )
    .await;
    let capture = received.try_recv();
    let duplicate = received.try_recv();
    let _ = shutdown.send(());
    timeout(Duration::from_secs(3), upstream)
        .await
        .unwrap()
        .unwrap();
    let output = result
        .expect("public consumer must finish")
        .expect("real HTTP attempt must succeed");
    assert_eq!(
        output.status, 200,
        "strict provider rejected changed history: {output:?}"
    );
    assert!(
        output.error_chain.is_none(),
        "successful first attempt must have no error chain"
    );
    assert!(capture.is_ok(), "actual provider must receive the request");
    assert!(
        duplicate.is_err(),
        "a successful input must require exactly one attempt"
    );
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("JSON public consumer must return JSON");
    };
    assert_eq!(body["status"], "completed");
    assert_eq!(body["output_text"], "fold-http-complete");
    assert_eq!(
        body["output"],
        json!([{"type":"output_text","text":"fold-http-complete"}]),
        "public Relay semantic result must preserve the real provider completion"
    );
}

#[tokio::test]
async fn optional_null_container_preserves_real_http_user_turn() {
    assert_public_relay_http(
        json!({"model":"fold-wire","input":"hi","messages":null,"stream":false}),
        json!([{"role":"user","content":"hi"}]),
        "fold-http-null",
    )
    .await;
}

#[tokio::test]
async fn equivalent_tool_sources_keep_full_arguments_and_result_on_first_http_attempt() {
    let command = format!("{}\r\nEXACT_CMD_TAIL", "opaque;$()`bytes`".repeat(6000));
    let arguments = json!({"cmd":command}).to_string();
    let output = "tool result\r\nEXACT_RESULT_TAIL";
    let messages = json!([
        {"role":"assistant","content":null,"tool_calls":[{"id":"fold-call","type":"function","function":{"name":"exec","arguments":arguments}}]},
        {"role":"tool","tool_call_id":"fold-call","content":output}
    ]);
    assert_public_relay_http(json!({
        "model":"fold-wire","stream":false,
        "tools":[{"type":"function","name":"exec","parameters":{"type":"object"}}],
        "messages":messages,
        "input":[
            {"type":"function_call","id":"fc_source","call_id":"fold-call","name":"exec","arguments":arguments},
            {"type":"function_call_output","id":"fco_source","call_id":"fold-call","output":output}
        ]
    }), messages, "fold-http-tools").await;
}

#[tokio::test]
async fn mixed_source_output_kind_preserves_representable_http_pair_without_name_rules() {
    let arguments = "{\"cmd\":\"complete command\\r\\nCOMMAND_TAIL\"}";
    let output = "complete result\r\nRESULT_TAIL";
    let call = json!({"role":"assistant","content":null,"tool_calls":[{
        "id":"mixed-kind-call","type":"function",
        "function":{"name":"opaque_client_tool","arguments":arguments}
    }]});
    assert_public_relay_http(
        json!({
            "model":"fold-wire","stream":false,
            "messages":[call.clone()],
            "input":[{"type":"custom_tool_call_output","call_id":"mixed-kind-call","output":output}]
        }),
        json!([
            call,
            {"role":"tool","tool_call_id":"mixed-kind-call","content":output}
        ]),
        "fold-http-mixed-kind",
    )
    .await;
}
