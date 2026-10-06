use serde_json::{Map, Value};

use crate::operation_runner::{
    CurrentFieldAssociations, RequestInverseContext, ToolMappingReference,
};

use provider_compat_core::namespace_tools::{
    flatten_namespace_tool_for_provider_with_sources, namespace_tool_name_map,
    provider_function_tool_name, push_unique_provider_function_tool,
};

use super::request_outbound_format::namespace_child_canonical_path;

/// Optional typed observer threaded through the standard Outbound declaration
/// producer. It records, at the actual emit/replace/filter point, which
/// canonical source tool produced each provider declaration.
///
/// The producer reports the *current* canonical source path it actually emitted
/// from. Identity is resolved by asking the request's current field association
/// slot which original inverse mapping record currently lives at that path, then
/// reading that original record's own `source_path`. The immutable
/// `inverse.field_mappings[].destination` is only the normalization-time
/// address and must never be matched against the post-governance layout.
///
/// It is never matched from emitted names, schemas, models, or a post-hoc
/// re-search of the produced payload, so a shifted, replaced, deduplicated, or
/// promoted declaration cannot drift from its real origin.
pub(crate) struct StandardOutboundDeclarationObserver<'a> {
    inverse: &'a RequestInverseContext,
    current: &'a CurrentFieldAssociations,
    associations: Vec<ToolMappingReference>,
}

impl<'a> StandardOutboundDeclarationObserver<'a> {
    pub(crate) fn new(
        inverse: &'a RequestInverseContext,
        current: &'a CurrentFieldAssociations,
    ) -> Self {
        Self {
            inverse,
            current,
            associations: Vec::new(),
        }
    }

    /// Record the provider declaration that was actually emitted at
    /// `destination_index` from the canonical source tool at
    /// `canonical_source_path`.
    ///
    /// Callers invoke this only for an actual push or refresh replacement; a
    /// deduplicated no-op keeps the association the emitter actually retained
    /// and is not reported. A replacement whose source cannot be resolved
    /// invalidates any previous association instead of carrying a stale one.
    pub(crate) fn note_emitted(
        &mut self,
        destination_index: usize,
        canonical_source_path: &str,
        emitted_tool: &Value,
    ) {
        self.note_emitted_at(
            &format!("tools[{destination_index}]"),
            canonical_source_path,
            emitted_tool,
            emitted_tool.get("namespace").cloned(),
        );
    }

    /// The emitter supplies its actual destination and namespace context while
    /// inserting a declaration. Structured target namespaces derive this value
    /// from the emitted container, never from the original client declaration.
    pub(crate) fn note_emitted_at(
        &mut self,
        destination_path: &str,
        canonical_source_path: &str,
        emitted_tool: &Value,
        emitted_namespace: Option<Value>,
    ) {
        let reference = self.resolve(
            destination_path,
            canonical_source_path,
            emitted_tool,
            emitted_namespace,
        );
        let retained = self
            .associations
            .iter()
            .position(|entry| entry.destination_path == destination_path);
        match (retained, reference) {
            (Some(index), Some(reference)) => self.associations[index] = reference,
            (Some(index), None) => {
                self.associations.remove(index);
            }
            (None, Some(reference)) => self.associations.push(reference),
            (None, None) => {}
        }
    }

    pub(crate) fn into_mappings(self) -> Vec<ToolMappingReference> {
        self.associations
    }

    fn resolve(
        &self,
        destination_path: &str,
        canonical_source_path: &str,
        emitted_tool: &Value,
        emitted_namespace: Option<Value>,
    ) -> Option<ToolMappingReference> {
        // `canonical_source_path` is the current structural path the producer
        // emitted from. The current association slot maps it back to the real
        // origin mapping index; the original record's `source_path` then names
        // the canonical declaration. Multiple sources folded onto one current
        // address are returned in original order and resolved by the first.
        let current_path = chat_current_path(canonical_source_path);
        let indices = self
            .current
            .original_mapping_indices_for_destination(&current_path);
        let indices = if indices.is_empty() {
            self.current
                .original_mapping_indices_for_destination(canonical_source_path)
        } else {
            indices
        };
        let original_mapping_index = *indices.first()?;
        let mapping = self.inverse.field_mappings.get(original_mapping_index)?;
        let declaration = self
            .inverse
            .tool_declarations
            .iter()
            .find(|declaration| declaration.source_path == mapping.source_path)?;
        Some(ToolMappingReference {
            declaration_record_id: declaration.record_id.clone(),
            source_path: declaration.source_path.clone(),
            destination_path: destination_path.to_string(),
            emitted_kind: emitted_tool
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("function")
                .to_string(),
            emitted_name: provider_function_tool_name(emitted_tool).map(str::to_string),
            emitted_namespace,
            encoding: declaration.encoding.clone(),
        })
    }
}

fn chat_current_path(source_path: &str) -> String {
    source_path
        .strip_prefix("request.")
        .map(|path| format!("chat.{path}"))
        .unwrap_or_else(|| source_path.to_string())
}

/// Actual provider declaration emission for the registered Direct request
/// view. This is the single traversal that both flattens the native
/// namespace/custom declaration containers into the provider wire and records
/// each emitted leaf through the standard declaration observer, so the returned
/// attempt map names exactly what the provider wire contains.
///
/// Origins come from the request-local typed references (`inverse` + `current`)
/// carried by the view; they are never recovered by emitted name, schema,
/// model, or a post-hoc scan of the produced payload. Historical call names are
/// converted to the same emitted flat names from the same traversal, and
/// declaration-less convention guessing is not performed.
pub(crate) fn project_direct_provider_request_declarations(
    body: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    protocol: &str,
    attempt: &crate::operation_runner::AttemptContext,
) -> Result<(Value, crate::operation_runner::AttemptContext), String> {
    let mut projected = body.clone();
    let mut observer = StandardOutboundDeclarationObserver::new(inverse, current);
    // The declaration traversal below is the single place that chooses the
    // emitted namespace wire name. Resolve the collision-free alias first so the
    // wire declaration, the recorded attempt mapping, and the rewritten history
    // all name the same tool.
    let namespace_wire_aliases = {
        let declarations: Vec<Value> = body
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        super::request_outbound_mcp_names::openai_chat_namespace_wire_aliases(&serde_json::json!({
            "tools": declarations,
        }))?
    };
    let mut namespace_names = std::collections::HashMap::new();
    let mut emitted_kinds = std::collections::HashMap::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array).cloned() {
        let mut emitted: Vec<Value> = Vec::with_capacity(tools.len());
        let mut emitted_indexes = std::collections::HashMap::new();
        for (index, tool) in tools.iter().enumerate() {
            let canonical_source_path = format!("chat.tools[{index}]");
            if let Some(mapping) = namespace_tool_name_map(tool)? {
                namespace_names.extend(mapping.into_iter().map(|(source, name)| {
                    let wire = if protocol == "openai-chat" {
                        provider_compat_core::namespace_tools::openai_chat_namespace_wire_name(
                            &name,
                        )
                    } else {
                        name
                    };
                    let resolved = namespace_wire_aliases.get(&wire).cloned().unwrap_or(wire);
                    (source, resolved)
                }));
            }
            match flatten_namespace_tool_for_provider_with_sources(protocol, tool)? {
                Some(projection) => {
                    for (emission, flattened) in projection.sources.iter().zip(projection.tools) {
                        let flattened = super::request_outbound_builtin_tool_projection::apply_namespace_wire_alias(flattened, &namespace_wire_aliases);
                        let source_path = namespace_child_canonical_path(
                            &canonical_source_path,
                            &emission.source_child_indices,
                        );
                        let destination_index = emitted.len();
                        push_unique_provider_function_tool(
                            &mut emitted,
                            &mut emitted_indexes,
                            flattened,
                            protocol,
                        )?;
                        if emitted.len() > destination_index {
                            observer.note_emitted(
                                destination_index,
                                &source_path,
                                &emitted[destination_index],
                            );
                        }
                    }
                }
                None => {
                    let destination_index = emitted.len();
                    push_unique_provider_function_tool(
                        &mut emitted,
                        &mut emitted_indexes,
                        tool.clone(),
                        protocol,
                    )?;
                    if emitted.len() > destination_index {
                        observer.note_emitted(
                            destination_index,
                            &canonical_source_path,
                            &emitted[destination_index],
                        );
                    }
                }
            }
        }
        emitted_kinds = emitted_declaration_kinds(&emitted);
        projected["tools"] = Value::Array(emitted);
    }
    rewrite_direct_history_call_names(&mut projected, &namespace_names, &emitted_kinds);
    let mut actual_attempt = attempt.clone();
    actual_attempt.declarations.tool_mappings = observer.into_mappings();
    Ok((projected, actual_attempt))
}

/// The emitted provider declaration kind for every emitted provider name.
///
/// A declared custom tool reaches the provider either as a native custom
/// declaration or as a flattened function that carries the free-form
/// `{"input": ...}` envelope. The emitted declaration decides which history form
/// the provider accepts, so the kind is read from the declaration the same
/// traversal actually emitted, never from a name shape or a convention.
pub(super) fn emitted_declaration_kinds(
    tools: &[Value],
) -> std::collections::HashMap<String, String> {
    let mut kinds = std::collections::HashMap::new();
    for tool in tools {
        let kind = tool
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("function");
        let name = tool
            .get("name")
            .or_else(|| tool.pointer("/function/name"))
            .and_then(Value::as_str);
        if let Some(name) = name {
            kinds.insert(name.to_string(), kind.to_string());
        }
    }
    kinds
}

/// Convert historical calls in the already-projected provider body to the flat
/// provider names and representation emitted by the same declaration traversal.
/// A call may carry its namespace either as a sibling `namespace` field (native
/// Responses) or encoded in a dotted name (canonical Chat custom namespace
/// child). Only the names actually emitted by the current declaration traversal
/// are rewritten; no convention or name-shape guessing is performed.
///
/// A declared custom call whose emitted provider declaration is a flattened
/// function must reach the provider in that function form when the same request
/// also carries that call's tool result: the provider pairs the result with a
/// call it declares, so the free-form text moves into the `{"input": ...}`
/// arguments envelope, which is the exact inverse of restoring the client's
/// `custom_tool_call` identity on the response side. A call whose result is not
/// part of the request is plain history and keeps the client's representation.
pub(super) fn rewrite_direct_history_call_names(
    body: &mut Value,
    names: &std::collections::HashMap<String, String>,
    emitted_kinds: &std::collections::HashMap<String, String>,
) {
    /// Resolve the emitted provider name for one call from its own name and
    /// namespace. An unmapped call keeps its name.
    fn emitted_name(
        name: &str,
        namespace: Option<&str>,
        names: &std::collections::HashMap<String, String>,
    ) -> String {
        let key = match namespace {
            Some(namespace) if !namespace.is_empty() => format!("{namespace}.{name}"),
            _ => name.to_string(),
        };
        names.get(&key).cloned().unwrap_or_else(|| name.to_string())
    }

    /// The provider arguments envelope of a flattened free-form custom tool.
    fn flattened_arguments(
        emitted: &str,
        input: &Value,
        emitted_kinds: &std::collections::HashMap<String, String>,
    ) -> Option<String> {
        if emitted_kinds.get(emitted).map(String::as_str) != Some("function") {
            return None;
        }
        serde_json::to_string(&serde_json::json!({ "input": input })).ok()
    }

    fn rewrite_name(
        object: &mut Map<String, Value>,
        names: &std::collections::HashMap<String, String>,
    ) {
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let namespace = object
            .get("namespace")
            .and_then(Value::as_str)
            .map(str::to_string);
        let emitted = emitted_name(&name, namespace.as_deref(), names);
        if emitted != name {
            object.insert("name".to_string(), Value::String(emitted));
        }
    }

    /// A Responses custom call that is part of a completed tool round trip is
    /// emitted in the emitted declaration's own form, because the provider pairs
    /// the result with a call it declares. A call that carries no result in this
    /// request is plain history: the Direct request view keeps the client's
    /// representation and only reconciles the call name.
    fn rewrite_custom_call(
        object: &mut Map<String, Value>,
        names: &std::collections::HashMap<String, String>,
        emitted_kinds: &std::collections::HashMap<String, String>,
        paired_result: bool,
    ) {
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let namespace = object
            .get("namespace")
            .and_then(Value::as_str)
            .map(str::to_string);
        let emitted = emitted_name(&name, namespace.as_deref(), names);
        if paired_result {
            if let Some(input) = object.get("input").cloned() {
                if let Some(arguments) = flattened_arguments(&emitted, &input, emitted_kinds) {
                    object.remove("input");
                    object.insert(
                        "type".to_string(),
                        Value::String("function_call".to_string()),
                    );
                    object.insert("arguments".to_string(), Value::String(arguments));
                }
            }
        }
        if emitted != name {
            object.insert("name".to_string(), Value::String(emitted));
        }
    }

    /// A canonical Chat custom call is `{id, type: "custom", custom: {name,
    /// namespace?, input}}`. When the request also carries that call's tool
    /// result and its emitted declaration is a flattened function, the call
    /// becomes the provider's function call carrying the envelope; otherwise the
    /// call stays exactly as the client sent it.
    fn rewrite_chat_custom_call(
        tool_call: &mut Value,
        names: &std::collections::HashMap<String, String>,
        emitted_kinds: &std::collections::HashMap<String, String>,
        paired_result: bool,
    ) {
        if !paired_result {
            return;
        }
        let Some(custom) = tool_call.get("custom").and_then(Value::as_object) else {
            return;
        };
        let Some(name) = custom
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let namespace = custom
            .get("namespace")
            .and_then(Value::as_str)
            .map(str::to_string);
        let emitted = emitted_name(&name, namespace.as_deref(), names);
        let Some(input) = custom.get("input").cloned() else {
            return;
        };
        let Some(arguments) = flattened_arguments(&emitted, &input, emitted_kinds) else {
            return;
        };
        let Some(object) = tool_call.as_object_mut() else {
            return;
        };
        let mut function = Map::new();
        function.insert("name".to_string(), Value::String(emitted));
        if let Some(namespace) = namespace {
            function.insert("namespace".to_string(), Value::String(namespace));
        }
        function.insert("arguments".to_string(), Value::String(arguments));
        object.remove("custom");
        object.insert("type".to_string(), Value::String("function".to_string()));
        object.insert("function".to_string(), Value::Object(function));
    }

    // A call whose result is part of the same request is a completed tool round
    // trip. The provider pairs that result with a call it declares, so the call
    // is emitted in the emitted declaration's own form. A call without its
    // result is plain history and keeps the client's representation; only its
    // name is reconciled with the emission.
    let paired_result_call_ids: std::collections::HashSet<String> = body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.ends_with("_output"))
        })
        .filter_map(|item| item.get("call_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let paired_result_tool_call_ids: std::collections::HashSet<String> = body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|message| message.get("tool_call_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            match item.get("type").and_then(Value::as_str) {
                Some("function_call" | "tool_call" | "tool_use") => {
                    if let Some(object) = item.as_object_mut() {
                        rewrite_name(object, names);
                    }
                }
                Some("custom_tool_call") => {
                    let paired_result = item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .is_some_and(|call_id| paired_result_call_ids.contains(call_id));
                    if let Some(object) = item.as_object_mut() {
                        rewrite_custom_call(object, names, emitted_kinds, paired_result);
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for tool_call in tool_calls {
                    match tool_call.get("type").and_then(Value::as_str) {
                        Some("function") => {
                            if let Some(function) =
                                tool_call.get_mut("function").and_then(Value::as_object_mut)
                            {
                                rewrite_name(function, names);
                            }
                        }
                        Some("custom") => {
                            let paired_result = tool_call
                                .get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|id| paired_result_tool_call_ids.contains(id));
                            rewrite_chat_custom_call(
                                tool_call,
                                names,
                                emitted_kinds,
                                paired_result,
                            );
                        }
                        _ => {}
                    }
                }
            }
            if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
                for part in content {
                    if matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("tool_use" | "function_call" | "custom_tool_call")
                    ) {
                        if let Some(object) = part.as_object_mut() {
                            rewrite_name(object, names);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::request_outbound_format::{
        build_v3_openai_chat_standard_request_from_chat_canonical,
        build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations,
    };
    use crate::operation_runner::{
        apply_canonical_field_edit, CanonicalFieldEdit, CurrentFieldAssociations, FieldMapping,
        RequestInverseContext, ToolDeclarationReference,
    };
    use serde_json::{json, Value};

    #[test]
    fn chat_emission_consumes_actual_sdk_normalization_and_current_tool_schema() {
        use crate::operation_runner::{
            execute_v3_operation_runner_request_capture_client_json,
            execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
            RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
        };
        let patch = "*** Begin Patch\n*** Add File: /tmp/exact-path\n+literal $() and `bytes`\n*** End Patch\n";
        let raw = json!({
            "model":"client-model",
            "input":[
                {"role":"user","content":"Use all declared tools"},
                {"type":"custom_tool_call","call_id":"patch-id","name":"apply_patch","namespace":"functions","input":patch},
                {"type":"custom_tool_call_output","call_id":"patch-id","output":"applied"}
            ],
            "tools":[{
                "type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"apply_patch","format":{"type":"text"}},
                    {"type":"function","name":"exec","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}
                ]
            }]
        });
        let handle = V3RequestContextHandle::new("sdk-emission".into(), "responses".into());
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            "sdk-invocation".into(),
            "sdk-attempt".into(),
            RequestOriginKind::ClientEntry,
        );
        let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
        let mut canonical = execute_v3_operation_runner_request_normalize_losslessly(
            &handle,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .unwrap();
        let pair = handle.original_pair().unwrap();
        canonical["tools"][0]["tools"][1]["parameters"]["properties"]["cwd"] =
            json!({"type":"string"});
        let original_canonical = canonical.clone();
        let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        let (wire, mappings) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &canonical,
                &pair.inverse_context,
                &current,
            )
            .expect("actual SDK carrier must be consumed by standard Outbound");
        assert_eq!(
            canonical, original_canonical,
            "projection must retain the request canonical and opaque values"
        );
        assert!(canonical["routecodex_chat_extension"]["chat_extension_opaque_record"].is_array());
        assert!(wire.get("routecodex_chat_extension").is_none());
        assert_eq!(mappings.len(), 2);
        assert_eq!(
            wire["tools"][1]["function"]["parameters"]["properties"]["cwd"],
            json!({"type":"string"})
        );
        let original = pair
            .inverse_context
            .tool_declarations
            .iter()
            .find(|declaration| declaration.source_path == "request.tools[0].tools[0]")
            .unwrap();
        assert_eq!(mappings[0].declaration_record_id, original.record_id);
        assert_eq!(mappings[0].source_path, original.source_path);
        assert_eq!(mappings[0].emitted_namespace, None);
        assert_eq!(
            mappings[0].emitted_name.as_deref(),
            Some("functions__apply_patch")
        );
        let call = wire["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
            .find(|call| call["id"] == "patch-id")
            .expect("original call id must be preserved");
        assert_eq!(
            call["type"], "function",
            "standard Chat must project custom history using the same declaration encoding: {call}"
        );
        let arguments = call["function"]["arguments"]
            .as_str()
            .expect("function arguments encoding");
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap()["input"],
            patch
        );
    }

    #[test]
    fn chat_emission_after_preceding_declaration_removal_keeps_surviving_source() {
        use crate::operation_runner::{
            execute_v3_operation_runner_request_capture_client_json,
            execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
            RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
        };
        let handle = V3RequestContextHandle::new("sdk-removal".into(), "responses".into());
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            "removal-invocation".into(),
            "removal-attempt".into(),
            RequestOriginKind::ClientEntry,
        );
        let captured = execute_v3_operation_runner_request_capture_client_json(json!({
            "input":[],
            "tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"apply_patch","format":{"type":"text"}},
                {"type":"function","name":"exec","parameters":{"type":"object"}}
            ]}]
        }))
        .unwrap();
        let canonical = execute_v3_operation_runner_request_normalize_losslessly(
            &handle,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .unwrap();
        let pair = handle.original_pair().unwrap();
        let surviving_source = pair
            .inverse_context
            .tool_declarations
            .iter()
            .find(|declaration| declaration.source_path == "request.tools[0].tools[1]")
            .unwrap();
        // The registered structural edit consumer removes the first child and
        // hands back the shifted current association set in the same call.
        let initial = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        let (canonical, current) = apply_canonical_field_edit(
            &canonical,
            &initial,
            &CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
        )
        .expect("registered remove edit must pair the data and current origins");
        let (wire, mappings) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &canonical,
                &pair.inverse_context,
                &current,
            )
            .unwrap();
        assert_eq!(wire["tools"][0]["function"]["name"], "functions__exec");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].declaration_record_id, surviving_source.record_id,
            "a structural shift must not turn exec into the removed custom apply_patch on the response path");
        assert_eq!(mappings[0].source_path, "request.tools[0].tools[1]");
        assert_eq!(mappings[0].destination_path, "tools[0]");
        assert_eq!(mappings[0].emitted_name.as_deref(), Some("functions__exec"));
    }

    fn declaration(
        record_id: &str,
        source_path: &str,
        kind: &str,
        name: &str,
        namespace: Value,
    ) -> ToolDeclarationReference {
        ToolDeclarationReference {
            record_id: record_id.to_string(),
            source_path: source_path.to_string(),
            kind: kind.to_string(),
            name: Some(name.to_string()),
            namespace: Some(namespace),
            encoding: "json".to_string(),
        }
    }

    fn mapping(source_path: &str, destination: &str) -> FieldMapping {
        FieldMapping {
            source_path: source_path.to_string(),
            destination: destination.to_string(),
            operator: "routecodex.v3.field.tool_declaration_transform@1".to_string(),
            shape: None,
            semantics: None,
            transform_id: None,
            collision_policy: None,
            encoding: "json".to_string(),
        }
    }

    fn inverse(
        field_mappings: Vec<FieldMapping>,
        tool_declarations: Vec<ToolDeclarationReference>,
    ) -> RequestInverseContext {
        RequestInverseContext {
            entry_protocol: "responses".to_string(),
            normalized_protocol: "chat".to_string(),
            field_mappings,
            opaque_record_references: Vec::new(),
            tool_declarations,
        }
    }

    #[test]
    fn chat_emission_maps_flattened_namespace_children_to_their_sources() {
        let payload = json!({
            "messages":[],
            "tools": [{
                "type":"namespace",
                "name":"ns",
                "tools":[
                    {"type":"function","name":"a","parameters":{"type":"object"}},
                    {"type":"custom","name":"b","format":{"type":"text"}}
                ]
            }]
        });
        let inverse = inverse(
            vec![
                mapping("request.tools[0].tools[0]", "chat.tools[0].tools[0]"),
                mapping("request.tools[0].tools[1]", "chat.tools[0].tools[1]"),
            ],
            vec![
                declaration(
                    "r-a",
                    "request.tools[0].tools[0]",
                    "function",
                    "a",
                    json!("ns"),
                ),
                declaration(
                    "r-b",
                    "request.tools[0].tools[1]",
                    "custom",
                    "b",
                    json!("ns"),
                ),
            ],
        );
        let current = CurrentFieldAssociations::from_normalization(&inverse);
        let (projected, declarations) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &payload, &inverse, &current,
            )
            .expect("standard Chat projection succeeds");

        let tools = projected["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["function"]["name"].as_str(), Some("ns__a"));
        assert_eq!(tools[1]["function"]["name"].as_str(), Some("ns__b"));
        assert_eq!(declarations.len(), 2);
        let first = declarations
            .iter()
            .find(|mapping| mapping.destination_path == "tools[0]")
            .expect("first emission recorded");
        assert_eq!(first.declaration_record_id, "r-a");
        assert_eq!(first.source_path, "request.tools[0].tools[0]");
        assert_eq!(first.emitted_name.as_deref(), Some("ns__a"));
        assert_eq!(first.emitted_kind, "function");
        assert_eq!(first.emitted_namespace, None);
        let second = declarations
            .iter()
            .find(|mapping| mapping.destination_path == "tools[1]")
            .expect("second emission recorded");
        assert_eq!(second.declaration_record_id, "r-b");
        assert_eq!(second.source_path, "request.tools[0].tools[1]");
        assert_eq!(second.emitted_name.as_deref(), Some("ns__b"));
        assert_eq!(second.emitted_kind, "function");
        assert_eq!(second.emitted_namespace, None);
    }

    #[test]
    fn chat_emission_maps_plain_function_to_its_canonical_source() {
        let payload = json!({
            "messages":[],
            "tools":[{
                "type":"function",
                "function":{"name":"lookup","parameters":{"type":"object"}}
            }]
        });
        let inverse = inverse(
            vec![mapping("request.tools[0]", "chat.tools[0]")],
            vec![declaration(
                "r-lookup",
                "request.tools[0]",
                "function",
                "lookup",
                json!(null),
            )],
        );
        let current = CurrentFieldAssociations::from_normalization(&inverse);
        let (projected, declarations) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &payload, &inverse, &current,
            )
            .expect("standard Chat projection succeeds");
        assert_eq!(projected["tools"].as_array().unwrap().len(), 1);
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].declaration_record_id, "r-lookup");
        assert_eq!(declarations[0].source_path, "request.tools[0]");
        assert_eq!(declarations[0].destination_path, "tools[0]");
        assert_eq!(declarations[0].emitted_name.as_deref(), Some("lookup"));
        assert_eq!(declarations[0].emitted_kind, "function");
    }

    #[test]
    fn chat_emission_nested_namespace_child_path_accumulates_child_indices() {
        let payload = json!({
            "messages":[],
            "tools":[{
                "type":"namespace",
                "name":"outer",
                "tools":[{
                    "type":"namespace",
                    "name":"inner",
                    "tools":[
                        {"type":"function","name":"leaf","parameters":{"type":"object"}}
                    ]
                }]
            }]
        });
        let inverse = inverse(
            vec![mapping(
                "request.tools[0].tools[0].tools[0]",
                "chat.tools[0].tools[0].tools[0]",
            )],
            vec![declaration(
                "r-leaf",
                "request.tools[0].tools[0].tools[0]",
                "function",
                "leaf",
                json!("inner"),
            )],
        );
        let current = CurrentFieldAssociations::from_normalization(&inverse);
        let (projected, declarations) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &payload, &inverse, &current,
            )
            .expect("standard Chat projection succeeds");
        let tools = projected["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0]["function"]["name"].as_str(),
            Some("outer__inner__leaf")
        );
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].declaration_record_id, "r-leaf");
        assert_eq!(
            declarations[0].source_path,
            "request.tools[0].tools[0].tools[0]"
        );
        assert_eq!(declarations[0].destination_path, "tools[0]");
        assert_eq!(
            declarations[0].emitted_name.as_deref(),
            Some("outer__inner__leaf")
        );
    }

    #[test]
    fn chat_emission_unknown_origin_does_not_invent_a_record() {
        let payload = json!({
            "messages":[],
            "tools":[{"type":"function","function":{"name":"solo","parameters":{"type":"object"}}}]
        });
        // No field mapping or declaration exists for the only canonical tool:
        // the promoted/discovered tool has a real origin but no original record.
        let inverse = inverse(Vec::new(), Vec::new());
        let current = CurrentFieldAssociations::from_normalization(&inverse);
        let (projected, declarations) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &payload, &inverse, &current,
            )
            .expect("standard Chat projection succeeds");
        assert_eq!(projected["tools"].as_array().unwrap().len(), 1);
        assert!(declarations.is_empty(), "no invented declaration record");
    }

    #[test]
    fn chat_emission_with_observer_does_not_change_the_payload() {
        let payload = json!({
            "messages":[],
            "tools":[{
                "type":"namespace",
                "name":"ns",
                "tools":[
                    {"type":"function","name":"a","parameters":{"type":"object"}}
                ]
            }]
        });
        let inverse = inverse(
            vec![mapping(
                "request.tools[0].tools[0]",
                "chat.tools[0].tools[0]",
            )],
            vec![declaration(
                "r-a",
                "request.tools[0].tools[0]",
                "function",
                "a",
                json!("ns"),
            )],
        );
        let current = CurrentFieldAssociations::from_normalization(&inverse);
        let plain = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
            .expect("observer-free builder succeeds");
        let (declared, _) =
            build_v3_openai_chat_standard_request_from_chat_canonical_with_declarations(
                &payload, &inverse, &current,
            )
            .expect("declared builder succeeds");
        assert_eq!(plain, declared, "payload must not change with an observer");
    }
}
