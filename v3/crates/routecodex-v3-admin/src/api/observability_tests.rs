//! Unit tests for the observability aggregation helpers.
//!
//! Extracted from `observability.rs` (declared there as `#[path] mod tests;`) to
//! keep that file under the 1500-line limit enforced by `verify:v3-file-size`.

use super::{
    attempt_status_code, error_category_status_code, row_cache_creation_value,
    row_cache_hit_numerator, row_cache_read_value, row_cached_value, row_effective_input,
    row_error_origin, row_error_origin_opt, row_input_value, row_output_value, row_status_code,
    row_total_value, to_query_row, QueryRow, SourceRow, SourceScope,
};
use serde_json::{json, Value};

#[test]
fn openai_cached_subcount_keeps_raw_input_as_denominator() {
    // OpenAI/Responses shape: input_tokens already includes cached_tokens;
    // cache hit is cached / input_tokens.
    let row = build_usage_row(json!({
        "input_tokens": 1000,
        "output_tokens": 200,
        "cached_tokens": 250,
        "total_tokens": 1200,
    }));
    assert_eq!(row_input_value(&row), 1000);
    assert_eq!(row_output_value(&row), 200);
    assert_eq!(row_cached_value(&row), Some(250));
    assert_eq!(row_cache_read_value(&row), None);
    assert_eq!(row_total_value(&row), 1200);
    assert_eq!(row_cache_hit_numerator(&row), 250);
    assert_eq!(row_effective_input(&row), 1000);
}

#[test]
fn split_anthropic_cache_fields_keep_read_and_creation_distinct() {
    let row = build_usage_row(json!({
        "input_tokens": 800,
        "output_tokens": 150,
        "cache_read_input_tokens": 600,
        "cache_creation_input_tokens": 100,
        "total_tokens": 950,
    }));
    assert_eq!(row_input_value(&row), 800);
    assert_eq!(row_cached_value(&row), None);
    assert_eq!(row_cache_read_value(&row), Some(600));
    assert_eq!(row_cache_creation_value(&row), Some(100));
    // Anthropic input excludes cache, so the denominator is
    // input + read + creation and the hit count is the read count.
    assert_eq!(row_cache_hit_numerator(&row), 600);
    assert_eq!(row_effective_input(&row), 1500);
}

#[test]
fn split_cache_read_zero_does_not_use_creation_as_hit() {
    let row = build_usage_row(json!({
        "input_tokens": 100,
        "output_tokens": 5,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 30,
        "total_tokens": 105,
    }));
    assert_eq!(row_cache_read_value(&row), Some(0));
    assert_eq!(row_cache_creation_value(&row), Some(30));
    // Creation is never a hit, but it still belongs in the denominator.
    assert_eq!(row_cache_hit_numerator(&row), 0);
    assert_eq!(row_effective_input(&row), 130);
}

#[test]
fn error_categories_always_have_numbered_status_projection() {
    assert_eq!(
        error_category_status_code(Some("malformed_json")),
        Some("400".to_string())
    );
    assert_eq!(
        error_category_status_code(Some("provider_response_sse_event_invalid")),
        Some("599".to_string())
    );
    assert_eq!(
        error_category_status_code(Some("v3_debug_failure")),
        Some("598".to_string())
    );
    assert_eq!(error_category_status_code(Some("unclassified")), None);
}

/// Acceptance criterion 1: the origin rule is positive for `upstream` and open
/// for `local`, so an unrecognised or malformed category is `local` rather than
/// silently unclassified.
#[test]
fn row_error_origin_classifies_upstream_local_and_unknown() {
    for category in [
        "provider_http_502",
        "provider_http_429",
        "provider_http_500",
    ] {
        assert_eq!(
            row_error_origin(&build_origin_row("error", Some(category))),
            "upstream",
            "{category} is the provider answering with an HTTP status"
        );
    }
    for category in [
        "provider_transport_error",
        "provider_runtime_error",
        "provider_response_header_timeout",
        "provider_response_body_error",
        "provider_response_sse_event_invalid",
        "http_502",
        "body_too_large",
        "malformed_json",
        "provider_empty_visible_output",
        "provider_http_x",
        "provider_http_",
    ] {
        assert_eq!(
            row_error_origin(&build_origin_row("error", Some(category))),
            "local",
            "{category} is not the provider answering with an HTTP status"
        );
    }
    assert_eq!(
        row_error_origin(&build_origin_row("error", None)),
        "unknown"
    );
    assert_eq!(
        row_error_origin(&build_origin_row("error", Some("   "))),
        "unknown",
        "a blank category carries no origin"
    );
}

/// Acceptance criterion 3: origin is defined only for rows that carry an error
/// result, so the row field and the `error_origin` filter agree.
#[test]
fn error_origin_is_absent_for_rows_without_an_error_result() {
    assert_eq!(
        row_error_origin_opt(&build_origin_row("error", Some("provider_http_502"))),
        Some("upstream")
    );
    assert_eq!(
        row_error_origin_opt(&build_origin_row(
            "failed-attempt",
            Some("provider_transport_error")
        )),
        Some("local")
    );
    for result in ["success", "cancelled", "active"] {
        assert_eq!(
            row_error_origin_opt(&build_origin_row(result, Some("provider_http_502"))),
            None,
            "{result} rows carry no error origin"
        );
    }
}

fn build_origin_row(result: &str, category: Option<&str>) -> QueryRow {
    let mut row = build_usage_row(json!({}));
    row.result = Some(result.to_string());
    if let Some(category) = category {
        row.meta = json!({ "error_category": category });
    }
    row
}

fn build_usage_row(usage: Value) -> QueryRow {
    QueryRow {
        request_key: "k".to_string(),
        event_type: "request.completed".to_string(),
        started_epoch_ms: 0,
        updated_epoch_ms: 0,
        finished_epoch_ms: Some(0),
        duration_ms: Some(0),
        meta: json!({}),
        scope: SourceScope::default(),
        result: Some("success".to_string()),
        error_origin: None,
        attempts: 1,
        failed_attempts: 0,
        switches: 0,
        usage: Some(usage),
        timing_internal_ms: None,
        timing_external_ms: None,
        servertool: false,
        raw_artifact_ref: None,
    }
}

fn build_attempt_row(meta: Value) -> QueryRow {
    let mut row = build_usage_row(json!({}));
    row.event_type = "request.provider_attempt_failed".to_string();
    row.result = Some("failed-attempt".to_string());
    row.meta = meta;
    row
}

/// The direct projection must stay equivalent to the serde round-trip it
/// replaced: `QueryRow` is `SourceRow` without `tokens_output` plus a defaulted
/// `error_origin`.
#[test]
fn query_projection_matches_the_serde_round_trip_it_replaced() {
    let row = SourceRow {
        request_key: "4444:r1".to_string(),
        event_type: "request.completed".to_string(),
        started_epoch_ms: 1,
        updated_epoch_ms: 2,
        finished_epoch_ms: Some(3),
        duration_ms: Some(4),
        meta: json!({"endpoint": "/v1/responses", "error_category": "provider_http_502"}),
        scope: SourceScope {
            port: 4444,
            workdir: Some("/tmp".to_string()),
            session: Some("session".to_string()),
        },
        result: Some("success".to_string()),
        attempts: 2,
        failed_attempts: 1,
        switches: 3,
        usage: Some(json!({"input_tokens": 10})),
        timing_internal_ms: Some(5),
        timing_external_ms: Some(6),
        servertool: true,
        tokens_output: Some(7),
        raw_artifact_ref: Some("artifact".to_string()),
    };
    let round_tripped: QueryRow =
        serde_json::from_value(serde_json::to_value(&row).expect("source row serializes"))
            .expect("query row shape is compatible");
    let projected = to_query_row(&row);
    assert_eq!(projected, round_tripped);
    assert_eq!(
        serde_json::to_value(&projected).expect("projected row serializes"),
        serde_json::to_value(&round_tripped).expect("round-tripped row serializes"),
        "the projected row must serialize exactly as the round-trip did"
    );
}

#[test]
fn transport_failure_without_upstream_status_renders_as_network_not_599() {
    // Direct lane identity for a network transport failure.
    let row = build_attempt_row(json!({
        "provider_status": null,
        "error_category": "provider_transport_error",
    }));
    assert_eq!(row_status_code(&row), "network");
    assert_eq!(attempt_status_code(&row), Some("network".to_string()));

    // The relay lane records the same transport failure under its generic
    // provider runtime identity; it must be non-599 as well.
    let row = build_attempt_row(json!({
        "provider_status": null,
        "error_category": "provider_runtime_error",
    }));
    assert_eq!(row_status_code(&row), "network");
    assert_eq!(attempt_status_code(&row), Some("network".to_string()));

    // A genuine upstream HTTP failure keeps rendering its own status.
    let row = build_attempt_row(json!({
        "provider_status": 502,
        "error_category": "provider_http_502",
    }));
    assert_eq!(row_status_code(&row), "502");
    assert_eq!(attempt_status_code(&row), Some("502".to_string()));
}
