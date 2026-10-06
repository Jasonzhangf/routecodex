//! Public harness for the namespace flattener's actual emission association.
//!
//! The projection must keep the emitted `Value`s byte-identical to the
//! flattened tools while recording, for each real leaf push, the exact
//! namespace child index path that produced it. No name/schema/model matching
//! may be used to recover identity.

use provider_compat_core::namespace_tools::{
    flatten_namespace_tool_for_provider, flatten_namespace_tool_for_provider_with_sources,
};
use serde_json::{json, Value};

fn sources_of(
    projection: &provider_compat_core::namespace_tools::NamespaceToolProjection,
) -> Vec<Vec<usize>> {
    projection
        .sources
        .iter()
        .map(|emission| emission.source_child_indices.clone())
        .collect()
}

#[test]
fn projection_preserves_values_and_records_actual_sources() {
    let declaration = json!({
        "type": "namespace",
        "name": "alpha",
        "tools": [
            {"type": "namespace", "name": "beta", "tools": [
                {"type": "custom", "name": "run", "description": "custom leaf"},
                {"type": "function", "name": "read", "description": "function leaf",
                 "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}},
            ]},
            {"type": "function", "name": "read", "description": "outer duplicate name",
             "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}},
        ],
    });

    let projection = flatten_namespace_tool_for_provider_with_sources("openai-chat", &declaration)
        .expect("namespace declaration flattens")
        .expect("namespace declaration is flattened");
    let legacy = flatten_namespace_tool_for_provider("openai-chat", &declaration)
        .expect("legacy entry flattens")
        .expect("legacy entry returns tools");

    // The dependent entry returns exactly the legacy tools.
    assert_eq!(projection.tools, legacy);

    // Actual sources: nested custom, nested function, outer function.
    assert_eq!(
        sources_of(&projection),
        vec![vec![0, 0], vec![0, 1], vec![1]]
    );
    assert_eq!(
        projection
            .sources
            .iter()
            .map(|emission| emission.destination_index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );

    // Values stay untouched: nested qualified names under the accumulated
    // namespace; repeated child name `read` keeps two distinct emissions.
    assert_eq!(projection.tools[0]["function"]["name"], "alpha__beta__run");
    assert_eq!(projection.tools[1]["function"]["name"], "alpha__beta__read");
    assert_eq!(projection.tools[2]["function"]["name"], "alpha__read");
    assert_eq!(
        projection.tools[2]["function"]["description"],
        "outer duplicate name"
    );
}

#[test]
fn projection_destination_index_matches_real_position_even_after_deduped_shape() {
    // Distinct child names with different schemas must each keep their own
    // emission even when the flattened values differ only by name.
    let declaration = json!({
        "type": "namespace",
        "name": "ns",
        "tools": [
            {"type": "function", "name": "a", "parameters": {"type": "object"}},
            {"type": "function", "name": "a", "parameters": {"type": "object", "properties": {"x": {"type": "boolean"}}}},
        ],
    });
    let projection = flatten_namespace_tool_for_provider_with_sources("openai-chat", &declaration)
        .expect("declaration flattens")
        .expect("flat output");
    assert_eq!(sources_of(&projection), vec![vec![0], vec![1]]);
    assert_ne!(projection.tools[0], projection.tools[1]);
    for index in 0..projection.tools.len() {
        assert_eq!(projection.sources[index].destination_index, index);
    }
}

#[test]
fn non_namespace_input_returns_none_without_recording_sources() {
    let plain: Value = json!({"type": "function", "name": "solo"});
    assert!(
        flatten_namespace_tool_for_provider_with_sources("openai-chat", &plain)
            .expect("plain function is representable")
            .is_none()
    );
    assert!(
        flatten_namespace_tool_for_provider_with_sources("openai-chat", &json!("text"))
            .expect("non-object is representable")
            .is_none()
    );
}

#[test]
fn existing_error_behavior_is_unchanged() {
    let missing_name = json!({"type": "namespace", "tools": [{"type": "function", "name": "x"}]});
    let error = flatten_namespace_tool_for_provider_with_sources("openai-chat", &missing_name)
        .expect_err("namespace without a name fails");
    assert!(error.contains("non-empty name"), "{error}");

    let empty_tools = json!({"type": "namespace", "name": "ns", "tools": []});
    let error = flatten_namespace_tool_for_provider("openai-chat", &empty_tools)
        .expect_err("empty namespace tools fail");
    assert!(error.contains("non-empty tools"), "{error}");

    let bad_child = json!({"type": "namespace", "name": "ns", "tools": [{"type": "unknown"}]});
    let error = flatten_namespace_tool_for_provider_with_sources("openai-chat", &bad_child)
        .expect_err("unknown child type fails");
    assert!(
        error.contains("must be namespace, function, or custom"),
        "{error}"
    );
}
