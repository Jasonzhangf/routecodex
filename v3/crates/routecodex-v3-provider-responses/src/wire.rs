use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Provider07ResponsesWirePayload {
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    pub auth_env: String,
    pub body: Value,
}

pub fn build_v3_provider_07_responses_wire_payload(
    provider_id: impl Into<String>,
    base_url: impl Into<String>,
    model: impl Into<String>,
    auth_env: impl Into<String>,
    current_request_body: Value,
) -> V3Provider07ResponsesWirePayload {
    V3Provider07ResponsesWirePayload {
        provider_id: provider_id.into(),
        base_url: base_url.into(),
        model: model.into(),
        auth_env: auth_env.into(),
        body: current_request_body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_body_is_current_request_body_unchanged() {
        let body = json!({"model":"client-model","input":"hello","unknown_client_field":true});
        let wire = build_v3_provider_07_responses_wire_payload(
            "openai",
            "http://upstream/v1",
            "manifest-model",
            "ROUTECODEX_V3_TEST_KEY",
            body.clone(),
        );
        assert_eq!(wire.body, body);
        assert_eq!(wire.model, "manifest-model");
    }
}
