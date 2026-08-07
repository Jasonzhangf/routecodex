use super::*;
use crate::{
    V3LocalContinuationError, V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey,
    V3LocalContinuationStore, V3LocalContinuationTerminalOutcome,
};
use serde_json::{json, Map, Value};
use std::ops::Deref;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespContinuation04Committed {
    pub(crate) previous: V3HubRespChatProcess03Governed,
    pub(crate) action: V3HubContinuationCommit,
    pub(crate) finalized_payload: Arc<Value>,
    pub(crate) canonical_context: Option<V3HubRelayCanonicalResponseContext>,
}

pub fn build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
    input: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
) -> V3HubRespContinuation04Committed {
    let finalized_payload = input.previous.provider_payload().clone();
    let canonical_context = if action == V3HubContinuationCommit::LocalContext {
        Some(V3HubRelayCanonicalResponseContext {
            payload: Arc::clone(&finalized_payload),
            terminality: input.terminality,
            tool_calls: input.tool_calls.clone(),
            servertool_action: input.servertool_action,
        })
    } else {
        None
    };
    V3HubRespContinuation04Committed {
        previous: input,
        action,
        finalized_payload,
        canonical_context,
    }
}

impl V3HubRespContinuation04Committed {
    pub fn action(&self) -> V3HubContinuationCommit {
        self.action
    }

    pub fn canonical_context_count(&self) -> usize {
        usize::from(self.canonical_context.is_some())
    }

    pub fn canonical_context_shares_finalized_payload(&self) -> bool {
        self.canonical_context
            .as_ref()
            .is_some_and(|context| Arc::ptr_eq(&context.payload, &self.finalized_payload))
    }

    pub fn canonical_context_shares_provider_payload(&self) -> bool {
        self.canonical_context.as_ref().is_some_and(|context| {
            Arc::ptr_eq(&context.payload, self.previous.previous.provider_payload())
        })
    }

    pub fn canonical_tool_call_kinds(&self) -> Vec<V3HubRelayToolKind> {
        self.canonical_context
            .as_ref()
            .map(|context| {
                context
                    .tool_calls
                    .iter()
                    .map(|tool_call| tool_call.kind)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn canonical_context_payload(&self) -> Option<&Value> {
        self.canonical_context
            .as_ref()
            .map(|context| context.payload.as_ref())
    }

    pub fn finalized_payload(&self) -> &Value {
        self.finalized_payload.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespContinuation04Outcome {
    data: V3HubRespContinuation04Committed,
    control_transition: Option<V3StoplessCenterState>,
    web_search_transition: Option<V3WebSearchCenterState>,
}

impl V3HubRespContinuation04Outcome {
    pub fn control_transition(&self) -> Option<&V3StoplessCenterState> {
        self.control_transition.as_ref()
    }

    pub fn web_search_transition(&self) -> Option<&V3WebSearchCenterState> {
        self.web_search_transition.as_ref()
    }

    pub fn into_parts(
        self,
    ) -> (
        V3HubRespContinuation04Committed,
        Option<V3StoplessCenterState>,
        Option<V3WebSearchCenterState>,
    ) {
        (self.data, self.control_transition, self.web_search_transition)
    }

    pub fn into_data(self) -> V3HubRespContinuation04Committed {
        self.data
    }
}

impl Deref for V3HubRespContinuation04Outcome {
    type Target = V3HubRespContinuation04Committed;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

pub(crate) fn commit_v3_hub_relay_response(
    input: V3HubRespChatProcess03Outcome,
) -> Result<V3HubRespContinuation04Outcome, V3HubRelayResponseError> {
    let (input, control_transition, web_search_transition) = input.into_parts();
    let finalized_payload = input.previous.provider_payload().clone();
    let (action, canonical_context) = match input.terminality {
        V3HubResponseTerminality::Terminal => (V3HubContinuationCommit::None, None),
        V3HubResponseTerminality::NonTerminal
            if input.tool_calls.is_empty() && control_transition.is_some() =>
        {
            (V3HubContinuationCommit::None, None)
        }
        V3HubResponseTerminality::NonTerminal => (
            V3HubContinuationCommit::LocalContext,
            Some(V3HubRelayCanonicalResponseContext {
                payload: Arc::clone(&finalized_payload),
                terminality: input.terminality,
                tool_calls: input.tool_calls.clone(),
                servertool_action: input.servertool_action,
            }),
        ),
    };
    Ok(V3HubRespContinuation04Outcome {
        data: V3HubRespContinuation04Committed {
            previous: input,
            action,
            finalized_payload,
            canonical_context,
        },
        control_transition,
        web_search_transition,
    })
}

pub(crate) fn build_v3_relay_local_continuation_context_at_resp04(
    canonical_request: &Value,
    finalized_response: &Value,
) -> Result<Value, V3LocalContinuationError> {
    let mut input = canonical_request_input_items_at_resp04(canonical_request)?;
    let response_output = finalized_response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Resp04 local finalized response output must be an array".to_string(),
        })?;
    input.extend(
        response_output
            .iter()
            .map(project_v3_resp04_output_item_to_chat_input_item)
            .collect::<Result<Vec<_>, _>>()?,
    );

    let mut responses_context = Map::new();
    responses_context.insert("input".to_string(), Value::Array(input));
    if let Some(id) = finalized_response.get("id").and_then(Value::as_str) {
        if !id.trim().is_empty() {
            responses_context.insert("id".to_string(), Value::String(id.to_string()));
        }
    }
    for field in [
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "instructions",
    ] {
        if let Some(value) = canonical_request.get(field) {
            responses_context.insert(field.to_string(), value.clone());
        }
    }
    let chat_context =
        super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &Value::Object(responses_context),
        )
        .map_err(|message| V3LocalContinuationError::Codec { message })?;
    Ok(coalesce_v3_resp04_reasoning_with_following_tool_call(
        chat_context,
    ))
}

pub(crate) fn build_v3_relay_local_response_continuation_context_at_resp04(
    finalized_response: &Value,
) -> Result<Value, V3LocalContinuationError> {
    let response_output = finalized_response
        .get("output")
        .and_then(Value::as_array)
        .ok_or_else(|| V3LocalContinuationError::Codec {
            message: "Resp04 local finalized response output must be an array".to_string(),
        })?;
    let response_input = response_output
        .iter()
        .map(project_v3_resp04_output_item_to_chat_input_item)
        .collect::<Result<Vec<_>, _>>()?;
    let mut responses_context = Map::new();
    responses_context.insert("input".to_string(), Value::Array(response_input));
    let chat_context =
        super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &Value::Object(responses_context),
        )
        .map_err(|message| V3LocalContinuationError::Codec { message })?;
    Ok(coalesce_v3_resp04_reasoning_with_following_tool_call(
        chat_context,
    ))
}

fn coalesce_v3_resp04_reasoning_with_following_tool_call(mut chat_context: Value) -> Value {
    let Some(messages) = chat_context
        .get_mut("messages")
        .and_then(Value::as_array_mut)
    else {
        return chat_context;
    };
    let mut coalesced = Vec::with_capacity(messages.len());
    let mut pending_reasoning: Option<Value> = None;
    for message in std::mem::take(messages) {
        if v3_resp04_chat_message_is_reasoning_only(&message) {
            pending_reasoning = Some(match pending_reasoning.take() {
                Some(mut pending) => {
                    merge_v3_resp04_reasoning_content(&mut pending, &message);
                    pending
                }
                None => message,
            });
            continue;
        }
        if v3_resp04_chat_message_has_tool_calls(&message) {
            let mut target = message;
            if let Some(pending) = pending_reasoning.take() {
                merge_v3_resp04_reasoning_content(&mut target, &pending);
            }
            coalesced.push(target);
            continue;
        }
        if let Some(pending) = pending_reasoning.take() {
            coalesced.push(pending);
        }
        coalesced.push(message);
    }
    if let Some(pending) = pending_reasoning {
        coalesced.push(pending);
    }
    *messages = coalesced;
    chat_context
}

fn v3_resp04_chat_message_is_reasoning_only(message: &Value) -> bool {
    message
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        && message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        && !v3_resp04_chat_message_has_tool_calls(message)
        && message
            .get("content")
            .is_none_or(v3_resp04_chat_content_is_empty)
}

fn v3_resp04_chat_message_has_tool_calls(message: &Value) -> bool {
    message
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        && message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|tool_calls| !tool_calls.is_empty())
}

fn v3_resp04_chat_content_is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(parts) => parts.is_empty(),
        _ => false,
    }
}

fn merge_v3_resp04_reasoning_content(target: &mut Value, source: &Value) {
    let Some(source_reasoning) = source
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let merged = match target_object
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(existing) => format!("{existing}\n{source_reasoning}"),
        None => source_reasoning.to_string(),
    };
    target_object.insert("reasoning_content".to_string(), Value::String(merged));
}

fn project_v3_resp04_output_item_to_chat_input_item(
    item: &Value,
) -> Result<Value, V3LocalContinuationError> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if item_type == "reasoning" {
        let mut reasoning = item.clone();
        if let Some(reasoning_object) = reasoning.as_object_mut() {
            if let Some(summary) = v3_resp04_reasoning_summary_text(item) {
                reasoning_object.insert("reasoning_content".to_string(), Value::String(summary));
            }
        }
        return Ok(reasoning);
    }
    if item_type != "output_text" {
        return Ok(item.clone());
    }
    let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
        V3LocalContinuationError::Codec {
            message: "Resp04 output_text continuation item must contain text".to_string(),
        }
    })?;
    Ok(json!({
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}]
    }))
}

fn v3_resp04_reasoning_summary_text(item: &Value) -> Option<String> {
    let summary = item.get("summary").and_then(Value::as_array)?;
    let text = summary
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn canonical_request_input_items_at_resp04(
    canonical_request: &Value,
) -> Result<Vec<Value>, V3LocalContinuationError> {
    if let Some(input) = canonical_request.get("input") {
        return match input {
            Value::Array(items) => Ok(items.clone()),
            Value::String(text) => Ok(vec![json!({
                "type": "message",
                "role": "user",
                "content": [{"type":"input_text","text": text}]
            })]),
            _ => Err(V3LocalContinuationError::Codec {
                message: "Resp04 local canonical request input must be an array or string"
                    .to_string(),
            }),
        };
    }
    match canonical_request.get("messages").and_then(Value::as_array) {
        Some(messages) => {
            match super::request_outbound_format::build_responses_input_from_chat_messages(messages)
            {
                Ok(Value::Array(items)) => Ok(items),
                Ok(_) => Err(V3LocalContinuationError::Codec {
                    message: "Resp04 local canonical request messages did not produce input items"
                        .to_string(),
                }),
                Err(reason) => Err(V3LocalContinuationError::Codec { message: reason }),
            }
        }
        None => Err(V3LocalContinuationError::Codec {
            message: "Resp04 local canonical request input is required".to_string(),
        }),
    }
}

fn restored_context_call_ids(
    canonical_context: &Value,
) -> Result<Vec<String>, V3LocalContinuationError> {
    canonical_context
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|message| {
            message
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .map(|call| {
            call.get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| V3LocalContinuationError::Codec {
                    message: "Resp04 local context has a tool call without id".to_string(),
                })
        })
        .collect::<Result<Vec<_>, _>>()
}

pub(crate) fn assert_v3_relay_local_continuation_context_has_call_ids(
    canonical_context: &Value,
) -> Result<Vec<String>, V3LocalContinuationError> {
    let context_ids = restored_context_call_ids(canonical_context)?;
    if context_ids.is_empty() {
        return Err(V3LocalContinuationError::Codec {
            message: "Resp04 local context has no tool call id".to_string(),
        });
    }
    Ok(context_ids)
}

fn local_continuation_context_ids(
    canonical_context: &Value,
    response_id: Option<&str>,
) -> Result<Vec<String>, V3LocalContinuationError> {
    let call_ids = assert_v3_relay_local_continuation_context_has_call_ids(canonical_context)?;
    let mut non_internal_ids = Vec::new();
    if let Some(response_id) = response_id.filter(|value| !value.trim().is_empty()) {
        non_internal_ids.push(response_id.to_string());
    }
    for id in &call_ids {
        if !is_v3_stopless_internal_call_id(id)
            && !non_internal_ids.iter().any(|existing| existing == id)
        {
            non_internal_ids.push(id.clone());
        }
    }
    if !non_internal_ids.is_empty() {
        return Ok(non_internal_ids);
    }
    if call_ids
        .iter()
        .any(|id| is_v3_stopless_internal_call_id(id))
    {
        if let Some(response_id) = response_id.filter(|value| !value.trim().is_empty()) {
            return Ok(vec![response_id.to_string()]);
        }
    }
    Ok(non_internal_ids)
}

pub(crate) fn commit_or_release_v3_relay_local_continuation_at_resp04(
    store: &mut V3LocalContinuationStore,
    scope: V3LocalContinuationScopeKey,
    now_epoch_ms: u64,
    ttl_ms: u64,
    restored_context_ids: &[String],
    canonical_response: &Value,
    response_id: Option<&str>,
    action: V3HubContinuationCommit,
) -> Result<(), V3LocalContinuationError> {
    for context_id in restored_context_ids {
        store.release_aliases_in_scope(&scope, context_id);
    }
    if action != V3HubContinuationCommit::LocalContext {
        return Ok(());
    }
    let context_ids = local_continuation_context_ids(canonical_response, response_id)?;
    if let Some(duplicate) = context_ids
        .iter()
        .find(|id| store.contains_in_scope(&scope, id))
    {
        return Err(V3LocalContinuationError::AlreadyCommitted {
            context_id: duplicate.clone(),
        });
    }
    let expires_at_epoch_ms =
        now_epoch_ms
            .checked_add(ttl_ms)
            .ok_or_else(|| V3LocalContinuationError::Codec {
                message: "local continuation clock overflow".to_string(),
            })?;
    for context_id in context_ids {
        store.commit_at_resp04(V3LocalContinuationResp04SaveInput::new(
            context_id,
            scope.clone(),
            canonical_response.clone(),
            V3LocalContinuationTerminalOutcome::NonTerminal,
            now_epoch_ms,
            expires_at_epoch_ms,
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn responses_scope() -> V3LocalContinuationScopeKey {
        V3LocalContinuationScopeKey::responses(
            "/v1/responses",
            "session-stopless-repeat",
            "conversation-stopless-repeat",
            5555,
            "coding",
        )
    }

    fn stopless_context() -> Value {
        json!({
            "messages": [
                {"role":"user","content":"continue"},
                {
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_stopless_reasoning",
                        "type":"function",
                        "function":{
                            "name":"exec_command",
                            "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                        }
                    }]
                }
            ]
        })
    }

    #[test]
    fn resp04_stores_stopless_context_by_response_id_not_internal_call_id() {
        let mut store = V3LocalContinuationStore::default();
        let scope = responses_scope();
        let first = stopless_context();

        commit_or_release_v3_relay_local_continuation_at_resp04(
            &mut store,
            scope.clone(),
            10_000,
            60_000,
            &[],
            &first,
            Some("resp_stopless_context"),
            V3HubContinuationCommit::LocalContext,
        )
        .expect("stopless projection context must be restorable by response id");

        assert!(
            !store.contains_in_scope(&scope, "call_stopless_reasoning"),
            "internal stopless call id must not become a reusable local continuation context"
        );
        assert!(
            store.contains_in_scope(&scope, "resp_stopless_context"),
            "client previous_response_id must restore the stopless projected context"
        );

        commit_or_release_v3_relay_local_continuation_at_resp04(
            &mut store,
            scope.clone(),
            11_000,
            60_000,
            &["resp_stopless_context".to_string()],
            &stopless_context(),
            Some("resp_stopless_context"),
            V3HubContinuationCommit::LocalContext,
        )
        .expect("consumed stopless response-id context must release before recommit");

        assert!(store.contains_in_scope(&scope, "resp_stopless_context"));
    }

    #[test]
    fn resp04_still_stores_regular_tool_call_local_continuation() {
        let mut store = V3LocalContinuationStore::default();
        let scope = responses_scope();
        let context = json!({
            "messages": [
                {"role":"user","content":"use tool"},
                {
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_exec_regular",
                        "type":"function",
                        "function":{
                            "name":"exec_command",
                            "arguments":"{\"cmd\":\"pwd\"}"
                        }
                    }]
                }
            ]
        });

        commit_or_release_v3_relay_local_continuation_at_resp04(
            &mut store,
            scope.clone(),
            20_000,
            60_000,
            &[],
            &context,
            None,
            V3HubContinuationCommit::LocalContext,
        )
        .expect("regular tool call must remain local-continuation owned");

        assert!(store.contains_in_scope(&scope, "call_exec_regular"));
        assert_eq!(store.len(), 1);
    }
}
