use provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry;
use serde_json::{Map, Value};
use std::collections::HashMap;

pub(super) fn provider_function_name(name: &str) -> String {
    name.to_owned()
}

pub(super) fn rewrite_openai_chat_declared_namespace_history(
    payload: &mut Value,
) -> Result<(), String> {
    let registry = NamespaceToolIdentityRegistry::from_request(payload, "openai-chat")?;
    registry.project_references(payload);
    Ok(())
}

pub(crate) fn responses_mcp_dispatch_identities(
    request: &Value,
) -> Result<HashMap<String, (String, String)>, String> {
    Ok(
        NamespaceToolIdentityRegistry::from_request(request, "openai-responses")?
            .restore_identities(),
    )
}

pub(super) fn normalize_openai_chat_namespace_history_names(
    payload: &mut Value,
) -> Result<(), String> {
    rewrite_openai_chat_declared_namespace_history(payload)
}

/// Target encoding only. All collision bindings are assigned before tools and
/// references are projected; this final adapter only encodes remaining names.
pub(super) fn project_openai_chat_namespace_wire_names(
    wire: &mut Value,
    request: &Value,
) -> Result<(), String> {
    let aliases = openai_chat_namespace_wire_aliases(request)?;
    let rewrite = |value: Option<&mut Value>| {
        if let Some(value) = value {
            if let Some(alias) = value.as_str().and_then(|name| aliases.get(name)) {
                *value = Value::String(alias.clone());
            }
        }
    };
    for tool in wire
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        rewrite(tool.pointer_mut("/function/name"));
        rewrite(tool.get_mut("name"));
    }
    for message in wire
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for call in message
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            rewrite(call.pointer_mut("/function/name"));
        }
    }
    rewrite(wire.pointer_mut("/tool_choice/function/name"));
    rewrite(wire.pointer_mut("/tool_choice/name"));
    Ok(())
}

pub(super) fn openai_chat_namespace_wire_aliases(
    request: &Value,
) -> Result<HashMap<String, String>, String> {
    let responses = NamespaceToolIdentityRegistry::from_request(request, "openai-responses")?;
    let chat = NamespaceToolIdentityRegistry::from_request(request, "openai-chat")?;
    Ok(responses
        .identities()
        .filter_map(|identity| {
            let wire = chat.wire_name_for_client(
                identity
                    .is_namespaced()
                    .then(|| identity.client_namespace())
                    .as_deref(),
                &identity.leaf_name,
                identity.kind,
            )?;
            (identity.actual_wire_name != wire)
                .then(|| (identity.actual_wire_name.clone(), wire.to_owned()))
        })
        .collect())
}

pub(super) fn restore_responses_mcp_namespace(
    object: &mut Map<String, Value>,
    identities: &HashMap<String, (String, String)>,
) -> bool {
    restore_responses_namespace(object, |name| {
        identities
            .get(name)
            .map(|(namespace, leaf)| (namespace.as_str(), leaf.as_str()))
    })
}

fn restore_responses_namespace<'a>(
    object: &mut Map<String, Value>,
    resolve: impl FnOnce(&str) -> Option<(&'a str, &'a str)>,
) -> bool {
    if object
        .get("namespace")
        .is_some_and(|namespace| !namespace.is_null())
    {
        return false;
    }
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some((namespace, leaf)) = resolve(name) else {
        return false;
    };
    if namespace.is_empty() {
        object.remove("namespace");
    } else {
        object.insert("namespace".into(), Value::String(namespace.into()));
    }
    object.insert("name".into(), Value::String(leaf.into()));
    true
}

pub(super) fn restore_responses_mcp_tool_identities(
    response: &mut Value,
    identities: &HashMap<String, (String, String)>,
) {
    for item in response
        .get_mut("output")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        restore_responses_mcp_tool_identity_item(item, identities);
    }
}

pub(super) fn restore_responses_mcp_tool_identity_item(
    item: &mut Value,
    identities: &HashMap<String, (String, String)>,
) {
    if matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "custom_tool_call")
    ) {
        if let Some(object) = item.as_object_mut() {
            restore_responses_mcp_namespace(object, identities);
        }
    }
}

pub(crate) fn restore_v3_responses_namespace_in_value(
    value: &mut Value,
    identities: &provider_compat_core::namespace_identity::NamespaceToolAliases,
) {
    use provider_compat_core::namespace_identity::ToolKind;
    let restore = |item: &mut Value| {
        let kind = match item["type"].as_str() {
            Some("function_call") => ToolKind::Function,
            Some("custom_tool_call") => ToolKind::Custom,
            _ => return,
        };
        if let Some(object) = item.as_object_mut() {
            restore_responses_namespace(object, |name| {
                let alias = identities
                    .get(name)
                    .filter(|alias| alias.kind.is_none_or(|wire_kind| wire_kind == kind))?;
                Some((alias.namespace.as_str(), alias.name.as_str()))
            });
        }
    };
    let response = match value.get("type").and_then(Value::as_str) {
        Some("response.output_item.added" | "response.output_item.done") => {
            if let Some(item) = value.get_mut("item") {
                restore(item);
            }
            return;
        }
        Some("response.completed" | "response.done" | "response.incomplete") => {
            let Some(response) = value.get_mut("response") else {
                return;
            };
            response
        }
        _ => value,
    };
    if let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) {
        output.iter_mut().for_each(restore);
    }
}
