use super::*;
use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_agent_memory::{
    organize_pending_generation, MemoryIndexEntryDraftV1, MemoryKind, MemoryKnowledgeStore,
    MemoryOperation, MemoryOrganizationMode, MemoryScope, MemorySkillHandle, MemorySourceKind,
    MemorySourceWindow, PendingIndex, MEMORY_ENTRY_SCHEMA_V1,
};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct MemoryCaptureTransport {
    bodies: Arc<Mutex<Vec<Value>>>,
    response_payload: Value,
}

#[async_trait]
impl ResponsesTransport for MemoryCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.bodies.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response_payload).expect("test response serializes"),
        ))
    }
}

struct MemorySseTransport {
    frames: Vec<Vec<u8>>,
}

#[async_trait]
impl ResponsesTransport for MemorySseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_owned(),
            request.provider_id().to_owned(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(
                self.frames
                    .clone()
                    .into_iter()
                    .map(Ok::<Vec<u8>, V3ProviderError>),
            )),
        ))
    }
}

fn responses_sse_frame(event_type: &str, event: Value) -> Vec<u8> {
    let data = serde_json::to_string(&event).expect("test SSE event serializes");
    format!("event: {event_type}\ndata: {data}\n\n").into_bytes()
}

fn responses_sse_memory_frames() -> Vec<Vec<u8>> {
    vec![
        responses_sse_frame(
            "response.created",
            json!({
                "type": "response.created",
                "response": {"id": "resp_memory_sse", "status": "in_progress", "output": []}
            }),
        ),
        responses_sse_frame(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": "msg_memory_sse",
                "output_index": 0,
                "content_index": 0,
                "delta": "done"
            }),
        ),
        // Native Responses SSE uses the typed response.completed/status pair;
        // finish_reason is intentionally absent from this wire terminal.
        responses_sse_frame(
            "response.completed",
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp_memory_sse",
                    "status": "completed",
                    "output": [{
                        "type": "message",
                        "id": "msg_memory_sse",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "done"}]
                    }],
                    "memory": {"entries": [{
                        "schema": MEMORY_ENTRY_SCHEMA_V1,
                        "operation": "add",
                        "scope": "project",
                        "kind": "fact",
                        "title": "SSE kernel memory",
                        "summary": "Typed Responses terminal reaches Resp03 without finish_reason.",
                        "tags": ["sse"],
                        "entities": ["routecodex"]
                    }]}
                }
            }),
        ),
    ]
}

fn memory_skill_root(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-memory-kernel-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    root
}

fn memory_skill_with_recall(label: &str) -> Arc<MemorySkillHandle> {
    let root = memory_skill_root(label);
    let mut pending = PendingIndex::open(root.join("pending")).expect("open pending index");
    pending
        .append(
            MemoryIndexEntryDraftV1 {
                schema: MEMORY_ENTRY_SCHEMA_V1.to_string(),
                operation: MemoryOperation::Add,
                target_memory_id: None,
                scope: MemoryScope::Project,
                kind: MemoryKind::Decision,
                title: "Pinned route".to_string(),
                summary: "Keep the explicit provider target stable.".to_string(),
                tags: vec!["routing".to_string()],
                entities: vec!["routecodex".to_string()],
            },
            MemorySourceWindow::new(MemorySourceKind::EndTurn, ["fixture-entry"]),
        )
        .expect("append recall fixture");
    let mut knowledge = MemoryKnowledgeStore::open(root.join("knowledge"))
        .expect("open knowledge store");
    organize_pending_generation(
        &mut pending,
        &mut knowledge,
        MemoryOrganizationMode::Incremental,
        16,
        None,
    )
    .expect("organize recall fixture");
    Arc::new(MemorySkillHandle::open(root).expect("open memory skill"))
}

fn memory_skill_empty(label: &str) -> Arc<MemorySkillHandle> {
    Arc::new(MemorySkillHandle::open(memory_skill_root(label)).expect("open empty memory skill"))
}

fn capture_body(bodies: &Arc<Mutex<Vec<Value>>>) -> Value {
    bodies
        .lock()
        .unwrap()
        .last()
        .cloned()
        .expect("provider transport must capture one body")
}

fn memory_enabled_manifest() -> V3Config05ManifestPublished {
    let mut manifest = test_manifest();
    manifest.features.insert("agent_memory".to_string(), true);
    manifest
}

#[tokio::test]
async fn direct_kernel_missing_compiled_hook_plan_fails_before_provider_send() {
    let manifest = test_manifest();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::no_continuation()
            .with_provider_health(V3ProviderFailureRuntimeHealth::from_manifest(&manifest)),
        &manifest,
        test_responses_raw(
            "default",
            "req-missing-hook-plan",
            "exec-missing-hook-plan",
            json!({"model":"client-model","input":"hello"}),
        ),
        crate::register_responses_direct_hooks(),
        &MemoryCaptureTransport {
            bodies: bodies.clone(),
            response_payload: json!({"id":"must-not-send","output_text":"unexpected"}),
        },
    )
    .await;

    assert_eq!(bodies.lock().expect("capture lock").len(), 0);
    let V3ClientBody::Json(ref error_body) = output.client_payload.body else {
        panic!("missing hook plan must project a JSON error: {output:?}");
    };
    assert!(
        error_body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("compiled Hub v1 hook operation plan is missing")),
        "missing compiled hook plan must be an explicit runtime error: {output:?}"
    );
}

#[tokio::test]
async fn shared_state_memory_recall_reaches_provider_wire_without_route_change() {
    let baseline_manifest = test_manifest();
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-session",
        "memory-conversation",
        7777,
        "default",
    );
    let raw = test_responses_raw(
        "default",
        "req-memory-wire",
        "exec-memory-wire",
        json!({"model":"client-model","input":"hello"}),
    );
    let baseline_bodies = Arc::new(Mutex::new(Vec::new()));
    let baseline_transport = MemoryCaptureTransport {
        bodies: baseline_bodies.clone(),
        response_payload: json!({
            "id":"resp_memory",
            "status":"completed",
            "finish_reason":"stop",
            "output_text":"ok"
        }),
    };
    let baseline_health = V3ProviderFailureRuntimeHealth::from_manifest(&baseline_manifest);
    let baseline = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            baseline_health,
        ),
        &baseline_manifest,
        raw.clone(),
        scope.clone(),
        crate::register_responses_direct_hooks(),
        &baseline_transport,
        1_000,
    )
    .await;

    let memory_bodies = Arc::new(Mutex::new(Vec::new()));
    let memory_transport = MemoryCaptureTransport {
        bodies: memory_bodies.clone(),
        response_payload: json!({
            "id":"resp_memory",
            "status":"completed",
            "finish_reason":"stop",
            "output_text":"ok"
        }),
    };
    let memory_health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let memory = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            memory_health,
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(
                &manifest,
                Some(memory_skill_with_recall("wire")),
            )
            .expect("compile memory hook operation plan"),
        )),
        &manifest,
        raw,
        scope,
        crate::register_responses_direct_hooks(),
        &memory_transport,
        1_000,
    )
    .await;

    let baseline_body = capture_body(&baseline_bodies);
    let memory_body = capture_body(&memory_bodies);
    assert_eq!(baseline_body["input"], "hello");
    let memory_input = memory_body["input"]
        .as_array()
        .expect("recall turns scalar input into a canonical message array");
    assert_eq!(memory_input[0]["content"][0]["text"], "hello");
    assert_eq!(memory_input.len(), 2);
    let recall_text = memory_input[1]["content"][0]["text"]
        .as_str()
        .expect("recall message text");
    assert!(recall_text.contains("[RouteCodex Memory Recall v1]"));
    assert!(recall_text.contains("Pinned route"));
    assert!(recall_text.contains("routing"));
    for control_field in [
        "generation",
        "content_hash",
        "entry_id",
        "source_event_refs",
    ] {
        assert!(
            !recall_text.contains(control_field),
            "memory control field leaked into provider text: {control_field}"
        );
    }

    let baseline_observability = baseline.observability.expect("baseline observability");
    let memory_observability = memory.observability.expect("memory observability");
    assert_eq!(
        baseline_observability.provider_key, memory_observability.provider_key,
        "recall must not change selected provider target"
    );
    assert_eq!(
        baseline_observability.model_id, memory_observability.model_id,
        "recall must not change selected model"
    );
    assert_eq!(baseline_body["model"], memory_body["model"]);
    assert_eq!(baseline_body["stream"], memory_body["stream"]);
}

#[tokio::test]
async fn shared_state_without_memory_preserves_provider_request_body_identity() {
    let manifest = test_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-identity-session",
        "memory-identity-conversation",
        7777,
        "default",
    );
    let raw_body = json!({"model":"client-model","input":"hello"});
    let first_bodies = Arc::new(Mutex::new(Vec::new()));
    let second_bodies = Arc::new(Mutex::new(Vec::new()));
    let first_transport = MemoryCaptureTransport {
        bodies: first_bodies.clone(),
        response_payload: json!({
            "id":"resp_memory",
            "status":"completed",
            "finish_reason":"stop",
            "output_text":"ok"
        }),
    };
    let second_transport = MemoryCaptureTransport {
        bodies: second_bodies.clone(),
        response_payload: json!({
            "id":"resp_memory",
            "status":"completed",
            "finish_reason":"stop",
            "output_text":"ok"
        }),
    };
    for (request_id, transport) in [
        ("req-memory-identity-a", &first_transport),
        ("req-memory-identity-b", &second_transport),
    ] {
        let raw = test_responses_raw(
            "default",
            request_id,
            &format!("exec-{request_id}"),
            raw_body.clone(),
        );
        let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
        execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
            V3ResponsesDirectRuntimeSharedState::new(
                &continuation_state,
                &stopless_control,
                health,
            ),
            &manifest,
            raw,
            scope.clone(),
            crate::register_responses_direct_hooks(),
            transport,
            1_000,
        )
        .await;
    }
    assert_eq!(capture_body(&first_bodies), capture_body(&second_bodies));
}

fn client_json(output: &V3ResponsesDirectRuntimeOutput) -> Value {
    match &output.client_payload.body {
        V3ClientBody::Json(value) => value.clone(),
        body => panic!("expected buffered JSON client response, got {body:?}"),
    }
}

fn terminal_memory_response() -> Value {
    json!({
        "id":"resp_memory_kernel",
        "status":"completed",
        "finish_reason":"stop",
        "output_text":"parent response is unchanged",
        "memory":{"entries":[{
            "schema": MEMORY_ENTRY_SCHEMA_V1,
            "operation":"add",
            "scope":"project",
            "kind":"fact",
            "title":"Kernel observation",
            "summary":"Only an explicit completed stop response may create memory.",
            "tags":["memory"],
            "entities":["routecodex"]
        }]}
    })
}

#[tokio::test]
async fn shared_state_resp03_observer_admits_memory_without_changing_parent_or_target() {
    let plain_manifest = test_manifest();
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-resp03-session",
        "memory-resp03-conversation",
        7777,
        "default",
    );
    let response_payload = terminal_memory_response();

    let plain_bodies = Arc::new(Mutex::new(Vec::new()));
    let plain = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&plain_manifest),
        ),
        &plain_manifest,
        test_responses_raw(
            "default",
            "req-memory-resp03-plain",
            "exec-memory-resp03-plain",
            json!({"model":"client-model","input":"hello"}),
        ),
        scope.clone(),
        crate::register_responses_direct_hooks(),
        &MemoryCaptureTransport {
            bodies: plain_bodies,
            response_payload: response_payload.clone(),
        },
        1_000,
    )
    .await;

    let skill = memory_skill_empty("admit");
    let observed = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(&manifest, Some(skill.clone()))
                .expect("compile memory hook operation plan"),
        )),
        &manifest,
        test_responses_raw(
            "default",
            "req-memory-resp03-observed",
            "exec-memory-resp03-observed",
            json!({"model":"client-model","input":"hello"}),
        ),
        scope,
        crate::register_responses_direct_hooks(),
        &MemoryCaptureTransport {
            bodies: Arc::new(Mutex::new(Vec::new())),
            response_payload,
        },
        1_000,
    )
    .await;

    assert_eq!(client_json(&observed), client_json(&plain));
    assert_eq!(
        observed
            .observability
            .as_ref()
            .map(|value| (&value.provider_key, &value.model_id)),
        plain
            .observability
            .as_ref()
            .map(|value| (&value.provider_key, &value.model_id)),
        "Resp03 memory admission must not change the selected target"
    );
    assert!(observed.node_trace.contains(&"V3Resp03MemoryObserved"));
    let entries = skill.pending_entries().expect("pending entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].draft.title, "Kernel observation");
    assert_eq!(
        client_json(&observed)["output_text"],
        "parent response is unchanged"
    );
}

#[tokio::test]
async fn shared_state_resp03_invalid_memory_keeps_parent_success_and_pending_empty() {
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-resp03-invalid-session",
        "memory-resp03-invalid-conversation",
        7777,
        "default",
    );
    let skill = memory_skill_empty("invalid");
    let output = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(&manifest, Some(skill.clone()))
                .expect("compile memory hook operation plan"),
        )),
        &manifest,
        test_responses_raw(
            "default",
            "req-memory-resp03-invalid",
            "exec-memory-resp03-invalid",
            json!({"model":"client-model","input":"hello"}),
        ),
        scope,
        crate::register_responses_direct_hooks(),
        &MemoryCaptureTransport {
            bodies: Arc::new(Mutex::new(Vec::new())),
            response_payload: json!({
                "status":"completed",
                "finish_reason":"stop",
                "output_text":"parent remains successful",
                "memory":{"entries":[{
                    "schema": MEMORY_ENTRY_SCHEMA_V1,
                    "operation":"add",
                    "scope":"project",
                    "kind":"fact",
                    "title":"Invalid",
                    "summary":"This entry has an unknown field.",
                    "tags":[],
                    "entities":[],
                    "unexpected":true
                }]}
            }),
        },
        1_000,
    )
    .await;

    assert_eq!(output.client_payload.status, 200);
    assert_eq!(
        client_json(&output)["output_text"],
        "parent remains successful"
    );
    assert!(skill
        .pending_entries()
        .expect("pending entries")
        .is_empty());
}

#[tokio::test]
async fn shared_state_resp03_append_failure_keeps_parent_success_and_records_observer_error() {
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-resp03-append-failure-session",
        "memory-resp03-append-failure-conversation",
        7777,
        "default",
    );
    let skill = memory_skill_empty("append-failure");
    std::fs::create_dir(skill.root().join("pending/pending-index.jsonl"))
        .expect("block pending journal path");
    let output = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(&manifest, Some(skill.clone()))
                .expect("compile memory hook operation plan"),
        )),
        &manifest,
        test_responses_raw(
            "default",
            "req-memory-resp03-append-failure",
            "exec-memory-resp03-append-failure",
            json!({"model":"client-model","input":"hello"}),
        ),
        scope,
        crate::register_responses_direct_hooks(),
        &MemoryCaptureTransport {
            bodies: Arc::new(Mutex::new(Vec::new())),
            response_payload: json!({
                "status":"completed",
                "finish_reason":"stop",
                "output_text":"parent remains successful",
                "memory":{"entries":[{
                    "schema": MEMORY_ENTRY_SCHEMA_V1,
                    "operation":"add",
                    "scope":"project",
                    "kind":"fact",
                    "title":"Append failure",
                    "summary":"Persistence failure is diagnostic-only.",
                    "tags":[],
                    "entities":[]
                }]}
            }),
        },
        1_000,
    )
    .await;

    assert_eq!(output.client_payload.status, 200);
    assert_eq!(
        client_json(&output)["output_text"],
        "parent remains successful"
    );
    assert!(output.node_trace.contains(&"V3Resp03MemoryObserved"));
    assert!(output.node_trace.contains(&"V3Resp03MemoryObserverError"));
    assert!(skill
        .pending_entries()
        .expect("pending entries")
        .is_empty());
}

#[tokio::test]
async fn shared_state_resp03_observer_admits_typed_responses_sse_terminal_without_finish_reason() {
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-sse-session",
        "memory-sse-conversation",
        7777,
        "default",
    );
    let skill = memory_skill_empty("sse-admit");
    let frames = responses_sse_memory_frames();
    let output = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(&manifest, Some(skill.clone()))
                .expect("compile memory hook operation plan"),
        )),
        &manifest,
        test_responses_raw(
            "default",
            "req-memory-sse",
            "exec-memory-sse",
            json!({"model":"client-model","input":"hello","stream":true}),
        ),
        scope,
        crate::register_responses_direct_hooks(),
        &MemorySseTransport {
            frames: frames.clone(),
        },
        1_000,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert!(output
        .node_trace
        .contains(&"V3Resp03MemoryObserverAttached"));
    let V3ClientBody::CommittedSse(stream) = output.client_payload.body else {
        panic!("Responses SSE success must be a committed client stream: {output:?}");
    };
    let received = stream.collect::<Vec<_>>().await;
    let mut expected_client_frames = frames.clone();
    expected_client_frames
        .last_mut()
        .expect("provider fixture has a terminal frame")
        .extend_from_slice(b"data: [DONE]\n\n");
    assert_eq!(
        received, expected_client_frames,
        "Resp03 observer must not rewrite client frames"
    );
    let entries = skill.pending_entries().expect("pending entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].draft.title, "SSE kernel memory");
    let terminal = received
        .iter()
        .find(|frame| String::from_utf8_lossy(frame).contains("response.completed"))
        .cloned()
        .expect("terminal response.completed frame");
    let terminal = String::from_utf8(terminal).expect("terminal frame is UTF-8");
    assert!(terminal.contains("response.completed"));
    assert!(terminal.contains("\"memory\""));
    assert!(terminal.contains("Typed Responses terminal"));
}

#[tokio::test]
async fn shared_state_resp03_observer_does_not_admit_when_client_drops_before_sse_terminal() {
    let manifest = memory_enabled_manifest();
    let continuation_state = V3ResponsesDirectContinuationState::default();
    let stopless_control = V3ResponsesDirectStoplessControlState::default();
    let scope = V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "memory-sse-drop-session",
        "memory-sse-drop-conversation",
        7777,
        "default",
    );
    let skill = memory_skill_empty("sse-drop");
    let output = execute_v3_responses_direct_runtime_kernel_with_shared_state_for_test(
        V3ResponsesDirectRuntimeSharedState::new(
            &continuation_state,
            &stopless_control,
            V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        )
        .with_hook_operation_plan(Some(
            crate::hub_v1::compile_v3_hub_hook_operation_plan(&manifest, Some(skill.clone()))
                .expect("compile memory hook operation plan"),
        )),
        &manifest,
        test_responses_raw(
            "default",
            "req-memory-sse-drop",
            "exec-memory-sse-drop",
            json!({"model":"client-model","input":"hello","stream":true}),
        ),
        scope,
        crate::register_responses_direct_hooks(),
        &MemorySseTransport {
            frames: responses_sse_memory_frames(),
        },
        1_000,
    )
    .await;

    let V3ClientBody::CommittedSse(mut stream) = output.client_payload.body else {
        panic!("Responses SSE success must be a committed client stream: {output:?}");
    };
    let _first_frame = stream.next().await.expect("created frame");
    drop(stream);
    assert!(
        skill
            .pending_entries()
            .expect("pending entries")
            .is_empty(),
        "a client drop before response.completed must not admit memory"
    );
}
