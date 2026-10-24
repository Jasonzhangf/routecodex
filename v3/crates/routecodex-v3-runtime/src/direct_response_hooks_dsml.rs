//! Complete Responses Direct tool-envelope projection. No routing or error policy.
use super::V3DirectResponseHookFailure;
use crate::tool_markup_parser::{
    scan_tool_markup, ParsedToolCall, ToolMarkupDeclarations, ToolMarkupIdentity, ToolMarkupKind,
    ToolMarkupParamKind, ToolMarkupSegment,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub(crate) struct V3DirectDsmlContext {
    tools: HashMap<String, DsmlToolIdentity>,
    declarations: ToolMarkupDeclarations,
}

#[derive(Clone, PartialEq)]
struct DsmlToolIdentity {
    namespace: Option<String>,
    leaf: String,
}

fn declared_parameter_objects(source: &Value) -> Option<&Map<String, Value>> {
    source
        .get("parameters")
        .or_else(|| source.pointer("/function/parameters"))
        .and_then(|parameters| parameters.get("properties"))
        .and_then(Value::as_object)
}

fn declared_parameter_kinds(source: &Value) -> HashMap<String, ToolMarkupParamKind> {
    declared_parameter_objects(source)
        .map(|properties| {
            properties
                .iter()
                .filter_map(|(name, schema)| {
                    schema
                        .get("type")
                        .and_then(Value::as_str)
                        .map(|kind| (name.clone(), ToolMarkupParamKind::declared(kind)))
                })
                .collect()
        })
        .unwrap_or_default()
}

impl V3DirectDsmlContext {
    /// True when no tool markup declaration can match provider output. The
    /// complete-attempt DSML rewrite still removes the standalone protocol
    /// labels for such requests, so it is not the identity; the caller must
    /// leave the early commit to the Direct content probe, which refuses to
    /// certify a prefix that carries a label.
    pub(crate) fn has_no_declared_tools(&self) -> bool {
        self.declarations.is_empty()
    }

    /// Resolve dispatch identities through the single declaration owner
    /// (`NamespaceToolIdentityRegistry`) and bind them to the exact attempt
    /// inverse (provider wire name -> client namespace + leaf). The registry
    /// owns nested namespace recursion and every supported discovery channel;
    /// this module never traverses declarations itself.
    pub(crate) fn from_request(body: &Value, inverse: &HashMap<String, (String, String)>) -> Self {
        use provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry;
        let mut result = Self::default();
        if body["tool_choice"] == "none" {
            return result;
        }
        let Ok(registry) = NamespaceToolIdentityRegistry::from_request(body, "openai-responses")
        else {
            return result;
        };
        let mut ambiguous = HashSet::new();
        for identity in registry.identities() {
            let namespace = identity
                .is_namespaced()
                .then(|| identity.client_namespace());
            let resolved = DsmlToolIdentity {
                namespace: namespace.clone(),
                leaf: identity.leaf_name.clone(),
            };
            let declaration = ToolMarkupIdentity {
                kind: match identity.kind {
                    provider_compat_core::namespace_tools::ToolKind::Function => {
                        ToolMarkupKind::Function
                    }
                    provider_compat_core::namespace_tools::ToolKind::Custom => {
                        ToolMarkupKind::Custom
                    }
                },
                parameter_kinds: declared_parameter_kinds(&identity.source),
            };
            // The exact attempt inverse is authoritative for the wire name.
            // A plain declaration whose wire name equals its leaf keeps the
            // leaf binding; a renamed plain declaration also keeps its wire.
            let keys = std::iter::once(identity.leaf_name.clone())
                .chain(
                    inverse
                        .iter()
                        .filter(|(_, (ns, leaf))| {
                            leaf == &identity.leaf_name
                                && Some(ns.as_str()) == namespace.as_deref().or(Some(""))
                        })
                        .map(|(wire, _)| wire.clone()),
                )
                .chain(
                    identity
                        .is_namespaced()
                        .then(|| identity.actual_wire_name.clone()),
                );
            for key in keys {
                if result.tools.get(&key).is_some_and(|old| old != &resolved) {
                    ambiguous.insert(key.clone());
                }
                result.tools.insert(key.clone(), resolved.clone());
                result.declarations.insert(key, declaration.clone());
            }
        }
        for name in ambiguous {
            result.tools.remove(&name);
            result.declarations.remove(&name);
        }
        result
    }
}

fn fresh_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{prefix}_dsml_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn dsml_function_call(identity: &DsmlToolIdentity, arguments: String, call_id: String) -> Value {
    let mut call = json!({"id":fresh_id("fc"),"type":"function_call","call_id":call_id,"name":identity.leaf.clone(),"arguments":arguments,"status":"completed"});
    if let Some(namespace) = &identity.namespace {
        call["namespace"] = namespace.clone().into();
    }
    call
}

fn direct_function_call(call: ParsedToolCall<'_>, context: &V3DirectDsmlContext) -> Value {
    let identity = context
        .tools
        .get(call.wire_name)
        .expect("declaration and Direct identity are built together");
    let call_id = call
        .call_id
        .map(str::to_owned)
        .unwrap_or_else(|| fresh_id("call"));
    dsml_function_call(identity, call.arguments, call_id)
}

struct Replacement {
    old: usize,
    start: usize,
    items: Vec<Value>,
}

fn normalize(
    payload: &mut Value,
    context: &V3DirectDsmlContext,
) -> Result<Vec<Replacement>, V3DirectResponseHookFailure> {
    normalize_with_protected(payload, context, &HashSet::new())
}

fn complete_native_call(item: &Value) -> bool {
    // A native model call remains business content even when its name or
    // arguments are invalid. Only serialized text needs harvesting here.
    matches!(
        item["type"].as_str(),
        Some("function_call" | "custom_tool_call")
    )
}

fn only_removable_labels_remain(output: &[Value]) -> bool {
    output.iter().all(|item| {
        item["type"] == "message"
            && item["content"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .all(|part| part["text"].as_str().is_some_and(|text| text.is_empty()))
            })
    })
}

fn rewrite_finish_reason(payload: &mut Value) {
    for path in [
        "/finish_reason",
        "/response/finish_reason",
        "/choices/0/finish_reason",
    ] {
        let Some(slot) = payload.pointer_mut(path) else {
            continue;
        };
        if slot.as_str() == Some("stop") {
            *slot = "tool_calls".into();
        }
    }
}

/// Output indexes whose carrier events carry opaque extensions that the
/// synthesized replacement events cannot faithfully inherit keep their original
/// provider text and payload.
fn normalize_with_protected(
    payload: &mut Value,
    context: &V3DirectDsmlContext,
    protected: &HashSet<usize>,
) -> Result<Vec<Replacement>, V3DirectResponseHookFailure> {
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(Vec::new());
    };
    let old_text = joined_text(output);
    let native_complete_call = output.iter().any(complete_native_call);
    let mut next = Vec::new();
    let mut plans = Vec::new();
    let mut opening_tool_label = false;
    let mut harvested_calls = 0usize;
    let mut incomplete_invocation = false;
    let mut opaque_invocation = false;
    for (index, item) in output.iter().enumerate() {
        if protected.contains(&index) {
            next.push(item.clone());
            continue;
        }
        let Some(parts) = item.get("content").and_then(Value::as_array) else {
            next.push(item.clone());
            continue;
        };
        if !known_message_item(item) {
            next.push(item.clone());
            continue;
        }
        let mut items = Vec::new();
        let mut content = Vec::new();
        let mut changed = false;
        for part in parts {
            let scan = scan_tool_markup(part["text"].as_str().unwrap(), &context.declarations);
            changed |= scan.removed_label;
            opening_tool_label |= scan.opener_label;
            incomplete_invocation |= scan.incomplete_tool_invocation;
            opaque_invocation |= scan.opaque_invocation;
            for segment in scan.segments {
                match segment {
                    ToolMarkupSegment::Text(text) => {
                        let mut p = part.clone();
                        p["text"] = text.into();
                        content.push(p);
                    }
                    ToolMarkupSegment::Calls(calls) => {
                        changed = true;
                        harvested_calls += calls.len();
                        flush_message(item, &mut content, &mut items);
                        items.extend(
                            calls
                                .into_iter()
                                .map(|call| direct_function_call(call, context)),
                        );
                    }
                }
            }
        }
        if changed {
            flush_message(item, &mut content, &mut items);
            plans.push(Replacement {
                old: index,
                start: next.len(),
                items: items.clone(),
            });
            next.extend(items);
        } else {
            next.push(item.clone());
        }
    }
    if incomplete_invocation
        || (opening_tool_label
            && !opaque_invocation
            && !native_complete_call
            && harvested_calls == 0
            && !only_removable_labels_remain(&next))
    {
        return Err(V3DirectResponseHookFailure::UnharvestableToolMarkup);
    }
    if !plans.is_empty() {
        *output = next;
        refresh_matching_aggregate(payload, &old_text);
        if harvested_calls > 0 {
            rewrite_finish_reason(payload);
        }
    }
    Ok(plans)
}

fn known_message_item(item: &Value) -> bool {
    item["type"] == "message"
        && item["role"] == "assistant"
        && item.get("id").is_none_or(Value::is_string)
        && item.get("status").is_none_or(Value::is_string)
        && item["content"]
            .as_array()
            .is_some_and(|parts| parts.iter().all(known_text_part))
        && item.as_object().is_some_and(|o| {
            o.keys()
                .all(|k| matches!(k.as_str(), "id" | "type" | "role" | "status" | "content"))
        })
}

fn known_text_part(part: &Value) -> bool {
    part["type"] == "output_text"
        && part["text"].is_string()
        && part.as_object().is_some_and(|o| {
            o.keys()
                .all(|k| matches!(k.as_str(), "type" | "text" | "annotations" | "logprobs"))
        })
        && part
            .get("annotations")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
        && empty_logprobs(part)
}

fn empty_logprobs(value: &Value) -> bool {
    value
        .get("logprobs")
        .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
}

fn joined_text(output: &[Value]) -> String {
    output
        .iter()
        .filter_map(|i| i["content"].as_array())
        .flatten()
        .filter_map(|p| p["text"].as_str())
        .collect()
}

fn refresh_matching_aggregate(payload: &mut Value, original: &str) {
    if payload.get("output_text").and_then(Value::as_str) == Some(original) {
        if let Some(output) = payload["output"].as_array() {
            payload["output_text"] = joined_text(output).into();
        }
    }
}

fn flush_message(original: &Value, content: &mut Vec<Value>, items: &mut Vec<Value>) {
    if content.is_empty() {
        return;
    }
    let mut item = original.clone();
    if !items.is_empty() || original.get("id").is_none() {
        item["id"] = fresh_id("msg").into();
    }
    item["content"] = Value::Array(std::mem::take(content));
    items.push(item);
}

pub(crate) fn normalize_v3_direct_dsml_response(
    payload: &mut Value,
    context: &V3DirectDsmlContext,
) -> Result<(), V3DirectResponseHookFailure> {
    normalize(payload, context).map(|_| ())
}

/// The event-level extension keys the synthesized replacement events keep.
/// A replaced carrier event that carries any other data field cannot have it
/// associated with the projected result, so its item keeps provider text.
const KNOWN_EVENT_FIELDS: &[&str] = &[
    "type",
    "output_index",
    "content_index",
    "item_id",
    "delta",
    "text",
    "item",
    "part",
    "sequence_number",
    "logprobs",
];

fn event_has_unrepresentable_extension(event: &Value) -> bool {
    event.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|key| !KNOWN_EVENT_FIELDS.contains(&key.as_str()))
    }) || !empty_logprobs(event)
        || event
            .get("item")
            .is_some_and(|item| !known_message_item(item))
        || event.get("part").is_some_and(|part| !known_text_part(part))
}

fn unique_terminal_indexes(
    items: &[Value],
    key: impl Fn(&Value) -> Option<String>,
) -> HashMap<String, Option<usize>> {
    let mut indexes = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        let Some(key) = key(item) else {
            continue;
        };
        indexes
            .entry(key)
            .and_modify(|slot: &mut Option<usize>| *slot = None)
            .or_insert(Some(index));
    }
    indexes
}

struct TerminalAssociation {
    types: Vec<Option<String>>,
    by_id: HashMap<String, Option<usize>>,
    by_call_id: HashMap<String, Option<usize>>,
    by_wire_index: HashMap<usize, Option<usize>>,
}

fn bind_association<K: Eq + std::hash::Hash>(
    bindings: &mut HashMap<K, Option<usize>>,
    key: K,
    index: usize,
) {
    bindings
        .entry(key)
        .and_modify(|slot| {
            if *slot != Some(index) {
                *slot = None;
            }
        })
        .or_insert(Some(index));
}

impl TerminalAssociation {
    fn new(items: &[Value]) -> Self {
        Self {
            types: items
                .iter()
                .map(|item| item["type"].as_str().map(str::to_owned))
                .collect(),
            by_id: unique_terminal_indexes(items, |item| item["id"].as_str().map(str::to_owned)),
            by_call_id: unique_terminal_indexes(items, |item| {
                item["call_id"].as_str().map(str::to_owned)
            }),
            by_wire_index: HashMap::new(),
        }
    }

    fn bind_events<'a>(&mut self, events: impl Iterator<Item = &'a Value>) {
        let events: Vec<_> = events.collect();
        // A native item may have a new terminal ID while its call ID remains
        // stable. Bind its wire ID once for subsequent argument-only events.
        for event in &events {
            if let Some(item) = event.get("item") {
                if let (Some(index), Some(id)) = (self.item_index(item), item["id"].as_str()) {
                    bind_association(&mut self.by_id, id.to_owned(), index);
                }
            }
        }
        for event in events {
            let index = if let Some(item) = event.get("item") {
                self.item_index(item)
            } else {
                self.lookup(event["item_id"].as_str(), event["call_id"].as_str(), None)
            };
            if let (Some(index), Some(wire)) = (index, event["output_index"].as_u64()) {
                bind_association(&mut self.by_wire_index, wire as usize, index);
            }
        }
    }

    fn lookup(
        &self,
        id: Option<&str>,
        call_id: Option<&str>,
        item_type: Option<&str>,
    ) -> Option<usize> {
        let by_id = id.and_then(|id| self.by_id.get(id).copied().flatten());
        let by_call = call_id.and_then(|id| self.by_call_id.get(id).copied().flatten());
        if matches!((by_id, by_call), (Some(left), Some(right)) if left != right) {
            return None;
        }
        by_id.or(by_call).filter(|index| {
            item_type.is_none_or(|item_type| {
                self.types
                    .get(*index)
                    .and_then(Option::as_deref)
                    .is_none_or(|terminal_type| terminal_type == item_type)
            })
        })
    }

    fn item_index(&self, item: &Value) -> Option<usize> {
        self.lookup(
            item["id"].as_str(),
            item["call_id"].as_str(),
            item["type"].as_str(),
        )
    }

    fn event_index(&self, event: &Value) -> Option<usize> {
        let identity = if let Some(item) = event.get("item") {
            self.item_index(item)
        } else {
            self.lookup(event["item_id"].as_str(), event["call_id"].as_str(), None)
        };
        identity.or_else(|| {
            event["output_index"]
                .as_u64()
                .and_then(|wire| self.by_wire_index.get(&(wire as usize)).copied().flatten())
        })
    }
}

fn event_requires_message_association(event: &Value) -> bool {
    if let Some(item) = event.get("item") {
        return item["type"] == "message";
    }
    if event.get("part").is_some() {
        return event
            .get("part")
            .is_some_and(|part| part["type"] == "output_text");
    }
    matches!(
        event["type"].as_str(),
        Some(
            "response.content_part.added"
                | "response.content_part.done"
                | "response.output_text.delta"
                | "response.output_text.done"
        )
    )
}

fn projected_terminal_index(index: usize, plans: &[Replacement]) -> usize {
    plans.iter().find(|plan| plan.old == index).map_or_else(
        || {
            let shift: isize = plans
                .iter()
                .filter(|plan| plan.old < index)
                .map(|plan| plan.items.len() as isize - 1)
                .sum();
            (index as isize + shift).max(0) as usize
        },
        |plan| plan.start,
    )
}

fn rewrite_snapshot(
    snapshot: &mut Vec<Value>,
    plans: &[Replacement],
    association: &TerminalAssociation,
) -> bool {
    let original = std::mem::take(snapshot);
    let mut unknown = Vec::new();
    let mut associated = Vec::new();
    for item in original {
        if let Some(index) = association.item_index(&item) {
            associated.push((index, item));
        } else if item["type"] == "message" {
            return false;
        } else {
            if !associated.is_empty() {
                return false;
            }
            unknown.push(item);
        }
    }
    associated.sort_by_key(|(index, _)| *index);
    let mut next = unknown;
    for (index, item) in associated {
        if let Some(plan) = plans.iter().find(|plan| plan.old == index) {
            next.extend(plan.items.clone());
        } else {
            next.push(item);
        }
    }
    *snapshot = next;
    true
}

pub(crate) fn rewrite_v3_direct_dsml_attempt(
    frames: &[Vec<u8>],
    flushed: usize,
    context: &V3DirectDsmlContext,
) -> Result<Option<(Vec<Vec<u8>>, usize)>, V3DirectResponseHookFailure> {
    use routecodex_v3_sse::{
        build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
    };
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut events = Vec::new();
    for bytes in frames {
        let Ok(decoded) = decoder.push(build_v3_sse_transport_in_01_raw_chunk(bytes)) else {
            return Ok(None);
        };
        for frame in decoded {
            let data = frame
                .frame()
                .fields()
                .iter()
                .filter_map(|f| match f {
                    SseField::Named { name, value } if name == "data" => Some(value.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let value = serde_json::from_str::<Value>(&data).ok();
            events.push((frame, value));
        }
    }
    if decoder.finish().is_err() {
        return Ok(None);
    }
    let Some(terminal) = events.iter().position(|(_, v)| {
        v.as_ref().is_some_and(|v| {
            matches!(
                v["type"].as_str(),
                Some("response.completed" | "response.incomplete")
            )
        })
    }) else {
        return Ok(None);
    };
    let Some(terminal_response) = events[terminal].1.as_ref().map(|event| &event["response"])
    else {
        return Ok(None);
    };
    let terminal_items = terminal_response["output"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut association = TerminalAssociation::new(&terminal_items);
    association.bind_events(events.iter().filter_map(|(_, value)| value.as_ref()));
    let mut protected: HashSet<usize> = HashSet::new();
    let mut unbound_wire_indexes = Vec::new();
    for (_, value) in events.iter() {
        let Some(event) = value.as_ref() else {
            continue;
        };
        let carrier = matches!(
            event["type"].as_str(),
            Some(
                "response.output_item.added"
                    | "response.output_item.done"
                    | "response.content_part.added"
                    | "response.content_part.done"
                    | "response.output_text.delta"
                    | "response.output_text.done"
            )
        );
        if carrier && event_has_unrepresentable_extension(event) {
            if let Some(index) = association.event_index(event) {
                protected.insert(index);
            } else if event_requires_message_association(event) {
                return Ok(None);
            } else if let Some(index) = event["output_index"].as_u64() {
                unbound_wire_indexes.push(index as usize);
            }
        }
        let snapshot = matches!(
            event["type"].as_str(),
            Some(
                "response.created"
                    | "response.in_progress"
                    | "response.queued"
                    | "response.completed"
                    | "response.incomplete"
            )
        );
        if carrier || snapshot {
            continue;
        }
        // An unrecognized event with an item association cannot be regenerated
        // or safely re-indexed by this owner. Its affected item keeps provider
        // text so the association remains faithful.
        let index = association.event_index(event);
        if let Some(index) = index {
            protected.insert(index);
        } else if let Some(index) = event["output_index"].as_u64() {
            unbound_wire_indexes.push(index as usize);
        }
    }
    let mut response = terminal_response.clone();
    let plans = normalize_with_protected(&mut response, context, &protected)?;
    if plans.is_empty() {
        return Ok(None);
    }
    // An unbound earlier carrier keeps its original wire slot. A rewrite
    // before it could change that association, so retain the original attempt
    // when the affected ordering cannot be established from identities.
    if !unbound_wire_indexes.is_empty() {
        let first_changed_wire = association
            .by_wire_index
            .iter()
            .filter_map(|(wire, index)| {
                index
                    .filter(|index| plans.iter().any(|plan| plan.old == *index))
                    .map(|_| *wire)
            })
            .min();
        if first_changed_wire
            .is_none_or(|first| unbound_wire_indexes.iter().any(|index| *index >= first))
        {
            return Ok(None);
        }
    }
    // A committed client channel is append-only, so every frame that already
    // crossed it must leave this rewrite byte-identical. The commit probe holds
    // the tail from the first governed marker on, which means a flushed prefix
    // can only carry the leading carrier frames of the item this rewrite
    // harvests. Emit the rest of that item from the delivered carrier state and
    // append the synthesized items after it, keeping the client's frame
    // coordinates and text intact.
    if flushed > 0 && events.len() != frames.len() {
        return Err(V3DirectResponseHookFailure::UnharvestableToolMarkup);
    }
    let flushed = flushed.min(events.len());
    let delivered = delivered_carrier_state(&events, flushed, &association, &plans);
    let kinds = original_carrier_kinds(&events, &association, &plans);
    let mut output = Vec::new();
    let mut emitted = vec![false; plans.len()];
    let mut sequence = flushed as u64;
    let mut terminal_index = 0;
    for (position, (frame, value)) in events.into_iter().enumerate() {
        if position < flushed {
            output.push(frames[position].clone());
            continue;
        }
        let Some(mut event) = value.filter(|v| {
            v.get("type")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        }) else {
            output.push(
                routecodex_v3_sse::build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(
                    &frame,
                )
                .into_bytes(),
            );
            continue;
        };
        let index = association.event_index(&event);
        if let Some((pi, plan)) = plans
            .iter()
            .enumerate()
            .find(|(_, plan)| Some(plan.old) == index)
        {
            // Known item/content events are replaced together. Unknown extension events survive.
            if matches!(
                event["type"].as_str(),
                Some(
                    "response.output_item.added"
                        | "response.output_item.done"
                        | "response.content_part.added"
                        | "response.content_part.done"
                        | "response.output_text.delta"
                        | "response.output_text.done"
                )
            ) {
                let transport = frame.frame().fields().iter().filter(|f| !matches!(f, SseField::Named{name,..} if name == "event" || name == "data")).cloned().collect::<Vec<_>>();
                if !transport.is_empty() {
                    let Some(encoded) = encode_fields(transport) else {
                        return Ok(None);
                    };
                    output.push(encoded);
                }
                if !emitted[pi] {
                    if !resume_emitted_items(
                        &mut output,
                        &mut sequence,
                        plan,
                        delivered.get(&plan.old),
                        kinds.get(&plan.old),
                    ) {
                        return Err(V3DirectResponseHookFailure::UnharvestableToolMarkup);
                    }
                    emitted[pi] = true;
                }
                continue;
            }
        }
        if let Some(index) = index {
            if let Some(slot) = event.get_mut("output_index") {
                *slot = projected_terminal_index(index, &plans).into();
            }
        }
        if position == terminal {
            for (pi, plan) in plans.iter().enumerate() {
                if !emitted[pi] {
                    if !resume_emitted_items(
                        &mut output,
                        &mut sequence,
                        plan,
                        delivered.get(&plan.old),
                        kinds.get(&plan.old),
                    ) {
                        return Err(V3DirectResponseHookFailure::UnharvestableToolMarkup);
                    }
                }
            }
            event["response"] = response.clone();
            terminal_index = output.len();
        } else if matches!(
            event["type"].as_str(),
            Some("response.created" | "response.in_progress" | "response.queued")
        ) {
            if let Some(snapshot_response) = event.get_mut("response") {
                if let Some(snapshot) = snapshot_response
                    .get_mut("output")
                    .and_then(Value::as_array_mut)
                {
                    let old_text = joined_text(snapshot);
                    let mut next = snapshot.clone();
                    if !rewrite_snapshot(&mut next, &plans, &association) {
                        return Ok(None);
                    }
                    *snapshot = next;
                    refresh_matching_aggregate(snapshot_response, &old_text);
                }
            }
        }
        event["sequence_number"] = sequence.into();
        sequence += 1;
        let Some(rendered) = render_original_event(&frame, &event, &plans, &association) else {
            return Ok(None);
        };
        output.push(rendered);
    }
    Ok(Some((output, terminal_index)))
}

/// Preserve untouched JSON values as raw text, including numbers outside f64
/// precision and duplicate opaque fields. Only declared protocol fields change.
pub(crate) struct RawObject(Vec<(String, Box<serde_json::value::RawValue>)>);

impl<'de> serde::Deserialize<'de> for RawObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
            type Value = RawObject;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<RawObject, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry()? {
                    fields.push(field);
                }
                Ok(RawObject(fields))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

impl RawObject {
    pub(crate) fn get(&self, name: &str) -> Option<&serde_json::value::RawValue> {
        let mut matches = self.0.iter().filter(|(key, _)| key == name);
        let (_, value) = matches.next()?;
        matches.next().is_none().then_some(value.as_ref())
    }
    pub(crate) fn set(&mut self, name: &str, json: String) -> Option<()> {
        let value = serde_json::value::RawValue::from_string(json).ok()?;
        let mut slots = self.0.iter_mut().filter(|(key, _)| key == name);
        if let Some((_, slot)) = slots.next() {
            if slots.next().is_some() {
                return None;
            }
            *slot = value;
        } else {
            self.0.push((name.to_owned(), value));
        }
        Some(())
    }
    pub(crate) fn render(&self) -> String {
        format!(
            "{{{}}}",
            self.0
                .iter()
                .map(|(key, value)| format!("{}:{}", Value::String(key.clone()), value.get()))
                .collect::<Vec<_>>()
                .join(",")
        )
    }
}

fn planned_output_item(item: &Value, plans: &[Replacement]) -> bool {
    plans
        .iter()
        .flat_map(|plan| plan.items.iter())
        .any(|planned| planned == item)
}

fn render_rewritten_output(
    original_items: &[Value],
    original_raw: &[Box<serde_json::value::RawValue>],
    rewritten: &[Value],
    plans: &[Replacement],
    association: &TerminalAssociation,
) -> Option<String> {
    if original_raw.len() != original_items.len() {
        return None;
    }
    let mut output = Vec::new();
    for item in rewritten {
        if planned_output_item(item, plans) {
            output.push(item.to_string());
            continue;
        }
        let mut candidates = Vec::new();
        if let Some(index) = association.item_index(item) {
            candidates.extend(
                original_items
                    .iter()
                    .enumerate()
                    .filter(|(_, original)| association.item_index(original) == Some(index))
                    .map(|(index, _)| index),
            );
        }
        if candidates.is_empty() {
            if let Some(id) = item["id"].as_str() {
                candidates.extend(
                    original_items
                        .iter()
                        .enumerate()
                        .filter(|(_, original)| original["id"].as_str() == Some(id))
                        .map(|(index, _)| index),
                );
            }
        }
        if candidates.is_empty() {
            if let Some(call_id) = item["call_id"].as_str() {
                candidates.extend(
                    original_items
                        .iter()
                        .enumerate()
                        .filter(|(_, original)| original["call_id"].as_str() == Some(call_id))
                        .map(|(index, _)| index),
                );
            }
        }
        candidates.dedup();
        if let [index] = candidates.as_slice() {
            output.push(original_raw[*index].get().to_owned());
        } else {
            return None;
        }
    }
    Some(format!("[{}]", output.join(",")))
}

fn render_original_event(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
    event: &Value,
    plans: &[Replacement],
    association: &TerminalAssociation,
) -> Option<Vec<u8>> {
    use routecodex_v3_sse::*;
    let data = frame
        .frame()
        .fields()
        .iter()
        .filter_map(|f| match f {
            SseField::Named { name, value } if name == "data" => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let original: Value = serde_json::from_str(&data).ok()?;
    let mut raw: RawObject = serde_json::from_str(&data).ok()?;
    for key in ["output_index", "sequence_number"] {
        if event.get(key) != original.get(key) {
            raw.set(key, event.get(key)?.to_string())?;
        }
    }
    if event.get("response") != original.get("response") {
        let mut response: RawObject = serde_json::from_str(raw.get("response")?.get()).ok()?;
        let original_response: Value = serde_json::from_str(raw.get("response")?.get()).ok()?;
        let original_items = original_response["output"].as_array()?;
        let original_raw: Vec<Box<serde_json::value::RawValue>> =
            serde_json::from_str(response.get("output")?.get()).ok()?;
        let rewritten = event["response"]["output"].as_array()?;
        let output =
            render_rewritten_output(original_items, &original_raw, rewritten, plans, association)?;
        response.set("output", output)?;
        if event["response"].get("output_text") != original["response"].get("output_text") {
            response.set("output_text", event["response"]["output_text"].to_string())?;
        }
        if event["response"].get("finish_reason") != original["response"].get("finish_reason") {
            response.set(
                "finish_reason",
                event["response"]["finish_reason"].to_string(),
            )?;
        }
        raw.set("response", response.render())?;
    }
    if event.get("finish_reason") != original.get("finish_reason") {
        raw.set("finish_reason", event.get("finish_reason")?.to_string())?;
    }
    if event.get("choices") != original.get("choices") && original.get("choices").is_some() {
        let mut choices: Vec<RawObject> = serde_json::from_str(raw.get("choices")?.get()).ok()?;
        if let Some(first) = choices.first_mut() {
            first.set(
                "finish_reason",
                event.pointer("/choices/0/finish_reason")?.to_string(),
            )?;
        }
        raw.set(
            "choices",
            format!(
                "[{}]",
                choices
                    .iter()
                    .map(RawObject::render)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        )?;
    }
    let mut inserted = false;
    let mut fields = Vec::new();
    for field in frame.frame().fields() {
        if matches!(field, SseField::Named{name,..} if name == "data") {
            if !inserted {
                fields.push(SseField::Named {
                    name: "data".into(),
                    value: raw.render(),
                });
                inserted = true;
            }
        } else {
            fields.push(field.clone());
        }
    }
    encode_fields(fields)
}

fn encode_fields(fields: Vec<routecodex_v3_sse::SseField>) -> Option<Vec<u8>> {
    use routecodex_v3_sse::*;
    let decoded = build_v3_sse_transport_in_02_from_fields(fields).ok()?;
    let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded).ok()?;
    Some(build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes())
}

fn push_event(output: &mut Vec<Vec<u8>>, sequence: &mut u64, mut event: Value) -> bool {
    use routecodex_v3_sse::*;
    event["sequence_number"] = (*sequence).into();
    *sequence += 1;
    let fields = vec![
        SseField::Named {
            name: "event".into(),
            value: event["type"].as_str().unwrap_or("message").into(),
        },
        SseField::Named {
            name: "data".into(),
            value: event.to_string(),
        },
    ];
    let Some(frame) = encode_fields(fields) else {
        return false;
    };
    output.push(frame);
    true
}

fn emit_item(output: &mut Vec<Vec<u8>>, sequence: &mut u64, index: usize, item: &Value) -> bool {
    let mut added = item.clone();
    added["status"] = "in_progress".into();
    if item["type"] == "function_call" {
        added["arguments"] = "".into();
    } else {
        added["content"] = json!([]);
    }
    if !push_event(
        output,
        sequence,
        json!({"type":"response.output_item.added","output_index":index,"item":added}),
    ) {
        return false;
    }
    if item["type"] == "function_call" {
        for kind in [
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ] {
            let mut event = json!({"type":kind,"output_index":index,"item_id":item["id"],"call_id":item["call_id"]});
            event[if kind.ends_with("delta") {
                "delta"
            } else {
                "arguments"
            }] = item["arguments"].clone();
            if !push_event(output, sequence, event) {
                return false;
            }
        }
    } else if let Some(parts) = item["content"].as_array() {
        for (ci, part) in parts.iter().enumerate() {
            let mut added_part = part.clone();
            if part["type"] == "output_text" {
                added_part["text"] = "".into();
            }
            if !push_event(
                output,
                sequence,
                json!({"type":"response.content_part.added","output_index":index,"item_id":item["id"],"content_index":ci,"part":added_part}),
            ) {
                return false;
            }
            if part["type"] == "output_text" {
                if !push_event(
                    output,
                    sequence,
                    json!({"type":"response.output_text.delta","output_index":index,"item_id":item["id"],"content_index":ci,"delta":part["text"]}),
                ) {
                    return false;
                }
                if !push_event(
                    output,
                    sequence,
                    json!({"type":"response.output_text.done","output_index":index,"item_id":item["id"],"content_index":ci,"text":part["text"]}),
                ) {
                    return false;
                }
            }
            if !push_event(
                output,
                sequence,
                json!({"type":"response.content_part.done","output_index":index,"item_id":item["id"],"content_index":ci,"part":part}),
            ) {
                return false;
            }
        }
    }
    push_event(
        output,
        sequence,
        json!({"type":"response.output_item.done","output_index":index,"item":item}),
    )
}

fn emit_items(output: &mut Vec<Vec<u8>>, sequence: &mut u64, plan: &Replacement) {
    for (offset, item) in plan.items.iter().enumerate() {
        let _ = emit_item(output, sequence, plan.start + offset, item);
    }
}

/// Carrier state that already crossed the committed client channel for the
/// items this rewrite harvests. The commit probe holds the tail from the first
/// governed marker on, so only the leading carrier frames of the harvested item
/// can be flushed; everything after them is rewritten here.
#[derive(Default)]
struct DeliveredItem {
    added: bool,
    id: Option<String>,
    parts: HashMap<usize, DeliveredPart>,
    done: bool,
}

#[derive(Default)]
struct DeliveredPart {
    added: bool,
    text: String,
    text_done: bool,
    part_done: bool,
}

/// Carrier event kinds the provider itself used for a harvested item. A
/// provider may stream text as bare deltas without `output_item.added` or
/// `content_part.added`; the continuation must then close that item with the
/// same shapes, or the client would receive an `added` event after text it
/// already aggregated.
#[derive(Default, Clone, Copy)]
struct CarrierKinds {
    part_added: bool,
    delta: bool,
    text_done: bool,
    part_done: bool,
    item_done: bool,
}

fn original_carrier_kinds(
    events: &[(
        routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
        Option<Value>,
    )],
    association: &TerminalAssociation,
    plans: &[Replacement],
) -> HashMap<usize, CarrierKinds> {
    let mut kinds: HashMap<usize, CarrierKinds> = HashMap::new();
    for (_, value) in events.iter() {
        let Some(event) = value.as_ref() else {
            continue;
        };
        let Some(index) = association.event_index(event) else {
            continue;
        };
        if !plans.iter().any(|plan| plan.old == index) {
            continue;
        }
        let slot = kinds.entry(index).or_default();
        match event["type"].as_str() {
            Some("response.content_part.added") => slot.part_added = true,
            Some("response.output_text.delta") => slot.delta = true,
            Some("response.output_text.done") => slot.text_done = true,
            Some("response.content_part.done") => slot.part_done = true,
            Some("response.output_item.done") => slot.item_done = true,
            _ => {}
        }
    }
    kinds
}

fn delivered_carrier_state(
    events: &[(
        routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
        Option<Value>,
    )],
    flushed: usize,
    association: &TerminalAssociation,
    plans: &[Replacement],
) -> HashMap<usize, DeliveredItem> {
    let mut delivered: HashMap<usize, DeliveredItem> = HashMap::new();
    for (_, value) in events.iter().take(flushed) {
        let Some(event) = value.as_ref() else {
            continue;
        };
        let Some(index) = association.event_index(event) else {
            continue;
        };
        if !plans.iter().any(|plan| plan.old == index) {
            continue;
        }
        let slot = delivered.entry(index).or_default();
        if slot.id.is_none() {
            slot.id = event
                .pointer("/item/id")
                .and_then(Value::as_str)
                .or_else(|| event["item_id"].as_str())
                .map(str::to_owned);
        }
        let content_index = event["content_index"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        match event["type"].as_str() {
            Some("response.output_item.added") => {
                slot.added = true;
            }
            Some("response.output_item.done") => slot.done = true,
            Some("response.content_part.added") => {
                slot.parts.entry(content_index).or_default().added = true;
            }
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    slot.parts
                        .entry(content_index)
                        .or_default()
                        .text
                        .push_str(delta);
                }
            }
            Some("response.output_text.done") => {
                let part = slot.parts.entry(content_index).or_default();
                if let Some(text) = event["text"].as_str() {
                    part.text = text.to_owned();
                }
                part.text_done = true;
            }
            Some("response.content_part.done") => {
                slot.parts.entry(content_index).or_default().part_done = true;
            }
            _ => {}
        }
    }
    delivered
}

/// Emit one plan where the provider stream left it. A plan whose leading
/// carrier frames were already flushed continues from the delivered text and
/// part state instead of repeating it, so every frame the client saw stays
/// byte-identical while the terminal snapshot keeps the full planned output.
/// The continuation repeats only the carrier kinds the provider itself used for
/// that item: a provider that streams bare deltas without `output_item.added`
/// or `content_part.added` gets the same bare shape back, never an `added`
/// event after text the client already aggregated.
fn resume_emitted_items(
    output: &mut Vec<Vec<u8>>,
    sequence: &mut u64,
    plan: &Replacement,
    delivered: Option<&DeliveredItem>,
    kinds: Option<&CarrierKinds>,
) -> bool {
    let Some(delivered) =
        delivered.filter(|delivered| delivered.added || !delivered.parts.is_empty())
    else {
        emit_items(output, sequence, plan);
        return true;
    };
    let kinds = kinds.copied().unwrap_or_default();
    let Some(first) = plan.items.first() else {
        return true;
    };
    if first["type"] != "message"
        || delivered
            .id
            .as_deref()
            .is_some_and(|id| first["id"].as_str() != Some(id))
    {
        return false;
    }
    let index = plan.start;
    for (content_index, part) in first["content"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        let part_state = delivered.parts.get(&content_index);
        if kinds.part_added && !part_state.is_some_and(|part_state| part_state.added) {
            let mut added_part = part.clone();
            if part["type"] == "output_text" {
                added_part["text"] = "".into();
            }
            if !push_event(
                output,
                sequence,
                json!({"type":"response.content_part.added","output_index":index,"item_id":first["id"],"content_index":content_index,"part":added_part}),
            ) {
                return false;
            }
        }
        if part["type"] == "output_text" {
            let text = part["text"].as_str().unwrap_or_default();
            let Some(remaining) =
                text.strip_prefix(part_state.map_or("", |part_state| part_state.text.as_str()))
            else {
                return false;
            };
            if !remaining.is_empty() {
                if !kinds.delta
                    || !push_event(
                        output,
                        sequence,
                        json!({"type":"response.output_text.delta","output_index":index,"item_id":first["id"],"content_index":content_index,"delta":remaining}),
                    )
                {
                    return false;
                }
            }
            if kinds.text_done
                && !part_state.is_some_and(|part_state| part_state.text_done)
                && !push_event(
                    output,
                    sequence,
                    json!({"type":"response.output_text.done","output_index":index,"item_id":first["id"],"content_index":content_index,"text":text}),
                )
            {
                return false;
            }
        }
        if kinds.part_done
            && !part_state.is_some_and(|part_state| part_state.part_done)
            && !push_event(
                output,
                sequence,
                json!({"type":"response.content_part.done","output_index":index,"item_id":first["id"],"content_index":content_index,"part":part}),
            )
        {
            return false;
        }
    }
    if kinds.item_done
        && !delivered.done
        && !push_event(
            output,
            sequence,
            json!({"type":"response.output_item.done","output_index":index,"item":first}),
        )
    {
        return false;
    }
    for (offset, item) in plan.items.iter().enumerate().skip(1) {
        if !emit_item(output, sequence, plan.start + offset, item) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_markup_parser::{ASCII_TOOL_CALLS, CLOSE, END_INVOKE, END_PARAM, OPEN};
    fn sample(text: &str) -> Value {
        json!({"status":"completed","output_text":text,"output":[{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}],"usage":{"output_tokens":42},"extension":{"keep":true}})
    }
    fn context() -> V3DirectDsmlContext {
        V3DirectDsmlContext::from_request(
            &json!({"tools":[{"type":"function","name":"read_image"}]}),
            &HashMap::new(),
        )
    }
    fn call(value: &str) -> String {
        format!("{OPEN}<｜｜DSML｜｜ invoke name=\"read_image\"><｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">{value}{END_PARAM}{END_INVOKE}{CLOSE}")
    }

    #[test]
    fn direct_dsml_empty_logprobs_convert_but_values_remain_opaque() {
        let mut part = json!({"type":"output_text","text":call("x"),"logprobs":[]});
        assert!(known_text_part(&part));
        part["logprobs"] = json!([{"token":"x","logprob":-1.0}]);
        assert!(!known_text_part(&part));
        let mut event = json!({"type":"response.output_text.delta","delta":"x","logprobs":[]});
        assert!(!event_has_unrepresentable_extension(&event));
        event["logprobs"] = part["logprobs"].clone();
        assert!(event_has_unrepresentable_extension(&event));
    }

    #[test]
    fn direct_dsml_preserves_values_text_and_native_content() {
        let block = call(" /tmp/图像.png\n ");
        let text = format!("Before\n{block}\nAfter");
        let mut payload = sample(&text);
        payload["output"].as_array_mut().unwrap().push(json!({"id":"native","type":"function_call","call_id":"original","name":"other","arguments":"invalid but model owned"}));
        let native = payload["output"][1].clone();
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        assert_eq!(payload["output"][0]["content"][0]["text"], "Before\n");
        assert_eq!(
            serde_json::from_str::<Value>(payload["output"][1]["arguments"].as_str().unwrap())
                .unwrap(),
            json!({"file_path":" /tmp/图像.png\n "})
        );
        assert_eq!(payload["output"][2]["content"][0]["text"], "\nAfter");
        assert_eq!(payload["output"][3], native);
        assert_eq!(payload["usage"]["output_tokens"], 42);
        assert_eq!(payload["extension"], json!({"keep":true}));
        assert_eq!(payload["output_text"], "Before\n\nAfter");
    }

    #[test]
    fn direct_dsml_literal_incomplete_unknown_and_duplicate_are_unchanged() {
        let block = call("x");
        let duplicate = block.replace(END_INVOKE, &format!("<｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">y{END_PARAM}{END_INVOKE}"));
        for text in [
            format!("```xml\n{block}\n```"),
            format!("`{block}`"),
            format!("``{block}``"),
            format!("“{block}”"),
            format!("「{block}」"),
            format!("    {block}"),
            format!("> quoted example\n{block}"),
            format!("\"quoted {block}\""),
            format!("'{block}'"),
            format!("> {block}"),
            block.replace("name=\"read_image\"", "name=\"undeclared\""),
            block.replace(
                "name=\"read_image\"",
                "name=\"read_image\" unknown=\"keep\"",
            ),
            duplicate,
        ] {
            let mut payload = sample(&text);
            let original = payload.clone();
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert_eq!(payload, original, "must preserve literal: {text}");
        }
    }

    #[test]
    fn direct_dsml_truncated_declared_invocation_is_rejected_not_preserved() {
        // The complete outer envelope is missing, but the declared function
        // invocation and its delimited parameter are recognized executable
        // leakage rather than literal text.
        let text = call("x").replace(CLOSE, "");
        let mut payload = sample(&text);
        let error = normalize_v3_direct_dsml_response(&mut payload, &context())
            .expect_err("a truncated declared invocation must reject the attempt");
        assert!(matches!(
            error,
            V3DirectResponseHookFailure::UnharvestableToolMarkup
        ));
    }

    #[test]
    fn direct_dsml_truncated_invocation_beside_complete_call_rejects_whole_attempt() {
        let complete = call("keep");
        let truncated_fullwidth = call("lost").replace(CLOSE, "");
        let text = format!("{complete}\n{truncated_fullwidth}");
        let mut payload = sample(&text);
        let error = normalize_v3_direct_dsml_response(&mut payload, &context())
            .expect_err("a truncated sibling invocation must reject the attempt");
        assert!(matches!(
            error,
            V3DirectResponseHookFailure::UnharvestableToolMarkup
        ));
    }

    #[test]
    fn direct_dsml_multiple_calls_restore_declared_namespace_and_preserve_ids() {
        let request = json!({"tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"read_image"}]}]});
        let inverse = HashMap::from([(
            "functions__read_image".into(),
            ("functions".into(), "read_image".into()),
        )]);
        let context = V3DirectDsmlContext::from_request(&request, &inverse);
        let first = call("first").replace(
            "name=\"read_image\"",
            "name=\"read_image\" call_id=\"upstream_call\"",
        );
        let second =
            call("second").replace("name=\"read_image\"", "name=\"functions__read_image\"");
        let mut payload = sample(&format!("{first}\n{second}"));
        normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
        let calls: Vec<_> = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "function_call")
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["namespace"], "functions");
        assert_eq!(calls[1]["namespace"], "functions");
        assert_eq!(calls[0]["call_id"], "upstream_call");
        assert_ne!(calls[0]["call_id"], calls[1]["call_id"]);
        let mut literal = sample(&call("x"));
        let original = literal.clone();
        let mut disabled = request;
        disabled["tool_choice"] = "none".into();
        normalize_v3_direct_dsml_response(
            &mut literal,
            &V3DirectDsmlContext::from_request(&disabled, &inverse),
        )
        .unwrap();
        assert_eq!(literal, original);
    }

    fn dispatch_context(request: &Value) -> V3DirectDsmlContext {
        V3DirectDsmlContext::from_request(
            request,
            &provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
                request,
                "openai-responses",
            )
            .unwrap()
            .restore_identities(),
        )
    }

    fn function_call(payload: &Value) -> &Value {
        payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call")
            .expect("DSML must become a native call")
    }

    fn message(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type":"output_text","text":text,"annotations":[]}]
        })
    }

    fn sse_frame(event: Value) -> Vec<u8> {
        format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap()
        )
        .into_bytes()
    }

    fn sse_events(frames: &[Vec<u8>]) -> Vec<Value> {
        String::from_utf8(frames.concat())
            .unwrap()
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    #[test]
    fn direct_dsml_native_invalid_business_fields_do_not_trigger_markup_failure() {
        let native = json!({"type":"function_call","name":"","call_id":"invalid_call","arguments":{"model_generated":"invalid"}});
        let mut payload = sample(ASCII_TOOL_CALLS);
        payload["output"]
            .as_array_mut()
            .unwrap()
            .push(native.clone());
        normalize_v3_direct_dsml_response(&mut payload, &context())
            .expect("native business result must remain available for client correction");
        assert_eq!(payload["output"], json!([native]));
    }

    #[test]
    fn direct_dsml_calls_close_residue_keeps_native_calls_and_literals() {
        let native = json!({"type":"function_call","id":"native","name":"exec_command","call_id":"native_call","arguments":"{\"cmd\":\"printf 42\"}","status":"completed"});
        for text in [
            " calls>",
            "Before\n calls>\nAfter",
            "Before\r\n calls>\r\nAfter",
        ] {
            let mut payload = sample(text);
            payload["output"]
                .as_array_mut()
                .unwrap()
                .push(native.clone());
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert_eq!(payload["output"].as_array().unwrap().last(), Some(&native));
            assert!(
                !joined_text(payload["output"].as_array().unwrap()).contains(" calls>"),
                "residue leaked: {payload}"
            );
        }
        for text in [
            "The token calls> is discussed here.",
            "\" calls>\"",
            "` calls>`",
            "```text\n calls>\n```",
            "    calls>",
            "> calls>",
        ] {
            let mut payload = sample(text);
            payload["output"]
                .as_array_mut()
                .unwrap()
                .push(native.clone());
            let original = payload.clone();
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert_eq!(payload, original, "literal changed");
        }
    }

    #[test]
    fn direct_dsml_exact_standalone_closing_fragments() {
        for text in [" calls>", "｜｜DSML｜｜ calls>"] {
            let mut payload = sample(text);
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert_eq!(
                payload["output"],
                json!([]),
                "standalone closing fragment must be removed: {text:?}"
            );
            assert_eq!(payload["output_text"], "");
        }
        for (text, expected) in [
            ("Before\n calls>\nAfter", "Before\nAfter"),
            ("Before\r\n calls>\r\nAfter", "Before\r\nAfter"),
            ("Before\n｜｜DSML｜｜ calls>\nAfter", "Before\nAfter"),
        ] {
            let mut payload = sample(text);
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            let actual = payload["output"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["type"] == "message")
                .flat_map(|item| item["content"].as_array().unwrap())
                .filter_map(|part| part["text"].as_str())
                .collect::<String>();
            assert_eq!(actual, expected);
        }
        let native = json!({"type":"function_call","id":"native","name":"exec_command","call_id":"native_call","arguments":"not-json","status":"completed"});
        for text in [
            "The token calls> is discussed here.",
            "\" calls>\"",
            "\"｜｜DSML｜｜ calls>\"",
            "` calls>`",
            "```text\n calls>\n｜｜DSML｜｜ calls>\n```",
            "    calls>",
            "> ｜｜DSML｜｜ calls>",
        ] {
            let mut payload = sample(text);
            payload["output"]
                .as_array_mut()
                .unwrap()
                .push(native.clone());
            let original = payload.clone();
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert_eq!(
                payload, original,
                "literal closing fragment changed: {text:?}"
            );
        }
    }

    #[test]
    fn direct_dsml_ambiguous_native_raw_items_are_not_reserialized() {
        let wire = concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[",
            "{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\" calls>\"}]},",
            "{\"id\":\"duplicate\",\"type\":\"function_call\",\"call_id\":\"duplicate\",\"name\":\"\",\"arguments\":{},\"opaque\":123456789012345678901234567890,\"vendor\":1,\"vendor\":2},",
            "{\"id\":\"duplicate\",\"type\":\"function_call\",\"call_id\":\"duplicate\",\"name\":\"\",\"arguments\":{},\"opaque\":987654321098765432109876543210,\"vendor\":3,\"vendor\":4}",
            "]}}\n\n"
        );
        assert!(
            rewrite_v3_direct_dsml_attempt(&[wire.as_bytes().to_vec()], 0, &context())
                .unwrap()
                .is_none(),
            "ambiguous original items must keep their raw values and duplicate fields"
        );
    }

    #[test]
    fn direct_dsml_reordered_index_only_opaque_event_protects_its_message() {
        let message = message("stable_message", CLOSE);
        let native = json!({"id":"native_terminal","type":"function_call","call_id":"stable_call","name":"read_image","arguments":"{}"});
        let frames = vec![
            sse_frame(
                json!({"type":"response.output_item.added","output_index":0,"item":{"id":"native_wire","type":"function_call","call_id":"stable_call","name":"read_image","arguments":""}}),
            ),
            sse_frame(
                json!({"type":"response.output_item.added","output_index":1,"item":message.clone()}),
            ),
            sse_frame(
                json!({"type":"response.vendor.association","output_index":1,"opaque":"preserve message association"}),
            ),
            sse_frame(
                json!({"type":"response.completed","response":{"status":"completed","output":[message,native]}}),
            ),
        ];
        assert!(
            rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
                .unwrap()
                .is_none(),
            "index-only opaque event lost its associated original message"
        );
    }

    #[test]
    fn direct_dsml_demonstrated_close_sequence_and_tool_prefix_are_removed() {
        let native =
            json!({"type":"function_call","name":"read_image","call_id":"keep","arguments":"{}"});
        let mut payload = sample("Before\n\n>\n>\n</｜｜DSML｜｜ calls>");
        payload["output"]
            .as_array_mut()
            .unwrap()
            .push(native.clone());
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        assert_eq!(
            joined_text(payload["output"].as_array().unwrap()),
            "Before\n\n"
        );
        assert_eq!(payload["output"].as_array().unwrap().last(), Some(&native));

        let mut payload = sample("Before\n calls><tool_call>read_image<arg_key>file_path</arg_key><arg_value>x</arg_value></tool_call>\nAfter");
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        assert_eq!(
            joined_text(payload["output"].as_array().unwrap()),
            "Before\n\nAfter"
        );
        assert!(payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "function_call"));
    }

    #[test]
    fn direct_dsml_tool_call_arg_key_value_grammar_uses_declared_types() {
        let request = json!({"tools":[
            {
                "type":"function",
                "name":"exec_command",
                "parameters":{"type":"object","properties":{
                    "cmd":{"type":"string"},
                    "max_output_tokens":{"type":"integer"},
                    "yield_time_ms":{"type":"integer"}
                }}
            },
            {
                "type":"function",
                "name":"write_stdin",
                "parameters":{"type":"object","properties":{
                    "chars":{"type":"string"},
                    "session_id":{"type":"integer"},
                    "yield_time_ms":{"type":"integer"}
                }}
            }
        ]});
        let context = dispatch_context(&request);
        let text = concat!(
            "Run it.\n",
            "<tool_call>exec_command",
            "<arg_key>cmd</arg_key><arg_value>printf 42</arg_value>",
            "</tool_call>\n",
            "<tool_call>write_stdin",
            "<arg_key>chars</arg_key><arg_value></arg_value>",
            "<arg_key>session_id</arg_key><arg_value>123456789012345678901234567890</arg_value>",
            "<arg_key>yield_time_ms</arg_key><arg_value>30000</arg_value>",
            "</tool_call>\nDone."
        );
        let mut payload = sample(text);
        normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
        let calls: Vec<_> = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call")
            .collect();
        assert_eq!(calls.len(), 2, "{payload}");
        assert_eq!(calls[0]["name"], "exec_command");
        assert_eq!(
            serde_json::from_str::<Value>(calls[0]["arguments"].as_str().unwrap()).unwrap(),
            json!({"cmd":"printf 42"})
        );
        assert_eq!(calls[1]["name"], "write_stdin");
        let write_stdin = calls[1]["arguments"].as_str().unwrap();
        assert_eq!(
            write_stdin,
            "{\"chars\":\"\",\"session_id\":123456789012345678901234567890,\"yield_time_ms\":30000}"
        );
        assert!(!payload.to_string().contains("<tool_call>"));
        assert!(!payload.to_string().contains("<arg_key>"));
    }

    #[test]
    fn direct_dsml_unharvestable_tool_call_rejects_beside_prose_and_native_sibling() {
        let native = json!({"type":"function_call","id":"native","name":"exec_command","call_id":"native_call","arguments":"not-json","status":"completed"});
        for text in [
            "Continue.\n<tool_call>exec_command<arg_key>cmd</arg_key><arg_value>printf 42</arg_value>",
        ] {
            let mut payload = sample(text);
            payload["output"].as_array_mut().unwrap().push(native.clone());
            let error = normalize_v3_direct_dsml_response(
                &mut payload,
                &dispatch_context(&json!({"tools":[{"type":"function","name":"exec_command"}]})),
            )
            .expect_err("recognized unharvestable tool_call must reject the attempt");
            assert!(matches!(
                error,
                V3DirectResponseHookFailure::UnharvestableToolMarkup
            ));
        }
    }

    #[test]
    fn direct_dsml_complete_opaque_and_unknown_calls_preserve_native_sibling() {
        let native = json!({"type":"function_call","id":"native","name":"exec_command","call_id":"native_call","arguments":"not-json","status":"completed"});
        for text in [
            "Continue.\n<tool_call>undeclared<arg_key>cmd</arg_key><arg_value>printf 42</arg_value></tool_call>",
            "Continue.\n<tool_call>exec_command<arg_key>cmd</arg_key><arg_value>printf 42</arg_value><arg_key>cmd</arg_key><arg_value>x</arg_value></tool_call>",
            "<|exec_command\">\n<cmd>a</cmd>\n<cmd>b</cmd>\n</exec_command>",
        ] {
            let mut payload = sample(text);
            payload["output"].as_array_mut().unwrap().push(native.clone());
            let original = payload.clone();
            normalize_v3_direct_dsml_response(
                &mut payload,
                &dispatch_context(&json!({"tools":[{"type":"function","name":"exec_command"}]})),
            ).expect("unknown and complete opaque calls remain business data");
            assert_eq!(payload, original);
        }
    }

    #[test]
    fn direct_dsml_tool_call_literal_counterexamples_remain_text() {
        let invocation = "<tool_call>exec_command<arg_key>cmd</arg_key><arg_value>printf 42</arg_value></tool_call>";
        let context =
            dispatch_context(&json!({"tools":[{"type":"function","name":"exec_command"}]}));
        let native = json!({"type":"function_call","id":"native","name":"exec_command","call_id":"native_call","arguments":"not-json","status":"completed"});
        for text in [
            format!("\"{invocation}\""),
            format!("`{invocation}`"),
            format!("```text\n{invocation}\n```"),
            format!("    {invocation}"),
            format!("> {invocation}"),
        ] {
            let mut payload = sample(&text);
            payload["output"]
                .as_array_mut()
                .unwrap()
                .push(native.clone());
            let original = payload.clone();
            normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
            assert_eq!(payload, original, "literal invocation changed: {text}");
        }
    }

    #[test]
    fn direct_dsml_sse_reordered_native_association_uses_stable_identity() {
        let reasoning_terminal = json!({
            "id":"reasoning_terminal",
            "type":"reasoning",
            "summary":[{"type":"summary_text","text":"keep reasoning"}]
        });
        let message_terminal = message("message_stable", CLOSE);
        let native_terminal = json!({
            "id":"fc_terminal",
            "type":"function_call",
            "call_id":"call_stable",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"printf 42\"}",
            "status":"completed"
        });
        let response = json!({
            "id":"resp_reordered",
            "object":"response",
            "status":"completed",
            "output_text":CLOSE,
            "output":[
                reasoning_terminal.clone(),
                message_terminal.clone(),
                native_terminal.clone()
            ],
            "usage":{"output_tokens":3}
        });
        let opaque_number = "123456789012345678901234567890";
        let frames = vec![
            sse_frame(json!({
                "type":"response.created",
                "response":{
                    "id":"resp_reordered",
                    "status":"in_progress",
                    "output":[
                        {"id":"reasoning_wire","type":"reasoning","summary":[]},
                        {"id":"fc_wire","type":"function_call","call_id":"call_stable","name":"exec_command","arguments":"","status":"in_progress"},
                        {"id":"message_stable","type":"message","role":"assistant","content":[]}
                    ]
                }
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"id":"reasoning_wire","type":"reasoning","summary":[]}
            })),
            sse_frame(json!({
                "type":"response.reasoning_summary_text.delta",
                "output_index":0,
                "item_id":"reasoning_wire",
                "summary_index":0,
                "delta":"retained reasoning prefix"
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":1,
                "item":{
                    "id":"fc_wire",
                    "type":"function_call",
                    "call_id":"call_stable",
                    "name":"exec_command",
                    "arguments":"",
                    "status":"in_progress",
                    "vendor_data":{"business":"native-carrier-kept"}
                }
            })),
            format!(
                "event: response.vendor.native\ndata: {{\"type\":\"response.vendor.native\",\"output_index\":1,\"item_id\":\"fc_wire\",\"call_id\":\"call_stable\",\"opaque_number\":{opaque_number}}}\n\n"
            )
            .into_bytes(),
            sse_frame(json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"call_stable",
                "delta":"{\"cmd\":\"printf 42\"}"
            })),
            sse_frame(json!({
                "type":"response.function_call_arguments.done",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"call_stable",
                "arguments":"{\"cmd\":\"printf 42\"}"
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":1,
                "item":{
                    "id":"fc_wire",
                    "type":"function_call",
                    "call_id":"call_stable",
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"printf 42\"}",
                    "status":"completed",
                    "vendor_data":{"business":"native-done-kept"}
                }
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":2,
                "item":{"id":"message_stable","type":"message","role":"assistant","content":[]}
            })),
            sse_frame(json!({
                "type":"response.output_text.delta",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "delta":CLOSE
            })),
            sse_frame(json!({
                "type":"response.output_text.done",
                "output_index":2,
                "content_index":0,
                "item_id":"message_stable",
                "text":CLOSE
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":2,
                "item":message_terminal.clone()
            })),
            sse_frame(json!({"type":"response.completed","response":response})),
        ];
        let (rewritten, _) = rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
            .unwrap()
            .expect("reordered native and message identities must be rewritten");
        let wire = String::from_utf8(rewritten.concat()).unwrap();
        assert!(!wire.contains(CLOSE), "known CLOSE leaked: {wire}");
        assert!(wire.contains("native-carrier-kept"), "{wire}");
        assert!(wire.contains("native-done-kept"), "{wire}");
        assert!(
            wire.contains(&format!("\"opaque_number\":{opaque_number}")),
            "opaque raw number changed: {wire}"
        );
        let events = sse_events(&rewritten);
        let terminal = events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(
            terminal["response"]["output"],
            json!([reasoning_terminal, native_terminal])
        );
        let native_added: Vec<_> = events
            .iter()
            .filter(|event| {
                event["type"] == "response.output_item.added"
                    && event["item"]["type"] == "function_call"
            })
            .collect();
        assert_eq!(native_added.len(), 1, "{wire}");
        assert_eq!(native_added[0]["output_index"], 1, "{wire}");
        assert!(events.iter().all(|event| {
            event["type"] != "response.output_text.delta"
                || !event["delta"].as_str().unwrap().contains(CLOSE)
        }));
    }

    #[test]
    fn direct_dsml_sse_reordered_expansion_shifts_native_and_snapshots() {
        let native_terminal = json!({
            "id":"fc_terminal",
            "type":"function_call",
            "call_id":"call_stable",
            "name":"exec_command",
            "arguments":"{\"cmd\":\"printf 42\"}",
            "status":"completed"
        });
        let expanded_text = format!("Before\n{}\nAfter", call("owned.png"));
        let message_terminal = message("message_stable", &expanded_text);
        let response = json!({
            "id":"resp_expand",
            "object":"response",
            "status":"completed",
            "output_text":expanded_text,
            "output":[native_terminal.clone(), message_terminal.clone()],
            "usage":{"output_tokens":4}
        });
        let frames = vec![
            sse_frame(json!({
                "type":"response.created",
                "response":{
                    "id":"resp_expand",
                    "status":"in_progress",
                    "output":[
                        {"id":"message_stable","type":"message","role":"assistant","content":[]},
                        {"id":"fc_wire","type":"function_call","call_id":"call_stable","name":"exec_command","arguments":"","status":"in_progress"}
                    ]
                }
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"id":"message_stable","type":"message","role":"assistant","content":[]}
            })),
            sse_frame(json!({
                "type":"response.output_text.delta",
                "output_index":0,
                "content_index":0,
                "item_id":"message_stable",
                "delta":expanded_text
            })),
            sse_frame(json!({
                "type":"response.output_text.done",
                "output_index":0,
                "content_index":0,
                "item_id":"message_stable",
                "text":expanded_text
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":0,
                "item":message_terminal
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":1,
                "item":{"id":"fc_wire","type":"function_call","call_id":"call_stable","name":"exec_command","arguments":""}
            })),
            sse_frame(json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"call_stable",
                "delta":"{\"cmd\":\"printf 42\"}"
            })),
            sse_frame(json!({
                "type":"response.function_call_arguments.done",
                "output_index":1,
                "item_id":"fc_wire",
                "call_id":"call_stable",
                "arguments":"{\"cmd\":\"printf 42\"}"
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":1,
                "item":native_terminal.clone()
            })),
            sse_frame(json!({"type":"response.completed","response":response})),
        ];
        let (rewritten, _) = rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
            .unwrap()
            .expect("reordered expansion must rewrite every associated carrier");
        let events = sse_events(&rewritten);
        let terminal = events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(terminal["response"]["output"][0], native_terminal);
        assert_eq!(terminal["response"]["output"][1]["type"], "message");
        assert_eq!(
            terminal["response"]["output"][1]["content"][0]["text"],
            "Before\n"
        );
        assert_eq!(terminal["response"]["output"][2]["type"], "function_call");
        assert_eq!(terminal["response"]["output"][3]["type"], "message");
        let native_added = events
            .iter()
            .find(|event| {
                event["type"] == "response.output_item.added"
                    && event["item"]["type"] == "function_call"
                    && event["item"]["call_id"] == "call_stable"
            })
            .unwrap();
        assert_eq!(native_added["output_index"], 0);
        let created = events
            .iter()
            .find(|event| event["type"] == "response.created")
            .unwrap();
        assert_eq!(created["response"]["output"][0]["call_id"], "call_stable");
        assert_eq!(created["response"]["output"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn direct_dsml_red_orphan_labels_are_removed_and_native_items_preserved() {
        let reasoning = json!({
            "id": "reasoning_keep",
            "type": "reasoning",
            "summary": [{"type":"summary_text","text":"native reasoning"}]
        });
        let native_call = json!({
            "id": "fc_keep",
            "type": "function_call",
            "call_id": "call_keep",
            "name": "read_image",
            "arguments": "{\"file_path\":\"owned.png\"}",
            "status": "completed"
        });
        let label_messages = [
            message("open_only", OPEN),
            message("close_only", CLOSE),
            message("close_residue", ">\n</｜｜DSML｜｜ calls>"),
            message("bare_marker", "<｜｜DSML｜｜>"),
        ];
        let mut output = vec![label_messages[0].clone(), reasoning.clone()];
        output.push(label_messages[1].clone());
        output.push(native_call.clone());
        output.extend(label_messages[2..].iter().cloned());
        let mut payload = json!({
            "status": "completed",
            "output_text": label_messages
                .iter()
                .map(|item| item["content"][0]["text"].as_str().unwrap())
                .collect::<String>(),
            "output": output,
            "usage": {"output_tokens": 8},
            "extension": {"keep": true}
        });

        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();

        let survivors: Vec<_> = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] != "message")
            .cloned()
            .collect();
        assert_eq!(
            survivors,
            vec![reasoning, native_call],
            "orphan labels changed native reasoning or native tool items: {payload}"
        );
        assert!(
            payload["output"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["type"] != "message"),
            "text-only orphan labels must leave zero output messages: {payload}"
        );
        assert_eq!(payload["output_text"], "");
        assert_eq!(payload["usage"]["output_tokens"], 8);
        assert_eq!(payload["extension"], json!({"keep":true}));
    }

    #[test]
    fn direct_dsml_red_ascii_labels_and_analysis_lines_are_removed_from_prose() {
        for text in [
            "<|DSML|tool_calls>",
            "<|end▁of▁analysis|>",
            "<|end_of_analysis|>",
        ] {
            let mut payload = sample(text);
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            assert!(
                payload["output"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item["type"] != "message"),
                "label-only text must leave zero messages: {payload}"
            );
            assert_eq!(payload["output_text"], "");
        }
        for (name, text, expected) in [
            (
                "observed-analysis-spelling",
                "Observed.\n<|end▁of▁analysis|>\n",
                "Observed.\n",
            ),
            (
                "screenshot-analysis-spelling",
                "Earlier screenshot.\n<|end_of_analysis|>\n",
                "Earlier screenshot.\n",
            ),
        ] {
            let mut payload = sample(text);
            normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
            let message = payload["output"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "message")
                .unwrap_or_else(|| panic!("{name}: prose must survive"));
            assert_eq!(message["content"][0]["text"], expected, "{name}");
        }
        for text in [
            "Business text.\n<|DSML|tool_calls>\n".to_owned(),
            "Continue.\n<|end▁of▁analysis|>\n<|DSML|tool_calls>\n".to_owned(),
            format!("Business text.\n{OPEN}\n"),
        ] {
            let mut payload = sample(&text);
            let error = normalize_v3_direct_dsml_response(&mut payload, &context())
                .expect_err("tool intent without a complete call must reject");
            assert!(matches!(
                error,
                V3DirectResponseHookFailure::UnharvestableToolMarkup
            ));
        }

        let native = json!({
            "id": "fc_keep",
            "type": "function_call",
            "call_id": "call_keep",
            "name": "read_image",
            "arguments": "{\"file_path\":\"owned.png\"}",
            "status": "completed"
        });
        let mut payload = sample("Business text.\n<|DSML|tool_calls>\n");
        payload["output"]
            .as_array_mut()
            .unwrap()
            .push(native.clone());
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        assert_eq!(
            payload["output"][0]["content"][0]["text"],
            "Business text.\n"
        );
        assert_eq!(payload["output"][1], native);
    }

    #[test]
    fn direct_dsml_red_screenshot_exec_command_shape_is_harvested() {
        let request = json!({"tools":[{
            "type":"function",
            "name":"exec_command",
            "parameters":{
                "type":"object",
                "properties":{
                    "cmd":{"type":"string"},
                    "max_output_tokens":{"type":"integer"},
                    "yield_time_ms":{"type":"integer"}
                },
                "required":["cmd","max_output_tokens","yield_time_ms"]
            }
        }]});
        let text = "Continue.\n<|DSML|tool_calls>\n<|exec_command\">\n<cmd>printf 42</cmd>\n<max_output_tokens>4000</max_output_tokens>\n<yield_time_ms>30000</yield_time_ms>\n</exec_command>\n_command>";
        let mut payload = sample(text);
        payload["finish_reason"] = "stop".into();

        normalize_v3_direct_dsml_response(&mut payload, &dispatch_context(&request)).unwrap();

        let call = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call")
            .unwrap_or_else(|| {
                panic!("safe screenshot shape must become a native call: {payload}")
            });
        assert_eq!(call["name"], "exec_command");
        assert_eq!(
            serde_json::from_str::<Value>(call["arguments"].as_str().unwrap()).unwrap(),
            json!({
                "cmd":"printf 42",
                "max_output_tokens":4000,
                "yield_time_ms":30000
            })
        );
        let prose = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "message")
            .and_then(|item| item["content"][0]["text"].as_str());
        assert_eq!(prose, Some("Continue.\n"));
        let serialized = payload.to_string();
        for residue in [
            "<|DSML|tool_calls>",
            "<|exec_command\">",
            "<cmd>",
            "</cmd>",
            "<max_output_tokens>",
            "<yield_time_ms>",
            "</exec_command>",
            "_command>",
        ] {
            assert!(
                !serialized.contains(residue),
                "harvested screenshot residue {residue:?} leaked: {payload}"
            );
        }
        assert_eq!(
            payload["finish_reason"], "tool_calls",
            "an explicit stop terminal must follow the harvested call"
        );
    }

    #[test]
    fn direct_dsml_only_declared_incomplete_alternate_rejects_attempt() {
        let context =
            dispatch_context(&json!({"tools":[{"type":"function","name":"exec_command"}]}));
        let mut unknown = sample("Continue.\n<|undeclared_tool\">");
        let original = unknown.clone();
        normalize_v3_direct_dsml_response(&mut unknown, &context).unwrap();
        assert_eq!(unknown, original, "unknown opener remains business text");
        for text in [
            "Continue.\n<|exec_command\">".to_owned(),
            "Continue.\n<|exec_command\">\n<cmd>printf 42</cmd>".to_owned(),
        ] {
            let mut payload = sample(&text);
            let error = normalize_v3_direct_dsml_response(&mut payload, &context)
                .expect_err("an unharvestable alternate invocation must reject");
            assert!(matches!(
                error,
                V3DirectResponseHookFailure::UnharvestableToolMarkup
            ));
        }
    }

    #[test]
    fn direct_dsml_harvest_finish_reason_rewrites_stop_to_tool_calls() {
        let request = json!({"tools":[{"type":"function","name":"exec_command","parameters":{"type":"object","properties":{"cmd":{"type":"string"},"n":{"type":"integer"}}}}]});
        let context = dispatch_context(&request);
        let text = "Done.\n<|exec_command\">\n<cmd>printf 42</cmd>\n<n>123456789012345678901234567890</n>\n</exec_command>";

        let mut json_payload = sample(text);
        json_payload["finish_reason"] = "stop".into();
        normalize_v3_direct_dsml_response(&mut json_payload, &context).unwrap();
        assert_eq!(json_payload["finish_reason"], "tool_calls");
        let arguments = function_call(&json_payload)["arguments"].as_str().unwrap();
        assert!(
            arguments.contains("123456789012345678901234567890"),
            "numeric argument changed: {arguments}"
        );

        let mut response = sample(text);
        response["finish_reason"] = "stop".into();
        let frames = vec![
            sse_frame(json!({
                "type":"response.created",
                "response":{"id":"resp_finish","status":"in_progress","output":[]}
            })),
            sse_frame(json!({"type":"response.completed","response":response})),
        ];
        let (rewritten, _) = rewrite_v3_direct_dsml_attempt(&frames, 0, &context)
            .unwrap()
            .expect("complete alternate harvest must rewrite the SSE terminal");
        let terminal = sse_events(&rewritten)
            .into_iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert!(
            terminal["response"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "function_call"),
            "{terminal}"
        );
        assert_eq!(terminal["response"]["finish_reason"], "tool_calls");
    }

    #[test]
    fn direct_dsml_red_sse_deletion_before_native_item_keeps_index_and_terminal() {
        let residue = ">\n</｜｜DSML｜｜ calls>";
        let native = json!({
            "id": "fc_keep",
            "type": "function_call",
            "call_id": "call_keep",
            "name": "read_image",
            "arguments": "{\"file_path\":\"owned.png\"}",
            "status": "completed"
        });
        let residue_message = message("message_remove", residue);
        let response = json!({
            "id": "resp_residue",
            "object": "response",
            "status": "completed",
            "output_text": residue,
            "output": [residue_message.clone(), native.clone()],
            "usage": {"output_tokens": 2}
        });
        let frames = vec![
            sse_frame(json!({
                "type":"response.created",
                "response":{"id":"resp_residue","status":"in_progress","output":[
                    residue_message.clone(),
                    native.clone()
                ]}
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"id":"message_remove","type":"message","role":"assistant","content":[]}
            })),
            sse_frame(json!({
                "type":"response.content_part.added",
                "output_index":0,
                "item_id":"message_remove",
                "content_index":0,
                "part":{"type":"output_text","text":"","annotations":[]}
            })),
            sse_frame(json!({
                "type":"response.output_text.delta",
                "output_index":0,
                "item_id":"message_remove",
                "content_index":0,
                "delta":residue
            })),
            sse_frame(json!({
                "type":"response.output_text.done",
                "output_index":0,
                "item_id":"message_remove",
                "content_index":0,
                "text":residue
            })),
            sse_frame(json!({
                "type":"response.content_part.done",
                "output_index":0,
                "item_id":"message_remove",
                "content_index":0,
                "part":residue_message["content"][0]
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":0,
                "item":residue_message
            })),
            sse_frame(json!({
                "type":"response.output_item.added",
                "output_index":1,
                "item":{"id":"fc_keep","type":"function_call","call_id":"call_keep","name":"read_image","arguments":""}
            })),
            sse_frame(json!({
                "type":"response.function_call_arguments.delta",
                "output_index":1,
                "item_id":"fc_keep",
                "call_id":"call_keep",
                "delta":native["arguments"]
            })),
            sse_frame(json!({
                "type":"response.function_call_arguments.done",
                "output_index":1,
                "item_id":"fc_keep",
                "call_id":"call_keep",
                "arguments":native["arguments"]
            })),
            sse_frame(json!({
                "type":"response.output_item.done",
                "output_index":1,
                "item":native.clone()
            })),
            sse_frame(json!({"type":"response.completed","response":response})),
        ];

        let (rewritten, _) = rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
            .unwrap()
            .expect("deletion-only SSE normalization must preserve the surviving native item");
        let wire = String::from_utf8(rewritten.concat()).unwrap();
        assert!(!wire.contains("DSML"), "deleted SSE residue leaked: {wire}");
        let events = sse_events(&rewritten);
        assert!(
            events.iter().any(|event| {
                event["type"] == "response.output_item.added"
                    && event["item"]["type"] == "function_call"
                    && event["output_index"] == 0
            }),
            "native item was not shifted into index zero: {wire}"
        );
        let terminal = events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(terminal["response"]["output"], json!([native]));
        assert_eq!(terminal["response"]["output_text"], "");
        for snapshot in events.iter().filter(|event| {
            matches!(
                event["type"].as_str(),
                Some("response.created" | "response.in_progress" | "response.queued")
            )
        }) {
            assert_eq!(snapshot["response"]["output"], json!([native]));
        }
    }

    #[test]
    fn direct_dsml_red_inline_and_code_marker_counterexamples_remain_text() {
        let text = "Inline <|DSML|tool_calls> mention.\n`<|end▁of▁analysis|>`\n```text\n<｜｜DSML｜｜>\n<|end_of_analysis|>\n```\n> </｜｜DSML｜｜ calls>";
        let mut payload = sample(text);
        let original = payload.clone();
        normalize_v3_direct_dsml_response(&mut payload, &dispatch_context(&json!({"tools":[]})))
            .unwrap();
        assert_eq!(
            payload, original,
            "inline and code marker counterexamples must remain text"
        );
    }

    #[test]
    fn direct_dsml_nested_namespace_declared_identity_dispatches() {
        let request = json!({"tools":[{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"namespace","name":"workspace","tools":[
                {"type":"function","name":"read","parameters":{"type":"object"}}
            ]}
        ]}]});
        let text = call("note.md").replace("name=\"read_image\"", "name=\"read\"");
        let mut payload = sample(&text);
        let context = dispatch_context(&request);
        normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
        let call_item = function_call(&payload);
        assert_eq!(call_item["namespace"], "mcp__mcpx.workspace");
        assert_eq!(call_item["name"], "read");
        assert_eq!(
            serde_json::from_str::<Value>(call_item["arguments"].as_str().unwrap()).unwrap(),
            json!({"file_path":"note.md"})
        );
    }

    #[test]
    fn direct_dsml_discovered_declaration_channels_dispatch() {
        let discovered = json!([
            {"type":"namespace","name":"search_ns","tools":[
                {"type":"function","name":"found","parameters":{"type":"object"}}
            ]}
        ]);
        for request in [
            json!({"tools":[{"type":"function","name":"read_image"}],"input":[
                {"type":"additional_tools","tools":discovered.clone()}
            ]}),
            json!({"tools":[{"type":"function","name":"read_image"}],"input":[
                {"type":"tool_search_output","call_id":"discovery_1","tools":discovered.clone()}
            ]}),
            json!({"tools":[{"type":"function","name":"read_image"}],"messages":[
                {
                    "role":"tool",
                    "content":discovered.to_string(),
                    "routecodex_chat_extension":{"responses_tool_output_type":"tool_search_output"}
                }
            ]}),
        ] {
            let text = call("found.txt").replace("name=\"read_image\"", "name=\"found\"");
            let mut payload = sample(&text);
            let context = dispatch_context(&request);
            normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
            let call_item = function_call(&payload);
            assert_eq!(call_item["namespace"], "search_ns");
            assert_eq!(call_item["name"], "found");
            assert_eq!(
                serde_json::from_str::<Value>(call_item["arguments"].as_str().unwrap()).unwrap(),
                json!({"file_path":"found.txt"})
            );
        }
    }

    #[test]
    fn direct_dsml_custom_kind_is_not_misreported_as_a_function_call() {
        let request = json!({"tools":[{"type":"custom","name":"shell"}]});
        let text = call("x").replace("name=\"read_image\"", "name=\"shell\"");
        let mut payload = sample(&text);
        let original = payload.clone();
        normalize_v3_direct_dsml_response(&mut payload, &dispatch_context(&request)).unwrap();
        assert_eq!(payload, original);
    }

    #[test]
    fn direct_dsml_keeps_large_json_numbers_without_float_rounding() {
        let number = "123456789012345678901234567890";
        let text = call(number).replace("string=\"true\"", "string=\"false\"");
        let mut payload = sample(&text);
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        let arguments = payload["output"][0]["arguments"]
            .as_str()
            .expect("native tool call");
        assert!(arguments.contains(number), "number changed: {arguments}");
    }

    #[test]
    fn direct_dsml_opaque_output_text_is_not_assumed_to_be_an_aggregate() {
        let mut payload = sample(&call("x"));
        payload["output_text"] = "provider-specific supplemental text".into();
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        assert_eq!(payload["output"][0]["type"], "function_call");
        assert_eq!(
            payload["output_text"],
            "provider-specific supplemental text"
        );
    }

    #[test]
    fn direct_dsml_opaque_sse_numbers_and_transport_fields_survive() {
        let number = "123456789012345678901234567890";
        let body = sample(&call("x")).to_string();
        let body = format!("{{\"opaque_number\":{number},{}", &body[1..]);
        let wire = format!("event: response.completed\nid: provider-terminal\nretry: 25\n: keep this comment\ndata: {{\"type\":\"response.completed\",\"response\":{body},\"opaque_event\":{number}}}\n\n");
        let added = "event: response.output_item.added\nid: original-added\n: original added comment\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n";
        let (frames, _) = rewrite_v3_direct_dsml_attempt(
            &[added.as_bytes().to_vec(), wire.into_bytes()],
            0,
            &context(),
        )
        .unwrap()
        .unwrap();
        let wire = String::from_utf8(frames.concat()).unwrap();
        assert!(
            wire.contains(&format!("\"opaque_number\":{number}")),
            "response extension changed: {wire}"
        );
        assert!(
            wire.contains(&format!("\"opaque_event\":{number}")),
            "event extension changed: {wire}"
        );
        assert!(wire.contains("id: provider-terminal"), "SSE id was lost");
        assert!(wire.contains("retry: 25"), "SSE retry was lost");
        assert!(wire.contains("keep this comment"), "SSE comment was lost");
        assert!(
            wire.contains("id: original-added"),
            "replaced item lost its opaque transport id"
        );
        assert!(
            wire.contains("original added comment"),
            "replaced item lost its transport comment"
        );
    }

    #[test]
    fn direct_dsml_opaque_json_frames_are_untouched() {
        for data in ["[1,2,3]", "{\"vendor\":\"opaque\"}"] {
            let opaque = format!("data: {data}\n\n");
            let terminal = format!("event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{}}}\n\n", sample(&call("x")));
            let (frames, _) = rewrite_v3_direct_dsml_attempt(
                &[opaque.as_bytes().to_vec(), terminal.into_bytes()],
                0,
                &context(),
            )
            .unwrap()
            .unwrap();
            assert!(String::from_utf8(frames.concat())
                .unwrap()
                .contains(&opaque));
        }
    }

    #[test]
    fn direct_dsml_argument_fences_do_not_change_following_envelope_scope() {
        let text = format!(
            "{}\n{}",
            call("first\n```\ninside argument"),
            call("second")
        );
        let mut payload = sample(&text);
        normalize_v3_direct_dsml_response(&mut payload, &context()).unwrap();
        let calls: Vec<_> = payload["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "function_call")
            .collect();
        assert_eq!(
            calls.len(),
            2,
            "argument content contaminated lexical scope: {payload}"
        );
        assert_eq!(
            serde_json::from_str::<Value>(calls[0]["arguments"].as_str().unwrap()).unwrap(),
            json!({"file_path":"first\n```\ninside argument"})
        );
        assert_eq!(
            serde_json::from_str::<Value>(calls[1]["arguments"].as_str().unwrap()).unwrap(),
            json!({"file_path":"second"})
        );
    }

    #[test]
    fn direct_dsml_replaced_sse_carrier_event_extensions_survive() {
        let keep = "opaque-carrier-value-0123456789".repeat(24);
        let source = sample(&format!("Before\n{}\nAfter", call("x")));
        let data = |event: Value| -> String {
            let mut event = event;
            event["vendor_data"] = json!({"business":"kept","raw":keep});
            format!(
                "event: {}\ndata: {}\n\n",
                event["type"].as_str().unwrap(),
                event
            )
        };
        let frames = vec![
            data(json!({"type":"response.output_item.added","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[]}})).into_bytes(),
            data(json!({"type":"response.content_part.added","output_index":0,"item_id":"m","content_index":0,"part":{"type":"output_text","text":""}})).into_bytes(),
            data(json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":"Before\n"})).into_bytes(),
            data(json!({"type":"response.output_text.done","output_index":0,"item_id":"m","content_index":0,"text":"Before\n"})).into_bytes(),
            data(json!({"type":"response.content_part.done","output_index":0,"item_id":"m","content_index":0,"part":{"type":"output_text","text":"Before\n","annotations":[]}})).into_bytes(),
            data(json!({"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Before\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"read_image\"><｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">x</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>\nAfter","annotations":[]}]}})).into_bytes(),
            data(json!({"type":"response.completed","response":source})).into_bytes(),
        ];
        // An event-level extension has no defined association with the
        // synthesized tool events, so the complete attempt keeps provider text.
        let output = rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
            .unwrap()
            .map(|(frames, _)| frames)
            .unwrap_or_else(|| frames.clone());
        let wire = String::from_utf8(output.concat()).unwrap();
        assert_eq!(
            wire.matches("\"vendor_data\"").count(),
            frames.len(),
            "an event-level extension was dropped: {wire}"
        );
        let terminal = wire
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        assert_eq!(terminal["response"]["output"][0]["type"], "message");
        assert!(terminal["response"]["output"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains(OPEN));
    }

    #[test]
    fn direct_dsml_flushed_prefix_is_preserved_and_harvest_continues() {
        // A provider that streams bare text deltas (no item/part added frames)
        // and commits before the markup arrives. The flushed delta must stay
        // byte-identical, the harvested item must not repeat it, and the
        // terminal must keep the full planned output.
        let full = format!("Before\n{}\nAfter", call("x"));
        let rest = full.strip_prefix("Before\n").unwrap().to_owned();
        let frames = vec![
            format!(
                "data: {}\n\n",
                json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":"Before\n"})
            )
            .into_bytes(),
            format!(
                "data: {}\n\n",
                json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","content_index":0,"delta":rest})
            )
            .into_bytes(),
            format!(
                "data: {}\n\n",
                json!({"type":"response.output_text.done","output_index":0,"item_id":"m","content_index":0,"text":full})
            )
            .into_bytes(),
            format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":sample(&full)})
            )
            .into_bytes(),
        ];
        let (output, _) = rewrite_v3_direct_dsml_attempt(&frames, 1, &context())
            .unwrap()
            .unwrap();
        assert_eq!(
            output[0], frames[0],
            "the already-flushed frame was rewritten"
        );
        let events: Vec<Value> = output
            .iter()
            .skip(1)
            .filter_map(|frame| {
                String::from_utf8_lossy(frame)
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .and_then(|data| serde_json::from_str(data).ok())
            })
            .collect();
        assert!(
            !events
                .iter()
                .any(|event| event["type"] == "response.output_text.delta"
                    && event["item_id"] == "m"),
            "the flushed text was re-emitted: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| event["type"] == "response.output_item.added"
                    && event["item"]["id"] == "m"),
            "the continuation re-added the delivered item: {events:?}"
        );
        let terminal = events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .expect("terminal event");
        let terminal_output = terminal["response"]["output"].as_array().unwrap();
        assert_eq!(terminal_output.len(), 3, "{terminal}");
        assert_eq!(terminal_output[0]["type"], "message");
        assert_eq!(terminal_output[0]["content"][0]["text"], "Before\n");
        assert_eq!(terminal_output[1]["type"], "function_call");
        assert_eq!(terminal_output[1]["name"], "read_image");
        assert_eq!(terminal_output[2]["type"], "message");
        assert_eq!(terminal_output[2]["content"][0]["text"], "\nAfter");
        let wire = String::from_utf8(output.concat()).unwrap();
        assert!(!wire.contains(OPEN), "harvest markup leaked: {wire}");
        assert!(!wire.contains(END_INVOKE), "harvest markup leaked: {wire}");
    }

    #[test]
    fn direct_dsml_snapshot_extensions_keep_original_association() {
        for (kind, field, snapshot) in [
            (
                "response.output_item.added",
                "item",
                json!({"id":"m","type":"message","role":"assistant","content":[],"vendor_data":{"business":"snapshot-kept"}}),
            ),
            (
                "response.content_part.added",
                "part",
                json!({"type":"output_text","text":"","vendor_data":{"business":"snapshot-kept"}}),
            ),
        ] {
            let mut event = json!({"type":kind,"output_index":0});
            event[field] = snapshot;
            let frames = vec![
                format!("data: {event}\n\n").into_bytes(),
                format!(
                    "data: {}\n\n",
                    json!({"type":"response.completed","response":sample(&call("x"))})
                )
                .into_bytes(),
            ];
            let output = rewrite_v3_direct_dsml_attempt(&frames, 0, &context())
                .unwrap()
                .map(|(frames, _)| frames)
                .unwrap_or_else(|| frames.clone());
            let wire = String::from_utf8(output.concat()).unwrap();
            assert!(
                wire.contains("snapshot-kept"),
                "{kind} lost its opaque snapshot field"
            );
            assert!(
                wire.contains(OPEN),
                "{kind} changed an unrepresentable association"
            );
        }
    }

    #[test]
    fn direct_dsml_all_exact_attempt_aliases_dispatch() {
        let request = json!({"tools":[{"type":"namespace","name":"workspace","tools":[{"type":"function","name":"read_image","parameters":{"type":"object"}}]}]});
        let inverse = HashMap::from([
            (
                "provider_alias_a".into(),
                ("workspace".into(), "read_image".into()),
            ),
            (
                "provider_alias_b".into(),
                ("workspace".into(), "read_image".into()),
            ),
        ]);
        let context = V3DirectDsmlContext::from_request(&request, &inverse);
        for name in ["provider_alias_a", "provider_alias_b"] {
            let text = call("x").replacen("name=\"read_image\"", &format!("name=\"{name}\""), 1);
            let mut payload = sample(&text);
            normalize_v3_direct_dsml_response(&mut payload, &context).unwrap();
            assert_eq!(
                payload["output"][0]["type"], "function_call",
                "exact attempt binding {name} was lost"
            );
            assert_eq!(payload["output"][0]["namespace"], "workspace");
            assert_eq!(payload["output"][0]["name"], "read_image");
        }
    }
}
