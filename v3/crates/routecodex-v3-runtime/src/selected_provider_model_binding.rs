use routecodex_v3_target::V3TargetCandidate;
use serde_json::Value;

// feature_id: v3.route_selected_provider_model_binding
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct V3SelectedProviderModelBinding {
    payload: Value,
}

impl V3SelectedProviderModelBinding {
    pub(crate) fn into_payload(self) -> Value {
        self.payload
    }
}

pub(crate) fn bind_v3_selected_provider_model(
    payload: Value,
    selected: &V3TargetCandidate,
) -> Result<V3SelectedProviderModelBinding, String> {
    let wire_model = selected.wire_model.as_str();
    if wire_model.trim().is_empty() {
        return Err(format!(
            "selected provider {} model {} has an empty wire model",
            selected.provider_id, selected.model_id
        ));
    }
    if wire_model != wire_model.trim() {
        return Err(format!(
            "selected provider {} model {} has a non-normalized wire model",
            selected.provider_id, selected.model_id
        ));
    }
    let mut payload = payload;
    let object = payload.as_object_mut().ok_or_else(|| {
        format!(
            "selected provider model binding requires an object payload for {}:{}",
            selected.provider_id, selected.model_id
        )
    })?;
    object.insert("model".to_string(), Value::String(wire_model.to_string()));
    Ok(V3SelectedProviderModelBinding { payload })
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{
        V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
    };
    use serde_json::json;

    fn selected() -> V3TargetCandidate {
        V3TargetCandidate {
            provider_id: "provider-a".to_string(),
            provider_type: "responses".to_string(),
            auth_alias: "primary".to_string(),
            model_id: "canonical-provider-model".to_string(),
            wire_model: "provider-wire-model".to_string(),
            visible_model_ids: vec!["client-route-alias".to_string()],
            model_capabilities: vec!["text".to_string()],
            web_search_execution_mode: V3WebSearchExecutionMode::None,
            max_context_tokens: None,
            base_url: "https://provider.invalid/v1".to_string(),
            responses_process: None,
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
            initial_concurrency_budget: 8,
            compatibility_profile: None,
            env_name: Some("TEST_KEY".to_string()),
            token_file: None,
            secret_file: None,
            secret_key: None,
            api_key: None,
            required_capabilities: Vec::new(),
            pool_ids: vec!["default".to_string()],
            default_pool_member: true,
            path: vec!["provider-a".to_string()],
        }
    }

    #[test]
    fn binding_uses_selected_wire_model_without_mutating_selected_target() {
        let bound = bind_v3_selected_provider_model(
            json!({"model":"client-route-alias","input":"hello"}),
            &selected(),
        )
        .unwrap();

        assert_eq!(bound.payload["model"], "provider-wire-model");
        assert_eq!(selected().wire_model, "provider-wire-model");
    }

    #[test]
    fn binding_rejects_non_object_payload_and_empty_wire_model() {
        assert!(bind_v3_selected_provider_model(json!([]), &selected()).is_err());
        let mut invalid = selected();
        invalid.wire_model = "  ".to_string();
        assert!(bind_v3_selected_provider_model(json!({}), &invalid).is_err());
        invalid.wire_model = " provider-wire-model ".to_string();
        assert!(bind_v3_selected_provider_model(json!({}), &invalid).is_err());
    }
}
