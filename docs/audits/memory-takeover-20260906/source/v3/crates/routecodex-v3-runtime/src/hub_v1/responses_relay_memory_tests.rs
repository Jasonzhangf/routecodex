use super::*;
use routecodex_v3_agent_memory::MemorySkillHandle;
use serde_json::json;
use std::sync::Arc;

fn terminal_memory_value(title: &str) -> serde_json::Value {
    json!({
        "entries": [{
            "schema": "routecodex.memory.index-entry.v1",
            "operation": "add",
            "scope": "project",
            "kind": "fact",
            "title": title,
            "summary": "A completed stop response is eligible for the Memory Skill.",
            "tags": ["relay"],
            "entities": ["routecodex"]
        }]
    })
}

struct RelayMemoryJsonTransport {
    response: Vec<u8>,
}

#[async_trait::async_trait]
impl ResponsesTransport for RelayMemoryJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            self.response.clone(),
        ))
    }
}

struct RelayMemorySseTransport {
    frames: Vec<Vec<u8>>,
}

#[async_trait::async_trait]
impl ResponsesTransport for RelayMemorySseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let frames = self.frames.clone();
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(futures_util::stream::iter(frames.into_iter().map(Ok))),
        ))
    }
}

fn memory_skill_root(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-relay-memory-runtime-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    root
}

fn memory_relay_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut manifest = relay_manifest();
    manifest
        .servers
        .get_mut("test")
        .and_then(|server| server.execution.as_mut())
        .expect("test execution manifest")
        .allowed_modes = vec!["relay".to_string()];
    manifest
}

fn relay_memory_plan(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    label: &str,
) -> (Arc<super::V3HubHookOperationPlan>, Arc<MemorySkillHandle>) {
    let skill = Arc::new(
        MemorySkillHandle::open(memory_skill_root(label)).expect("memory skill must open"),
    );
    let plan = compile_v3_hub_hook_operation_plan(manifest, Some(Arc::clone(&skill)))
        .expect("startup plan must compile");
    (plan, skill)
}

#[tokio::test]
async fn responses_relay_json_terminal_memory_runs_exit_operation_before_return() {
    std::env::set_var("ROUTECODEX_V3_TEST_KEY", "relay-memory-secret");
    let manifest = memory_relay_manifest();
    let memory = terminal_memory_value("Relay JSON terminal");
    let response = json!({
        "id": "resp-relay-memory-json",
        "status": "completed",
        "finish_reason": "stop",
        "output": [{
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "done"}]
        }],
        "memory": memory
    });
    let (plan, skill) = relay_memory_plan(&manifest, "json");
    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: missing_plan_scope("relay-memory-json"),
            request_id: "relay-memory-json".to_string(),
            payload: json!({"model":"client-model","input":"hello"}),
        },
        &RelayMemoryJsonTransport {
            response: serde_json::to_vec(&response).expect("response JSON"),
        },
        None,
        None,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
        None,
        Some(plan),
        true,
    )
    .await
    .expect("terminal JSON relay response");

    let body = match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("JSON request must return JSON"),
    };
    assert_eq!(body["memory"], memory);
    assert_eq!(
        skill.pending_entries().expect("pending index").len(),
        1,
        "Relay JSON must invoke the terminal Memory Skill operation"
    );
    assert!(output
        .node_trace
        .contains(&"V3HubHookOperationMemorySkillTerminalObservation"));
}

#[tokio::test]
async fn responses_relay_json_terminal_memory_disabled_is_exact_noop() {
    std::env::set_var("ROUTECODEX_V3_TEST_KEY", "relay-memory-secret");
    let mut manifest = memory_relay_manifest();
    manifest
        .hub_v1
        .as_mut()
        .expect("Hub v1")
        .hooks
        .iter_mut()
        .find(|hook| {
            hook.node == V3HubFixedNode::V3HubRespChatProcess03Governed
                && hook.phase == V3HubHookPhase::Exit
        })
        .expect("Resp03 exit hook")
        .operation_ids
        .retain(|id| id != "routecodex.memory.skill.terminal.v1");
    let memory = terminal_memory_value("Relay JSON disabled");
    let response = json!({
        "id": "resp-relay-memory-disabled",
        "status": "completed",
        "finish_reason": "stop",
        "output": [{
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "done"}]
        }],
        "memory": memory
    });
    let (plan, skill) = relay_memory_plan(&manifest, "json-disabled");
    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: missing_plan_scope("relay-memory-json-disabled"),
            request_id: "relay-memory-json-disabled".to_string(),
            payload: json!({"model":"client-model","input":"hello"}),
        },
        &RelayMemoryJsonTransport {
            response: serde_json::to_vec(&response).expect("response JSON"),
        },
        None,
        None,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
        None,
        Some(plan),
        true,
    )
    .await
    .expect("terminal JSON relay response");

    let body = match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("JSON request must return JSON"),
    };
    assert_eq!(body["memory"], memory);
    assert!(skill.pending_entries().expect("pending index").is_empty());
    assert!(!output
        .node_trace
        .contains(&"V3HubHookOperationMemorySkillTerminalObservation"));
}

#[tokio::test]
async fn responses_relay_sse_terminal_memory_observes_only_after_client_stream_completion() {
    std::env::set_var("ROUTECODEX_V3_TEST_KEY", "relay-memory-secret");
    let manifest = memory_relay_manifest();
    let memory = terminal_memory_value("Relay SSE terminal");
    let terminal = json!({
        "type": "response.completed",
        "response": {
            "id": "resp-relay-memory-sse",
            "status": "completed",
            "finish_reason": "stop",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "done"}]
            }],
            "memory": memory
        }
    });
    let terminal_bytes = format!(
        "event: response.completed\ndata: {}\n\n",
        serde_json::to_string(&terminal).expect("terminal JSON")
    )
    .into_bytes();
    let (plan, skill) = relay_memory_plan(&manifest, "sse");
    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: missing_plan_scope("relay-memory-sse"),
            request_id: "relay-memory-sse".to_string(),
            payload: json!({"model":"client-model","input":"hello","stream":true}),
        },
        &RelayMemorySseTransport {
            frames: vec![terminal_bytes],
        },
        None,
        None,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
        None,
        Some(plan),
        true,
    )
    .await
    .expect("terminal SSE relay response");

    assert!(skill.pending_entries().expect("pending index").is_empty());
    let mut stream = match output.client_body {
        V3ResponsesRelayClientBody::Sse(stream) => stream,
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must return SSE"),
    };
    let mut bytes = Vec::new();
    while let Some(frame) = stream.next().await {
        bytes.extend_from_slice(&frame);
    }
    assert!(String::from_utf8_lossy(&bytes).contains("response.completed"));
    assert_eq!(
        skill.pending_entries().expect("pending index").len(),
        1,
        "Memory observation must happen after the committed client SSE reaches terminal"
    );
}
