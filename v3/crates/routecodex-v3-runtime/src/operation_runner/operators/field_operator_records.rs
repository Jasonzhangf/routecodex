use super::field_operator_helpers::{history_values_equivalent, merge_history_annotations};
use super::field_operator_library::RequestNormalizer;
use super::field_operator_profiles::ProfileRow;
use super::project_canonical_paths::field_path;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub(super) struct MessageSourceRange {
    pub(super) source_path: String,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) extras: Vec<Value>,
    pub(super) result_kind: Option<String>,
}

#[derive(Clone, Debug)]
struct MessageContribution {
    original_index: usize,
    value: Value,
    extras: Vec<Value>,
    result_kind: Option<String>,
}

impl<'a> RequestNormalizer<'a> {
    pub(super) fn with_history_context<T>(
        &mut self,
        message_index: Option<usize>,
        part_index: Option<usize>,
        call_index: Option<usize>,
        f: impl FnOnce(&mut Self) -> T,
    ) -> T {
        let previous = (
            self.history_message_index,
            self.history_part_index,
            self.history_call_index,
        );
        self.history_message_index = message_index;
        self.history_part_index = part_index;
        self.history_call_index = call_index;
        let result = f(self);
        self.history_message_index = previous.0;
        self.history_part_index = previous.1;
        self.history_call_index = previous.2;
        result
    }

    fn resolve_history_destination(&self, destination: &str) -> String {
        let Some(message_index) = self.history_message_index else {
            return destination.to_string();
        };
        if destination.starts_with("chat.messages[]") {
            let mut resolved = destination.replacen(
                "chat.messages[]",
                &format!("chat.messages[{message_index}]"),
                1,
            );
            if let Some(part_index) = self.history_part_index {
                resolved = resolved.replacen(".content[]", &format!(".content[{part_index}]"), 1);
            }
            if let Some(call_index) = self.history_call_index {
                resolved =
                    resolved.replacen(".tool_calls[]", &format!(".tool_calls[{call_index}]"), 1);
            }
            return resolved;
        }
        if destination.starts_with("chat.") {
            return destination.to_string();
        }
        let base = if let Some(call_index) = self.history_call_index {
            format!("chat.messages[{message_index}].tool_calls[{call_index}]")
        } else if let Some(part_index) = self.history_part_index {
            format!("chat.messages[{message_index}].content[{part_index}]")
        } else {
            format!("chat.messages[{message_index}]")
        };
        append_structural_suffix(&base, destination)
    }

    pub(super) fn process_known_container(&mut self, key: &str, value: &Value) {
        let raw_path = format!("request.{key}");
        self.record_opaque_once(&raw_path, value);
        let transformed = self.transform_known_value(key, value, &raw_path);
        if key == "safetySettings" {
            self.record_mapping_by_path(
                &raw_path,
                "chat.routecodex_chat_extension.gemini_request.safetySettings",
                "routecodex.v3.field.lossless_preserve@1",
            );
            self.insert_extension_value("gemini_request", "safetySettings", transformed);
        } else {
            self.canonical.insert(key.to_string(), transformed);
        }
    }

    fn is_history_contribution_source(&self, raw_path: &str) -> bool {
        self.history_fold
            .and_then(|fold| fold.params.source_order.as_ref())
            .is_some_and(|sources| {
                sources.iter().any(|source| {
                    raw_path == source
                        || raw_path
                            .strip_prefix(source)
                            .is_some_and(|suffix| suffix.starts_with('['))
                })
            })
    }

    pub(super) fn record_mapping(
        &mut self,
        row: &ProfileRow,
        raw_path: &str,
        destination: &str,
        encoding: &str,
    ) {
        let destination = self.resolve_history_destination(destination);
        let mut record = json!({
            "source_path": raw_path,
            "destination": destination,
            "operator": row.dispatch_operator(),
            "shape": row.params.shape.as_deref(),
            "semantics": row.params.semantics.as_deref(),
            "transform_id": row.transform_id(),
            "collision_policy": row.collision_policy(),
            "encoding": encoding,
        });
        if destination.starts_with("chat.messages")
            && (self.history_message_index.is_some()
                || self.is_history_contribution_source(raw_path))
        {
            record["_message_index"] =
                json!(self.history_message_index.unwrap_or(self.messages.len()));
        }
        self.provenance.push(record);
    }

    pub(super) fn record_mapping_by_path(
        &mut self,
        raw_path: &str,
        destination: &str,
        operator: &str,
    ) {
        let destination = self.resolve_history_destination(destination);
        let mut record = json!({
            "source_path": raw_path,
            "destination": destination,
            "operator": operator,
            "encoding": "json",
        });
        if destination.starts_with("chat.messages")
            && (self.history_message_index.is_some()
                || self.is_history_contribution_source(raw_path))
        {
            record["_message_index"] =
                json!(self.history_message_index.unwrap_or(self.messages.len()));
        }
        self.provenance.push(record);
    }

    /// Record the inverse provenance for a field inside a recognized Gemini
    /// content part using the registered profile row that owns the edge.
    pub(super) fn record_part_mapping(
        &mut self,
        lookup_path: &str,
        raw_path: &str,
        destination: &str,
    ) {
        match self.profiles.row(&self.protocol, lookup_path).cloned() {
            Some(row) => self.record_mapping(&row, raw_path, destination, "json"),
            None => self.record_mapping_by_path(raw_path, destination, "lossless_preserve"),
        }
    }

    /// Preserve every sibling field of a recognized content-part branch as an
    /// exact opaque record instead of collapsing it away.
    pub(super) fn record_part_siblings(
        &mut self,
        part: &Map<String, Value>,
        part_path: &str,
        recognized: &[&str],
    ) {
        for (key, value) in part {
            if recognized.contains(&key.as_str()) {
                continue;
            }
            self.record_opaque(&field_path(part_path, key), value);
        }
    }

    pub(super) fn record_opaque(&mut self, raw_path: &str, value: &Value) -> String {
        self.next_opaque_record += 1;
        let record_id = format!("opaque-{}", self.next_opaque_record);
        self.opaque_records.push(json!({
            "record_id": record_id,
            "protocol": self.protocol,
            "path": raw_path,
            "encoding": "json",
            "value": value.clone(),
        }));
        record_id
    }

    /// Preserve a raw value once at its exact path. This avoids duplicating a
    /// path that the normalizer already recorded before a later merge step.
    pub(super) fn record_opaque_once(&mut self, raw_path: &str, value: &Value) -> String {
        if let Some(existing) = self
            .opaque_records
            .iter()
            .find(|record| record.get("path").and_then(Value::as_str) == Some(raw_path))
        {
            if let Some(record_id) = existing.get("record_id").and_then(Value::as_str) {
                return record_id.to_string();
            }
        }
        self.record_opaque(raw_path, value)
    }

    pub(super) fn record_history_pairing(
        &mut self,
        raw_path: &str,
        call_id: Option<&str>,
        name: Option<&str>,
        kind: &str,
        namespace: Option<&Value>,
        payload: Option<&Value>,
    ) {
        self.record_history_pairing_at_message(
            raw_path,
            call_id,
            name,
            kind,
            namespace,
            payload,
            self.messages.len(),
        );
    }

    pub(super) fn record_history_pairing_at_message(
        &mut self,
        raw_path: &str,
        call_id: Option<&str>,
        name: Option<&str>,
        kind: &str,
        namespace: Option<&Value>,
        payload: Option<&Value>,
        message_index: usize,
    ) {
        let payload_encoding = match payload {
            Some(Value::String(_)) => "string",
            Some(Value::Object(_)) => "json-object",
            Some(Value::Array(_)) => "json-array",
            Some(Value::Null) | None => "null",
            Some(Value::Bool(_)) => "boolean",
            Some(Value::Number(_)) => "number",
        };
        let mut record = json!({
            "source_path": raw_path,
            "call_id": call_id,
            "name": name,
            "kind": kind,
            "encoding": payload_encoding,
            "_message_index": message_index,
        });
        if let Some(namespace) = namespace {
            record
                .as_object_mut()
                .expect("history pairing record is an object")
                .insert("namespace".to_string(), namespace.clone());
        }
        self.history_pairing.push(record);
    }

    /// Record one handler contribution and its canonical span. Original item
    /// paths remain in the inverse and history records.
    pub(super) fn record_message_span(
        &mut self,
        source_path: &str,
        item_path: &str,
        start: usize,
        opaque_start: usize,
    ) {
        let end = self.messages.len();
        if end <= start {
            return;
        }
        let mut extras = self
            .opaque_records
            .iter()
            .skip(opaque_start)
            .filter_map(|record| {
                let object = record.as_object()?;
                let path = object
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let relative = path
                    .strip_prefix(item_path)
                    .map(|suffix| suffix.trim_start_matches('.'))
                    .filter(|suffix| !suffix.is_empty())
                    .unwrap_or(path);
                let value = object.get("value")?;
                // A field copied verbatim into this canonical message is already
                // compared by full canonical equality. Its inverse record stays
                // intact; only redundant comparison evidence is omitted here.
                if end == start + 1 && self.messages[start].get(relative) == Some(value) {
                    return None;
                }
                Some(json!({
                    "path": relative,
                    "value": value,
                }))
            })
            .collect::<Vec<_>>();
        extras.sort_by(|left, right| {
            left.get("path")
                .and_then(Value::as_str)
                .cmp(&right.get("path").and_then(Value::as_str))
        });
        let result_kind = self.history_pairing.iter().rev().find_map(|record| {
            let source_path = record.get("source_path").and_then(Value::as_str)?;
            if !source_path.starts_with(item_path) {
                return None;
            }
            let kind = record.get("kind").and_then(Value::as_str)?;
            canonical_result_kind(kind)
        });
        for message_index in start..end {
            self.provenance.push(json!({
                "source_path": item_path,
                "destination": format!("chat.messages[{message_index}]"),
                "operator": "routecodex.v3.field.array_container_shape@1",
                "encoding": "json",
                "_message_index": message_index,
            }));
        }
        self.message_sources.push(MessageSourceRange {
            source_path: source_path.to_string(),
            start,
            end,
            extras,
            result_kind,
        });
    }

    /// Fold configured source contributions after traversal. Only a complete
    /// ordered secondary history or a complete equivalent tool result with the
    /// same call identity may alias an existing canonical item. Repeated
    /// secondary results consume distinct existing occurrences.
    pub(super) fn finalize_message_history(&mut self) -> Option<BTreeMap<usize, usize>> {
        let source_order = self.history_fold?.params.source_order.as_ref()?.clone();
        let ranges = self.message_sources.clone();
        let mut batches = vec![Vec::<MessageContribution>::new(); source_order.len()];
        let mut covered = BTreeSet::new();

        for range in &ranges {
            let Some(position) = source_order
                .iter()
                .position(|source| source == &range.source_path)
            else {
                continue;
            };
            for offset in 0..range.end.saturating_sub(range.start) {
                let original_index = range.start + offset;
                covered.insert(original_index);
                batches[position].push(MessageContribution {
                    original_index,
                    value: self.messages[original_index].clone(),
                    extras: range.extras.clone(),
                    result_kind: range.result_kind.clone(),
                });
            }
        }

        let primary = batches.first().cloned().unwrap_or_default();
        let mut ordered = Vec::<MessageContribution>::new();
        let mut used_matches = Vec::<usize>::new();
        let mut indices = BTreeMap::new();

        for contribution in &primary {
            indices.insert(contribution.original_index, ordered.len());
            ordered.push(contribution.clone());
            used_matches.push(0);
        }

        for batch in batches.iter().skip(1) {
            if !batch.is_empty() && histories_equivalent(&primary, batch) {
                for (primary_item, secondary_item) in primary.iter().zip(batch) {
                    if let Some(index) = indices.get(&primary_item.original_index).copied() {
                        merge_history_annotations(&mut ordered[index].value, &secondary_item.value);
                        indices.insert(secondary_item.original_index, index);
                    }
                }
                continue;
            }

            let previous_source_count = ordered.len();
            for contribution in batch {
                let identity = tool_result_identity(&contribution.value);
                let matched = identity.as_ref().and_then(|identity| {
                    ordered[..previous_source_count]
                        .iter()
                        .enumerate()
                        .find_map(|(index, existing)| {
                            (used_matches[index] == 0
                                && tool_result_identity(&existing.value).as_ref() == Some(identity)
                                && contributions_equivalent(existing, contribution))
                            .then_some(index)
                        })
                });
                if let Some(index) = matched {
                    merge_history_annotations(&mut ordered[index].value, &contribution.value);
                    used_matches[index] += 1;
                    indices.insert(contribution.original_index, index);
                } else {
                    indices.insert(contribution.original_index, ordered.len());
                    ordered.push(contribution.clone());
                    used_matches.push(0);
                }
            }
        }

        for (original_index, value) in self.messages.iter().enumerate() {
            if covered.contains(&original_index) {
                continue;
            }
            indices.insert(original_index, ordered.len());
            ordered.push(MessageContribution {
                original_index,
                value: value.clone(),
                extras: Vec::new(),
                result_kind: None,
            });
            used_matches.push(0);
        }

        self.messages = ordered.into_iter().map(|item| item.value).collect();
        Some(indices)
    }

    pub(super) fn remap_history_references(
        &mut self,
        message_indices: &BTreeMap<usize, usize>,
        index_shift: usize,
    ) {
        if message_indices.is_empty() {
            return;
        }
        for mapping in &mut self.provenance {
            let Some(original_index) = take_message_index(mapping) else {
                continue;
            };
            let Some(canonical_index) = message_indices.get(&original_index).copied() else {
                continue;
            };
            let canonical_index = canonical_index + index_shift;
            if let Some(destination) = mapping.get("destination").and_then(Value::as_str) {
                if let Some(remapped) = remap_history_destination(destination, canonical_index) {
                    mapping["destination"] = Value::String(remapped);
                }
            }
            mapping["canonical_index"] = json!(canonical_index);
        }
        for pairing in &mut self.history_pairing {
            let Some(original_index) = take_message_index(pairing) else {
                continue;
            };
            let Some(canonical_index) = message_indices.get(&original_index).copied() else {
                continue;
            };
            pairing["canonical_index"] = json!(canonical_index + index_shift);
        }
        sort_records_by_canonical_index(&mut self.provenance);
        sort_records_by_canonical_index(&mut self.history_pairing);
    }

    pub(super) fn insert_extension_value(&mut self, namespace: &str, key: &str, value: Value) {
        self.insert_extension_value_at(namespace, key, value);
    }

    pub(super) fn insert_extension_value_at(&mut self, namespace: &str, key: &str, value: Value) {
        let mut extension = self.take_extension_object();
        let namespace_value = extension
            .entry(namespace.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !namespace_value.is_object() {
            let existing = std::mem::replace(namespace_value, Value::Object(Map::new()));
            self.record_opaque_once(
                &format!("request.routecodex_chat_extension.{namespace}"),
                &existing,
            );
        }
        namespace_value
            .as_object_mut()
            .expect("namespace is an object")
            .insert(key.to_string(), value);
        self.canonical.insert(
            super::field_operator_library::ROOT_CARRIER_KEY.to_string(),
            Value::Object(extension),
        );
    }

    pub(super) fn take_extension_object(&mut self) -> Map<String, Value> {
        match self
            .canonical
            .remove(super::field_operator_library::ROOT_CARRIER_KEY)
        {
            Some(Value::Object(object)) => object,
            Some(value) => {
                self.record_opaque_once("request.routecodex_chat_extension", &value);
                Map::new()
            }
            None => Map::new(),
        }
    }
}

fn canonical_result_kind(kind: &str) -> Option<String> {
    match kind {
        "function_call_output" | "functionResponse" => Some("function".to_string()),
        "custom_tool_call_output" => Some("custom".to_string()),
        kind if kind.ends_with("_output") => Some(format!("unknown:{kind}")),
        _ => None,
    }
}

fn tool_result_identity(value: &Value) -> Option<String> {
    if value.get("role").and_then(Value::as_str) != Some("tool") {
        return None;
    }
    value
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn contributions_equivalent(left: &MessageContribution, right: &MessageContribution) -> bool {
    // Chat-style tool results do not declare function/custom kind. Preserve
    // explicit kind conflicts without assigning a kind to an untyped result.
    let kind_matches = match (&left.result_kind, &right.result_kind) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    };
    history_values_equivalent(&left.value, &right.value)
        && left.extras.iter().all(|left| {
            right
                .extras
                .iter()
                .filter(|right| right.get("path") == left.get("path"))
                .all(|right| right.get("value") == left.get("value"))
        })
        && kind_matches
}

fn histories_equivalent(left: &[MessageContribution], right: &[MessageContribution]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| contributions_equivalent(left, right))
}

fn take_message_index(record: &mut Value) -> Option<usize> {
    let value = record.as_object_mut()?.remove("_message_index")?;
    value.as_u64().map(|index| index as usize)
}

fn remap_history_destination(destination: &str, canonical_index: usize) -> Option<String> {
    let marker = "chat.messages";
    let start = destination.find(marker)?;
    let suffix_start = start + marker.len();
    let suffix = destination.get(suffix_start..)?;
    let close = suffix.find(']')?;
    let mut remapped = String::with_capacity(destination.len() + 8);
    remapped.push_str(&destination[..suffix_start]);
    remapped.push('[');
    remapped.push_str(&canonical_index.to_string());
    remapped.push(']');
    remapped.push_str(&suffix[close + 1..]);
    Some(remapped)
}

fn sort_records_by_canonical_index(records: &mut [Value]) {
    records.sort_by_key(|record| record.get("canonical_index").and_then(Value::as_u64));
}

fn append_structural_suffix(base: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        base.to_string()
    } else if suffix.starts_with('.') || suffix.starts_with('[') {
        format!("{base}{suffix}")
    } else {
        format!("{base}.{suffix}")
    }
}

pub(super) fn append_history_relative(base: &str, suffix: &str) -> String {
    append_structural_suffix(base, suffix)
}
