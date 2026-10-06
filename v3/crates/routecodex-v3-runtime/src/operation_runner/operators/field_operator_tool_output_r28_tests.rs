//! R28 coverage for Responses tool-output identity/status/unknown siblings:
//! the producer records real source -> current destination mappings, and the
//! registered Direct inverse reads those fields from the current association
//! (never from the original opaque source).

use super::field_operator_library::normalize_client_request;
use crate::operation_runner::{
    apply_canonical_field_edit, project_canonical_direct_request, CanonicalFieldEdit,
    CurrentFieldAssociations, RequestScopedContextPair,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let normalized = normalize_client_request(protocol, &raw).expect("responses normalizes");
    let pair = RequestScopedContextPair::from_field_json(
        normalized.inverse_context,
        normalized.explicit_history_pairing,
    )
    .expect("real inverse/history pair");
    (normalized.canonical_request, pair)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    associations: &CurrentFieldAssociations,
) -> Value {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        associations,
        &pair.explicit_history_pairing,
    )
    .expect("registered Direct inverse projects the output item")
    .payload
}

fn destinations(pair: &RequestScopedContextPair, source: &str) -> Vec<String> {
    pair.inverse_context
        .field_mappings
        .iter()
        .filter(|mapping| mapping.source_path == source)
        .map(|mapping| mapping.destination.clone())
        .collect()
}

const EXTRA_CARRIER: &str =
    "chat.messages[0].routecodex_chat_extension.responses_tool_output_extra_fields";

#[test]
fn paired_output_records_real_mappings_for_identity_status_and_unknown_siblings() {
    let (canonical, pair) = normalize(
        "responses",
        json!({"model":"m","input":[{
            "type":"function_call_output",
            "call_id":"call_1",
            "output":"done",
            "id":"fco_1",
            "status":"completed",
            "vendor.key[0]": null,
            "after": {"keep": true}
        }]}),
    );

    let carrier = &canonical["messages"][0]["routecodex_chat_extension"];
    assert_eq!(carrier["responses_item_id"], "fco_1");
    assert_eq!(carrier["responses_tool_output_status"], "completed");
    assert_eq!(
        carrier["responses_tool_output_extra_fields"]["vendor.key[0]"],
        Value::Null
    );
    assert_eq!(
        carrier["responses_tool_output_extra_fields"]["after"],
        json!({"keep": true})
    );

    assert_eq!(
        destinations(&pair, "request.input[0].id"),
        vec!["chat.messages[0].routecodex_chat_extension.responses_item_id".to_string()]
    );
    assert_eq!(
        destinations(&pair, "request.input[0].status"),
        vec!["chat.messages[0].routecodex_chat_extension.responses_tool_output_status".to_string()]
    );
    // A dotted/bracketed key uses the escaped structural path, never string
    // concatenation.
    assert_eq!(
        destinations(&pair, r#"request.input[0]["vendor.key[0]"]"#),
        vec![format!(r#"{EXTRA_CARRIER}["vendor.key[0]"]"#)]
    );
    assert_eq!(
        destinations(&pair, "request.input[0].after"),
        vec![format!("{EXTRA_CARRIER}.after")]
    );
}

#[test]
fn direct_inverse_restores_paired_and_named_outputs_exactly() {
    let paired = json!({
        "type":"function_call_output",
        "call_id":"call_1",
        "output":"done",
        "id":"fco_1",
        "status":"completed",
        "name":"exec",
        "namespace":"mcp",
        "before":{"keep":1},
        "vendor.key[0]":null,
        "after":[1,null,"x"]
    });
    let (canonical, pair) = normalize("responses", json!({"model":"m","input":[paired.clone()]}));
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    assert_eq!(
        project(&canonical, &pair, &associations)["input"][0],
        paired
    );

    let named = json!({
        "type":"custom_tool_call_output",
        "output":"patch result",
        "id":"ctco_1",
        "status":"incomplete",
        "name":"apply_patch",
        "namespace":"mcp",
        "before":{"keep":1},
        "vendor.key[0]":null,
        "after":[1,null,"x"]
    });
    let (canonical, pair) = normalize("responses", json!({"model":"m","input":[named.clone()]}));
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    assert_eq!(project(&canonical, &pair, &associations)["input"][0], named);
}

#[test]
fn current_replace_and_remove_win_over_the_original_opaque_source() {
    let raw = json!({"model":"m","input":[{
        "type":"function_call_output",
        "call_id":"call_1",
        "output":"done",
        "id":"fco_1",
        "status":"completed",
        "vendor":{"keep":true}
    }]});
    let (canonical, pair) = normalize("responses", raw);
    let mut state = (
        canonical,
        CurrentFieldAssociations::from_normalization(&pair.inverse_context),
    );

    for (path, value) in [
        (
            "chat.messages[0].routecodex_chat_extension.responses_item_id",
            json!("fco_edited"),
        ),
        (
            "chat.messages[0].routecodex_chat_extension.responses_tool_output_status",
            json!("edited-status"),
        ),
        (
            "chat.messages[0].routecodex_chat_extension.responses_tool_output_extra_fields.vendor",
            json!({"edited":true}),
        ),
    ] {
        state = apply_canonical_field_edit(
            &state.0,
            &state.1,
            &CanonicalFieldEdit::Replace {
                path: path.to_string(),
                value,
            },
        )
        .expect("typed current Replace applies");
    }
    let replaced = project(&state.0, &pair, &state.1);
    assert_eq!(replaced["input"][0]["id"], "fco_edited");
    assert_eq!(replaced["input"][0]["status"], "edited-status");
    assert_eq!(replaced["input"][0]["vendor"], json!({"edited":true}));

    for path in [
        "chat.messages[0].routecodex_chat_extension.responses_tool_output_status",
        "chat.messages[0].routecodex_chat_extension.responses_tool_output_extra_fields.vendor",
    ] {
        state = apply_canonical_field_edit(
            &state.0,
            &state.1,
            &CanonicalFieldEdit::Remove {
                path: path.to_string(),
            },
        )
        .expect("typed current Remove applies");
    }
    let removed = project(&state.0, &pair, &state.1);
    assert!(removed["input"][0].get("status").is_none());
    assert!(removed["input"][0].get("vendor").is_none());
    // The original opaque source still records the removed values; the inverse
    // must not resurrect them from there.
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|reference| reference.path == "request.input[0].status"));
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|reference| reference.path == "request.input[0].vendor"));
}
