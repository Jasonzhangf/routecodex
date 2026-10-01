//! Request-scope trace and dry-run helpers for the endpoint entry.
//!
//! These helpers own the protocol-plan and relay-handoff `node_trace` plumbing
//! and the provider-failure observation merge across the direct/relay seam, plus
//! the provider-request dry-run header check and target label used by the entry.
//! Pure structural extraction from `endpoint_handlers`; no behavior change.

use crate::*;
use axum::http::HeaderMap;
use serde_json::{json, Value};

pub(crate) fn is_provider_request_dry_run(headers: &HeaderMap) -> bool {
    headers
        .get("x-routecodex-dry-run")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("provider-request"))
}

pub(super) fn resolve_v3_dry_run_target_label(state: &V3ListenerState) -> String {
    state
        .manifest
        .providers
        .values()
        .find_map(|provider| {
            let auth_alias = provider.auth.entries.first()?.alias.as_str();
            let model = provider.models.values().next()?;
            Some(format!(
                "{}[{}].{}",
                provider.id, auth_alias, model.wire_name
            ))
        })
        .unwrap_or_else(|| "-".to_string())
}

pub(crate) fn merge_v3_protocol_plan_trace(
    mut plan_trace: Vec<&'static str>,
    runtime_trace: Vec<&'static str>,
) -> Vec<&'static str> {
    plan_trace.extend(runtime_trace);
    plan_trace
}

pub(crate) fn prepend_v3_protocol_plan_trace_to_foundation_output(
    output: &mut V3FoundationRuntimeOutput,
    plan_trace: &[&'static str],
) {
    let merged = merge_v3_protocol_plan_trace(plan_trace.to_vec(), output.node_trace.clone());
    output.node_trace = merged.clone();
    if let Some(dry_run) = output
        .body
        .get_mut("dry_run")
        .and_then(Value::as_object_mut)
    {
        dry_run.insert("node_ids".to_string(), json!(merged));
    }
}

pub(crate) fn prepend_v3_protocol_plan_trace_to_responses_relay_output(
    output: &mut V3ResponsesRelayRuntimeOutput,
    plan_trace: &[&'static str],
) {
    output.node_trace =
        merge_v3_protocol_plan_trace(plan_trace.to_vec(), output.node_trace.clone());
}

pub(crate) fn prepend_v3_relay_handoff_trace_to_direct_frame(
    frame: &mut V3Server16HttpFrame,
    relay_trace: &[&'static str],
) {
    frame.node_trace = merge_v3_protocol_plan_trace(relay_trace.to_vec(), frame.node_trace.clone());
}

pub(crate) fn merge_v3_direct_handoff_provider_failure_events(
    output: &mut V3ResponsesRelayRuntimeOutput,
    direct_events: Vec<V3RuntimeProviderFailureObservation>,
) {
    if direct_events.is_empty() {
        return;
    }
    let observability = output.observability.get_or_insert_with(Default::default);
    let mut merged = direct_events;
    merged.append(&mut observability.provider_failure_events);
    observability.provider_failure_events = merged;
}

pub(crate) fn merge_v3_relay_handoff_provider_failure_events_into_direct_frame(
    frame: &mut V3Server16HttpFrame,
    relay_events: Vec<V3RuntimeProviderFailureObservation>,
) {
    if relay_events.is_empty() {
        return;
    }
    let observability = frame.observability.get_or_insert_with(Default::default);
    let mut merged = relay_events;
    merged.append(&mut observability.provider_failure_events);
    observability.provider_failure_events = merged;
}
