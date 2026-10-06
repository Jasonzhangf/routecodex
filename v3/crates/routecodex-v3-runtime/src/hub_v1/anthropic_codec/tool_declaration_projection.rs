use super::super::request_outbound_builtin_tool_projection::provider_tool_declaration_sources;
use super::super::request_outbound_declaration_emission::StandardOutboundDeclarationObserver;
use super::responses_to_anthropic::responses_tool_as_anthropic_tool;
use super::*;

/// Encode a Chat-canonical Anthropic request while recording declaration
/// provenance through the shared current-field observer at the same emission
/// traversal used by the source-declarations contract.
pub fn encode_v3_responses_semantic_as_anthropic_request_with_current_declarations(
    input: Value,
    inverse: &RequestInverseContext,
    current: &CurrentFieldAssociations,
) -> Result<(Value, Vec<ToolMappingReference>), V3AnthropicCodecError> {
    let hosted_emissions =
        crate::operation_runner::project_hosted_history_emissions(&input, inverse, current)
            .map_err(|reason| V3AnthropicCodecError::HostedHistoryProjection { reason })?;
    let mut declarations = AnthropicToolSourceDeclarations::new_current(inverse, current);
    let wire = encode_v3_responses_semantic_as_anthropic_request_inner_with_hosted(
        input,
        Some(&mut declarations),
        &hosted_emissions,
    )?;
    Ok((wire, declarations.into_mappings()))
}

pub(super) fn append_responses_tools_for_anthropic_wire(
    tools: Option<&Value>,
    output: &mut Vec<Value>,
    tool_indexes: &mut HashMap<String, usize>,
    source_array_path: &str,
    namespace_prefix: Option<&str>,
    mut declarations: Option<&mut AnthropicToolSourceDeclarations<'_>>,
) -> Result<(), V3AnthropicCodecError> {
    for (source_index, tool) in tools
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let source_path = format!("{source_array_path}[{source_index}]");
        append_responses_tool_for_anthropic_wire(
            tool,
            output,
            tool_indexes,
            &source_path,
            namespace_prefix,
            declarations.as_deref_mut(),
        )?;
    }
    Ok(())
}

/// Emit one declaration already addressed by its canonical source path.
/// `provider_tool_declaration_sources` supplies the path for sources that are
/// not a plain array walk (e.g. discovered MCP tools nested in a message), so
/// the observer records the real canonical address instead of a synthesized
/// array index. Namespace recursion still appends `.tools[index]` to that path.
pub(super) fn append_responses_tool_for_anthropic_wire(
    tool: &Value,
    output: &mut Vec<Value>,
    tool_indexes: &mut HashMap<String, usize>,
    source_path: &str,
    namespace_prefix: Option<&str>,
    mut declarations: Option<&mut AnthropicToolSourceDeclarations<'_>>,
) -> Result<(), V3AnthropicCodecError> {
    let tool_object = tool
        .as_object()
        .ok_or(V3AnthropicCodecError::MalformedField { field: "tools[]" })?;
    if tool_object.get("type").and_then(Value::as_str) == Some("namespace") {
        let namespace = tool_object.get("name").and_then(Value::as_str).ok_or(
            V3AnthropicCodecError::MalformedField {
                field: "tools[].name",
            },
        )?;
        append_responses_tools_for_anthropic_wire(
            tool_object.get("tools"),
            output,
            tool_indexes,
            &format!("{source_path}.tools"),
            Some(namespace),
            declarations,
        )?;
        return Ok(());
    }
    let prefixed = namespace_prefix.map(|namespace| {
        let mut child = tool_object.clone();
        let child_name = child
            .get("name")
            .or_else(|| {
                child
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .and_then(Value::as_str)
            .ok_or(V3AnthropicCodecError::MalformedField {
                field: "tools[].name",
            })?;
        child.insert(
            "name".to_string(),
            Value::String(super::namespace_tool_names::anthropic_namespace_wire_name(
                namespace, child_name,
            )),
        );
        Ok::<_, V3AnthropicCodecError>(child)
    });
    let prefixed = prefixed.transpose()?;
    let tool_object = prefixed.as_ref().unwrap_or(tool_object);
    let anthropic_tool = responses_tool_as_anthropic_tool(tool_object)?;
    let name = anthropic_tool
        .get("name")
        .and_then(Value::as_str)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "tools[].name",
        })?
        .to_string();
    let retained = tool_indexes.get(&name).copied();
    let destination_index = retained.unwrap_or(output.len());
    if let Some(declarations) = declarations
        .as_mut()
        .map(|declarations| &mut **declarations)
    {
        declarations.note_emitted(source_path, destination_index, &anthropic_tool);
    }
    if let Some(index) = retained {
        output[index] = anthropic_tool;
    } else {
        tool_indexes.insert(name, destination_index);
        output.push(anthropic_tool);
    }
    Ok(())
}

pub(super) struct AnthropicToolSourceDeclarations<'a> {
    source_mappings: Vec<ToolMappingReference>,
    current: Option<StandardOutboundDeclarationObserver<'a>>,
    emitted_mappings: Vec<ToolMappingReference>,
}

impl<'a> AnthropicToolSourceDeclarations<'a> {
    pub(super) fn new(source_mappings: &[ToolMappingReference]) -> Self {
        Self {
            source_mappings: source_mappings.to_vec(),
            current: None,
            emitted_mappings: Vec::new(),
        }
    }

    pub(super) fn new_current(
        inverse: &'a crate::operation_runner::RequestInverseContext,
        current: &'a crate::operation_runner::CurrentFieldAssociations,
    ) -> Self {
        Self {
            source_mappings: Vec::new(),
            current: Some(StandardOutboundDeclarationObserver::new(inverse, current)),
            emitted_mappings: Vec::new(),
        }
    }

    fn source_mapping(&self, destination_path: &str) -> Option<&ToolMappingReference> {
        self.source_mappings
            .iter()
            .find(|mapping| mapping.destination_path == destination_path)
    }

    pub(super) fn note_emitted(
        &mut self,
        source_path: &str,
        destination_index: usize,
        emitted_tool: &Value,
    ) {
        if let Some(current) = &mut self.current {
            let canonical_source_path = if source_path.starts_with("tools") {
                format!("chat.{source_path}")
            } else {
                source_path.to_string()
            };
            current.note_emitted(destination_index, &canonical_source_path, emitted_tool);
            return;
        }
        let destination_path = format!("tools[{destination_index}]");
        let mapping = self
            .source_mapping(source_path)
            .map(|source| ToolMappingReference {
                declaration_record_id: source.declaration_record_id.clone(),
                source_path: source.source_path.clone(),
                destination_path: destination_path.clone(),
                emitted_kind: emitted_tool
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("function")
                    .to_string(),
                emitted_name: emitted_tool
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                emitted_namespace: None,
                encoding: source.encoding.clone(),
            });
        let retained = self
            .emitted_mappings
            .iter()
            .position(|entry| entry.destination_path == destination_path);
        match (retained, mapping) {
            (Some(index), Some(mapping)) => self.emitted_mappings[index] = mapping,
            (Some(index), None) => {
                self.emitted_mappings.remove(index);
            }
            (None, Some(mapping)) => self.emitted_mappings.push(mapping),
            (None, None) => {}
        }
    }

    pub(super) fn into_mappings(self) -> Vec<ToolMappingReference> {
        self.current
            .map(|observer| observer.into_mappings())
            .unwrap_or(self.emitted_mappings)
    }
}

pub(super) fn responses_tools_for_anthropic_wire_with_declarations(
    object: &Map<String, Value>,
    mut declarations: Option<&mut AnthropicToolSourceDeclarations<'_>>,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let mut output = Vec::new();
    let mut tool_indexes = HashMap::new();
    append_responses_tools_for_anthropic_wire(
        object.get("tools"),
        &mut output,
        &mut tool_indexes,
        "tools",
        None,
        declarations.as_deref_mut(),
    )?;
    for (item_index, item) in object
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            append_responses_tools_for_anthropic_wire(
                item.get("tools"),
                &mut output,
                &mut tool_indexes,
                &format!("input[{item_index}].tools"),
                None,
                declarations.as_deref_mut(),
            )?;
        }
    }
    // The canonical Chat view also carries declarations that are not a plain
    // top-level array: a discovered MCP namespace survives normalization as a
    // `tool_search_output` message. The shared source collector is the single
    // owner of those canonical addresses; consume its message sources here so
    // the actual Anthropic emission and the observer stay on one traversal.
    // Top-level `chat.tools[i]` is already emitted above; only the non-array
    // message sources are appended to avoid double emission.
    for (source_path, tool) in provider_tool_declaration_sources(&Value::Object(object.clone()))
        .map_err(|paths| V3AnthropicCodecError::UnmappedOutboundFields { paths })?
    {
        if !source_path.starts_with("chat.messages") {
            continue;
        }
        append_responses_tool_for_anthropic_wire(
            &tool,
            &mut output,
            &mut tool_indexes,
            &source_path,
            None,
            declarations.as_deref_mut(),
        )?;
    }
    Ok(output)
}
