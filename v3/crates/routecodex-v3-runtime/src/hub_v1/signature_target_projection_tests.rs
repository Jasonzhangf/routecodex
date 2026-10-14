use super::*;

fn call(custom: bool, signature: Option<Value>) -> Value {
    let mut call = json!({"id":"paired_call","type":"function","function":{"name":"sum","arguments":if custom {r#"{"input":"19+23"}"#} else {r#"{"left":19,"right":23}"#}}});
    if custom {
        call["routecodex_chat_extension"] = json!({"responses_tool_call_type":"custom_tool_call"});
    }
    if let Some(signature) = signature {
        call["thought_signature"] = signature;
    }
    call
}

#[test]
fn signature_targets_responses_preserve_exact_call_local_values() {
    for signature in [
        json!("opaque/+=="),
        json!({"opaque":[1,"different"]}),
        Value::Null,
    ] {
        for custom in [false, true] {
            let source = call(custom, Some(signature.clone()));
            let projected = chat_tool_call_to_responses_input_item(&source)
                .unwrap()
                .unwrap();
            assert_eq!(projected.get("thought_signature"), Some(&signature));
            assert_eq!(projected["call_id"], "paired_call");
            assert_eq!(
                projected["type"],
                if custom {
                    "custom_tool_call"
                } else {
                    "function_call"
                }
            );
            assert_eq!(
                projected[if custom { "input" } else { "arguments" }],
                if custom {
                    json!("19+23")
                } else {
                    json!(r#"{"left":19,"right":23}"#)
                }
            );
        }
    }
    assert!(chat_tool_call_to_responses_input_item(&call(false, None))
        .unwrap()
        .unwrap()
        .get("thought_signature")
        .is_none());
}

#[test]
fn signature_targets_unrepresentable_use_existing_drop_carrier() {
    use super::super::project_outbound_payload_for_target_protocol_with_drops;
    for target in [
        V3OutboundTargetProtocol::Anthropic,
        V3OutboundTargetProtocol::OpenAiChat,
    ] {
        let source = json!({"messages":[{"role":"assistant","tool_calls":[call(false,Some(json!("function/+=="))),call(true,Some(json!("custom/+=="))),call(false,None)]}]});
        let (projected, drops) =
            project_outbound_payload_for_target_protocol_with_drops(&source, target).unwrap();
        assert_eq!(drops.len(), 2);
        for (index, signature) in ["function/+==", "custom/+=="].into_iter().enumerate() {
            assert_eq!(
                drops[index].json_path,
                format!("$.messages[0].tool_calls[{index}].thought_signature")
            );
            assert_eq!(drops[index].canonical_value, signature);
            assert_eq!(
                drops[index].reason,
                "unmapped_target_protocol_field_unrepresentable"
            );
            assert!(projected["messages"][0]["tool_calls"][index]
                .get("thought_signature")
                .is_none());
            assert_eq!(
                projected["messages"][0]["tool_calls"][index]["function"]["arguments"],
                source["messages"][0]["tool_calls"][index]["function"]["arguments"]
            );
        }
    }
}
