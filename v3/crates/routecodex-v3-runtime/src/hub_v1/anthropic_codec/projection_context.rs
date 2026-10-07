use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::V3AnthropicCodecError;
use crate::operation_runner::ResponseProjectionView;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct V3AnthropicResponsesProjectionContext {
    metadata: Option<Value>,
    custom_tool_names: BTreeMap<String, String>,
    namespaced_custom_tool_identities: BTreeMap<String, (String, String)>,
    mcp_tool_identities: HashMap<String, (String, String)>,
    successful_attempt_tool_identities: BTreeMap<String, (String, Option<String>, Option<Value>)>,
    reasoning_summary_policy: Option<String>,
}

impl V3AnthropicResponsesProjectionContext {
    pub fn from_successful_attempt(
        view: &ResponseProjectionView,
    ) -> Result<Self, V3AnthropicCodecError> {
        Self::from_successful_attempt_with_business_context(view, None, None)
    }

    /// Successful-attempt typed identity plus business-only metadata/reasoning
    /// extracted from the canonical Chat request.
    ///
    /// Tool identity (kind/name/namespace) still comes exclusively from the
    /// typed view; the Chat canonical request only supplies the Responses
    /// `metadata` carrier and the reasoning summary policy.
    pub fn from_successful_attempt_with_chat_canonical_business_context(
        view: &ResponseProjectionView,
        chat_canonical_request: &Value,
    ) -> Result<Self, V3AnthropicCodecError> {
        let (metadata, reasoning_summary_policy) =
            chat_canonical_business_context(chat_canonical_request)?;
        Self::from_successful_attempt_with_business_context(
            view,
            metadata,
            reasoning_summary_policy.as_deref(),
        )
    }

    pub fn from_successful_attempt_with_business_context(
        view: &ResponseProjectionView,
        metadata: Option<Value>,
        reasoning_summary_policy: Option<&str>,
    ) -> Result<Self, V3AnthropicCodecError> {
        if metadata.as_ref().is_some_and(|value| !value.is_object()) {
            return Err(V3AnthropicCodecError::MalformedField { field: "metadata" });
        }
        let reasoning_summary_policy = reasoning_summary_policy
            .map(valid_responses_reasoning_summary_policy_text)
            .transpose()?
            .map(str::to_string);
        let inverse = view.request_inverse_context();
        let mut successful_attempt_tool_identities = BTreeMap::new();

        for mapping in &view.attempt().declarations.tool_mappings {
            // This map is keyed by the emitted declaration name, so it indexes
            // only nameable declarations. A hosted/builtin declaration (a
            // Responses `tool_search` or `web_search`, a Gemini `googleSearch`)
            // is emitted without a function name and can never be named by a
            // provider tool call; it stays in the attempt declaration map for
            // its own consumers.
            let Some(emitted_name) = mapping.emitted_name.as_deref() else {
                continue;
            };
            let declaration = inverse
                .tool_declarations
                .iter()
                .find(|declaration| declaration.record_id == mapping.declaration_record_id)
                .ok_or(V3AnthropicCodecError::MalformedField {
                    field: "attempt_declaration.declaration_record_id",
                })?;
            successful_attempt_tool_identities.insert(
                emitted_name.to_string(),
                (
                    declaration.kind.clone(),
                    declaration.name.clone(),
                    declaration.namespace.clone(),
                ),
            );
        }

        Ok(Self {
            metadata,
            custom_tool_names: BTreeMap::new(),
            namespaced_custom_tool_identities: BTreeMap::new(),
            mcp_tool_identities: HashMap::new(),
            successful_attempt_tool_identities,
            reasoning_summary_policy,
        })
    }

    pub fn from_chat_canonical_request(request: &Value) -> Result<Self, V3AnthropicCodecError> {
        let (metadata, reasoning_summary_policy) = chat_canonical_business_context(request)?;
        let mut mcp_tool_identities =
            super::super::request_outbound_mcp_names::responses_mcp_dispatch_identities(request)
                .map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools" })?;
        let (anthropic_client_names, _) =
            super::namespace_tool_names::anthropic_declared_tool_names(request);
        for (client_path, provider_name) in anthropic_client_names {
            if let Some((namespace, name)) = client_path.rsplit_once('.') {
                mcp_tool_identities
                    .insert(provider_name, (namespace.to_string(), name.to_string()));
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
            metadata,
            custom_tool_names,
            namespaced_custom_tool_identities,
            mcp_tool_identities,
            successful_attempt_tool_identities: BTreeMap::new(),
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

    pub(crate) fn successful_attempt_tool_identity(
        &self,
        name: &str,
    ) -> Option<(&str, Option<&str>, Option<&Value>)> {
        self.successful_attempt_tool_identities
            .get(name)
            .map(|(kind, name, namespace)| (kind.as_str(), name.as_deref(), namespace.as_ref()))
    }

    pub(super) fn metadata(&self) -> Option<&Value> {
        self.metadata.as_ref()
    }

    pub(super) fn reasoning_summary_policy(&self) -> Option<&str> {
        self.reasoning_summary_policy.as_deref()
    }
}

fn chat_canonical_business_context(
    request: &Value,
) -> Result<(Option<Value>, Option<String>), V3AnthropicCodecError> {
    let metadata = request.get("metadata").cloned();
    if metadata.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(V3AnthropicCodecError::MalformedField { field: "metadata" });
    }
    let reasoning_summary_policy = request
        .get("reasoning_summary_policy")
        .map(valid_responses_reasoning_summary_policy)
        .transpose()?
        .map(str::to_string);
    Ok((metadata, reasoning_summary_policy))
}

fn valid_responses_reasoning_summary_policy(value: &Value) -> Result<&str, V3AnthropicCodecError> {
    value
        .as_str()
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning_summary_policy",
        })
        .and_then(valid_responses_reasoning_summary_policy_text)
}

fn valid_responses_reasoning_summary_policy_text(
    policy: &str,
) -> Result<&str, V3AnthropicCodecError> {
    matches!(policy, "auto" | "concise" | "detailed")
        .then_some(policy)
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
