//! Public lossless SDK/Direct boundary checks for explicit null and absence.
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    CurrentFieldAssociations, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn round_trip(protocol: &str, raw: Value) -> Value {
    let handle = V3RequestContextHandle::new("nested-presence".into(), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "nested-presence-invocation".into(),
        "nested-presence-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw),
    )
    .expect("public SDK normalization must preserve representable fields");
    let pair = handle.original_pair().unwrap();
    project_canonical_direct_request(
        &canonical,
        &pair.inverse_context,
        &CurrentFieldAssociations::from_normalization(&pair.inverse_context),
        &pair.explicit_history_pairing,
    )
    .expect("registered Direct inverse must preserve field presence")
    .payload
}

#[test]
fn nested_known_nulls_keep_their_original_presence_and_values() {
    let cases = [
        (
            "responses",
            json!({"input":"hello","reasoning":{"effort":null,"summary":null}}),
        ),
        (
            "anthropic",
            json!({"messages":[{"role":"user","content":"hello"}],
                "output_config":{"effort":null},
                "thinking":{"type":null,"budget_tokens":null,"display":null}}),
        ),
    ];
    for (protocol, raw) in cases {
        assert_eq!(round_trip(protocol, raw.clone()), raw, "{protocol}");
    }
}

#[test]
fn explicit_empty_nested_containers_survive_the_registered_inverse() {
    let cases = [
        ("responses", json!({"input":"hello","reasoning":{}})),
        (
            "anthropic",
            json!({"messages":[{"role":"user","content":"hello"}],
                "output_config":{},"thinking":{}}),
        ),
    ];
    for (protocol, raw) in cases {
        assert_eq!(round_trip(protocol, raw.clone()), raw, "{protocol}");
    }
}

#[test]
fn absent_nested_fields_do_not_create_defaults_or_empty_containers() {
    let cases = [
        ("responses", json!({"input":"hello"})),
        (
            "anthropic",
            json!({"messages":[{"role":"user","content":"hello"}]}),
        ),
    ];
    for (protocol, raw) in cases {
        assert_eq!(round_trip(protocol, raw.clone()), raw, "{protocol}");
    }
}
