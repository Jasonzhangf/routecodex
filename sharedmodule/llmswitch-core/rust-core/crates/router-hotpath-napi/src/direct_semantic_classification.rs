use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// feature_id: hub.direct_semantic_classification

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DirectSemanticClass {
    Routing,
    Passthrough,
}

impl DirectSemanticClass {
    pub(crate) fn from_optional_value(value: Option<&Value>) -> Result<Self, String> {
        match trimmed(value) {
            None | Some("routing") => Ok(Self::Routing),
            Some("passthrough") => Ok(Self::Passthrough),
            Some(other) => Err(format!(
                "direct semantic class must be routing or passthrough, received {other}"
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ConfigDirect01AuthoringPolicy {
    pub(crate) semantics: Option<String>,
    pub(crate) history_tool_image_cleanup: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ConfigDirect02ValidatedPolicy {
    pub(crate) semantic_class: DirectSemanticClass,
    pub(crate) history_tool_image_cleanup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VrDirect03ResolvedSemantics {
    pub(crate) semantic_class: DirectSemanticClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selected_provider_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selected_runtime_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) configured_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) route_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_client_model: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) direct_history_tool_image_cleanup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DirectFieldProjection {
    Preserve,
    Set(String),
    RestoreOriginal(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectReq04ProjectionPlan {
    pub(crate) model: DirectFieldProjection,
    pub(crate) thinking: DirectFieldProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectResp05ProjectionPlan {
    pub(crate) model: DirectFieldProjection,
    pub(crate) thinking: DirectFieldProjection,
}

pub(crate) fn validate_config_direct_02(
    model_id: &str,
    direct_value: Option<&Value>,
) -> Result<ConfigDirect02ValidatedPolicy, String> {
    let authoring = match direct_value {
        None => ConfigDirect01AuthoringPolicy {
            semantics: None,
            history_tool_image_cleanup: false,
        },
        Some(value) => {
            let direct = value.as_object().ok_or_else(|| {
                format!(
                    "Provider model {} direct policy must be an object",
                    model_id
                )
            })?;
            for key in direct.keys() {
                if key != "semantics" && key != "historyToolImageCleanup" {
                    return Err(format!(
                        "Provider model {} direct policy contains unknown field {}",
                        model_id, key
                    ));
                }
            }
            let semantics = match direct.get("semantics") {
                None => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            format!(
                                "Provider model {} direct.semantics must be routing or passthrough",
                                model_id
                            )
                        })?
                        .to_string(),
                ),
            };
            let history_tool_image_cleanup = match direct.get("historyToolImageCleanup") {
                None => false,
                Some(Value::Bool(value)) => *value,
                Some(_) => {
                    return Err(format!(
                        "Provider model {} direct.historyToolImageCleanup must be boolean",
                        model_id
                    ))
                }
            };
            ConfigDirect01AuthoringPolicy {
                semantics,
                history_tool_image_cleanup,
            }
        }
    };
    let semantic_class = match authoring.semantics.as_deref() {
        None | Some("routing") => DirectSemanticClass::Routing,
        Some("passthrough") => DirectSemanticClass::Passthrough,
        Some(_) => {
            return Err(format!(
                "Provider model {} direct.semantics must be routing or passthrough",
                model_id
            ))
        }
    };
    Ok(ConfigDirect02ValidatedPolicy {
        semantic_class,
        history_tool_image_cleanup: authoring.history_tool_image_cleanup,
    })
}

pub(crate) fn resolve_direct_semantic_classification(
    input: &Value,
) -> Result<VrDirect03ResolvedSemantics, String> {
    let root = input
        .as_object()
        .ok_or_else(|| "direct semantic classification input must be an object".to_string())?;
    let payload = root.get("payload").and_then(Value::as_object);
    let semantic_class = DirectSemanticClass::from_optional_value(root.get("directSemantic"))?;
    let request_model = owned_trimmed(payload.and_then(|row| row.get("model")));
    let configured_model_id = owned_trimmed(root.get("targetModelId"));
    let original_client_model = if semantic_class == DirectSemanticClass::Routing {
        match (&configured_model_id, &request_model) {
            (Some(target), Some(inbound)) if target != inbound => Some(inbound.clone()),
            _ => None,
        }
    } else {
        None
    };
    Ok(VrDirect03ResolvedSemantics {
        semantic_class,
        selected_provider_key: owned_trimmed(root.get("selectedProviderKey")),
        selected_runtime_key: owned_trimmed(root.get("selectedRuntimeKey")),
        configured_model_id,
        request_model,
        route_thinking: normalize_route_thinking(root.get("routeThinking")),
        request_thinking: request_thinking_level(payload),
        original_client_model,
        direct_history_tool_image_cleanup: read_optional_bool(
            root,
            "directHistoryToolImageCleanup",
        )?
        .unwrap_or(false),
    })
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn read_optional_bool(root: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match root.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("direct semantic field {key} must be boolean")),
    }
}

pub(crate) fn build_direct_req_04_projection_plan(
    resolved: &VrDirect03ResolvedSemantics,
) -> DirectReq04ProjectionPlan {
    match resolved.semantic_class {
        DirectSemanticClass::Routing => DirectReq04ProjectionPlan {
            model: resolved
                .configured_model_id
                .clone()
                .map(DirectFieldProjection::Set)
                .unwrap_or(DirectFieldProjection::Preserve),
            thinking: resolved
                .route_thinking
                .clone()
                .map(DirectFieldProjection::Set)
                .unwrap_or(DirectFieldProjection::Preserve),
        },
        DirectSemanticClass::Passthrough => DirectReq04ProjectionPlan {
            model: DirectFieldProjection::Preserve,
            thinking: DirectFieldProjection::Preserve,
        },
    }
}

pub(crate) fn build_direct_resp_05_projection_plan(
    resolved: &VrDirect03ResolvedSemantics,
) -> DirectResp05ProjectionPlan {
    match resolved.semantic_class {
        DirectSemanticClass::Routing => DirectResp05ProjectionPlan {
            model: resolved
                .original_client_model
                .clone()
                .map(DirectFieldProjection::RestoreOriginal)
                .unwrap_or(DirectFieldProjection::Preserve),
            thinking: DirectFieldProjection::Preserve,
        },
        DirectSemanticClass::Passthrough => DirectResp05ProjectionPlan {
            model: DirectFieldProjection::Preserve,
            thinking: DirectFieldProjection::Preserve,
        },
    }
}

#[napi(js_name = "resolveDirectSemanticClassificationJson")]
pub fn resolve_direct_semantic_classification_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct semantic input parse failed: {error}"))
    })?;
    let output =
        resolve_direct_semantic_classification(&input).map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|error| {
        napi::Error::from_reason(format!("direct semantic output serialize failed: {error}"))
    })
}

fn trimmed(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn owned_trimmed(value: Option<&Value>) -> Option<String> {
    trimmed(value).map(str::to_string)
}

fn normalize_route_thinking(route_thinking: Option<&Value>) -> Option<String> {
    let value = trimmed(route_thinking)?;
    let normalized = value.to_ascii_lowercase();
    if normalized == "max" {
        return Some("xhigh".to_string());
    }
    if matches!(normalized.as_str(), "xhigh" | "high" | "medium" | "low") {
        return Some(normalized);
    }
    None
}

fn request_thinking_level(payload: Option<&Map<String, Value>>) -> Option<String> {
    let payload = payload?;
    for value in [
        trimmed(payload.get("reasoning_effort")),
        trimmed(payload.get("reasoningEffort")),
        payload
            .get("reasoning")
            .and_then(Value::as_object)
            .and_then(|reasoning| trimmed(reasoning.get("effort"))),
        trimmed(payload.get("thinking")),
    ] {
        if let Some(value) = value {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_default_explicit_and_invalid_config_classes() {
        assert_eq!(
            validate_config_direct_02("m", None).unwrap().semantic_class,
            DirectSemanticClass::Routing
        );
        assert_eq!(
            validate_config_direct_02("m", Some(&json!({"semantics":"passthrough"})))
                .unwrap()
                .semantic_class,
            DirectSemanticClass::Passthrough
        );
        assert!(validate_config_direct_02("m", Some(&json!({"semantics":"unknown"}))).is_err());
    }

    #[test]
    fn resolves_real_target_contract_and_builds_paired_plans() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "directSemantic": "routing",
            "selectedProviderKey": "p.key.wire",
            "selectedRuntimeKey": "p.key",
            "targetModelId": "wire",
            "payload": {"model":"client","reasoning_effort":"low"},
            "routeThinking": "max",
            "routeParams": {"routePolicyGroup":"default"}
        }))
        .unwrap();
        assert_eq!(resolved.semantic_class, DirectSemanticClass::Routing);
        assert_eq!(
            build_direct_req_04_projection_plan(&resolved).model,
            DirectFieldProjection::Set("wire".to_string())
        );
        assert_eq!(
            build_direct_resp_05_projection_plan(&resolved).model,
            DirectFieldProjection::RestoreOriginal("client".to_string())
        );
        assert_eq!(resolved.route_thinking.as_deref(), Some("xhigh"));
    }

    #[test]
    fn does_not_derive_route_thinking_from_route_params() {
        let resolved = resolve_direct_semantic_classification(&json!({
            "directSemantic": "routing",
            "targetModelId": "wire",
            "payload": {"model":"client","reasoning_effort":"low"},
            "routeParams": {"thinking":"high"}
        }))
        .unwrap();

        assert_eq!(resolved.route_thinking, None);
        assert_eq!(
            build_direct_req_04_projection_plan(&resolved).thinking,
            DirectFieldProjection::Preserve
        );
    }
}
