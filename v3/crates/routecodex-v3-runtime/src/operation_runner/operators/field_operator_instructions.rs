use serde_json::{json, Value};
use std::collections::BTreeSet;

use super::field_operator_library::RequestNormalizer;

#[derive(Clone, Debug)]
pub(super) struct InstructionSource {
    pub(super) path: String,
}

impl InstructionSource {
    pub(super) fn new(path: &str) -> Self {
        Self {
            path: path.to_string(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct SystemInstructionBuilder {
    contributions: Vec<InstructionContribution>,
    field_sources: Vec<String>,
    existing_leaf: Option<usize>,
}

#[derive(Clone, Debug)]
struct InstructionContribution {
    source: InstructionSource,
    text: String,
}

impl SystemInstructionBuilder {
    pub(super) fn is_empty(&self) -> bool {
        self.contributions.is_empty()
    }

    pub(super) fn len(&self) -> usize {
        self.contributions.len()
    }

    pub(super) fn push(&mut self, source: InstructionSource, text: &str) {
        self.contributions.push(InstructionContribution {
            source,
            text: text.to_string(),
        });
    }

    pub(super) fn register_field_source(&mut self, path: &str) {
        if !self.field_sources.iter().any(|existing| existing == path) {
            self.field_sources.push(path.to_string());
        }
    }

    fn contributions(&self) -> &[InstructionContribution] {
        &self.contributions
    }

    fn field_sources(&self) -> &[String] {
        &self.field_sources
    }

    fn set_existing_leaf(&mut self, leaf_index: usize) {
        self.existing_leaf = Some(leaf_index);
    }

    fn existing_leaf(&self) -> Option<usize> {
        self.existing_leaf
    }
}

impl<'a> RequestNormalizer<'a> {
    pub(super) fn flush_system_instructions(&mut self) -> Option<usize> {
        if self.system_instructions.is_empty() {
            return None;
        }
        if let Some(existing_system_index) = self
            .messages
            .iter()
            .position(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        {
            let existing_content = self
                .messages
                .get(existing_system_index)
                .and_then(|message| message.get("content"))
                .cloned()
                .unwrap_or(Value::Null);
            if matches!(
                existing_content,
                Value::String(_) | Value::Null | Value::Array(_)
            ) {
                let existing_leaf = self.system_instructions.contributions().len() * 2;
                let merged = build_system_content(
                    self.system_instructions.contributions(),
                    Some(&existing_content),
                );
                if let Some(message) = self.messages[existing_system_index].as_object_mut() {
                    message.remove("content");
                    message.insert("content".to_string(), merged);
                }
                if !existing_content.is_null() {
                    self.system_instructions.set_existing_leaf(existing_leaf);
                }
                return Some(existing_system_index);
            }
        }
        let content = build_system_content(self.system_instructions.contributions(), None);
        self.messages.insert(
            0,
            json!({
                "role": "system",
                "content": content,
            }),
        );
        Some(0)
    }

    /// Assign concrete canonical leaf destinations from the ordered emission
    /// builder, not by searching text values or field names. Repeated equal
    /// texts keep separate explicit associations; existing system content is
    /// its own source and never reuses the prefix contribution paths.
    pub(super) fn finalize_instruction_source_mappings(&mut self, canonical_index: usize) {
        let content = self
            .messages
            .get(canonical_index)
            .and_then(|message| message.get("content"));
        let Some(content) = content else {
            return;
        };
        let content_is_scalar = !content.is_array();
        let container = format!("chat.messages[{canonical_index}].content");
        let contributions = self.system_instructions.contributions().to_vec();
        let field_sources = self.system_instructions.field_sources().to_vec();
        let instruction_sources: BTreeSet<String> = contributions
            .iter()
            .map(|contribution| contribution.source.path.clone())
            .chain(field_sources.iter().cloned())
            .collect();

        let mut remaps: Vec<(String, String)> = Vec::new();
        for (index, contribution) in contributions.iter().enumerate() {
            let destination = if content_is_scalar {
                container.clone()
            } else {
                format!("{container}[{}].text", index * 2)
            };
            remaps.push((contribution.source.path.clone(), destination));
        }
        // The whole-field source identifies the registered transform/original
        // shape and keeps the emitted container association; it is never a
        // wildcard role selector.
        for field_source in &field_sources {
            if !contributions
                .iter()
                .any(|contribution| contribution.source.path == *field_source)
            {
                remaps.push((field_source.clone(), container.clone()));
            }
        }

        // Existing system content is a separate source contribution: its own
        // emitted leaf(s) after the prefix, never inferred from resulting
        // strings and never reusing a prefix leaf. A scalar existing content
        // maps to its single emitted text leaf; existing text-part arrays shift
        // by the actual prefix length. A prefix container mapping is not an
        // existing-system scalar leaf.
        if !content_is_scalar {
            if let Some(existing_leaf) = self.system_instructions.existing_leaf() {
                let part_prefix = format!("{container}[");
                for mapping in &self.provenance {
                    let Some(source) = mapping
                        .get("source_path")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    else {
                        continue;
                    };
                    if instruction_sources.contains(&source) {
                        continue;
                    }
                    let Some(destination) = mapping
                        .get("destination")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    else {
                        continue;
                    };
                    if destination == container {
                        remaps.push((source, format!("{container}[{existing_leaf}].text")));
                    } else if let Some(suffix) = destination.strip_prefix(&part_prefix) {
                        if let Some(close) = suffix.find(']') {
                            if let Ok(part_index) = suffix[..close].parse::<usize>() {
                                remaps.push((
                                    source,
                                    format!(
                                        "{container}[{}]{}",
                                        part_index + existing_leaf,
                                        &suffix[close + 1..]
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
        }

        for (source, destination) in remaps {
            self.remap_mapping_to(&source, &destination);
        }
        // Record the join artifacts at their actual emitted positions. They
        // share the originating instruction owner, never a client text leaf.
        // The original field mapping remains first and unchanged.
        if !content_is_scalar {
            for separator_index in 1..contributions.len()
                + usize::from(self.system_instructions.existing_leaf().is_some())
            {
                let next_source = contributions.get(separator_index)
                    .unwrap_or_else(|| contributions.last().expect("nonempty instruction builder"))
                    .source.path.as_str();
                let owner = field_sources.iter().filter(|source|
                    next_source == source.as_str() || next_source.strip_prefix(source.as_str())
                        .is_some_and(|suffix| suffix.starts_with('.') || suffix.starts_with('[')))
                    .max_by_key(|source| source.len());
                if let Some(mapping) = owner.and_then(|owner| self.provenance.iter().find(|mapping|
                    mapping.get("source_path").and_then(Value::as_str) == Some(owner.as_str()))) {
                    let mut generated = mapping.clone();
                    generated["destination"] = json!(format!("{container}[{}]", separator_index * 2 - 1));
                    generated["semantics"] = json!(super::project_canonical_instructions::GENERATED_INSTRUCTION_SEPARATOR);
                    self.provenance.push(generated);
                }
            }
        }
    }
    fn remap_mapping_to(&mut self, source_path: &str, destination: &str) {
        for mapping in &mut self.provenance {
            if mapping.get("source_path").and_then(Value::as_str) == Some(source_path) {
                mapping["destination"] = Value::String(destination.to_string());
            }
        }
    }
}

/// Build the canonical system content representation. A single contribution
/// with no existing system content stays scalar; any merge emits an ordered
/// text-part array whose flattened text preserves the previous join bytes,
/// including empty texts and CRLF/trailing markers.
fn build_system_content(
    contributions: &[InstructionContribution],
    existing: Option<&Value>,
) -> Value {
    let single_scalar = contributions.len() == 1 && existing.is_none();
    if single_scalar {
        return Value::String(contributions[0].text.clone());
    }
    let mut parts = Vec::new();
    for (index, contribution) in contributions.iter().enumerate() {
        if index > 0 {
            parts.push(json!({"type": "text", "text": "\n"}));
        }
        parts.push(json!({"type": "text", "text": contribution.text}));
    }
    if let Some(content) = existing {
        if !contributions.is_empty() {
            match content {
                Value::Null => {}
                _ => parts.push(json!({"type": "text", "text": "\n"})),
            }
        }
        match content {
            Value::String(text) => parts.push(json!({"type": "text", "text": text})),
            Value::Array(existing_parts) => {
                for part in existing_parts {
                    parts.push(part.clone());
                }
            }
            Value::Null => {}
            other => parts.push(other.clone()),
        }
    }
    Value::Array(parts)
}
