use serde_json::{json, Map, Value};

use super::current_projection_view::CurrentProjectionView;
use super::field_operator_helpers::map_gemini_tool_choice;
use super::field_operator_library::profile_index;
use super::field_operator_profiles::{lookup_path, DirectionBinding, FieldOperatorKind};
use super::project_canonical_paths::{parse_path, read_path, write_path, PathSegment};
use crate::operation_runner::FieldMapping;

const STANDARD_REQUEST_PREFIX: &str = "provider.standard.request.";

/// Form an Outbound working view without serializing the canonical opaque
/// record envelope into the provider protocol. The compiled field profile owns
/// this representation boundary. The request canonical retains every record
/// value for subsequent Direct/client inverse consumers; no raw view is rebuilt.
pub(crate) fn project_canonical_standard_view(canonical: &Value) -> Result<Value, String> {
    let profiles = profile_index()?;
    let mut view = canonical.clone();
    if let Some(extension) = view
        .get_mut(super::field_operator_library::ROOT_CARRIER_KEY)
        .and_then(Value::as_object_mut)
    {
        extension.remove(profiles.request_only_carrier());
    }
    for binding in
        profiles.chat_to_provider_bindings_for_kind(FieldOperatorKind::ResponsesIncludeTransform)
    {
        materialize_chat_to_provider_binding(canonical, &mut view, binding)?;
    }
    Ok(view)
}

fn materialize_chat_to_provider_binding(
    canonical: &Value,
    view: &mut Value,
    binding: &DirectionBinding,
) -> Result<(), String> {
    let source = binding
        .source
        .as_deref()
        .ok_or_else(|| "chat_to_provider binding is missing source".to_string())?;
    let destination = binding
        .destination
        .as_deref()
        .ok_or_else(|| "chat_to_provider binding is missing destination".to_string())?;
    let Some(value) = read_path(canonical, source)? else {
        return Ok(());
    };
    let destination = destination
        .strip_prefix(STANDARD_REQUEST_PREFIX)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            format!(
                "chat_to_provider destination `{destination}` is not under `{STANDARD_REQUEST_PREFIX}`"
            )
        })?;
    write_path(view, destination, value.clone())?;
    remove_path_and_empty_containers(view, source)
}

fn remove_path_and_empty_containers(root: &mut Value, path: &str) -> Result<(), String> {
    let segments = parse_path(path)?;
    remove_segments_and_empty_containers(root, &segments)
}

fn remove_segments_and_empty_containers(
    current: &mut Value,
    segments: &[PathSegment],
) -> Result<(), String> {
    let Some((segment, remaining)) = segments.split_first() else {
        return Ok(());
    };
    match segment {
        PathSegment::Key(key) => {
            let Some(object) = current.as_object_mut() else {
                return Ok(());
            };
            if remaining.is_empty() {
                object.remove(key);
                return Ok(());
            }
            let Some(child) = object.get_mut(key) else {
                return Ok(());
            };
            remove_segments_and_empty_containers(child, remaining)?;
            if child.as_object().is_some_and(Map::is_empty) {
                object.remove(key);
            }
        }
        PathSegment::Index(index) => {
            let Some(array) = current.as_array_mut() else {
                return Ok(());
            };
            if remaining.is_empty() {
                if *index < array.len() {
                    array.remove(*index);
                }
                return Ok(());
            }
            let Some(child) = array.get_mut(*index) else {
                return Ok(());
            };
            remove_segments_and_empty_containers(child, remaining)?;
            if child.as_array().is_some_and(Vec::is_empty) {
                array.remove(*index);
            }
        }
    }
    Ok(())
}

/// Reverse non-history/non-declaration fields through their registered edges.
/// The original record supplies opaque siblings; mapped values come from the
/// current canonical data, including removals. No complete raw view is retained.
pub(super) fn project_direct_fields(view: &CurrentProjectionView<'_>) -> Result<Value, String> {
    let canonical = view.canonical();
    let inverse = view.inverse();
    let profiles = profile_index()?;
    let mut output = Value::Object(Map::new());
    let is_owned_container = |source: &str| {
        inverse.field_mappings.iter().any(|mapping| {
            (mapping.source_path == source && separate_owner(mapping))
                || descendant(&mapping.source_path, source)
        })
    };
    for (mapping_index, mapping) in inverse.field_mappings.iter().enumerate() {
        if separate_owner(mapping)
            || container_only(mapping)
            || inverse.field_mappings.iter().any(|parent| {
                separate_owner(parent) && descendant(&mapping.source_path, &parent.source_path)
            })
            || inverse.field_mappings.iter().any(|parent| {
                parent.transform_id.as_deref()
                    == Some("v3.gemini_tool_config_to_chat_tool_choice.v1")
                    && descendant(&mapping.source_path, &parent.source_path)
            })
        {
            continue;
        }
        // A token-limit collision is an explicitly preserved non-Chat value;
        // its reference is separate from the field that owns the Chat limit.
        let collision = if mapping.operator == "routecodex.v3.field.token_limit_rename@1" {
            inverse
                .opaque_record_references
                .iter()
                .find(|reference| reference.path == mapping.source_path)
        } else {
            None
        };
        let value = match collision {
            Some(reference) => view.opaque_value(reference)?,
            None => view.read_mapping(mapping_index)?,
        };
        let Some(value) = value else { continue };
        let row = profiles.row(
            &inverse.normalized_protocol,
            &lookup_path(
                mapping
                    .source_path
                    .strip_prefix("request.")
                    .unwrap_or(&mapping.source_path),
            ),
        );
        let projected = if mapping.transform_id.as_deref()
            == Some("v3.gemini_tool_config_to_chat_tool_choice.v1")
        {
            let original = inverse
                .opaque_record_references
                .iter()
                .find(|reference| reference.path == mapping.source_path)
                .map(|reference| view.opaque_value(reference))
                .transpose()?
                .flatten();
            gemini_tool_config(value, canonical, original)
        } else {
            match row.and_then(|row| row.dispatch_kind) {
                Some(FieldOperatorKind::ParallelToolCallsValueMap)
                    if row.is_some_and(|row| row.inverse_boolean()) =>
                {
                    value
                        .as_bool()
                        .map(|value| Value::Bool(!value))
                        .unwrap_or_else(|| value.clone())
                }
                Some(
                    FieldOperatorKind::ToolChoiceShapeBranch
                    | FieldOperatorKind::ToolChoiceValueMap,
                ) if mapping.transform_id.as_deref()
                    == Some("v3.anthropic_tool_choice_to_chat_tool_choice.v1") =>
                {
                    anthropic_tool_choice(value)
                }
                _ => value.clone(),
            }
        };
        write_path(&mut output, &mapping.source_path, projected)?;
    }
    for reference in &inverse.opaque_record_references {
        if reference.path == "$" {
            if let Some(value) = view.opaque_value(reference)? {
                return Ok(value.clone());
            }
            continue;
        }
        // A transformed container is represented by its mapped children. Only
        // unmapped sibling records are read; never revive that whole container.
        if is_owned_container(&reference.path)
            || read_path(&output, &reference.path)?.is_some()
            || inverse
                .field_mappings
                .iter()
                .any(|mapping| mapping.source_path == reference.path)
            || inverse.field_mappings.iter().any(|mapping| {
                separate_owner(mapping) && descendant(&reference.path, &mapping.source_path)
            })
            || inverse.field_mappings.iter().any(|mapping| {
                mapping.transform_id.as_deref()
                    == Some("v3.gemini_tool_config_to_chat_tool_choice.v1")
                    && descendant(&reference.path, &mapping.source_path)
            })
        {
            continue;
        }
        let Some(path) = reference.path.strip_prefix("request.") else {
            continue;
        };
        let value = if path.split(['.', '[']).next() != Some("routecodex_chat_extension") {
            super::project_canonical_paths::read_path(canonical, path)?
                .or(view.opaque_value(reference)?)
        } else {
            view.opaque_value(reference)?
        };
        if let Some(value) = value {
            write_path(&mut output, &reference.path, value.clone())?;
        }
    }
    Ok(output)
}

fn descendant(path: &str, parent: &str) -> bool {
    path.strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('.') || suffix.starts_with('['))
}

fn separate_owner(mapping: &FieldMapping) -> bool {
    mapping.destination.starts_with("chat.messages")
        || mapping.destination == "chat.system.instructions"
        || mapping.operator == "routecodex.v3.field.tool_declaration_transform@1"
        || matches!(
            mapping.transform_id.as_deref(),
            Some(
                "v3.openai_chat_messages_to_chat_messages.v1"
                    | "v3.anthropic_messages_to_chat_messages.v1"
                    | "v3.gemini_contents_to_chat_messages.v1"
                    | "v3.gemini_system_instruction_to_chat_system.v1"
            )
        )
}

fn container_only(mapping: &FieldMapping) -> bool {
    mapping.transform_id.as_deref()
        == Some("v3.gemini_generation_config_to_chat_generation_config.v1")
}

fn anthropic_tool_choice(value: &Value) -> Value {
    match value.as_str() {
        Some("required") => json!({"type":"any"}),
        Some("auto" | "none") => json!({"type":value}),
        _ if value.get("type").and_then(Value::as_str) == Some("function") => {
            json!({"type":"tool","name":value.pointer("/function/name").cloned().unwrap_or(Value::Null)})
        }
        _ => value.clone(),
    }
}

fn gemini_tool_config(choice: &Value, canonical: &Value, original: Option<&Value>) -> Value {
    let mut native = canonical
        .pointer("/routecodex_chat_extension/gemini_request/toolConfig")
        .cloned()
        .unwrap_or_else(|| json!({}));
    // The native-shaped extension can itself have changed. Compare the Chat
    // choice with its original registered conversion so an unchanged alias
    // cannot overwrite a current extension field with an old name list/mode.
    let source_choice = original
        .unwrap_or(&native)
        .get("functionCallingConfig")
        .unwrap_or(&Value::Null);
    if &map_gemini_tool_choice(source_choice) == choice {
        return native;
    }
    let mode = match choice.as_str() {
        Some("auto") => "AUTO",
        Some("none") => "NONE",
        Some("required") => "ANY",
        _ if choice.get("type").and_then(Value::as_str) == Some("function") => "ANY",
        _ => return choice.clone(),
    };
    let Some(root) = native.as_object_mut() else {
        return native;
    };
    let config = root
        .entry("functionCallingConfig")
        .or_insert_with(|| json!({}));
    let Some(config) = config.as_object_mut() else {
        return native;
    };
    config.insert("mode".to_string(), json!(mode));
    if let Some(name) = choice.pointer("/function/name") {
        config.insert("allowedFunctionNames".to_string(), json!([name]));
    }
    native
}

#[cfg(test)]
mod tests {
    use super::project_direct_fields;
    use crate::operation_runner::operators::current_projection_view::CurrentProjectionView;
    use crate::operation_runner::operators::field_operator_library::normalize_client_request;
    use crate::operation_runner::{CurrentFieldAssociations, RequestScopedContextPair};
    use serde_json::{json, Value};

    fn run(protocol: &str, raw: Value, mutate: impl FnOnce(&mut Value)) -> Value {
        let normalized = normalize_client_request(protocol, &raw).unwrap();
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        let mut canonical = normalized.canonical_request;
        mutate(&mut canonical);
        project_direct_fields(&CurrentProjectionView::new(
            &canonical,
            &pair.inverse_context,
            &associations,
        ))
        .unwrap()
    }

    #[test]
    fn scalar_mapped_and_unknown_values_read_current_data() {
        let raw =
            json!({"input":[],"model":"old","max_output_tokens":5,"vendor":{"nested":[null,1]}});
        let output = run("responses", raw, |canonical| {
            canonical["model"] = json!("new");
            canonical["max_completion_tokens"] = json!(10);
            canonical["vendor"]["nested"][1] = json!(2);
        });
        assert_eq!(
            output,
            json!({"model":"new","max_output_tokens":10,"vendor":{"nested":[null,2]}})
        );
    }

    #[test]
    fn removal_and_explicit_null_remain_distinct() {
        let raw = json!({"messages":[],"temperature":0.4,"top_p":0.8});
        let output = run("openai-chat", raw, |canonical| {
            canonical.as_object_mut().unwrap().remove("temperature");
            canonical["top_p"] = Value::Null;
        });
        assert_eq!(output, json!({"top_p":null}));
    }

    #[test]
    fn removing_current_unknown_field_does_not_revive_original_value() {
        let output = run(
            "responses",
            json!({"input":[],"vendor":{"opaque":true}}),
            |canonical| {
                canonical.as_object_mut().unwrap().remove("vendor");
            },
        );
        assert_eq!(output, json!({}));
    }

    #[test]
    fn gemini_safety_extension_reads_current_value() {
        let output = run(
            "gemini",
            json!({"contents":[],"safetySettings":[{"category":"original","threshold":"BLOCK_NONE","vendor":true}]}),
            |canonical| {
                canonical["routecodex_chat_extension"]["gemini_request"]["safetySettings"][0]
                    ["category"] = json!("changed");
            },
        );
        assert_eq!(
            output,
            json!({"safetySettings":[{"category":"changed","threshold":"BLOCK_NONE","vendor":true}]})
        );
    }

    #[test]
    fn gemini_unknown_generation_extension_reads_current_value() {
        let output = run(
            "gemini",
            json!({"contents":[],"generationConfig":{"vendor":{"keep":true}}}),
            |canonical| {
                canonical["routecodex_chat_extension"]["gemini_request"]
                    ["generationConfig.vendor"]["keep"] = json!(false);
            },
        );
        assert_eq!(
            output,
            json!({"generationConfig":{"vendor":{"keep":false}}})
        );
    }

    #[test]
    fn gemini_generation_leaves_use_current_values_and_keep_unknown_siblings() {
        let raw = json!({"contents":[],"generationConfig":{"maxOutputTokens":5,"topP":0.8,"vendor":{"keep":true}}});
        let output = run("gemini", raw, |canonical| {
            canonical["max_completion_tokens"] = json!(20);
            canonical["top_p"] = Value::Null;
        });
        assert_eq!(
            output,
            json!({"generationConfig":{"maxOutputTokens":20,"topP":null,"vendor":{"keep":true}}})
        );
    }

    #[test]
    fn anthropic_choice_preserves_siblings_and_inverse_boolean() {
        let raw = json!({"messages":[],"tool_choice":{"type":"tool","name":"old","disable_parallel_tool_use":true,"vendor":null}});
        let output = run("anthropic", raw, |canonical| {
            canonical["tool_choice"] = json!({"type":"function","function":{"name":"new"}});
            canonical["parallel_tool_calls"] = json!(true);
        });
        assert_eq!(
            output,
            json!({"tool_choice":{"type":"tool","name":"new","disable_parallel_tool_use":false,"vendor":null}})
        );
    }

    #[test]
    fn generated_carrier_does_not_overwrite_client_carrier() {
        let original = json!({"opaque":[null,"literal\npatch"]});
        let output = run(
            "responses",
            json!({"input":[],"routecodex_chat_extension":original}),
            |_| {},
        );
        assert_eq!(
            output,
            json!({"routecodex_chat_extension":{"opaque":[null,"literal\npatch"]}})
        );
    }

    #[test]
    fn gemini_tool_config_roundtrip_keeps_native_shape_and_current_siblings() {
        let raw = json!({"contents":[],"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["exec"],"vendor":{"keep":true}},"retrievalConfig":{"opaque":[null,1]}}});
        let output = run("gemini", raw, |canonical| {
            canonical["routecodex_chat_extension"]["gemini_request"]["toolConfig"]
                ["retrievalConfig"]["opaque"][1] = json!(2);
        });
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["exec"],"vendor":{"keep":true}},"retrievalConfig":{"opaque":[null,2]}}})
        );
    }

    #[test]
    fn gemini_tool_config_projects_changed_choice_to_registered_native_mode() {
        let output = run(
            "gemini",
            json!({"contents":[],"toolConfig":{"functionCallingConfig":{"mode":"AUTO","vendor":null}}}),
            |canonical| {
                canonical["tool_choice"] = json!("none");
            },
        );
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"mode":"NONE","vendor":null}}})
        );
    }

    #[test]
    fn gemini_missing_mode_stays_missing_when_the_choice_is_unchanged() {
        let output = run(
            "gemini",
            json!({"contents":[],"toolConfig":{"functionCallingConfig":{"allowedFunctionNames":["exec"]}}}),
            |_| {},
        );
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"allowedFunctionNames":["exec"]}}})
        );
    }

    #[test]
    fn gemini_pinned_choice_mutation_is_not_overwritten_by_the_original_name_list() {
        let output = run(
            "gemini",
            json!({"contents":[],"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["old"]}}}),
            |canonical| {
                canonical["tool_choice"]["function"]["name"] = json!("new");
            },
        );
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["new"]}}})
        );
    }

    #[test]
    fn gemini_deleted_current_tool_config_sibling_is_not_revived_from_opaque_data() {
        let output = run(
            "gemini",
            json!({"contents":[],"toolConfig":{"functionCallingConfig":{"mode":"NONE","vendor":{"keep":true}}}}),
            |canonical| {
                canonical["routecodex_chat_extension"]["gemini_request"]["toolConfig"]
                    ["functionCallingConfig"]
                    .as_object_mut()
                    .unwrap()
                    .remove("vendor");
            },
        );
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"mode":"NONE"}}})
        );
    }

    #[test]
    fn gemini_current_allowed_names_are_not_overwritten_by_an_unchanged_choice_alias() {
        let output = run(
            "gemini",
            json!({"contents":[],"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["old"]}}}),
            |canonical| {
                canonical["routecodex_chat_extension"]["gemini_request"]["toolConfig"]
                    ["functionCallingConfig"]["allowedFunctionNames"] = json!(["new"]);
            },
        );
        assert_eq!(
            output,
            json!({"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["new"]}}})
        );
    }

    #[test]
    fn literal_unknown_keys_do_not_become_nested_paths() {
        let output = run(
            "responses",
            json!({"input":[],"vendor.name[0]":{"keep":true}}),
            |canonical| {
                canonical["vendor.name[0]"]["keep"] = json!(false);
            },
        );
        assert_eq!(output, json!({"vendor.name[0]":{"keep":false}}));
    }
}
