use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    CanonicalFieldEdit, CurrentFieldAssociations, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new("nested-fields".into(), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "nested-invocation".into(),
        "nested-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    (canonical, handle.original_pair().unwrap())
}

fn associations(pair: &RequestScopedContextPair) -> CurrentFieldAssociations {
    CurrentFieldAssociations::from_normalization(&pair.inverse_context)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> Value {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
    )
    .unwrap()
    .payload
}

fn mapping(pair: &RequestScopedContextPair, source: &str, destination: &str) {
    assert!(
        pair.inverse_context
            .field_mappings
            .iter()
            .any(|mapping| mapping.source_path == source && mapping.destination == destination),
        "missing source association {source} -> {destination}"
    );
}

#[test]
fn responses_nested_reasoning_reaches_existing_chat_fields_and_round_trips() {
    let raw = json!({
        "input": "hello",
        "reasoning": {
            "effort": "xhigh",
            "summary": "detailed",
            "vendor": {"keep": true},
            "nullable": null
        }
    });
    let (canonical, pair) = normalize("responses", raw.clone());
    assert_eq!(canonical["reasoning_effort"], "xhigh", "{canonical}");
    assert_eq!(
        canonical["reasoning_summary_policy"], "detailed",
        "{canonical}"
    );
    assert_eq!(
        canonical["reasoning"],
        json!({"vendor": {"keep": true}, "nullable": null}),
        "{canonical}"
    );
    mapping(&pair, "request.reasoning.effort", "chat.reasoning_effort");
    mapping(
        &pair,
        "request.reasoning.summary",
        "chat.reasoning_summary_policy",
    );

    let current = associations(&pair);
    assert_eq!(project(&canonical, &pair, &current), raw);

    let (governed, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.reasoning_effort".to_string(),
            value: json!("high"),
        },
    )
    .unwrap();
    let projected = project(&governed, &pair, &current);
    assert_eq!(projected["reasoning"]["effort"], "high");
    assert_eq!(projected["reasoning"]["vendor"], json!({"keep": true}));
    assert_eq!(projected["reasoning"]["nullable"], Value::Null);

    let (removed, current) = apply_canonical_field_edit(
        &governed,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.reasoning_effort".to_string(),
        },
    )
    .unwrap();
    let projected = project(&removed, &pair, &current);
    assert!(projected["reasoning"].get("effort").is_none());
    assert_eq!(projected["reasoning"]["vendor"], json!({"keep": true}));
    assert_eq!(projected["reasoning"]["nullable"], Value::Null);

    // A known sibling that the client never sent stays absent: the shared
    // walker must not fabricate a default for a missing field, and a fully
    // consumed container must not linger as a raw root duplicate.
    let partial = json!({"input": "hi", "reasoning": {"effort": "low"}});
    let (partial_canonical, partial_pair) = normalize("responses", partial.clone());
    assert!(
        partial_canonical.get("reasoning").is_none(),
        "{partial_canonical}"
    );
    assert!(partial_canonical.get("reasoning_summary_policy").is_none());
    let partial_current = associations(&partial_pair);
    assert_eq!(
        project(&partial_canonical, &partial_pair, &partial_current),
        partial
    );
}

#[test]
fn anthropic_nested_reasoning_reaches_existing_chat_fields_and_round_trips() {
    let raw = json!({
        "messages": [{"role": "user", "content": "hello"}],
        "output_config": {"effort": "high", "vendor": null},
        "thinking": {
            "type": "enabled",
            "budget_tokens": 1024,
            "display": "omitted",
            "vendor": null
        }
    });
    let (canonical, pair) = normalize("anthropic", raw.clone());
    assert_eq!(canonical["reasoning_effort"], "high", "{canonical}");
    assert_eq!(
        canonical["reasoning_thinking_mode"], "enabled",
        "{canonical}"
    );
    assert_eq!(canonical["reasoning_budget_tokens"], 1024, "{canonical}");
    assert_eq!(
        canonical["reasoning_display_policy"], "omitted",
        "{canonical}"
    );
    assert_eq!(canonical["output_config"], json!({"vendor": null}));
    assert_eq!(canonical["thinking"], json!({"vendor": null}));
    mapping(
        &pair,
        "request.output_config.effort",
        "chat.reasoning_effort",
    );
    mapping(
        &pair,
        "request.thinking.type",
        "chat.reasoning_thinking_mode",
    );
    mapping(
        &pair,
        "request.thinking.budget_tokens",
        "chat.reasoning_budget_tokens",
    );
    mapping(
        &pair,
        "request.thinking.display",
        "chat.reasoning_display_policy",
    );

    let current = associations(&pair);
    assert_eq!(project(&canonical, &pair, &current), raw);

    let (governed, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.reasoning_budget_tokens".to_string(),
            value: json!(2048),
        },
    )
    .unwrap();
    let projected = project(&governed, &pair, &current);
    assert_eq!(projected["thinking"]["budget_tokens"], 2048);
    assert_eq!(projected["thinking"]["vendor"], Value::Null);

    let (removed, current) = apply_canonical_field_edit(
        &governed,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.reasoning_display_policy".to_string(),
        },
    )
    .unwrap();
    let projected = project(&removed, &pair, &current);
    assert!(projected["thinking"].get("display").is_none());
    assert_eq!(projected["thinking"]["vendor"], Value::Null);
}
