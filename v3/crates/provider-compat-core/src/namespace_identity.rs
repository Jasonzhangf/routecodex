//! Request-local namespace tool identity: the single source that keeps forward
//! provider-wire flattening and the response inverse from diverging.
//!
//! Every declaration channel (`tools`, `additional_tools`, and discovered
//! `tool_search_output` tools) is merged through
//! [`NamespaceToolIdentityRegistry::merge_tools`]. The original namespace
//! hierarchy, leaf name, function/custom kind, source, and emitted wire name are
//! stored together, so the inverse never reconstructs identity by splitting a
//! flattened provider name.

use crate::namespace_tools::{openai_chat_namespace_wire_name, provider_function_tool_name};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Fixed wire name of the standard Responses native tool-discovery declaration.
///
/// It is protocol data only. A request that actually declares this native tool
/// lets a same-request provider call regain the declared native kind; the
/// spelling alone never authorizes an undeclared or ordinary call.
pub const NATIVE_TOOL_SEARCH_WIRE_NAME: &str = "tool_search";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ToolKind {
    Function,
    Custom,
}

type IdentityKey = (Vec<String>, String, ToolKind);

/// A declared tool identity preserved from the originating request.
///
/// The namespace path is stored as its original components. It is never
/// reconstructed by splitting a flattened provider name, so a plain flat
/// declaration cannot silently become a namespace identity.
#[derive(Debug, Clone, PartialEq)]
pub struct NamespaceToolIdentity {
    /// Original nested namespace path. The first component is the outer
    /// declaration name and later components preserve their own spelling.
    /// Empty for a plain flat declaration.
    pub namespace_segments: Vec<String>,
    pub leaf_name: String,
    pub kind: ToolKind,
    pub source: Value,
    /// The exact name emitted to the target provider wire.
    pub actual_wire_name: String,
}

impl NamespaceToolIdentity {
    pub fn client_namespace(&self) -> String {
        self.namespace_segments.join(".")
    }

    pub fn is_namespaced(&self) -> bool {
        !self.namespace_segments.is_empty()
    }

    pub fn client_path(&self) -> String {
        if self.namespace_segments.is_empty() {
            self.leaf_name.clone()
        } else {
            format!("{}.{}", self.client_namespace(), self.leaf_name)
        }
    }
}

/// The single request-local source of namespace tool identity.
///
/// Every current declaration source (`tools`, `additional_tools`, and
/// discovered `tool_search_output` tools) is merged through [`Self::merge_tools`]
/// so forward flattening and the response inverse never diverge. Plain tools
/// reserve their original addresses. A renamed plain tool gets a name-only
/// inverse; only an explicit namespace declaration can restore a namespace.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NamespaceToolIdentityRegistry {
    /// `(original namespace components, leaf, kind)` -> declared identity.
    /// A function and a custom declaration may share one client path; they stay
    /// distinct entries instead of overwriting each other.
    by_identity: BTreeMap<IdentityKey, NamespaceToolIdentity>,
    declaration_order: Vec<IdentityKey>,
    /// Actual wire name -> exact identity keys. Before binding, a collision
    /// remains non-restorable. Binding assigns unique names to the whole set.
    namespaced_wire_paths: BTreeMap<String, BTreeSet<IdentityKey>>,
    /// Every current plain tool name and namespace wire name. Alias
    /// allocation must reserve these names before assigning generated names.
    declared_wire_names: BTreeSet<String>,
    /// Whether the current declaration grants the client executor for the
    /// standard native `tool_search` discovery tool. Declaration presence alone
    /// never grants it: the current official default is server-hosted, and an
    /// omitted `execution` field follows that same default. Only the explicit
    /// client declaration authorizes client-native restoration.
    client_executed_native_tool_search: bool,
}

impl NamespaceToolIdentityRegistry {
    pub fn from_tools(tools: &[Value]) -> Result<Self, String> {
        let mut registry = Self::default();
        registry.merge_tools(tools)?;
        Ok(registry)
    }

    /// Merge one declaration source into the request-local registry.
    pub fn merge_tools(&mut self, tools: &[Value]) -> Result<(), String> {
        let mut source = Self::default();
        for tool in tools {
            source.collect_declaration(tool)?;
        }
        self.client_executed_native_tool_search |= source.client_executed_native_tool_search;
        for key in source.declaration_order {
            if !self.by_identity.contains_key(&key) {
                self.declaration_order.push(key.clone());
            }
            self.by_identity
                .insert(key.clone(), source.by_identity.remove(&key).unwrap());
        }
        self.reindex();
        Ok(())
    }

    fn reindex(&mut self) {
        self.namespaced_wire_paths.clear();
        self.declared_wire_names.clear();
        for (key, identity) in &self.by_identity {
            self.namespaced_wire_paths
                .entry(identity.actual_wire_name.clone())
                .or_default()
                .insert(key.clone());
            self.declared_wire_names
                .insert(identity.actual_wire_name.clone());
        }
    }

    pub fn from_request(request: &Value, protocol: &str) -> Result<Self, String> {
        let mut registry = Self::default();
        if let Some(tools) = request.get("tools").and_then(Value::as_array) {
            registry.merge_tools(tools)?;
        }
        for item in request
            .get("input")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if matches!(
                item.get("type").and_then(Value::as_str),
                Some("additional_tools" | "tool_search_output")
            ) {
                if let Some(tools) = item.get("tools").and_then(Value::as_array) {
                    registry.merge_tools(tools)?;
                }
            }
        }
        for message in request
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if message
                .pointer("/routecodex_chat_extension/responses_tool_output_type")
                .and_then(Value::as_str)
                == Some("tool_search_output")
            {
                let tools = match message.get("content") {
                    Some(Value::String(text)) => {
                        serde_json::from_str::<Value>(text).map_err(|error| error.to_string())?
                    }
                    Some(value) => value.clone(),
                    None => continue,
                };
                if let Some(tools) = tools.as_array() {
                    registry.merge_tools(tools)?;
                }
            }
        }
        registry.bind_wire_names(protocol);
        Ok(registry)
    }

    /// Project declarations using the already assigned names. Namespace
    /// recursion and identity collection have only one owner.
    pub fn project_tools(&self, protocol: &str, tools: &[Value]) -> Result<Vec<Value>, String> {
        let mut result: Vec<_> = tools
            .iter()
            .filter(|tool| {
                !matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("namespace" | "function" | "custom")
                )
            })
            .cloned()
            .collect();
        for identity in self.identities() {
            let mut tool = if identity.is_namespaced() {
                let declaration = serde_json::json!({"type":"namespace","name":"projection","tools":[identity.source.clone()]});
                crate::namespace_tools::flatten_namespace_tool_for_provider(protocol, &declaration)?
                    .unwrap()
                    .remove(0)
            } else {
                identity.source.clone()
            };
            set_wire_name(&mut tool, &identity.actual_wire_name);
            result.push(tool);
        }
        Ok(result)
    }

    pub fn project_references(&self, body: &mut Value) {
        fn rewrite(registry: &NamespaceToolIdentityRegistry, value: &mut Value) {
            let kind = if matches!(
                value.get("type").and_then(Value::as_str),
                Some("custom" | "custom_tool_call")
            ) || value
                .pointer("/routecodex_chat_extension/responses_tool_call_type")
                .and_then(Value::as_str)
                == Some("custom_tool_call")
            {
                ToolKind::Custom
            } else {
                ToolKind::Function
            };
            let Some(name) = value
                .get("name")
                .or_else(|| value.pointer("/function/name"))
                .and_then(Value::as_str)
            else {
                return;
            };
            let namespace = value.get("namespace").and_then(Value::as_str);
            let wire = registry
                .wire_name_for_client(namespace, name, kind)
                .or_else(|| {
                    // Chat's registered custom wrapper is a function call on the
                    // wire. Only a unique declaration supplies the source kind.
                    let mut matches = registry.identities().filter(|identity| match namespace {
                        Some(namespace) => {
                            identity.client_namespace() == namespace && identity.leaf_name == name
                        }
                        None => identity.client_path() == name,
                    });
                    let identity = matches.next()?;
                    matches
                        .next()
                        .is_none()
                        .then_some(identity.actual_wire_name.as_str())
                })
                .map(str::to_owned);
            let Some(wire) = wire else { return };
            set_wire_name(value, &wire);
            if let Some(object) = value.as_object_mut() {
                object.remove("namespace");
            }
        }
        if let Some(choice) = body.get_mut("tool_choice") {
            rewrite(self, choice);
        }
        for item in body
            .get_mut("input")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call" | "tool_call")
            ) {
                rewrite(self, item);
            }
        }
        for message in body
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
                rewrite(self, call);
            }
        }
        for name in body
            .pointer_mut("/toolConfig/functionCallingConfig/allowedFunctionNames")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(identity) = name
                .as_str()
                .and_then(|name| self.identity_for_client_path(name))
            {
                *name = Value::String(identity.actual_wire_name.clone());
            }
        }
    }

    /// Apply standard declaration and reference projection before private compat.
    pub fn project_request(&self, body: &mut Value, protocol: &str) -> Result<(), String> {
        if let Some(tools) = body.get("tools").and_then(Value::as_array) {
            body["tools"] = Value::Array(self.project_tools(protocol, tools)?);
        }
        self.project_references(body);
        Ok(())
    }

    pub fn identities(&self) -> impl Iterator<Item = &NamespaceToolIdentity> {
        self.declaration_order
            .iter()
            .filter_map(|key| self.by_identity.get(key))
    }

    pub fn source_tools(&self, tools: &[Value]) -> Vec<Value> {
        let mut result: Vec<_> = tools
            .iter()
            .filter(|tool| {
                !matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("namespace" | "function" | "custom")
                )
            })
            .cloned()
            .collect();
        for identity in self.identities() {
            let mut tool = identity.source.clone();
            for namespace in identity.namespace_segments.iter().rev() {
                tool = serde_json::json!({"type":"namespace","name":namespace,"tools":[tool]});
            }
            result.push(tool);
        }
        result
    }

    pub fn identity_for_client_path(&self, client_path: &str) -> Option<&NamespaceToolIdentity> {
        let mut found = self
            .identities()
            .filter(|identity| identity.client_path() == client_path);
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    /// Bind the whole declaration set before any target name is emitted.
    /// Plain names reserve their addresses. Colliding namespace identities get
    /// unique names; every projection uses this same deterministic binding.
    pub fn bind_wire_names(&mut self, protocol: &str) {
        // Target name domain: OpenAI Chat hashes to 64 characters; Anthropic
        // rejects dotted names and allows at most 128 characters.
        let limit = match protocol {
            "openai-chat" => 64,
            "anthropic" => 128,
            _ => usize::MAX,
        };
        let candidate = |identity: &NamespaceToolIdentity| {
            let name = if identity.is_namespaced() {
                namespace_wire_name(&identity.namespace_segments, &identity.leaf_name)
            } else {
                identity.leaf_name.clone()
            };
            if protocol == "openai-chat" {
                openai_chat_namespace_wire_name(&name)
            } else if protocol == "anthropic" {
                truncate_wire_name(&anthropic_wire_name(&name), limit)
            } else {
                name
            }
        };
        let mut used: BTreeSet<String> = self.identities().map(candidate).collect();
        let mut assigned = BTreeSet::new();
        // Give unmodified plain declarations priority over generated names.
        let mut keys: Vec<_> = self.by_identity.keys().cloned().collect();
        keys.sort_by_key(|key| (!key.0.is_empty(), key.clone()));
        for key in keys {
            let identity = self.by_identity.get_mut(&key).unwrap();
            let base = candidate(identity);
            let name = if assigned.insert(base.clone()) {
                base
            } else {
                let head = match protocol {
                    "openai-chat" => openai_chat_namespace_wire_name(&base),
                    "anthropic" => truncate_wire_name(&anthropic_wire_name(&base), limit),
                    _ => base.clone(),
                };
                let mut index = 1;
                loop {
                    let suffix = format!("_{index}");
                    let prefix: String = head
                        .chars()
                        .take(limit.saturating_sub(suffix.len()))
                        .collect();
                    let name = format!("{prefix}{suffix}");
                    if used.insert(name.clone()) {
                        assigned.insert(name.clone());
                        break name;
                    }
                    index += 1;
                }
            };
            identity.actual_wire_name = name;
        }
        self.namespaced_wire_paths.clear();
        self.declared_wire_names.clear();
        for (key, identity) in &self.by_identity {
            self.namespaced_wire_paths
                .entry(identity.actual_wire_name.clone())
                .or_default()
                .insert(key.clone());
            self.declared_wire_names
                .insert(identity.actual_wire_name.clone());
        }
    }

    pub fn wire_name_for_client(
        &self,
        namespace: Option<&str>,
        name: &str,
        kind: ToolKind,
    ) -> Option<&str> {
        let mut found = self.identities().filter(|identity| {
            identity.kind == kind
                && match namespace {
                    Some(namespace) => {
                        identity.client_namespace() == namespace && identity.leaf_name == name
                    }
                    None => identity.client_path() == name,
                }
        });
        let first = found.next()?;
        found
            .next()
            .is_none()
            .then_some(first.actual_wire_name.as_str())
    }

    /// Resolve the unique namespace identity emitted for a provider wire name.
    /// Returns `None` for a plain flat name, an undeclared name, or a genuine
    /// collision where two distinct namespace identities share one wire name.
    pub fn identity_for_wire_name(&self, actual_wire_name: &str) -> Option<&NamespaceToolIdentity> {
        let identities = self.namespaced_wire_paths.get(actual_wire_name)?;
        if identities.len() != 1 {
            return None;
        }
        identities
            .iter()
            .next()
            .and_then(|key| self.by_identity.get(key))
            .filter(|identity| {
                identity.is_namespaced() || identity.actual_wire_name != identity.leaf_name
            })
    }

    pub fn is_ambiguous_wire_name(&self, actual_wire_name: &str) -> bool {
        self.namespaced_wire_paths
            .get(actual_wire_name)
            .is_some_and(|paths| paths.len() > 1)
    }

    pub fn declared_wire_names(&self) -> &BTreeSet<String> {
        &self.declared_wire_names
    }

    /// The single owner of "a declared native discovery tool regains its kind".
    ///
    /// True only when the current request actually declares the standard
    /// native `tool_search` tool and no ordinary function/custom declaration
    /// claims the same provider name. Ordinary and custom precedence therefore
    /// keeps its own kind, and a call that is not declared never gains the
    /// native kind from its name alone.
    ///
    /// The declaration must also grant client execution. An explicit
    /// `execution = "server"` declaration, and a declaration that omits the
    /// field, stay with their own ordinary projection: they never gain
    /// client-native authority from being named `tool_search`.
    pub fn declares_native_tool_search(&self) -> bool {
        self.client_executed_native_tool_search
            && !self.identities().any(|identity| {
                matches!(identity.kind, ToolKind::Function | ToolKind::Custom)
                    && identity.actual_wire_name == NATIVE_TOOL_SEARCH_WIRE_NAME
            })
    }

    /// The request-local inverse map consumed by every response projection
    /// owner: provider wire name -> `(client namespace, leaf name)`. Ambiguous
    /// wire names and plain flat declarations are omitted, so an undeclared or
    /// colliding call is forwarded verbatim instead of being guessed.
    pub fn restore_identities(&self) -> HashMap<String, (String, String)> {
        let mut identities = HashMap::new();
        for (wire_name, keys) in &self.namespaced_wire_paths {
            if keys.len() != 1 {
                continue;
            }
            let Some(identity) = keys.iter().next().and_then(|key| self.by_identity.get(key))
            else {
                continue;
            };
            if !identity.is_namespaced() && identity.actual_wire_name == identity.leaf_name {
                continue;
            }
            identities.insert(
                wire_name.clone(),
                (identity.client_namespace(), identity.leaf_name.clone()),
            );
        }
        identities
    }

    fn collect_declaration(&mut self, tool: &Value) -> Result<(), String> {
        let Some(object) = tool.as_object() else {
            return Ok(());
        };
        match object.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                let Some(name) = object
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                else {
                    return Ok(());
                };
                let Some(children) = object.get("tools").and_then(Value::as_array) else {
                    return Ok(());
                };
                let mut namespace_segments = Vec::new();
                self.collect_namespace(
                    name,
                    &mut namespace_segments,
                    children,
                    &format!("provider namespace tool {name}"),
                )?;
            }
            Some("tool_search") => {
                // The standard native discovery declaration is protocol data.
                // The response inverse restores client-native execution only
                // when the current declaration grants that executor.
                self.client_executed_native_tool_search |=
                    object.get("execution").and_then(Value::as_str) == Some("client");
            }
            Some(kind @ ("function" | "custom")) => {
                let Some(name) = provider_function_tool_name(tool) else {
                    return Ok(());
                };
                let kind = if kind == "function" {
                    ToolKind::Function
                } else {
                    ToolKind::Custom
                };
                let provider_name = name.to_string();
                // A plain flat declaration keeps its raw identity; no dotted
                // string is split back into a namespace.
                self.insert_identity(NamespaceToolIdentity {
                    namespace_segments: Vec::new(),
                    leaf_name: name.to_string(),
                    kind,
                    source: tool.clone(),
                    actual_wire_name: provider_name,
                })?;
            }
            _ => {}
        }
        Ok(())
    }

    fn collect_namespace(
        &mut self,
        namespace_name: &str,
        namespace_segments: &mut Vec<String>,
        children: &[Value],
        path: &str,
    ) -> Result<(), String> {
        namespace_segments.push(namespace_name.to_string());
        for (index, child) in children.iter().enumerate() {
            let Some(object) = child.as_object() else {
                continue;
            };
            let child_path = format!("{path}.tools[{index}]");
            match object.get("type").and_then(Value::as_str) {
                Some("namespace") => {
                    let Some(name) = object
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                    else {
                        continue;
                    };
                    let Some(nested) = object.get("tools").and_then(Value::as_array) else {
                        continue;
                    };
                    self.collect_namespace(name, namespace_segments, nested, &child_path)?;
                }
                Some(kind @ ("function" | "custom")) => {
                    let Some(leaf_name) = object
                        .get("name")
                        .or_else(|| {
                            object
                                .get("function")
                                .and_then(Value::as_object)
                                .and_then(|function| function.get("name"))
                        })
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                    else {
                        continue;
                    };
                    let kind = if kind == "function" {
                        ToolKind::Function
                    } else {
                        ToolKind::Custom
                    };
                    let actual_wire_name = namespace_wire_name(namespace_segments, leaf_name);
                    self.insert_identity(NamespaceToolIdentity {
                        namespace_segments: namespace_segments.clone(),
                        leaf_name: leaf_name.to_string(),
                        kind,
                        source: child.clone(),
                        actual_wire_name,
                    })?;
                }
                _ => {}
            }
        }
        namespace_segments.pop();
        Ok(())
    }

    fn insert_identity(&mut self, identity: NamespaceToolIdentity) -> Result<(), String> {
        let client_path = identity.client_path();
        let key = (
            identity.namespace_segments.clone(),
            identity.leaf_name.clone(),
            identity.kind,
        );
        if let Some(existing) = self.by_identity.get(&key) {
            if canonical_source(&existing.source) != canonical_source(&identity.source) {
                return Err(format!(
                    "ConflictingOutboundFields client tool `{client_path}` wire `{}` has conflicting schemas within the same declaration source",
                    identity.actual_wire_name
                ));
            }
            // The same identity may refresh its schema in a later source.
            self.declared_wire_names
                .insert(identity.actual_wire_name.clone());
            self.by_identity.insert(key, identity);
            return Ok(());
        }
        self.declared_wire_names
            .insert(identity.actual_wire_name.clone());
        self.namespaced_wire_paths
            .entry(identity.actual_wire_name.clone())
            .or_default()
            .insert(key.clone());
        self.declaration_order.push(key.clone());
        self.by_identity.insert(key, identity);
        Ok(())
    }
}

fn canonical_source(tool: &Value) -> Value {
    let mut source = tool.clone();
    if tool.get("type").and_then(Value::as_str) == Some("function") {
        if let Some(function) = tool.get("function").and_then(Value::as_object) {
            let object = source.as_object_mut().unwrap();
            object.remove("function");
            object.extend(function.clone());
        }
    }
    source
}

fn set_wire_name(tool: &mut Value, name: &str) {
    if let Some(object) = tool.as_object_mut() {
        if object.contains_key("name") {
            object.insert("name".into(), Value::String(name.into()));
        }
        if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
            function.insert("name".into(), Value::String(name.into()));
        }
    }
}

fn namespace_wire_name(namespace_segments: &[String], leaf_name: &str) -> String {
    let qualified_namespace = namespace_segments.join("__");
    format!("{qualified_namespace}__{leaf_name}")
}

/// Anthropic tool names reject dots; the protected underscore form keeps the
/// original client path visually readable and stays inside the provider
/// name domain whenever the source name is otherwise legal.
fn anthropic_wire_name(name: &str) -> String {
    name.replace('.', "__")
}

fn truncate_wire_name(name: &str, limit: usize) -> String {
    name.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_preserves_original_namespace_hierarchy_and_leaf_without_reparsing() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"namespace",
            "name":"mcp__mcpx",
            "tools":[{
                "type":"namespace",
                "name":"workspace",
                "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]
            }]
        })])
        .unwrap();

        let identity = registry
            .identity_for_wire_name("mcp__mcpx__workspace__read")
            .expect("nested wire name must resolve to one identity");
        assert_eq!(
            identity.namespace_segments,
            vec!["mcp__mcpx".to_string(), "workspace".to_string()]
        );
        assert_eq!(identity.leaf_name, "read");
        assert_eq!(identity.kind, ToolKind::Function);
        assert_eq!(identity.actual_wire_name, "mcp__mcpx__workspace__read");
        assert_eq!(identity.client_path(), "mcp__mcpx.workspace.read");
    }

    #[test]
    fn registry_keeps_leading_underscore_leaf_verbatim() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"namespace",
            "name":"mcp__codex_apps__gmail",
            "tools":[{
                "type":"function",
                "name":"_archive_emails",
                "parameters":{"type":"object"}
            }]
        })])
        .unwrap();

        let identity = registry
            .identity_for_wire_name("mcp__codex_apps__gmail___archive_emails")
            .expect("triple-underscore wire name must resolve from the original identity");
        assert_eq!(identity.namespace_segments, vec!["mcp__codex_apps__gmail"]);
        assert_eq!(identity.leaf_name, "_archive_emails");
        assert_eq!(
            identity.actual_wire_name,
            "mcp__codex_apps__gmail___archive_emails"
        );
    }

    #[test]
    fn registry_marks_distinct_wire_name_collisions_ambiguous_instead_of_last_write_winning() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[
            json!({"type":"namespace","name":"mcp__a","tools":[
                {"type":"function","name":"b__c","parameters":{"type":"object"}}
            ]}),
            json!({"type":"namespace","name":"mcp__a__b","tools":[
                {"type":"function","name":"c","parameters":{"type":"object"}}
            ]}),
        ])
        .unwrap();

        assert!(registry.is_ambiguous_wire_name("mcp__a__b__c"));
        assert!(registry.identity_for_wire_name("mcp__a__b__c").is_none());
        assert!(!registry.restore_identities().contains_key("mcp__a__b__c"));
        assert_eq!(
            registry
                .identity_for_client_path("mcp__a.b__c")
                .unwrap()
                .leaf_name,
            "b__c"
        );
        assert_eq!(
            registry
                .identity_for_client_path("mcp__a__b.c")
                .unwrap()
                .leaf_name,
            "c"
        );
    }

    #[test]
    fn registry_keeps_function_and_custom_with_the_same_client_path_distinct() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"namespace","name":"functions","tools":[
                {"type":"function","name":"exec","parameters":{"type":"object"}},
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]
        })])
        .expect("function and custom identities must both be collected");

        // Both kinds stay queryable under one client path; the shared wire name
        // is a real collision, so it never becomes a guessed inverse.
        let mut kinds: Vec<ToolKind> = registry
            .identities()
            .filter(|identity| identity.client_path() == "functions.exec")
            .map(|identity| identity.kind)
            .collect();
        kinds.sort();
        assert_eq!(kinds, vec![ToolKind::Function, ToolKind::Custom]);
        assert!(registry.is_ambiguous_wire_name("functions__exec"));
        assert!(registry.identity_for_wire_name("functions__exec").is_none());
        assert!(!registry
            .restore_identities()
            .contains_key("functions__exec"));
    }

    #[test]
    fn registry_does_not_infer_namespace_from_a_flat_mcp_declaration() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"function",
            "name":"mcp__codex_app__list_threads",
            "parameters":{"type":"object"}
        })])
        .unwrap();

        // The flat name is reserved for alias allocation, but it must never
        // become an inverse namespace identity.
        assert!(registry
            .declared_wire_names()
            .contains("mcp__codex_app__list_threads"));
        assert!(registry
            .identity_for_wire_name("mcp__codex_app__list_threads")
            .is_none());
        assert!(registry.restore_identities().is_empty());
    }

    #[test]
    fn registry_restore_identities_are_request_local_and_unique() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"namespace","name":"mcp__codex_app","tools":[
                {"type":"function","name":"list_threads","parameters":{"type":"object"}}
            ]
        })])
        .unwrap();

        let identities = registry.restore_identities();
        assert_eq!(
            identities.get("mcp__codex_app__list_threads"),
            Some(&("mcp__codex_app".to_string(), "list_threads".to_string()))
        );
        // An unrelated flat declaration in a different request cannot leak in.
        let other = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"function","name":"mcp__codex_app__list_threads","parameters":{"type":"object"}
        })])
        .unwrap();
        assert!(other.restore_identities().is_empty());
    }

    #[test]
    fn native_tool_search_declaration_is_request_local_and_kind_bearing() {
        let declared = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"tool_search",
            "execution":"client",
            "parameters":{"type":"object","properties":{"query":{"type":"string"}}}
        })])
        .unwrap();
        assert!(declared.declares_native_tool_search());

        // The declaration is request-local: another request without it cannot
        // promote a same-named call.
        let other = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"function",
            "name":"local_note",
            "parameters":{"type":"object"}
        })])
        .unwrap();
        assert!(!other.declares_native_tool_search());
    }

    #[test]
    fn native_tool_search_declaration_is_collected_from_every_source() {
        let additional = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[{"type":"function","name":"local_note","parameters":{"type":"object"}}],
                "input":[{"type":"additional_tools","tools":[{"type":"tool_search","execution":"client"}]}]
            }),
            "anthropic",
        )
        .unwrap();
        assert!(additional.declares_native_tool_search());

        let discovered = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[{"type":"function","name":"local_note","parameters":{"type":"object"}}],
                "input":[{"type":"tool_search_output","call_id":"call_search","tools":[{"type":"tool_search","execution":"client"}]}]
            }),
            "anthropic",
        )
        .unwrap();
        assert!(discovered.declares_native_tool_search());
    }

    #[test]
    fn only_a_client_executed_tool_search_declaration_grants_client_native_authority() {
        let client = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"tool_search",
            "execution":"client",
            "parameters":{"type":"object"}
        })])
        .unwrap();
        assert!(client.declares_native_tool_search());

        // Server execution is a real legal declaration, and it must not gain
        // client-native authority from its name.
        let server = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"tool_search",
            "execution":"server",
            "parameters":{"type":"object"}
        })])
        .unwrap();
        assert!(!server.declares_native_tool_search());

        // The current official default is server-hosted, so an omitted
        // execution field must not grant client-native authority either.
        let omitted = NamespaceToolIdentityRegistry::from_tools(&[json!({
            "type":"tool_search",
            "parameters":{"type":"object"}
        })])
        .unwrap();
        assert!(!omitted.declares_native_tool_search());
    }

    #[test]
    fn merged_declaration_sources_keep_native_authority_request_local() {
        // A client-executed declaration in a later source still grants the
        // shared inverse, while an earlier server declaration does not leak.
        let merged = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[{"type":"function","name":"local_note","parameters":{"type":"object"}}],
                "input":[{"type":"additional_tools","tools":[{"type":"tool_search","execution":"server"}]}]
            }),
            "anthropic",
        )
        .unwrap();
        assert!(!merged.declares_native_tool_search());

        let registry = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[{"type":"function","name":"local_note","parameters":{"type":"object"}}],
                "input":[
                    {"type":"additional_tools","tools":[{"type":"tool_search","execution":"server"}]},
                    {"type":"tool_search_output","call_id":"call_search","tools":[{"type":"tool_search","execution":"client"}]}
                ]
            }),
            "anthropic",
        )
        .unwrap();
        assert!(registry.declares_native_tool_search());

        // One source reporting both shapes must not make the server
        // declaration eligible.
        let both = NamespaceToolIdentityRegistry::from_tools(&[
            json!({"type":"tool_search","execution":"server"}),
            json!({"type":"tool_search","execution":"client"}),
        ])
        .unwrap();
        assert!(both.declares_native_tool_search());
    }

    #[test]
    fn ordinary_function_named_tool_search_keeps_its_kind_over_native_declaration() {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[
            json!({"type":"tool_search","execution":"client"}),
            json!({"type":"function","name":"tool_search","parameters":{"type":"object"}}),
        ])
        .unwrap();
        assert!(
            !registry.declares_native_tool_search(),
            "an ordinary declaration that claims the native name keeps its own kind"
        );
    }

    #[test]
    fn native_tool_search_declaration_projects_unchanged_and_once() {
        let tool = json!({
            "type":"tool_search",
            "execution":"client",
            "parameters":{"type":"object","properties":{"query":{"type":"string"}}}
        });
        let tools = vec![
            tool.clone(),
            json!({"type":"function","name":"local_note","parameters":{"type":"object"}}),
        ];
        let registry = NamespaceToolIdentityRegistry::from_tools(&tools).unwrap();
        let projected = registry.project_tools("openai-responses", &tools).unwrap();
        let native: Vec<_> = projected
            .iter()
            .filter(|candidate| candidate["type"] == "tool_search")
            .collect();
        assert_eq!(
            native.len(),
            1,
            "native declaration must project exactly once"
        );
        assert_eq!(
            native[0], &tool,
            "native declaration must project unchanged"
        );
        let sourced = registry.source_tools(&tools);
        assert_eq!(
            sourced
                .iter()
                .filter(|candidate| candidate["type"] == "tool_search")
                .count(),
            1
        );
    }

    #[test]
    fn bug4beffbf_anthropic_dotted_flat_custom_is_rewritten_and_restored() {
        let registry = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[{"type":"custom","name":"functions.exec","format":{"type":"text"}}],
                "input":[
                    {"type":"message","role":"user","content":"calculate"},
                    {"type":"custom_tool_call","call_id":"call_dotted","name":"functions.exec","input":"1+1"},
                    {"type":"custom_tool_call_output","call_id":"call_dotted","output":"2"}
                ]
            }),
            "anthropic",
        )
        .unwrap();
        let identity = registry.identities().next().unwrap();
        assert_eq!(identity.actual_wire_name, "functions__exec");
        assert_eq!(identity.client_path(), "functions.exec");
        assert_eq!(
            registry.restore_identities().get("functions__exec"),
            Some(&("".to_string(), "functions.exec".to_string()))
        );
        assert_eq!(
            registry.wire_name_for_client(None, "functions.exec", ToolKind::Custom),
            Some("functions__exec")
        );
    }

    #[test]
    fn bug4beffbf_anthropic_flat_collision_gets_deterministic_unique_aliases() {
        let registry = NamespaceToolIdentityRegistry::from_request(
            &json!({
                "tools":[
                    {"type":"custom","name":"functions.exec","format":{"type":"text"}},
                    {"type":"custom","name":"functions__exec","format":{"type":"text"}}
                ]
            }),
            "anthropic",
        )
        .unwrap();
        let names: Vec<_> = registry
            .identities()
            .map(|identity| identity.actual_wire_name.clone())
            .collect();
        assert_eq!(
            names,
            vec!["functions__exec".to_string(), "functions__exec_1".to_string()],
            "declaration order must choose the unchanged candidate first, then a deterministic suffix"
        );
        assert_eq!(registry.restore_identities().len(), 2);
    }

    #[test]
    fn bug4beffbf_anthropic_long_shared_prefix_stays_under_provider_limit() {
        let long_name = format!("{}{}", "shared.prefix.", "x".repeat(60));
        let underscore_twin = format!("{}{}", "shared__prefix__", "x".repeat(60));
        let registry = NamespaceToolIdentityRegistry::from_request(
            &json!({"tools":[
                {"type":"custom","name":long_name,"format":{"type":"text"}},
                {"type":"custom","name":underscore_twin,"format":{"type":"text"}}
            ]}),
            "anthropic",
        )
        .unwrap();
        let names: Vec<_> = registry
            .identities()
            .map(|identity| identity.actual_wire_name.clone())
            .collect();
        assert!(names.iter().all(|name| name.chars().count() <= 128));
        assert_eq!(
            names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            2,
            "long shared-prefix tools must stay distinct"
        );
        assert!(names.iter().any(|name| name.contains("shared__prefix__")));
        assert!(names.iter().any(|name| name.ends_with("_1")));
    }

    #[test]
    fn bug4beffbf_anthropic_repeated_binding_is_deterministic() {
        let tools = [
            json!({"type":"custom","name":"functions.exec","format":{"type":"text"}}),
            json!({"type":"custom","name":"functions__exec","format":{"type":"text"}}),
        ];
        let first = NamespaceToolIdentityRegistry::from_tools(&tools).unwrap();
        let mut first = first;
        first.bind_wire_names("anthropic");
        let second = NamespaceToolIdentityRegistry::from_tools(&tools).unwrap();
        let mut second = second;
        second.bind_wire_names("anthropic");
        assert_eq!(
            first
                .identities()
                .map(|identity| identity.actual_wire_name.clone())
                .collect::<Vec<_>>(),
            second
                .identities()
                .map(|identity| identity.actual_wire_name.clone())
                .collect::<Vec<_>>()
        );
    }
}
