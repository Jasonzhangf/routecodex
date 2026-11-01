use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use super::V3AnthropicCodecError;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct V3AnthropicResponsesProjectionContext {
    metadata: Option<Value>,
    custom_tool_names: BTreeMap<String, String>,
    namespaced_custom_tool_identities: BTreeMap<String, (String, String)>,
    mcp_tool_identities: HashMap<String, (String, String)>,
    /// Whether the current request actually declares the standard native
    /// `tool_search` discovery tool. It comes from the same request-local
    /// namespace registry that owns namespace identity, so the inverse restores
    /// the native kind from the declaration and never from a provider name.
    native_tool_search: bool,
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
        let registry =
            provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
                request,
                "anthropic",
            )
            .map_err(|_| V3AnthropicCodecError::MalformedField { field: "tools" })?;
        let native_tool_search = registry.declares_native_tool_search();
        let mcp_tool_identities = registry.restore_identities();
        let custom_tool_names = registry
            .identities()
            .filter(|identity| {
                identity.kind == provider_compat_core::namespace_tools::ToolKind::Custom
            })
            .map(|identity| (identity.actual_wire_name.clone(), identity.client_path()))
            .collect();
        let namespaced_custom_tool_identities = registry
            .identities()
            .filter(|identity| {
                identity.is_namespaced()
                    && identity.kind == provider_compat_core::namespace_tools::ToolKind::Custom
            })
            .map(|identity| {
                (
                    identity.actual_wire_name.clone(),
                    (identity.client_namespace(), identity.leaf_name.clone()),
                )
            })
            .collect();
        Ok(Self {
            metadata,
            custom_tool_names,
            namespaced_custom_tool_identities,
            mcp_tool_identities,
            native_tool_search,
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

    /// The single owner of "a declared native discovery tool regains its kind"
    /// for the Anthropic inverse. See
    /// [`provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::declares_native_tool_search`].
    pub(crate) fn declares_native_tool_search(&self) -> bool {
        self.native_tool_search
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
