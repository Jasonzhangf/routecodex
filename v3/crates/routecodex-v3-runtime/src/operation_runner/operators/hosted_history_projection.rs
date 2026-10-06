//! Narrow registered helper for the single current hosted-history event.
//!
//! The normalizer stores one complete hosted event as its original JSON value
//! under a registered `routecodex_chat_extension` key. This module reads that
//! one current event through its recorded source/current association and
//! derives the transient provider representations the standard Outbound
//! emitters need. It never stores a second control value, clones canonical
//! truth into a new slot, or calls the retired hosted codec.

use serde_json::{json, Map, Value};

use super::field_operator_library::profile_index;
use super::field_operator_profiles::HostedHistoryCase;
use super::project_canonical_paths::read_path;
use crate::operation_runner::{CurrentFieldAssociations, RequestInverseContext};

/// Canonical carrier key that holds generated extension data.
pub const HOSTED_HISTORY_EXTENSION_ROOT: &str = "routecodex_chat_extension";

/// Simple typed emission data derived from one current hosted event. Every
/// field is a transient representation derived from the same current value;
/// the full business value stays data.
#[derive(Clone, Debug, PartialEq)]
pub struct HostedHistoryEmission {
    /// Canonical message index of the single hosted anchor.
    pub canonical_message_index: usize,
    /// Original source item index inside the configured source container.
    pub source_index: usize,
    /// Selected or generated representation identity.
    pub identity: String,
    /// Action-derived transient call arguments (object value).
    pub arguments: Value,
    /// The complete current native event value.
    pub event: Value,
    /// Transient Chat assistant function-call message.
    pub chat_assistant: Value,
    /// Adjacent transient Chat tool-result message.
    pub chat_tool_result: Value,
    /// Anthropic native hosted blocks (`server_tool_use` then
    /// `web_search_tool_result`).
    pub anthropic_blocks: Vec<Value>,
}

fn registered_cases(
) -> Result<Vec<(&'static str, &'static str, &'static HostedHistoryCase)>, String> {
    Ok(profile_index()?.hosted_history_cases().collect())
}

fn split_trailing_index(source_path: &str) -> Option<(&str, usize)> {
    let open = source_path.rfind('[')?;
    let rest = source_path.get(open + 1..)?;
    let digits = rest.strip_suffix(']')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let index = digits.parse::<usize>().ok()?;
    Some((&source_path[..open], index))
}

fn canonical_message_index(destination: &str) -> Option<usize> {
    let marker = "chat.messages";
    let start = destination.find(marker)?;
    let suffix = destination.get(start + marker.len()..)?;
    let digits = suffix.strip_prefix('[')?.split(']').next()?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse::<usize>().ok()
}

fn whole_event_suffix(case: &HostedHistoryCase) -> String {
    format!(
        ".{HOSTED_HISTORY_EXTENSION_ROOT}.{}",
        case.canonical_extension_key()
    )
}

/// Locate the single registered whole-event mapping for a source item path.
/// Returns the mapping index when the item path maps to a registered hosted
/// extension destination. Child member mappings (deeper source paths) never
/// match.
pub(super) fn hosted_anchor_mapping_index(
    inverse: &RequestInverseContext,
    item_path: &str,
) -> Result<Option<usize>, String> {
    let cases = registered_cases()?;
    for (mapping_index, mapping) in inverse.field_mappings.iter().enumerate() {
        if mapping.source_path != item_path {
            continue;
        }
        let Some((base, _index)) = split_trailing_index(&mapping.source_path) else {
            continue;
        };
        if !cases.iter().any(|(_, lookup_path, case)| {
            base == format!("request.{lookup_path}")
                && mapping.destination.ends_with(&whole_event_suffix(case))
        }) {
            continue;
        }
        return Ok(Some(mapping_index));
    }
    Ok(None)
}

/// Derive every registered hosted-history emission from the current canonical
/// value and its paired current associations, in canonical message order.
pub fn project_hosted_history_emissions(
    canonical: &Value,
    inverse: &RequestInverseContext,
    associations: &CurrentFieldAssociations,
) -> Result<Vec<HostedHistoryEmission>, String> {
    let cases = registered_cases()?;
    let mut emissions = Vec::new();
    for (mapping_index, mapping) in inverse.field_mappings.iter().enumerate() {
        let Some((_protocol, _lookup_path, case)) = cases.iter().find(|(_, lookup_path, case)| {
            split_trailing_index(&mapping.source_path)
                .is_some_and(|(base, _)| base == format!("request.{lookup_path}"))
                && mapping.destination.ends_with(&whole_event_suffix(case))
        }) else {
            continue;
        };
        let Some((_base, source_index)) = split_trailing_index(&mapping.source_path) else {
            continue;
        };
        let Some(destination) = associations.destination_for_original_mapping(mapping_index) else {
            continue;
        };
        let Some(canonical_message_index) = canonical_message_index(destination) else {
            continue;
        };
        let Some(event) = read_path(canonical, destination)? else {
            continue;
        };
        emissions.push(build_emission(
            case,
            source_index,
            canonical_message_index,
            event,
        ));
    }
    emissions.sort_by_key(|emission| (emission.canonical_message_index, emission.source_index));
    Ok(emissions)
}

fn build_emission(
    case: &HostedHistoryCase,
    source_index: usize,
    canonical_message_index: usize,
    event: &Value,
) -> HostedHistoryEmission {
    let identity = select_identity(case, event, source_index);
    let arguments = derive_arguments(case, event);
    let (chat_assistant, chat_tool_result) = chat_pair(case, event, &identity, &arguments);
    let anthropic_blocks = anthropic_blocks(case, event, &identity, &arguments);
    HostedHistoryEmission {
        canonical_message_index,
        source_index,
        identity,
        arguments,
        event: event.clone(),
        chat_assistant,
        chat_tool_result,
        anthropic_blocks,
    }
}

/// First usable nonempty identity string wins; otherwise a stable
/// representation identity appends the original source item index. Nonstring,
/// null and empty identities never reject the business payload.
fn select_identity(case: &HostedHistoryCase, event: &Value, source_index: usize) -> String {
    if let Some(object) = event.as_object() {
        for path in case.identity_paths() {
            if let Some(value) = object.get(path).and_then(Value::as_str) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    format!("{}_{}", case.generated_identity_prefix(), source_index)
}

/// Ordered call-argument policy: an object is used directly, a nonobject value
/// is preserved under `value`, and an absent value becomes an empty object.
fn derive_arguments(case: &HostedHistoryCase, event: &Value) -> Value {
    if let Some(object) = event.as_object() {
        for path in case.argument_paths() {
            if let Some(value) = object.get(path) {
                if value.is_object() {
                    return value.clone();
                }
                return json!({ "value": value.clone() });
            }
        }
    }
    Value::Object(Map::new())
}

fn chat_pair(
    case: &HostedHistoryCase,
    event: &Value,
    identity: &str,
    arguments: &Value,
) -> (Value, Value) {
    let arguments_json = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string());
    let result_json = serde_json::to_string(event).unwrap_or_else(|_| "null".to_string());
    let assistant = json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": [{
            "id": identity,
            "type": "function",
            "function": {
                "name": case.function_name(),
                "arguments": arguments_json,
            },
        }],
    });
    let tool_result = json!({
        "role": "tool",
        "tool_call_id": identity,
        "content": result_json,
    });
    (assistant, tool_result)
}

fn anthropic_blocks(
    case: &HostedHistoryCase,
    event: &Value,
    identity: &str,
    arguments: &Value,
) -> Vec<Value> {
    let call_block = json!({
        "type": case.native_call_block_type(),
        "id": identity,
        "name": case.function_name(),
        "input": arguments.clone(),
    });
    let result_block = json!({
        "type": case.native_result_block_type(),
        "tool_use_id": identity,
        "content": outcome_members(event, case.native_result_excluded_fields()),
    });
    vec![call_block, result_block]
}

/// Keep every current outcome and unknown sibling; exclude only the configured
/// identity/type fields that the paired native blocks already represent.
fn outcome_members(event: &Value, excluded: &[String]) -> Value {
    match event.as_object() {
        Some(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| !excluded.iter().any(|excluded| excluded == *key))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        None => event.clone(),
    }
}
