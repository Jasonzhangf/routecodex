use super::*;
use crate::{
    V3LocalContinuationError, V3LocalContinuationResp04SaveInput, V3LocalContinuationScopeKey,
    V3LocalContinuationStore, V3LocalContinuationTerminalOutcome,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubRespContinuation04Committed {
    pub(crate) previous: V3HubRespChatProcess03Governed,
    pub(crate) action: V3HubContinuationCommit,
    pub(crate) finalized_payload: Arc<Value>,
    pub(crate) canonical_context: Option<V3HubRelayCanonicalResponseContext>,
    pub(crate) stopless_center_state: Option<V3StoplessCenterState>,
}

pub fn build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03(
    input: V3HubRespChatProcess03Governed,
    action: V3HubContinuationCommit,
) -> V3HubRespContinuation04Committed {
    let finalized_payload = canonicalize_v3_hub_resp04_finalized_payload(&input);
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
        stopless_center_state: None,
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

    pub fn stopless_center_state(&self) -> Option<&V3StoplessCenterState> {
        self.stopless_center_state.as_ref()
    }
}

pub(crate) fn commit_v3_hub_relay_response(
    input: V3HubRespChatProcess03Governed,
) -> Result<V3HubRespContinuation04Committed, V3HubRelayResponseError> {
    let finalized_payload = canonicalize_v3_hub_resp04_finalized_payload(&input);
    let stopless_center_state = input.stopless_center_state.clone();
    let (action, canonical_context) = match input.terminality {
        V3HubResponseTerminality::Terminal => (V3HubContinuationCommit::None, None),
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
    Ok(V3HubRespContinuation04Committed {
        previous: input,
        action,
        finalized_payload,
        canonical_context,
        stopless_center_state,
    })
}

fn canonicalize_v3_hub_resp04_finalized_payload(
    input: &V3HubRespChatProcess03Governed,
) -> Arc<Value> {
    let provider_payload = input.previous.provider_payload();
    if input.terminality != V3HubResponseTerminality::NonTerminal || input.tool_calls.is_empty() {
        return Arc::clone(provider_payload);
    }
    let Some(source) = provider_payload.as_object() else {
        return Arc::clone(provider_payload);
    };
    let mut projected = source.clone();
    let mut changed = false;
    if projected.get("status").and_then(Value::as_str) != Some("requires_action") {
        projected.insert(
            "status".to_string(),
            Value::String("requires_action".to_string()),
        );
        changed = true;
    }
    for key in ["finish_reason", "finishReason", "stop_reason", "stopReason"] {
        if projected.contains_key(key)
            && projected.get(key).and_then(Value::as_str) != Some("tool_calls")
        {
            projected.insert(key.to_string(), Value::String("tool_calls".to_string()));
            changed = true;
        }
    }
    if changed {
        Arc::new(Value::Object(projected))
    } else {
        Arc::clone(provider_payload)
    }
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
    input.extend(response_output.clone());

    let mut context = Map::new();
    context.insert("input".to_string(), Value::Array(input));
    context.insert("output".to_string(), Value::Array(response_output));
    if let Some(id) = finalized_response.get("id").and_then(Value::as_str) {
        if !id.trim().is_empty() {
            context.insert("id".to_string(), Value::String(id.to_string()));
        }
    }
    for field in [
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "instructions",
    ] {
        if let Some(value) = canonical_request.get(field) {
            context.insert(field.to_string(), value.clone());
        }
    }
    Ok(Value::Object(context))
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
                Value::Array(items) => Ok(items),
                _ => Err(V3LocalContinuationError::Codec {
                    message: "Resp04 local canonical request messages did not produce input items"
                        .to_string(),
                }),
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
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            )
        })
        .map(|item| {
            item.get("call_id")
                .or_else(|| item.get("id"))
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
) -> Result<Vec<String>, V3LocalContinuationError> {
    let call_ids = assert_v3_relay_local_continuation_context_has_call_ids(canonical_context)?;
    let mut non_internal_ids = Vec::new();
    for id in &call_ids {
        if !is_v3_stopless_internal_call_id(id) {
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
        if let Some(response_id) = canonical_context
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
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
    action: V3HubContinuationCommit,
) -> Result<(), V3LocalContinuationError> {
    for context_id in restored_context_ids {
        store.release_in_scope(&scope, context_id);
    }
    if action != V3HubContinuationCommit::LocalContext {
        return Ok(());
    }
    let context_ids = local_continuation_context_ids(canonical_response)?;
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
            "id":"resp_stopless_context",
            "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}],
            "output": [{
                "type":"function_call",
                "call_id":"call_stopless_reasoning",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
            }]
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
            "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"use tool"}]}],
            "output": [{
                "type":"function_call",
                "call_id":"call_exec_regular",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            }]
        });

        commit_or_release_v3_relay_local_continuation_at_resp04(
            &mut store,
            scope.clone(),
            20_000,
            60_000,
            &[],
            &context,
            V3HubContinuationCommit::LocalContext,
        )
        .expect("regular tool call must remain local-continuation owned");

        assert!(store.contains_in_scope(&scope, "call_exec_regular"));
        assert_eq!(store.len(), 1);
    }
}
