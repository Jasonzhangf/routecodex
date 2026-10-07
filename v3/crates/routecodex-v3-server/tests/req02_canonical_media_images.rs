use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_canonical,
    compile_v3_hub_relay_request_hooks, V3HubEntryProtocol, V3HubInvocationSource,
    V3HubServertoolRequestProfile, V3HubTransportIntent,
};
use serde_json::{json, Value};

fn governed_gemini_payload(raw: Value) -> (Value, Value) {
    let handle = V3RequestContextHandle::new(
        "req02-canonical-media-images".to_string(),
        "gemini".to_string(),
    );
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "req02-canonical-media-images-invocation".to_string(),
        "req02-canonical-media-images-attempt".to_string(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw.clone()).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public operation runner must normalize the Gemini payload");

    let hub_input = build_v3_hub_req_inbound_01_client_raw(
        raw,
        V3HubEntryProtocol::Gemini,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let normalized = build_v3_hub_req_inbound_02_from_canonical(hub_input, canonical.clone());
    let governed = compile_v3_hub_relay_request_hooks()
        .run_from_normalized(normalized, &V3HubServertoolRequestProfile::disabled())
        .expect("public Req04 consumer must accept canonical Gemini media");
    (canonical, governed.payload().clone())
}

#[test]
fn canonical_gemini_media_cleans_only_history_image_carriers() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [
            {
                "role": "user",
                "parts": [
                    { "text": "history" },
                    {
                        "inlineData": {
                            "mimeType": "image/png",
                            "data": "aGVsbG8="
                        }
                    },
                    {
                        "fileData": {
                            "mimeType": "image/png",
                            "fileUri": "https://example.test/history.png"
                        }
                    },
                    {
                        "inlineData": {
                            "mimeType": "audio/mpeg",
                            "data": "YXVkaW8="
                        }
                    },
                    {
                        "inlineData": {
                            "mimeType": "video/mp4",
                            "data": "dmlkZW8="
                        }
                    },
                    {
                        "inlineData": {
                            "data": "dW5rbm93bg=="
                        }
                    },
                    {
                        "type": "media",
                        "media": {
                            "mime_type": "image/png"
                        }
                    }
                ]
            },
            {
                "role": "model",
                "parts": [
                    {
                        "functionCall": {
                            "id": "call_lookup",
                            "name": "lookup",
                            "args": {
                                "query": "canonical",
                                "options": { "limit": 1 }
                            }
                        }
                    }
                ]
            },
            {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "id": "call_lookup",
                            "response": {
                                "items": [{ "name": "canonical" }]
                            }
                        }
                    }
                ]
            },
            {
                "role": "user",
                "parts": [
                    { "text": "current" },
                    {
                        "inlineData": {
                            "mimeType": "image/webp",
                            "data": "Y3VycmVudA=="
                        }
                    },
                    {
                        "fileData": {
                            "mimeType": "image/jpeg",
                            "fileUri": "https://example.test/current.jpg"
                        }
                    }
                ]
            }
        ]
    });

    let (canonical, governed) = governed_gemini_payload(raw);
    let canonical_messages = canonical["messages"].as_array().unwrap();
    let governed_messages = governed["messages"].as_array().unwrap();
    let history = governed_messages[0]["content"].as_array().unwrap();
    let last_user = governed_messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .unwrap();

    assert_eq!(history[0], json!({ "type": "text", "text": "history" }));
    assert_eq!(
        history[1],
        json!({ "type": "text", "text": "[Image]" }),
        "canonical inline image must become the fixed history placeholder"
    );
    assert_eq!(
        history[2],
        json!({ "type": "text", "text": "[Image]" }),
        "canonical file image must become the fixed history placeholder"
    );
    assert_eq!(history[3]["type"], "media");
    assert_eq!(history[3]["media"]["mime_type"], "audio/mpeg");
    assert_eq!(history[4]["type"], "media");
    assert_eq!(history[4]["media"]["mime_type"], "video/mp4");
    assert_eq!(history[5]["type"], "media");
    assert_eq!(history[5]["media"]["inline_data"], "dW5rbm93bg==");
    assert_eq!(
        history[6],
        json!({
            "type": "media",
            "media": { "mime_type": "image/png" }
        }),
        "image MIME without a real media carrier must be preserved"
    );
    assert!(
        !serde_json::to_string(history).unwrap().contains("aGVsbG8="),
        "history inline image bytes must not survive"
    );
    assert!(
        !serde_json::to_string(history)
            .unwrap()
            .contains("https://example.test/history.png"),
        "history file image carrier must not survive"
    );
    assert_eq!(
        governed_messages[last_user]["content"], canonical_messages[last_user]["content"],
        "current-turn canonical images must remain complete"
    );

    let canonical_calls = canonical_messages
        .iter()
        .find_map(|message| message.get("tool_calls"))
        .unwrap();
    let governed_calls = governed_messages
        .iter()
        .find_map(|message| message.get("tool_calls"))
        .unwrap();
    assert_eq!(
        governed_calls, canonical_calls,
        "tool identity and complete arguments must remain unchanged"
    );

    let canonical_tool_results = canonical_messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .cloned()
        .collect::<Vec<_>>();
    let governed_tool_results = governed_messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        governed_tool_results, canonical_tool_results,
        "complete tool output must remain unchanged"
    );
}
