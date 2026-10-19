//! Complete Responses Direct tool-envelope projection. No routing or error policy.
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

const OPEN: &str = "<｜｜DSML｜｜ calls>";
const CLOSE: &str = "</｜｜DSML｜｜ calls>";
const INVOKE: &str = "<｜｜DSML｜｜ invoke";
const END_INVOKE: &str = "</｜｜DSML｜｜ invoke>";
const PARAM: &str = "<｜｜DSML｜｜ parameter";
const END_PARAM: &str = "</｜｜DSML｜｜ parameter>";

#[derive(Default)]
pub(crate) struct V3DirectDsmlContext {
    tools: HashMap<String, DsmlToolIdentity>,
}

#[derive(Clone, PartialEq)]
struct DsmlToolIdentity {
    namespace: Option<String>,
    leaf: String,
    kind: provider_compat_core::namespace_tools::ToolKind,
}

impl V3DirectDsmlContext {
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
                kind: identity.kind,
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
                result.tools.insert(key, resolved.clone());
            }
        }
        for name in ambiguous {
            result.tools.remove(&name);
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

fn attributes<'a>(text: &'a str, start: &str) -> Option<(Map<String, Value>, &'a str)> {
    let mut rest = text.strip_prefix(start)?;
    let mut attrs = Map::new();
    loop {
        if let Some(after) = rest.strip_prefix('>') {
            return Some((attrs, after));
        }
        let trimmed = rest.trim_start();
        if trimmed.len() == rest.len() {
            return None;
        }
        rest = trimmed;
        if let Some(after) = rest.strip_prefix('>') {
            return Some((attrs, after));
        }
        let (name, after) = rest.split_once("=\"")?;
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        let (value, after) = after.split_once('"')?;
        if attrs
            .insert(name.to_owned(), Value::String(value.to_owned()))
            .is_some()
        {
            return None;
        }
        rest = after;
    }
}

fn envelope<'a>(text: &'a str, context: &V3DirectDsmlContext) -> Option<(Vec<Value>, &'a str)> {
    let mut rest = text.strip_prefix(OPEN)?;
    let mut calls = Vec::new();
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix(CLOSE) {
            return (!calls.is_empty()).then_some((calls, after));
        }
        let (attrs, after) = attributes(rest, INVOKE)?;
        if attrs.keys().any(|k| k != "name" && k != "call_id") {
            return None;
        }
        let name = attrs.get("name")?.as_str()?;
        let identity = context.tools.get(name)?;
        // A custom declaration takes freeform `input`, not the DSML parameter
        // map. Emitting a function call would change the declared kind, so the
        // complete envelope stays provider text.
        if identity.kind != provider_compat_core::namespace_tools::ToolKind::Function {
            return None;
        }
        rest = after;
        let mut arguments: Vec<(String, String)> = Vec::new();
        loop {
            rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix(END_INVOKE) {
                rest = after;
                break;
            }
            let (param, after) = attributes(rest, PARAM)?;
            if param.len() != 2 || !param.contains_key("name") || !param.contains_key("string") {
                return None;
            }
            let key = param["name"].as_str()?;
            let (value, after) = after.split_once(END_PARAM)?;
            let value = match param["string"].as_str()? {
                "true" => serde_json::to_string(value).ok()?,
                "false" => {
                    // Validate syntax without materializing numbers as f64.
                    // The complete JSON value remains the provider's text.
                    serde_json::from_str::<serde::de::IgnoredAny>(value).ok()?;
                    value.to_owned()
                }
                _ => return None,
            };
            if arguments.iter().any(|(name, _)| name == key) {
                return None;
            }
            arguments.push((key.to_owned(), value));
            rest = after;
        }
        let call_id = attrs
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| fresh_id("call"));
        let arguments = format!(
            "{{{}}}",
            arguments
                .iter()
                .map(|(name, value)| format!("{}:{value}", Value::String(name.clone())))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut call = json!({"id":fresh_id("fc"),"type":"function_call","call_id":call_id,"name":identity.leaf.clone(),"arguments":arguments,"status":"completed"});
        if let Some(namespace) = &identity.namespace {
            call["namespace"] = namespace.clone().into();
        }
        calls.push(call);
    }
}

enum Segment {
    Text(String),
    Calls(Vec<Value>),
}

fn segments(text: &str, context: &V3DirectDsmlContext) -> Vec<Segment> {
    let mut result = Vec::new();
    let mut consumed = 0;
    let mut cursor = 0;
    let mut fence: Option<(char, usize)> = None;
    let mut inline = None;
    let mut quote = None;
    let mut skip_until = 0;
    let mut blockquote = false;
    for line in text.split_inclusive('\n') {
        let line_start = cursor;
        let line_end = line_start + line.len();
        cursor = cursor.max(consumed.max(skip_until)).min(line_end);
        if cursor == line_end {
            continue;
        }
        let trimmed = line.trim_start();
        // Envelope arguments are consumed atomically. Their Markdown-like
        // contents must not change the lexical scope of subsequent text.
        if cursor == line_start {
            if trimmed.trim().is_empty() {
                blockquote = false;
            }
            let marker = trimmed.chars().next().unwrap_or('\n');
            let run = trimmed.chars().take_while(|c| *c == marker).count();
            if let Some((opening, length)) = fence {
                if marker == opening && run >= length && trimmed[run..].trim().is_empty() {
                    fence = None;
                }
                cursor = line_end;
                continue;
            }
            if line.starts_with("    ") || line.starts_with('\t') {
                cursor = line_end;
                continue;
            }
            if matches!(marker, '`' | '~') && run >= 3 {
                fence = Some((marker, run));
                cursor = line_end;
                continue;
            }
            blockquote |= trimmed.starts_with('>');
            if blockquote {
                cursor = line_end;
                continue;
            }
        }
        while cursor < line_end {
            if cursor < consumed.max(skip_until) {
                cursor = consumed.max(skip_until).min(line_end);
                continue;
            }
            let tail = &text[cursor..];
            let ch = tail.chars().next().unwrap();
            if ch == '`' && quote.is_none() {
                let run = tail.bytes().take_while(|c| *c == b'`').count();
                if inline == Some(run) {
                    inline = None;
                } else if inline.is_none() {
                    inline = Some(run);
                }
                cursor += run;
                continue;
            }
            if inline.is_none() {
                if ch == '\\' && quote.is_some() {
                    cursor += ch.len_utf8();
                    if let Some(escaped) = text[cursor..].chars().next() {
                        cursor += escaped.len_utf8();
                    }
                    continue;
                }
                let previous = text[..cursor].chars().next_back();
                let next = tail.chars().nth(1);
                let apostrophe = matches!(ch, '\'' | '’')
                    && previous.is_some_and(|c| c.is_ascii_alphanumeric())
                    && next.is_some_and(|c| c.is_ascii_alphanumeric());
                if quote == Some(ch) && !apostrophe {
                    quote = None;
                } else if quote.is_none() && !apostrophe {
                    quote = match ch {
                        '“' => Some('”'),
                        '‘' => Some('’'),
                        '「' => Some('」'),
                        '『' => Some('』'),
                        '"' | '\''
                            if previous.is_none_or(|p| {
                                p.is_whitespace() || matches!(p, '(' | '[' | '{' | ':')
                            }) =>
                        {
                            Some(ch)
                        }
                        _ => None,
                    };
                }
            }
            if inline.is_none() && quote.is_none() && tail.starts_with(OPEN) {
                if let Some((calls, rest)) = envelope(tail, context) {
                    if cursor > consumed {
                        result.push(Segment::Text(text[consumed..cursor].to_owned()));
                    }
                    result.push(Segment::Calls(calls));
                    consumed = text.len() - rest.len();
                    cursor = consumed.min(line_end);
                    continue;
                }
                // Do not extract a nested call from an envelope that failed
                // atomic parsing. The original complete span remains visible.
                skip_until = tail
                    .find(CLOSE)
                    .map(|end| cursor + end + CLOSE.len())
                    .unwrap_or(text.len());
                cursor = skip_until.min(line_end);
                continue;
            }
            cursor += ch.len_utf8();
        }
    }
    if consumed < text.len() {
        result.push(Segment::Text(text[consumed..].to_owned()));
    }
    result
}

struct Replacement {
    old: usize,
    start: usize,
    items: Vec<Value>,
}

fn normalize(payload: &mut Value, context: &V3DirectDsmlContext) -> Vec<Replacement> {
    normalize_with_protected(payload, context, &HashSet::new())
}

/// Output indexes whose carrier events carry opaque extensions that the
/// synthesized replacement events cannot faithfully inherit keep their original
/// provider text and payload.
fn normalize_with_protected(
    payload: &mut Value,
    context: &V3DirectDsmlContext,
    protected: &HashSet<usize>,
) -> Vec<Replacement> {
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Vec::new();
    };
    let old_text = joined_text(output);
    let mut next = Vec::new();
    let mut plans = Vec::new();
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
            for segment in segments(part["text"].as_str().unwrap(), context) {
                match segment {
                    Segment::Text(text) => {
                        let mut p = part.clone();
                        p["text"] = text.into();
                        content.push(p);
                    }
                    Segment::Calls(calls) => {
                        changed = true;
                        flush_message(item, &mut content, &mut items);
                        items.extend(calls);
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
    if !plans.is_empty() {
        *output = next;
        refresh_matching_aggregate(payload, &old_text);
    }
    plans
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
) {
    normalize(payload, context);
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

pub(crate) fn rewrite_v3_direct_dsml_attempt(
    frames: &[Vec<u8>],
    context: &V3DirectDsmlContext,
) -> Option<(Vec<Vec<u8>>, usize)> {
    use routecodex_v3_sse::{
        build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
    };
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut events = Vec::new();
    for bytes in frames {
        for frame in decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(bytes))
            .ok()?
        {
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
    decoder.finish().ok()?;
    let terminal = events.iter().position(|(_, v)| {
        v.as_ref().is_some_and(|v| {
            matches!(
                v["type"].as_str(),
                Some("response.completed" | "response.incomplete")
            )
        })
    })?;
    // A replaced item/part/text carrier may carry opaque event-level data.
    // Those values have no defined association with the synthesized tool
    // events, so the affected item keeps its original provider text.
    let protected: HashSet<usize> = events
        .iter()
        .filter_map(|(_, value)| value.as_ref())
        .filter(|event| {
            matches!(
                event["type"].as_str(),
                Some(
                    "response.output_item.added"
                        | "response.output_item.done"
                        | "response.content_part.added"
                        | "response.content_part.done"
                        | "response.output_text.delta"
                        | "response.output_text.done"
                )
            ) && event_has_unrepresentable_extension(event)
        })
        .filter_map(|event| event["output_index"].as_u64().map(|index| index as usize))
        .collect();
    let mut response = events[terminal].1.as_ref()?["response"].clone();
    let plans = normalize_with_protected(&mut response, context, &protected);
    if plans.is_empty() {
        return None;
    }
    let mut output = Vec::new();
    let mut emitted = vec![false; plans.len()];
    let mut sequence = 0u64;
    let mut terminal_index = 0;
    for (position, (frame, value)) in events.into_iter().enumerate() {
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
        let index = event["output_index"].as_u64().map(|v| v as usize);
        if let Some((pi, plan)) = plans.iter().enumerate().find(|(_, p)| Some(p.old) == index) {
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
                    output.push(encode_fields(transport)?);
                }
                if !emitted[pi] {
                    emit_items(&mut output, &mut sequence, plan);
                    emitted[pi] = true;
                }
                continue;
            }
        }
        if let Some(index) = index {
            let shift: usize = plans
                .iter()
                .filter(|p| p.old < index)
                .map(|p| p.items.len() - 1)
                .sum();
            event["output_index"] = (index + shift).into();
        }
        if position == terminal {
            for (pi, plan) in plans.iter().enumerate() {
                if !emitted[pi] {
                    emit_items(&mut output, &mut sequence, plan);
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
                    let mut next = Vec::new();
                    for (index, item) in snapshot.iter().enumerate() {
                        if let Some(plan) = plans.iter().find(|p| p.old == index) {
                            next.extend(plan.items.clone());
                        } else {
                            next.push(item.clone());
                        }
                    }
                    *snapshot = next;
                    refresh_matching_aggregate(snapshot_response, &old_text);
                }
            }
        }
        event["sequence_number"] = sequence.into();
        sequence += 1;
        output.push(render_original_event(&frame, &event, &plans)?);
    }
    Some((output, terminal_index))
}

/// Preserve untouched JSON values as raw text, including numbers outside f64
/// precision and duplicate opaque fields. Only declared protocol fields change.
struct RawObject(Vec<(String, Box<serde_json::value::RawValue>)>);

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
    fn get(&self, name: &str) -> Option<&serde_json::value::RawValue> {
        let mut matches = self.0.iter().filter(|(key, _)| key == name);
        let (_, value) = matches.next()?;
        matches.next().is_none().then_some(value.as_ref())
    }
    fn set(&mut self, name: &str, json: String) -> Option<()> {
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
    fn render(&self) -> String {
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

fn render_original_event(
    frame: &routecodex_v3_sse::SseTransportIn03ValidatedFrameStream,
    event: &Value,
    plans: &[Replacement],
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
        let items: Vec<Box<serde_json::value::RawValue>> =
            serde_json::from_str(response.get("output")?.get()).ok()?;
        let mut output = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if let Some(plan) = plans.iter().find(|p| p.old == index) {
                output.extend(plan.items.iter().map(Value::to_string));
            } else {
                output.push(item.get().to_owned());
            }
        }
        response.set("output", format!("[{}]", output.join(",")))?;
        if event["response"].get("output_text") != original["response"].get("output_text") {
            response.set("output_text", event["response"]["output_text"].to_string())?;
        }
        raw.set("response", response.render())?;
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

fn emit_items(output: &mut Vec<Vec<u8>>, sequence: &mut u64, plan: &Replacement) {
    for (offset, item) in plan.items.iter().enumerate() {
        let index = plan.start + offset;
        let mut added = item.clone();
        added["status"] = "in_progress".into();
        if item["type"] == "function_call" {
            added["arguments"] = "".into();
        } else {
            added["content"] = json!([]);
        }
        push_event(
            output,
            sequence,
            json!({"type":"response.output_item.added","output_index":index,"item":added}),
        );
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
                push_event(output, sequence, event);
            }
        } else if let Some(parts) = item["content"].as_array() {
            for (ci, part) in parts.iter().enumerate() {
                let mut added_part = part.clone();
                if part["type"] == "output_text" {
                    added_part["text"] = "".into();
                }
                push_event(
                    output,
                    sequence,
                    json!({"type":"response.content_part.added","output_index":index,"item_id":item["id"],"content_index":ci,"part":added_part}),
                );
                if part["type"] == "output_text" {
                    push_event(
                        output,
                        sequence,
                        json!({"type":"response.output_text.delta","output_index":index,"item_id":item["id"],"content_index":ci,"delta":part["text"]}),
                    );
                    push_event(
                        output,
                        sequence,
                        json!({"type":"response.output_text.done","output_index":index,"item_id":item["id"],"content_index":ci,"text":part["text"]}),
                    );
                }
                push_event(
                    output,
                    sequence,
                    json!({"type":"response.content_part.done","output_index":index,"item_id":item["id"],"content_index":ci,"part":part}),
                );
            }
        }
        push_event(
            output,
            sequence,
            json!({"type":"response.output_item.done","output_index":index,"item":item}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        normalize_v3_direct_dsml_response(&mut payload, &context());
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
            block.replace(CLOSE, ""),
            block.replace("name=\"read_image\"", "name=\"undeclared\""),
            block.replace(
                "name=\"read_image\"",
                "name=\"read_image\" unknown=\"keep\"",
            ),
            duplicate,
        ] {
            let mut payload = sample(&text);
            let original = payload.clone();
            normalize_v3_direct_dsml_response(&mut payload, &context());
            assert_eq!(payload, original, "must preserve literal: {text}");
        }
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
        normalize_v3_direct_dsml_response(&mut payload, &context);
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
        );
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
        normalize_v3_direct_dsml_response(&mut payload, &context);
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
            normalize_v3_direct_dsml_response(&mut payload, &context);
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
        normalize_v3_direct_dsml_response(&mut payload, &dispatch_context(&request));
        assert_eq!(payload, original);
    }

    #[test]
    fn direct_dsml_keeps_large_json_numbers_without_float_rounding() {
        let number = "123456789012345678901234567890";
        let text = call(number).replace("string=\"true\"", "string=\"false\"");
        let mut payload = sample(&text);
        normalize_v3_direct_dsml_response(&mut payload, &context());
        let arguments = payload["output"][0]["arguments"]
            .as_str()
            .expect("native tool call");
        assert!(arguments.contains(number), "number changed: {arguments}");
    }

    #[test]
    fn direct_dsml_opaque_output_text_is_not_assumed_to_be_an_aggregate() {
        let mut payload = sample(&call("x"));
        payload["output_text"] = "provider-specific supplemental text".into();
        normalize_v3_direct_dsml_response(&mut payload, &context());
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
            &context(),
        )
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
                &context(),
            )
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
        normalize_v3_direct_dsml_response(&mut payload, &context());
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
        let output = rewrite_v3_direct_dsml_attempt(&frames, &context())
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
            let output = rewrite_v3_direct_dsml_attempt(&frames, &context())
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
            normalize_v3_direct_dsml_response(&mut payload, &context);
            assert_eq!(
                payload["output"][0]["type"], "function_call",
                "exact attempt binding {name} was lost"
            );
            assert_eq!(payload["output"][0]["namespace"], "workspace");
            assert_eq!(payload["output"][0]["name"], "read_image");
        }
    }
}
