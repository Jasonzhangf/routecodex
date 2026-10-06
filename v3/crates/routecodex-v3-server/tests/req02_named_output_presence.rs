//! Public SDK -> Req04 -> registered Direct inverse coverage for named tool
//! outputs that do not carry a call id.

use routecodex_v3_runtime::operation_runner::{
    project_canonical_direct_request, CurrentFieldAssociations, RequestInvocationContext,
    RequestOriginKind, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    build_v3_hub_req_inbound_01_client_raw, compile_v3_hub_relay_request_hooks, V3HubEntryProtocol,
    V3HubInvocationSource, V3HubRelayRequestHookEvent, V3HubServertoolRequestProfile,
    V3HubTransportIntent,
};
use serde_json::{json, Value};

fn entry_invocation(
    request_id: &str,
    protocol: V3HubEntryProtocol,
) -> (V3RequestContextHandle, RequestInvocationContext) {
    let key = match protocol {
        V3HubEntryProtocol::Responses => "responses",
        V3HubEntryProtocol::Anthropic => "anthropic",
        V3HubEntryProtocol::Gemini => "gemini",
        V3HubEntryProtocol::OpenAiChat => "openai_chat",
    };
    let handle = V3RequestContextHandle::new(request_id.to_string(), key.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-entry"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    (handle, invocation)
}

fn governed_direct_round_trip(
    request_id: &str,
    protocol: V3HubEntryProtocol,
    raw_payload: Value,
) -> (Value, Value) {
    let (handle, invocation) = entry_invocation(request_id, protocol);
    let raw = build_v3_hub_req_inbound_01_client_raw(
        raw_payload,
        protocol,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Json,
    );
    let governed = compile_v3_hub_relay_request_hooks()
        .run(raw, &V3HubServertoolRequestProfile::disabled(), &invocation)
        .expect("Req02 normalization and Req04 governance must accept named output");
    assert!(governed
        .hook_events()
        .contains(&V3HubRelayRequestHookEvent::Req04ToolGoverned));
    assert!(
        governed
            .hook_events()
            .contains(&V3HubRelayRequestHookEvent::Req04ProtocolToolIdentityGoverned),
        "every normalized protocol must reach the same canonical tool identity operation"
    );

    let canonical = governed.payload().clone();
    let pair = handle
        .original_pair()
        .expect("the public SDK path must publish the immutable original pair");
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let projected = project_canonical_direct_request(
        &canonical,
        &pair.inverse_context,
        &associations,
        &pair.explicit_history_pairing,
    )
    .expect("registered Direct inverse must restore the original named output");
    (canonical, projected.payload)
}

fn assert_no_tool_call_id(canonical: &Value) {
    let messages = canonical["messages"]
        .as_array()
        .expect("canonical Chat messages");
    assert!(
        messages
            .iter()
            .all(|message| message.get("tool_call_id").is_none()),
        "an unpaired named output must not fabricate a tool_call_id: {canonical}"
    );
}

#[test]
fn responses_named_outputs_round_trip_without_call_id() {
    let output = format!(
        "<codex_delegation>cross-thread notification</codex_delegation>\r\nsecond line\r\n{}",
        "r".repeat(4096)
    );
    let cases = [
        (
            "function_call_output",
            "send_message_to_thread",
            json!("codex_tui"),
        ),
        ("custom_tool_call_output", "apply_patch", Value::Null),
    ];

    for (item_type, name, namespace) in cases {
        let raw = json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                },
                {
                    "type": item_type,
                    "id": format!("item-{item_type}"),
                    "name": name,
                    "namespace": namespace,
                    "output": output.clone(),
                    "status": "completed",
                    "vendor": {"keep": {"nested": true}}
                }
            ]
        });
        let (canonical, projected) = governed_direct_round_trip(
            &format!("req02-named-{item_type}"),
            V3HubEntryProtocol::Responses,
            raw.clone(),
        );
        assert_no_tool_call_id(&canonical);
        let carrier = canonical["messages"]
            .as_array()
            .expect("canonical Chat messages")
            .iter()
            .find(|message| {
                message["routecodex_chat_extension"]["responses_tool_output_name"] == name
            })
            .unwrap_or_else(|| panic!("missing named output carrier: {canonical}"));
        assert_eq!(
            carrier["routecodex_chat_extension"]["responses_tool_output_namespace"], namespace,
            "namespace presence changed for {item_type}"
        );
        assert_eq!(
            projected, raw,
            "registered Direct inverse changed {item_type}"
        );
    }
}

#[test]
fn responses_named_output_namespace_presence_is_exact() {
    for (label, namespace) in [
        ("absent", None),
        ("null", Some(Value::Null)),
        ("empty", Some(json!(""))),
        ("string", Some(json!("codex_tui"))),
    ] {
        let mut item = json!({
            "type": "function_call_output",
            "name": "send_message_to_thread",
            "output": "complete output",
            "vendor": {"keep": true}
        });
        if let Some(namespace) = namespace {
            item.as_object_mut()
                .expect("item object")
                .insert("namespace".to_string(), namespace);
        }
        let raw = json!({"model": "gpt-5.5", "input": [item]});
        let (canonical, projected) = governed_direct_round_trip(
            &format!("req02-named-namespace-{label}"),
            V3HubEntryProtocol::Responses,
            raw.clone(),
        );
        assert_no_tool_call_id(&canonical);
        assert_eq!(projected, raw, "namespace presence changed for {label}");
    }
}

#[test]
fn gemini_named_function_response_round_trips_without_id() {
    let raw = json!({
        "model": "gemini",
        "contents": [
            {"role": "user", "parts": [{"text": "lookup"}]},
            {
                "role": "model",
                "parts": [{
                    "functionCall": {
                        "name": "lookup",
                        "args": {"city": "Tokyo"}
                    }
                }]
            },
            {
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": "lookup",
                        "response": {"forecast": "sunny", "nested": {"keep": true}},
                        "vendor": {"keep": "response"}
                    }
                }]
            }
        ]
    });
    let (canonical, projected) = governed_direct_round_trip(
        "req02-named-gemini-function-response",
        V3HubEntryProtocol::Gemini,
        raw.clone(),
    );
    assert_no_tool_call_id(&canonical);
    assert!(
        canonical["messages"]
            .as_array()
            .expect("canonical Chat messages")
            .iter()
            .any(|message| {
                message["routecodex_chat_extension"]["responses_tool_output_name"] == "lookup"
            }),
        "Gemini functionResponse.name must reach the canonical extension: {canonical}"
    );
    assert_eq!(projected, raw);
}

#[test]
fn gemini_paired_function_response_keeps_name_and_unknown_siblings() {
    let raw = json!({
        "model": "gemini",
        "contents": [
            {
                "role": "model",
                "parts": [{
                    "functionCall": {
                        "id": "call-1",
                        "name": "lookup",
                        "args": {"city": "Tokyo"}
                    }
                }]
            },
            {
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "id": "call-1",
                        "name": "lookup",
                        "response": {"forecast": "sunny"},
                        "vendor": {"keep": "response"}
                    }
                }]
            }
        ]
    });
    let (canonical, projected) = governed_direct_round_trip(
        "req02-named-gemini-paired-function-response",
        V3HubEntryProtocol::Gemini,
        raw.clone(),
    );
    assert!(
        canonical["messages"]
            .as_array()
            .expect("canonical Chat messages")
            .iter()
            .any(|message| message["tool_call_id"] == "call-1"),
        "a paired Gemini functionResponse must keep its tool identity: {canonical}"
    );
    assert_eq!(projected, raw);
}
