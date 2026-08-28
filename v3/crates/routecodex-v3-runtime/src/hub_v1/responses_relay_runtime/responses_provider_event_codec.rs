use super::*;
use crate::hub_v1::relay_sse_hooks::V3RelaySseHookCatalog;

struct V3ResponsesRelayTypedSemanticHook<'a> {
    observation: &'a V3RuntimeStreamObservation,
    catalog: V3RelaySseHookCatalog,
}

impl V3ResponsesSseSemanticHook for V3ResponsesRelayTypedSemanticHook<'_> {
    fn notify(&mut self, input: &V3ResponsesSseHookInput<'_>) {
        // Type notification is an observation-side effect only. It never
        // enters the normalized response or provider/client payload.
        let _ = self
            .observation
            .record_typed_object_type("responses", &input.protocol.event_type);
        self.catalog.notify_responses(input);
    }

    fn rewrite(
        &mut self,
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError> {
        self.catalog.rewrite_responses(semantic)
    }
}

pub(super) fn observe_v3_runtime_responses_sse_transport_chunk_typed(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
    reducer: &mut V3ResponsesSseReducerState,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let mut hook = V3ResponsesRelayTypedSemanticHook {
        observation,
        catalog: compile_v3_hub_relay_response_hooks().typed_sse_catalog(),
    };
    observe_v3_runtime_responses_sse_transport_chunk_typed_with_hook(
        chunk,
        decoder,
        observation,
        reducer,
        &mut hook,
    )
}

pub(super) fn observe_v3_runtime_responses_sse_transport_chunk_typed_with_hook(
    chunk: &[u8],
    decoder: &mut SseIncrementalDecoder,
    observation: &V3RuntimeStreamObservation,
    reducer: &mut V3ResponsesSseReducerState,
    hook: &mut impl V3ResponsesSseSemanticHook,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let frames = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(chunk))
        .map_err(|error| V3ResponsesRelayRuntimeError::ProviderSseTransport(error.to_string()))?;
    let mut terminal_response = None;
    for frame in frames {
        if let Some(response) = observe_v3_runtime_responses_sse_semantic_frame_typed_with_hook(
            &frame,
            observation,
            reducer,
            hook,
        )? {
            terminal_response = Some(response);
        }
    }
    Ok(terminal_response)
}

pub(super) fn observe_v3_runtime_responses_sse_semantic_frame_typed(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
    observation: &V3RuntimeStreamObservation,
    reducer: &mut V3ResponsesSseReducerState,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    let mut hook = V3ResponsesRelayTypedSemanticHook {
        observation,
        catalog: compile_v3_hub_relay_response_hooks().typed_sse_catalog(),
    };
    observe_v3_runtime_responses_sse_semantic_frame_typed_with_hook(
        frame,
        observation,
        reducer,
        &mut hook,
    )
}

pub(super) fn observe_v3_runtime_responses_sse_semantic_frame_typed_with_hook(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
    observation: &V3RuntimeStreamObservation,
    reducer: &mut V3ResponsesSseReducerState,
    hook: &mut impl V3ResponsesSseSemanticHook,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    if !frame.frame().raw_utf8_valid() {
        return Err(V3ResponsesRelayRuntimeError::ProviderSseTransport(
            "SSE input is not valid UTF-8".to_string(),
        ));
    }
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(frame);
    if object.is_done() || !object.has_data() {
        return Ok(None);
    }
    if !object.is_json_valid() {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "V3 Responses Relay response event payload is malformed".to_string(),
        ));
    }
    let mut event = object.data_value().cloned().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "V3 Responses Relay response event payload is missing".to_string(),
        )
    })?;
    if !event.is_object() {
        return Ok(None);
    }
    crate::hub_v1::normalize_v3_responses_function_call_arguments(&mut event)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    if let Some(error) = extract_v3_provider_event_error(&event) {
        return Err(error);
    }
    if !event
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| !event_type.trim().is_empty())
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "Responses semantic SSE event payload is missing type".to_string(),
        ));
    }
    let transport_object = V3ResponsesSseTransportObject::new(
        object.event_name().map(ToOwned::to_owned),
        event.clone(),
    );
    let semantic = classify_v3_responses_sse_event(&event).map_err(|error| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
    })?;
    let mut semantic = semantic;
    let protocol = semantic.protocol.clone();
    apply_v3_responses_sse_semantic_hook(&mut semantic, &transport_object, &protocol, hook)
        .map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
        })?;
    let projected_event = project_v3_responses_sse_event_json(&semantic);
    observation
        .record_provider_event_json(&projected_event)
        .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    apply_v3_typed_responses_event(&projected_event, reducer)
}

fn apply_v3_typed_responses_event(
    event: &Value,
    reducer: &mut V3ResponsesSseReducerState,
) -> Result<Option<Value>, V3ResponsesRelayRuntimeError> {
    if let Some(error) = extract_v3_provider_event_error(event) {
        return Err(error);
    }
    if event
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| !is_supported_typed_responses_event(event_type))
    {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("V3 Responses Relay response event type {event_type} is unsupported"),
        ));
    }
    if event.get("type").and_then(Value::as_str) == Some("response.incomplete") {
        let reason = event
            .pointer("/response/incomplete_details/reason")
            .or_else(|| event.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if !matches!(reason, Some("max_output_tokens" | "content_filter")) {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "Responses SSE response.incomplete requires supported incomplete_details.reason"
                    .to_owned(),
            ));
        }
    }
    reducer.apply_event(event).map_err(|error| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(error.to_string())
    })?;
    match reducer.terminal {
        Some(V3ResponsesSseTerminalState::Completed)
        | Some(V3ResponsesSseTerminalState::Incomplete) => {
            build_typed_responses_terminal_response(event, reducer).map(Some)
        }
        Some(V3ResponsesSseTerminalState::Failed)
        | Some(V3ResponsesSseTerminalState::Cancelled) => {
            let message = event
                .pointer("/response/error/message")
                .or_else(|| event.pointer("/error/message"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(V3_RESPONSES_RELAY_PROVIDER_EVENT_FAILED_MESSAGE);
            Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                message.to_owned(),
            ))
        }
        None => Ok(None),
    }
}

fn is_supported_typed_responses_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "response.created"
            | "response.in_progress"
            | "response.output_item.added"
            | "response.output_item.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.completed"
            | "response.incomplete"
            | "response.failed"
            | "response.cancelled"
            | "response.canceled"
            | "response.error"
            | "response.requires_action"
            | "response.done"
    ) || !event_type.starts_with("response.")
}

fn build_typed_responses_terminal_response(
    event: &Value,
    reducer: &V3ResponsesSseReducerState,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let mut response = event
        .get("response")
        .and_then(|value| parse_response_container(value).ok())
        .or_else(|| reducer.response.clone())
        .map(|value| value.to_normalized_value())
        .unwrap_or_else(|| json!({}));
    if let Some(scaffold) = &reducer.response {
        let scaffold = scaffold.to_normalized_value();
        if let (Some(target), Some(source)) = (response.as_object_mut(), scaffold.as_object()) {
            for (key, value) in source {
                target.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    let object = response.as_object_mut().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "typed Responses terminal response must be an object".to_owned(),
        )
    })?;
    object
        .entry("status".to_owned())
        .or_insert_with(|| Value::String("completed".to_owned()));
    if let Some(required_action) = event.get("required_action") {
        object.insert("required_action".to_owned(), required_action.clone());
    }
    let mut output = object
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in reducer
        .items
        .iter()
        .map(|item| item.item().to_normalized_value())
    {
        let output_index = item.get("output_index").and_then(Value::as_u64);
        let identity = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str);
        if let Some(identity) = identity {
            if let Some(index) = output.iter().position(|existing| {
                existing
                    .get("call_id")
                    .or_else(|| existing.get("id"))
                    .and_then(Value::as_str)
                    == Some(identity)
            }) {
                output[index] = item;
                continue;
            }
        }
        if let Some(output_index) = output_index.and_then(|value| usize::try_from(value).ok()) {
            if let Some(index) = output.iter().position(|existing| {
                existing.get("output_index").and_then(Value::as_u64) == Some(output_index as u64)
            }) {
                output[index] = item;
                continue;
            }
            let insert_at = output_index.min(output.len());
            output.insert(insert_at, item);
        } else {
            output.push(item);
        }
    }
    object.insert("output".to_owned(), Value::Array(output));
    if !reducer.output_text.trim().is_empty() {
        object.insert(
            "output_text".to_owned(),
            Value::String(reducer.output_text.clone()),
        );
    }
    Ok(response)
}

pub(super) fn parse_v3_runtime_sse_frame_fields(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
) -> Result<Option<String>, V3ResponsesRelayRuntimeError> {
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(frame);
    if object.has_data() && !object.is_done() && !object.is_json_valid() {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "V3 Responses Relay response event payload is malformed".to_string(),
        ));
    }
    let Some(data) = object.normalized_data_json() else {
        return Ok(None);
    };
    let data = data.trim();
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(data.to_string()))
}

pub(super) fn extract_v3_provider_event_error(
    payload: &Value,
) -> Option<V3ResponsesRelayRuntimeError> {
    let error = payload.get("error")?;
    let (code, message) = match error {
        Value::Object(error) => {
            let message = read_v3_trimmed_string(error.get("message"))
                .or_else(|| read_v3_trimmed_string(error.get("error")))
                .or_else(|| read_v3_trimmed_string(error.get("detail")));
            let code = read_v3_trimmed_string(error.get("type"))
                .or_else(|| read_v3_trimmed_string(error.get("code")));
            (code, message)
        }
        Value::String(message) => {
            let message = message.trim();
            if message.is_empty() {
                return None;
            }
            (None, Some(message.to_owned()))
        }
        _ => return None,
    };
    let code = code.unwrap_or_else(|| "provider_error".to_owned());
    let message = message.unwrap_or_else(|| code.clone());
    Some(
        V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
            status: 502,
            code,
            message,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RewriteRelayMessageHook<'a> {
        observation: &'a V3RuntimeStreamObservation,
    }

    impl V3ResponsesSseSemanticHook for RewriteRelayMessageHook<'_> {
        fn notify(&mut self, input: &V3ResponsesSseHookInput<'_>) {
            self.observation
                .record_typed_object_type("responses", &input.protocol.event_type)
                .expect("typed notification must remain observation-side only");
        }

        fn rewrite(
            &mut self,
            semantic: &mut V3ResponsesSseSemanticObject,
        ) -> Result<(), V3ResponsesSseTreeError> {
            if semantic.item == Some(V3ResponsesSseOutputItemKind::Message) {
                semantic.rewrite_item_content(V3ResponsesSseContentRewrite::Text(
                    "relay typed rewrite".to_owned(),
                ))?;
            }
            Ok(())
        }
    }

    #[test]
    fn relay_responses_typed_hook_rewrite_is_consumed_before_reducer_projection() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let mut hook = RewriteRelayMessageHook {
            observation: &observation,
        };
        let chunk = br#"event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_relay_1","content":[{"type":"output_text","text":"before"}]}}

"#;

        observe_v3_runtime_responses_sse_transport_chunk_typed_with_hook(
            chunk,
            &mut decoder,
            &observation,
            &mut reducer,
            &mut hook,
        )
        .expect("typed Relay hook must rewrite before reducer consumption");

        assert_eq!(reducer.items.len(), 1);
        assert_eq!(
            reducer.items[0].item().to_normalized_value()["content"][0]["text"],
            "relay typed rewrite"
        );
        assert_eq!(
            observation
                .snapshot()
                .expect("observation snapshot")
                .typed_object_types,
            vec!["responses:response.output_item.done".to_owned()]
        );
    }

    #[test]
    fn relay_preserves_structured_provider_error_identity() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let error = observe_v3_runtime_responses_sse_transport_chunk_typed(
            br#"data: {"error":{"type":"invalid_request_error","message":"prompt is too long"}}

"#,
            &mut decoder,
            &observation,
            &mut reducer,
        )
        .expect_err("structured provider errors must remain typed semantic failures");
        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseSemanticFailure {
                status: 502,
                ref code,
                ref message,
            } if code == "invalid_request_error" && message == "prompt is too long"
        ));
    }

    #[test]
    fn relay_keeps_malformed_provider_events_as_codec_failures() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let error = observe_v3_runtime_responses_sse_transport_chunk_typed(
            b"data: {not-json}\n\n",
            &mut decoder,
            &observation,
            &mut reducer,
        )
        .expect_err("malformed provider events must remain codec failures");
        assert!(matches!(
            error,
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(_)
        ));
    }

    #[test]
    fn relay_normalizes_function_call_object_arguments_before_semantic_validation() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let chunk = br#"event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":{"cmd":"pwd"}}}

"#;

        observe_v3_runtime_responses_sse_transport_chunk_typed(
            chunk,
            &mut decoder,
            &observation,
            &mut reducer,
        )
        .expect("relay must stringify compatible function_call arguments");

        assert_eq!(reducer.items.len(), 1);
        assert_eq!(
            reducer.items[0].item().to_normalized_value()["arguments"],
            json!(r#"{"cmd":"pwd"}"#)
        );
    }

    #[test]
    fn relay_normalizes_function_call_arguments_in_terminal_response_output() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let chunk = br#"data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":{"cmd":"pwd"}}]}}

"#;

        observe_v3_runtime_responses_sse_transport_chunk_typed(
            chunk,
            &mut decoder,
            &observation,
            &mut reducer,
        )
        .expect("terminal response output must accept structured function_call arguments");
    }

    #[test]
    fn response_incomplete_is_terminal_typed_response_not_provider_error() {
        let mut reducer = V3ResponsesSseReducerState::default();
        let terminal = apply_v3_typed_responses_event(
            &json!({
                "type": "response.incomplete",
                "response": {
                    "id": "resp_incomplete_1",
                    "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"},
                    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
                }
            }),
            &mut reducer,
        )
        .expect("response.incomplete must produce a terminal response, not an error")
        .expect("response.incomplete must be terminal");
        assert_eq!(terminal["status"], json!("incomplete"));
        assert_eq!(
            terminal["incomplete_details"]["reason"],
            json!("max_output_tokens")
        );
        assert_eq!(terminal["usage"]["total_tokens"], json!(15));
    }

    #[test]
    fn response_incomplete_without_or_unknown_reason_fails_fast() {
        for payload in [
            json!({
                "type": "response.incomplete",
                "response": {"id": "resp_bad_1", "status": "incomplete"}
            }),
            json!({
                "type": "response.incomplete",
                "incomplete_details": {"reason": "internal_error"},
                "response": {"id": "resp_bad_2", "status": "incomplete"}
            }),
        ] {
            let mut reducer = V3ResponsesSseReducerState::default();
            let error = apply_v3_typed_responses_event(&payload, &mut reducer)
                .expect_err("malformed/unknown incomplete terminal must fail fast");
            assert!(error.to_string().contains("response.incomplete"));
        }
    }

    #[test]
    fn response_failed_still_errors_as_typed_provider_event_failure() {
        let mut reducer = V3ResponsesSseReducerState::default();
        let error = apply_v3_typed_responses_event(
            &json!({
                "type": "response.failed",
                "response": {
                    "id": "resp_failed_1",
                    "status": "failed",
                    "error": {"message": "upstream model crashed"}
                }
            }),
            &mut reducer,
        )
        .expect_err("response.failed must remain an explicit provider event failure");
        assert!(error.to_string().contains("upstream model crashed"));
    }

    #[test]
    fn missing_type_is_rejected_even_when_sse_event_name_is_registered() {
        let observation = V3RuntimeStreamObservation::default();
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let mut reducer = V3ResponsesSseReducerState::default();
        let error = observe_v3_runtime_responses_sse_transport_chunk_typed(
            b"event: response.output_text.delta\ndata: {\"delta\":\"recovered\"}\n\n",
            &mut decoder,
            &observation,
            &mut reducer,
        )
        .expect_err("SSE event metadata must not supply the semantic type");
        assert!(error.to_string().contains("missing type"));
        assert!(reducer.output_text.is_empty());
    }

    #[test]
    fn event_name_registry_is_not_a_semantic_type_source() {
        assert!(is_supported_typed_responses_event(
            "response.output_text.delta"
        ));
        assert!(is_supported_typed_responses_event("response.completed"));
        assert!(!is_supported_typed_responses_event("response.unknown"));
    }
}
