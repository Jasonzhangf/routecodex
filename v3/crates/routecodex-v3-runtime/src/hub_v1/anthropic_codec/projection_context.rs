use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::V3AnthropicCodecError;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct V3AnthropicResponsesProjectionContext {
    pub(crate) provider_tool_names:
        provider_compat_core::goaichat_tool_names::GoaichatToolNameProjection,
    metadata: Option<Value>,
    custom_tool_names: BTreeMap<String, String>,
    namespaced_custom_tool_identities: BTreeMap<String, (String, String)>,
    mcp_tool_identities: HashMap<String, (String, String)>,
    reasoning_summary_policy: Option<String>,
}

impl V3AnthropicResponsesProjectionContext {
    pub fn from_chat_canonical_request(request: &Value) -> Result<Self, V3AnthropicCodecError> {
        let metadata = request
            .pointer("/routecodex_chat_extension/responses_request/metadata")
            .cloned();
        if metadata.as_ref().is_some_and(|value| !value.is_object()) {
            return Err(V3AnthropicCodecError::MalformedField {
                field: "routecodex_chat_extension.responses_request.metadata",
            });
        }
        let reasoning_summary_policy = request
            .get("reasoning_summary_policy")
            .map(valid_responses_reasoning_summary_policy)
            .transpose()?
            .map(str::to_string);
        let mut mcp_tool_identities =
            super::super::request_outbound_mcp_names::responses_mcp_dispatch_identities(request)
                .map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools" })?;
        let (anthropic_client_names, _) =
            super::namespace_tool_names::anthropic_declared_tool_names(request);
        for (client_path, provider_name) in anthropic_client_names {
            if let Some((namespace, name)) = client_path.rsplit_once('.') {
                // Standard flat-function dispatch normalization already owns
                // its identity, including the optional functions.mcp__ prefix.
                mcp_tool_identities
                    .entry(provider_name)
                    .or_insert_with(|| (namespace.to_string(), name.to_string()));
            }
        }
        let custom_tool_names = governed_custom_tool_names(request)?;
        let namespaced_custom_tool_identities =
            super::namespace_tool_names::anthropic_declared_tool_names(request)
                .0
                .into_iter()
                .filter_map(|(client_path, provider_name)| {
                    (custom_tool_names.get(&provider_name) == Some(&client_path))
                        .then(|| {
                            client_path.rsplit_once('.').map(|(namespace, name)| {
                                (provider_name, (namespace.to_string(), name.to_string()))
                            })
                        })
                        .flatten()
                })
                .collect();
        Ok(Self {
            provider_tool_names: Default::default(),
            metadata,
            custom_tool_names,
            namespaced_custom_tool_identities,
            mcp_tool_identities,
            reasoning_summary_policy,
        })
    }

    pub(crate) fn governed_custom_tool_client_name(&self, name: &str) -> Option<&str> {
        self.custom_tool_names.get(name).map(String::as_str)
    }

    pub(crate) fn namespaced_custom_tool_identity(&self, name: &str) -> Option<(&str, &str)> {
        self.namespaced_custom_tool_identities
            .get(name)
            .map(|(namespace, tool_name)| (namespace.as_str(), tool_name.as_str()))
    }

    pub(crate) fn mcp_tool_identities(&self) -> &HashMap<String, (String, String)> {
        &self.mcp_tool_identities
    }

    pub(super) fn metadata(&self) -> Option<&Value> {
        self.metadata.as_ref()
    }

    pub(super) fn reasoning_summary_policy(&self) -> Option<&str> {
        self.reasoning_summary_policy.as_deref()
    }
}

fn valid_responses_reasoning_summary_policy(value: &Value) -> Result<&str, V3AnthropicCodecError> {
    value
        .as_str()
        .filter(|policy| matches!(*policy, "auto" | "concise" | "detailed"))
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning_summary_policy",
        })
}

fn governed_custom_tool_names(
    request: &Value,
) -> Result<BTreeMap<String, String>, V3AnthropicCodecError> {
    let mut names = BTreeSet::new();
    collect_governed_custom_tool_names(request.get("tools"), &mut names)?;
    for item in request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_governed_custom_tool_names(item.get("tools"), &mut names)?;
        }
    }
    let mut mapped = super::namespace_tool_names::anthropic_declared_tool_names(request).1;
    for name in names {
        mapped.entry(name.clone()).or_insert(name);
    }
    Ok(mapped)
}

fn collect_governed_custom_tool_names(
    tools: Option<&Value>,
    names: &mut BTreeSet<String>,
) -> Result<(), V3AnthropicCodecError> {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        if tool.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tools[].name",
            })?;
        names.insert(name.to_string());
    }
    Ok(())
}
