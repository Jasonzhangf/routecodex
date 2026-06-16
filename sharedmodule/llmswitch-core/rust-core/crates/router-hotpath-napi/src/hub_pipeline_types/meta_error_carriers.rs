use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetaReq02RuntimeCarrier {
    request_id: String,
    pipeline_id: String,
    scope: Map<String, Value>,
    control: Map<String, Value>,
}

impl MetaReq02RuntimeCarrier {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn pipeline_id(&self) -> &str {
        &self.pipeline_id
    }

    pub(crate) fn control(&self) -> &Map<String, Value> {
        &self.control
    }
}

pub(crate) fn build_meta_req_02_runtime_carrier(
    request_id: String,
    pipeline_id: String,
    scope: Map<String, Value>,
    control: Map<String, Value>,
) -> Result<MetaReq02RuntimeCarrier, String> {
    if request_id.trim().is_empty() || pipeline_id.trim().is_empty() {
        return Err("MetaReq02RuntimeCarrier requires requestId and pipelineId".to_string());
    }
    Ok(MetaReq02RuntimeCarrier {
        request_id,
        pipeline_id,
        scope,
        control,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetaRoute03RouteCarrier {
    control: Map<String, Value>,
}

impl MetaRoute03RouteCarrier {
    pub(crate) fn control(&self) -> &Map<String, Value> {
        &self.control
    }

    pub(crate) fn get_string(&self, field: &str) -> Option<String> {
        self.control
            .get(field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    }

    pub(crate) fn get_bool(&self, field: &str) -> bool {
        self.control
            .get(field)
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }

    pub(crate) fn to_metadata_value(&self) -> Value {
        Value::Object(self.control.clone())
    }
}

pub(crate) fn build_meta_route_03_from_metadata(metadata: &Value) -> MetaRoute03RouteCarrier {
    let mut control = Map::new();
    let Some(source) = metadata.as_object() else {
        return MetaRoute03RouteCarrier { control };
    };

    copy_normalized_string_array(source, &mut control, "allowedProviders");
    copy_normalized_string_array(source, &mut control, "excludedProviderKeys");
    copy_normalized_string_array(source, &mut control, "disabledProviderKeyAliases");
    copy_non_empty_string(source, &mut control, "__shadowCompareForcedProviderKey");
    copy_non_empty_string(source, &mut control, "__routecodexRetryProviderKey");
    copy_non_empty_string(source, &mut control, "routeHint");
    copy_non_empty_string(source, &mut control, "routerDirectInboundProtocol");
    copy_non_empty_string(source, &mut control, "routecodexRoutingPolicyGroup");
    copy_non_empty_string(source, &mut control, "routecodexPortMode");
    copy_non_empty_string(source, &mut control, "routecodexPortBinding");
    if source
        .get("serverToolRequired")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        control.insert("serverToolRequired".to_string(), Value::Bool(true));
    }
    if source
        .get("serverToolFollowup")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        control.insert("serverToolFollowup".to_string(), Value::Bool(true));
    }
    copy_non_empty_string(source, &mut control, "serverToolFollowupSource");
    if let Some(port) = source
        .get("routecodexLocalPort")
        .and_then(|value| value.as_i64())
    {
        control.insert(
            "routecodexLocalPort".to_string(),
            Value::Number(port.into()),
        );
    }

    MetaRoute03RouteCarrier { control }
}

fn copy_non_empty_string(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    field: &str,
) {
    if let Some(value) = source
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(field.to_string(), Value::String(value.to_string()));
    }
}

fn copy_normalized_string_array(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    field: &str,
) {
    let Some(items) = source.get(field).and_then(|value| value.as_array()) else {
        return;
    };
    let normalized: Vec<Value> = items
        .iter()
        .filter_map(|entry| entry.as_str())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| Value::String(entry.to_string()))
        .collect();
    if !normalized.is_empty() {
        target.insert(field.to_string(), Value::Array(normalized));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorErr03RuntimeClassified {
    code: String,
    stage: String,
    retryable: bool,
    details: Map<String, Value>,
}

impl ErrorErr03RuntimeClassified {
    pub(crate) fn code(&self) -> &str {
        &self.code
    }

    pub(crate) fn stage(&self) -> &str {
        &self.stage
    }

    pub(crate) fn retryable(&self) -> bool {
        self.retryable
    }
}

pub(crate) fn build_error_err_03_runtime_classified(
    code: String,
    stage: String,
    retryable: bool,
    details: Map<String, Value>,
) -> Result<ErrorErr03RuntimeClassified, String> {
    if code.trim().is_empty() || stage.trim().is_empty() {
        return Err("ErrorErr03RuntimeClassified requires code and stage".to_string());
    }
    Ok(ErrorErr03RuntimeClassified {
        code,
        stage,
        retryable,
        details,
    })
}

pub(super) fn assert_payload_has_no_meta_or_error_carrier(
    value: &Value,
    node_name: &str,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for key in [
        "metaCarrier",
        "metadataCarrier",
        "runtimeMetadata",
        "errorCarrier",
        "classifiedError",
    ] {
        if object.contains_key(key) {
            return Err(format!(
                "{node_name} must not embed Meta* or Error* carrier in normal payload"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    #[test]
    fn builds_meta_carrier_with_required_scope() {
        let mut scope = Map::new();
        scope.insert("serverId".to_string(), json!("5555"));
        let carrier = build_meta_req_02_runtime_carrier(
            "req_1".to_string(),
            "pipe_1".to_string(),
            scope,
            Map::new(),
        )
        .unwrap();
        assert_eq!(carrier.request_id(), "req_1");
        assert_eq!(carrier.pipeline_id(), "pipe_1");
        assert!(carrier.control().is_empty());
    }

    #[test]
    fn rejects_meta_carrier_without_request_identity() {
        let err = build_meta_req_02_runtime_carrier(
            "".to_string(),
            "pipe_1".to_string(),
            Map::new(),
            Map::new(),
        )
        .unwrap_err();
        assert!(err.contains("requestId"));
    }

    #[test]
    fn builds_meta_route_03_from_legacy_metadata_only_with_route_controls() {
        let carrier = build_meta_route_03_from_metadata(&json!({
            "allowedProviders": [" p1.key1 ", "", 7],
            "disabledProviderKeyAliases": ["p1.key2"],
            "__shadowCompareForcedProviderKey": " p2.key3.model ",
            "__routecodexRetryProviderKey": " p3.key4.model ",
            "routeHint": " tools ",
            "routerDirectInboundProtocol": " openai-responses ",
            "routecodexRoutingPolicyGroup": " coding ",
            "providerProtocol": "openai-chat",
            "metadata": {"mustNotNest": true}
        }));
        assert_eq!(carrier.get_string("routeHint").as_deref(), Some("tools"));
        assert_eq!(
            carrier.get_string("routerDirectInboundProtocol").as_deref(),
            Some("openai-responses")
        );
        assert_eq!(
            carrier.control().get("allowedProviders"),
            Some(&json!(["p1.key1"]))
        );
        assert!(carrier.control().get("providerProtocol").is_none());
        assert!(carrier.control().get("metadata").is_none());
    }

    #[test]
    fn builds_classified_error_carrier() {
        let carrier = build_error_err_03_runtime_classified(
            "HTTP_503".to_string(),
            "provider_runtime".to_string(),
            true,
            Map::new(),
        )
        .unwrap();
        assert_eq!(carrier.code(), "HTTP_503");
        assert_eq!(carrier.stage(), "provider_runtime");
        assert!(carrier.retryable());
    }

    #[test]
    fn normal_payload_cannot_embed_meta_or_error_carrier() {
        let err = assert_payload_has_no_meta_or_error_carrier(
            &json!({"metaCarrier":{"requestId":"req_1"}}),
            "HubReqOutbound05ProviderSemantic",
        )
        .unwrap_err();
        assert!(err.contains("must not embed Meta* or Error* carrier"));
    }
}
