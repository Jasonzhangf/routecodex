use super::V3ResponsesRelayServerToolScope;
use crate::V3RequestExecutionControl;
use serde_json::Value;
use servertool_core::web_search_contract::{WebSearchHookContractError, WebSearchHookRequest};

pub(crate) fn build_v3_web_search_hook_request(
    request_id: &str,
    call_id: &str,
    query: &str,
    count: Option<u32>,
    recency: Option<String>,
    content_types: Vec<String>,
    scope: &V3ResponsesRelayServerToolScope,
    execution_control: &V3RequestExecutionControl,
    policy_id: &str,
) -> Result<WebSearchHookRequest, WebSearchHookContractError> {
    let request = WebSearchHookRequest {
        request_id: request_id.to_string(),
        call_id: call_id.to_string(),
        query: query.to_string(),
        count,
        recency,
        content_types,
        scope: scope.web_search_hook_scope(),
        deadline_unix_ms: execution_control
            .deadline_unix_ms()
            .map_err(|_| WebSearchHookContractError::DeadlineExpired)?,
        policy_id: policy_id.to_string(),
    };
    request.validate()?;
    Ok(request)
}

pub(crate) fn build_v3_web_search_hook_request_from_value(
    request_id: &str,
    call_id: &str,
    input: &Value,
    scope: &V3ResponsesRelayServerToolScope,
    execution_control: &V3RequestExecutionControl,
    policy_id: &str,
) -> Result<WebSearchHookRequest, WebSearchHookContractError> {
    let query = input
        .get("query")
        .or_else(|| input.get("search_query"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let count = input
        .get("count")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    let recency = input
        .get("recency")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content_types = input
        .get("content_types")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    build_v3_web_search_hook_request(
        request_id,
        call_id,
        query,
        count,
        recency,
        content_types,
        scope,
        execution_control,
        policy_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use serde_json::json;

    fn execution_control() -> V3RequestExecutionControl {
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.test]
bind = "127.0.0.1"
port = 5520
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = { attempt_max_bytes = 1048576, attempt_max_frames = 1024, request_max_bytes = 1048576, process_max_bytes = 1048576, residence_timeout_ms = 60000 }
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEST_KEY" }] }
[providers.test.models.test-model]
capabilities = ["text"]
[route_groups.default.pools.default]
targets = [{ kind = "provider_model", provider = "test", model = "test-model", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();
        V3RequestExecutionControl::from_manifest(&manifest, "test").unwrap()
    }

    fn scope() -> V3ResponsesRelayServerToolScope {
        V3ResponsesRelayServerToolScope::new(
            "/v1/responses",
            "session-1",
            "conversation-1",
            5520,
            "default",
        )
    }

    #[test]
    fn request_binds_scope_query_and_execution_deadline() {
        let request = build_v3_web_search_hook_request_from_value(
            "req-1",
            "call-web-search-1",
            &json!({"query":"routecodex","count":3}),
            &scope(),
            &execution_control(),
            "metadata-center-local-search",
        )
        .unwrap();
        assert_eq!(request.scope.session_id, "session-1");
        assert_eq!(request.scope.conversation_id, "conversation-1");
        assert_eq!(request.query, "routecodex");
        assert_eq!(request.count, Some(3));
        assert!(request.deadline_unix_ms > 0);
    }

    #[test]
    fn request_rejects_missing_query_before_adapter() {
        assert_eq!(
            build_v3_web_search_hook_request_from_value(
                "req-1",
                "call-web-search-1",
                &json!({}),
                &scope(),
                &execution_control(),
                "metadata-center-local-search",
            ),
            Err(WebSearchHookContractError::MissingQuery)
        );
    }
}
