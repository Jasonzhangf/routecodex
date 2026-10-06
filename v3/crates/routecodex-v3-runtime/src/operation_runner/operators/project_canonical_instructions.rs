use serde_json::{json, Map, Value};

use super::current_projection_view::CurrentProjectionView;
use super::project_canonical_paths::field_path;

pub(super) const GENERATED_INSTRUCTION_SEPARATOR: &str = "normalization_instruction_separator";

/// Cancel only the unchanged encoding artifact created by the registered
/// native instruction transform. Original and newly inserted newline parts
/// have no generated association and remain ordinary current business data.
pub(crate) fn is_unchanged_native_instruction_separator(
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
    current_path: &str,
    current_part: &Value,
) -> bool {
    current
        .original_mapping_indices_for_destination(current_path)
        .into_iter()
        .any(|index| {
            let mapping = &inverse.field_mappings[index];
            mapping.semantics.as_deref() == Some(GENERATED_INSTRUCTION_SEPARATOR)
                && mapping.transform_id.as_deref()
                    == Some("v3.gemini_system_instruction_to_chat_system.v1")
        })
        && *current_part == json!({"type":"text","text":"\n"})
}

/// Restore an instruction source through its emitted leaf associations. Native
/// containers come from current data-plane source references; each consumed
/// leaf comes from its current canonical destination. No joined-text splitting
/// or text/name matching is needed for any protocol.
pub(super) fn project_instruction_source(
    view: &CurrentProjectionView<'_>,
    source: &str,
) -> Result<Option<Value>, String> {
    project_source_shape(view, source)
}

fn project_source_shape(
    view: &CurrentProjectionView<'_>,
    source: &str,
) -> Result<Option<Value>, String> {
    let Some(shape) = view.source_value(source)? else {
        return Ok(None);
    };
    match shape {
        Value::Object(fields) => {
            let mut output = Map::new();
            for key in fields.keys() {
                if let Some(current) = project_source_shape(view, &field_path(source, key))? {
                    output.insert(key.clone(), current);
                }
            }
            Ok(Some(Value::Object(output)))
        }
        Value::Array(items) => {
            let mut output = Vec::new();
            for index in 0..items.len() {
                if let Some(current) = project_source_shape(view, &format!("{source}[{index}]"))? {
                    output.push(current);
                }
            }
            Ok(Some(Value::Array(output)))
        }
        _ => {
            if let Some(mapping_index) = view.mapping_index_for_source(source) {
                Ok(view.read_mapping(mapping_index)?.cloned())
            } else {
                // This leaf was not consumed by normalization. It remains an
                // opaque business value in the current source representation.
                Ok(Some(shape.clone()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::project_instruction_source;
    use crate::operation_runner::operators::current_projection_view::CurrentProjectionView;
    use crate::operation_runner::operators::field_operator_library::normalize_client_request;
    use crate::operation_runner::{CurrentFieldAssociations, RequestScopedContextPair};
    use serde_json::{json, Value};

    fn fixture() -> (Value, RequestScopedContextPair) {
        let normalized = normalize_client_request(
            "gemini",
            &json!({
                "contents":[], "systemInstruction":{"parts":[
                    {"text":"same","literal.key[0]":true},
                    {"text":"same","opaque":null}
                ],"vendor":7}
            }),
        )
        .unwrap();
        let mut pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        let mut canonical = normalized.canonical_request;
        canonical["messages"][0]["content"] = json!([
            {"type":"text","text":"one-current"},
            {"type":"text","text":"\n"},
            {"type":"text","text":"two-current"}
        ]);
        // Exact consumer fixture for the admitted segmented producer contract;
        // full public SDK producer comparison follows its combination.
        for (source_index, destination_index) in [(0, 0), (1, 2)] {
            let source = format!("request.systemInstruction.parts[{source_index}].text");
            let mapping = pair
                .inverse_context
                .field_mappings
                .iter_mut()
                .find(|mapping| mapping.source_path == source)
                .unwrap();
            mapping.destination = format!("chat.messages[0].content[{destination_index}].text");
        }
        (canonical, pair)
    }

    #[test]
    fn equal_original_texts_restore_distinct_current_leaves() {
        let (canonical, pair) = fixture();
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        assert_eq!(
            project_instruction_source(
                &CurrentProjectionView::new(&canonical, &pair.inverse_context, &associations),
                "request.systemInstruction",
            )
            .unwrap(),
            Some(json!({"parts":[
            {"text":"one-current","literal.key[0]":true},
            {"text":"two-current","opaque":null}
        ],"vendor":7}))
        );
    }

    #[test]
    fn removed_and_null_leaves_keep_their_current_presence() {
        let (mut canonical, pair) = fixture();
        canonical["messages"][0]["content"][0]
            .as_object_mut()
            .unwrap()
            .remove("text");
        canonical["messages"][0]["content"][2]["text"] = Value::Null;
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        assert_eq!(
            project_instruction_source(
                &CurrentProjectionView::new(&canonical, &pair.inverse_context, &associations),
                "request.systemInstruction",
            )
            .unwrap(),
            Some(json!({"parts":[
            {"literal.key[0]":true}, {"text":null,"opaque":null}
        ],"vendor":7}))
        );
    }

    #[test]
    fn opaque_sibling_mutation_and_deletion_use_their_nearest_current_record() {
        let (mut canonical, pair) = fixture();
        let records = canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
            .as_array_mut()
            .unwrap();
        for record in records {
            match record["path"].as_str().unwrap() {
                "request.systemInstruction.parts[0][\"literal.key[0]\"]" => {
                    record["value"] = json!(false);
                }
                "request.systemInstruction.parts[1].opaque" => {
                    record.as_object_mut().unwrap().remove("value");
                }
                _ => {}
            }
        }
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        assert_eq!(
            project_instruction_source(
                &CurrentProjectionView::new(&canonical, &pair.inverse_context, &associations),
                "request.systemInstruction",
            )
            .unwrap(),
            Some(json!({"parts":[
            {"text":"one-current","literal.key[0]":false},
            {"text":"two-current"}
        ],"vendor":7}))
        );
    }
}
