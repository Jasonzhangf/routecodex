use super::*;
use serde_json::json;

struct RewriteChatHook {
    notified: bool,
}

impl V3OpenAiChatSseSemanticHook for RewriteChatHook {
    fn notify(&mut self, input: &V3OpenAiChatSseHookInput<'_>) {
        self.notified = input.protocol.object == "chat.completion.chunk";
    }

    fn rewrite(
        &mut self,
        semantic: &mut V3OpenAiChatSseSemanticObject,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        rewrite_v3_openai_chat_sse_content(
            &mut semantic.choices[0],
            V3OpenAiChatSseContentRewrite::Text("hooked".to_owned()),
        )
    }
}

#[test]
fn chat_sse_keeps_text_and_tool_call_semantics_distinct() {
    let semantic = classify_v3_openai_chat_sse_chunk(&json!({
        "object":"chat.completion.chunk",
        "choices":[
            {"index":0,"delta":{"content":"hello"},"finish_reason":null},
            {"index":1,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}
        ]
    })).unwrap();
    assert!(matches!(
        semantic.choices[0].delta,
        V3OpenAiChatSseDelta::Text(_)
    ));
    assert!(matches!(
        semantic.choices[1].delta,
        V3OpenAiChatSseDelta::ToolCall(_)
    ));
}

#[test]
fn chat_sse_null_usage_is_absent_but_scalar_usage_is_rejected() {
    let semantic = classify_v3_openai_chat_sse_chunk(&json!({
        "object":"chat.completion.chunk",
        "choices":[],
        "usage":null
    }))
    .unwrap();
    assert!(semantic.usage.is_none());

    assert!(matches!(
        classify_v3_openai_chat_sse_chunk(&json!({
            "object":"chat.completion.chunk",
            "choices":[],
            "usage":"not-an-object"
        })),
        Err(V3OpenAiChatSseTreeError::UsageNotObject)
    ));
}

#[test]
fn chat_sse_rewrite_preserves_choice_index_and_finish_reason() {
    let mut choice = classify_v3_openai_chat_sse_chunk(&json!({
        "object":"chat.completion.chunk",
        "choices":[{"index":3,"delta":{"content":"old"},"finish_reason":"stop"}]
    }))
    .unwrap()
    .choices
    .remove(0);
    rewrite_v3_openai_chat_sse_content(
        &mut choice,
        V3OpenAiChatSseContentRewrite::Text("new".to_owned()),
    )
    .unwrap();
    assert_eq!(choice.index, 3);
    assert_eq!(choice.finish_reason.as_deref(), Some("stop"));
    assert!(matches!(choice.delta, V3OpenAiChatSseDelta::Text(ref value) if value == "new"));
}

#[test]
fn chat_choice_round_trip_rebuilds_from_normalized_tree() {
    let input = json!({
        "index":3,
        "delta":{"content":"old","provider_extension":{"keep":true}},
        "finish_reason":"stop"
    });
    let mut choice = classify_v3_openai_chat_sse_chunk(&json!({
        "object":"chat.completion.chunk",
        "choices":[input.clone()]
    }))
    .unwrap()
    .choices
    .remove(0);
    rewrite_v3_openai_chat_sse_content(
        &mut choice,
        V3OpenAiChatSseContentRewrite::Text("new".to_owned()),
    )
    .unwrap();
    let output = choice.to_normalized_value();
    assert_eq!(output["index"], 3);
    assert_eq!(output["finish_reason"], "stop");
    assert_eq!(output["delta"]["content"], "new");
    assert_eq!(output["delta"]["provider_extension"]["keep"], true);
}

#[test]
fn chat_normalized_choice_projects_to_json_and_sse() {
    let input = json!({
        "index":3,
        "delta":{"content":"hello","provider_extension":{"keep":true}},
        "finish_reason":null
    });
    let choice = classify_v3_openai_chat_sse_chunk(&json!({
        "object":"chat.completion.chunk",
        "choices":[input.clone()]
    }))
    .unwrap()
    .choices
    .into_iter()
    .next()
    .unwrap();
    assert_eq!(project_v3_openai_chat_sse_choice_json(&choice), input);
    let bytes =
        project_v3_openai_chat_sse_choice_sse(Some("chat.completion.chunk".to_owned()), &choice)
            .unwrap();
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let frame = decoder
        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
            &bytes,
        ))
        .unwrap()
        .pop()
        .unwrap();
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
    assert_eq!(object.event_name(), Some("chat.completion.chunk"));
    assert_eq!(object.data_value(), Some(&input));
}

#[test]
fn chat_semantic_chunk_projection_preserves_envelope_and_choice_extensions() {
    let input = json!({
        "id":"chatcmpl_1",
        "object":"chat.completion.chunk",
        "created":1,
        "model":"model-a",
        "provider_extension":{"keep":true},
        "choices":[{
            "index":0,
            "delta":{"content":"before","provider_extension":{"choice":true}},
            "finish_reason":null
        }]
    });
    let semantic = classify_v3_openai_chat_sse_chunk(&input).unwrap();
    assert_eq!(project_v3_openai_chat_sse_chunk_json(&semantic), input);
    let bytes =
        project_v3_openai_chat_sse_chunk_sse(Some("chat.completion.chunk".to_owned()), &semantic)
            .unwrap();
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let frame = decoder
        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
            &bytes,
        ))
        .unwrap()
        .pop()
        .unwrap();
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
    assert_eq!(object.data_value(), Some(&input));
}

#[test]
fn chat_semantic_hook_notifies_and_rewrites_typed_choice() {
    let input = json!({
        "object":"chat.completion.chunk",
        "choices":[{"index":0,"delta":{"content":"before"},"finish_reason":null}]
    });
    let mut semantic = classify_v3_openai_chat_sse_chunk(&input).unwrap();
    let transport = V3OpenAiChatSseTransportObject::new(None, input.clone());
    let protocol = V3OpenAiChatSseProtocolMetadata::from_chunk(&input).unwrap();
    let mut hook = RewriteChatHook { notified: false };
    apply_v3_openai_chat_sse_semantic_hook(&mut semantic, &transport, &protocol, &mut hook)
        .unwrap();
    assert!(hook.notified);
    assert_eq!(
        semantic.to_normalized_value()["choices"][0]["delta"]["content"],
        "hooked"
    );
}

#[test]
fn chat_reasoning_usage_and_terminal_are_typed_reducer_fields() {
    let mut reducer = V3OpenAiChatSseReducerState::default();
    reducer
        .apply_chunk(&json!({
            "id":"chat_1",
            "object":"chat.completion.chunk",
            "created":1,
            "model":"model-a",
            "choices":[{"index":0,"delta":{"reasoning_content":"plan"},"finish_reason":null}],
            "usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5,"provider_extension":{"keep":true}}
        }))
        .unwrap();
    reducer
        .apply_chunk(&json!({
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]
        }))
        .unwrap();
    assert!(matches!(
        reducer.choices[0].delta,
        V3OpenAiChatSseDelta::Reasoning(ref value) if value == "plan"
    ));
    assert_eq!(reducer.usage.as_ref().unwrap().total_tokens, Some(5));
    assert_eq!(
        reducer.usage.as_ref().unwrap().extensions[0].name,
        "provider_extension"
    );
    assert_eq!(reducer.terminal, Some(V3OpenAiChatSseTerminalState::Stop));
}

#[test]
fn chat_reducer_materializes_one_typed_completion_from_delta_tree() {
    let mut reducer = V3OpenAiChatSseReducerState::default();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_typed_1",
            "object":"chat.completion.chunk",
            "created":7,
            "model":"chat-model",
            "choices":[{"index":0,"delta":{"role":"assistant","content":"hello "},"finish_reason":null}]
        }))
        .unwrap();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_typed_1",
            "object":"chat.completion.chunk",
            "created":7,
            "model":"chat-model",
            "choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]
        }))
        .unwrap();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_typed_1",
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\"q\":"}}]},"finish_reason":null}]
        }))
        .unwrap();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_typed_1",
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]},"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}
        }))
        .unwrap();

    let output = reducer.materialize_completion().unwrap();
    assert_eq!(output["id"], "chatcmpl_typed_1");
    assert_eq!(output["choices"][0]["message"]["content"], "hello world");
    assert_eq!(
        output["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"q\":\"x\"}"
    );
    assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(output["usage"]["total_tokens"], 3);
}

#[test]
fn chat_reducer_keeps_tool_call_when_terminal_delta_also_has_empty_content() {
    let mut reducer = V3OpenAiChatSseReducerState::default();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_empty_content_tool_call",
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]
        }))
        .unwrap();
    reducer
        .apply_chunk(&json!({
            "id":"chatcmpl_empty_content_tool_call",
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_reasoning_stop","type":"function","function":{"name":"reasoningStop","arguments":"{\"stopreason\":2}"}}],"content":""},"finish_reason":"tool_calls"}]
        }))
        .unwrap();

    let output = reducer.materialize_completion().unwrap();
    assert_eq!(
        output["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
        "{\"stopreason\":2}"
    );
    assert_eq!(output["choices"][0]["finish_reason"], "tool_calls");
}

#[test]
fn chat_reducer_rejects_unknown_finish_reason() {
    let error = V3OpenAiChatSseReducerState::default()
        .apply_chunk(&json!({
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{},"finish_reason":"future_reason"}]
        }))
        .unwrap_err();
    assert!(matches!(
        error,
        V3OpenAiChatSseTreeError::UnknownFinishReason { .. }
    ));
}

#[test]
fn chat_json_document_round_trips_choices_messages_tools_usage_and_extensions() {
    let input = json!({
        "id": "chatcmpl_json_1",
        "object": "chat.completion",
        "created": 7,
        "model": "chat-model",
        "system_fingerprint": "fp_1",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "hello",
                "refusal": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{\"q\":\"x\"}"}
                }],
                "reasoning_content": "typed reasoning extension"
            },
            "finish_reason": "tool_calls",
            "choice_extension": true
        }],
        "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        "document_extension": {"keep": true}
    });

    let document = V3OpenAiChatJsonDocument::from_json(&input).unwrap();
    assert_eq!(document.choices.len(), 1);
    assert_eq!(document.choices[0].index, 0);
    assert_eq!(document.choices[0].message.tool_calls.len(), 1);
    assert_eq!(
        document.choices[0].message.tool_calls[0]
            .function_name
            .as_deref(),
        Some("lookup")
    );
    assert_eq!(document.to_normalized_value(), input);
    assert_eq!(
        V3OpenAiChatJsonDocument::from_json(&document.to_normalized_value()).unwrap(),
        document
    );
}

#[test]
fn chat_json_document_rejects_stream_chunk_and_malformed_choice() {
    assert!(matches!(
        V3OpenAiChatJsonDocument::from_json(&json!({
            "object": "chat.completion.chunk",
            "choices": []
        })),
        Err(V3OpenAiChatJsonTreeError::WrongObjectType)
    ));
    assert!(matches!(
        V3OpenAiChatJsonDocument::from_json(&json!({
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"content": 3}}]
        })),
        Err(V3OpenAiChatJsonTreeError::ContentShapeInvalid)
    ));
}
