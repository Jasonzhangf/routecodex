//! Profile-driven field traversal. This foundation does not switch production callers.

mod field_operator_library;
mod profile;

pub(crate) use field_operator_library::FieldOperatorRegistry;
pub(crate) use profile::{FieldProfile, ProfileError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FieldDirection {
    ClientRequestToChat,
    ChatToProvider,
    ProviderResponseToChat,
    ChatToClientResponse,
}

impl FieldDirection {
    fn root(self) -> &'static str {
        match self {
            Self::ClientRequestToChat | Self::ChatToProvider => "request",
            Self::ProviderResponseToChat | Self::ChatToClientResponse => "response",
        }
    }

    fn reference_owner(self) -> ReferenceOwner {
        match self {
            Self::ClientRequestToChat | Self::ChatToProvider => {
                ReferenceOwner::RequestInverseContext
            }
            Self::ProviderResponseToChat | Self::ChatToClientResponse => {
                ReferenceOwner::ResponseProvenance
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ValueEncoding {
    JsonString,
    JsonValue,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OpaqueExtensionRecord {
    /// Concrete RFC 6901 pointer, including array indices and escaped member names.
    pub(crate) original_path: String,
    pub(crate) value: Value,
    pub(crate) encoding: ValueEncoding,
    segments: Vec<PathSegment>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PathSegment {
    Member(String),
    Index(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReferenceOwner {
    RequestInverseContext,
    ResponseProvenance,
}

/// Control reference only. Business values live exclusively in the extension records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpaqueExtensionReference {
    pub(crate) record_index: usize,
    pub(crate) owner: ReferenceOwner,
    pub(crate) protocol: String,
}

#[derive(Debug)]
pub(crate) struct FieldWalkResult {
    pub(crate) value: Value,
    pub(crate) opaque_records: Vec<OpaqueExtensionRecord>,
    pub(crate) inverse_references: Vec<OpaqueExtensionReference>,
    pub(crate) consumed: Vec<FieldReceipt>,
    pub(crate) protocol: String,
    direction: FieldDirection,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FieldReceipt {
    pub(crate) path: String,
    pub(crate) operator: String,
    pub(crate) semantic_id: Option<String>,
}

impl FieldWalkResult {
    /// Consumes the same-turn bundle, so extension records cannot be replayed twice.
    /// Provenance stays attached to the original protocol and direction rather than a
    /// process-wide store or a diagnostic snapshot.
    pub(crate) fn restore_inverse(mut self) -> Value {
        let mut restored = self.value;
        for record in self.opaque_records.drain(..) {
            restore_at(&mut restored, &record.segments, record.value);
        }
        restored
    }
}

/// Compiled ownership is immutable. Traversal cannot return a business shape error.
pub(crate) struct FieldWalker {
    profile: FieldProfile,
    registry: FieldOperatorRegistry,
}

impl FieldWalker {
    pub(crate) fn compile(
        profile: FieldProfile,
        registry: FieldOperatorRegistry,
    ) -> Result<Self, ProfileError> {
        profile.validate(&registry)?;
        Ok(Self { profile, registry })
    }

    pub(crate) fn walk(&self, value: Value) -> FieldWalkResult {
        let mut result = FieldWalkResult {
            value: Value::Null,
            opaque_records: Vec::new(),
            inverse_references: Vec::new(),
            consumed: Vec::new(),
            protocol: self.profile.protocol.clone(),
            direction: self.profile.direction,
        };
        result.value = self.visit(
            &value,
            &value,
            self.profile.direction.root(),
            "",
            &mut Vec::new(),
            &mut result,
        );
        result
    }

    fn visit(
        &self,
        root: &Value,
        value: &Value,
        path: &str,
        pointer: &str,
        segments: &mut Vec<PathSegment>,
        result: &mut FieldWalkResult,
    ) -> Value {
        let rule = self.profile.rules.iter().find(|rule| rule.path == path);
        if let Some(rule) = rule {
            let branch = rule.branch(root, pointer);
            if rule.typed_discriminator_cases.is_some() && branch.is_none() {
                return preserve_opaque(value, pointer, segments, result);
            }
            if !rule.matches_shape(value) {
                return preserve_opaque(value, pointer, segments, result);
            }
            let structural = rule.structure_only && (value.is_object() || value.is_array());
            if !structural {
                let operator = branch.map(|case| case.operator.as_str()).or({
                    if rule.structure_only {
                        rule.scalar_consumer.as_deref()
                    } else {
                        rule.consumer.as_deref()
                    }
                });
                if let Some(key) = operator {
                    // Registry resolution is proved at compile, never a request-time gate.
                    if let Some(operator) = self.registry.get(key) {
                        if let Some(mapped) = operator.apply(value) {
                            result.consumed.push(FieldReceipt {
                                path: pointer.to_owned(),
                                operator: key.to_owned(),
                                semantic_id: branch.map(|case| case.semantic_id.clone()),
                            });
                            return mapped;
                        }
                    }
                }
                return preserve_opaque(value, pointer, segments, result);
            }
        }
        let descendant = self.profile.rules.iter().any(|rule| {
            rule.path.starts_with(&format!("{path}."))
                || rule.path.starts_with(&format!("{path}[]"))
        });
        if rule.is_none() && !descendant {
            return preserve_opaque(value, pointer, segments, result);
        }
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, child)| {
                        let escaped = key.replace('~', "~0").replace('/', "~1");
                        let child_pointer = format!("{pointer}/{escaped}");
                        segments.push(PathSegment::Member(key.clone()));
                        let mapped = if key
                            .chars()
                            .any(|character| matches!(character, '.' | '[' | ']'))
                        {
                            preserve_opaque(child, &child_pointer, segments, result)
                        } else {
                            self.visit(
                                root,
                                child,
                                &format!("{path}.{key}"),
                                &child_pointer,
                                segments,
                                result,
                            )
                        };
                        segments.pop();
                        (key.clone(), mapped)
                    })
                    .collect(),
            ),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, child)| {
                        segments.push(PathSegment::Index(index));
                        let mapped = self.visit(
                            root,
                            child,
                            &format!("{path}[]"),
                            &format!("{pointer}/{index}"),
                            segments,
                            result,
                        );
                        segments.pop();
                        mapped
                    })
                    .collect(),
            ),
            _ => preserve_opaque(value, pointer, segments, result),
        }
    }
}

fn preserve_opaque(
    value: &Value,
    pointer: &str,
    segments: &[PathSegment],
    result: &mut FieldWalkResult,
) -> Value {
    let index = result.opaque_records.len();
    result.opaque_records.push(OpaqueExtensionRecord {
        original_path: pointer.to_owned(),
        value: value.clone(),
        encoding: if value.is_string() {
            ValueEncoding::JsonString
        } else {
            ValueEncoding::JsonValue
        },
        segments: segments.to_vec(),
    });
    result.inverse_references.push(OpaqueExtensionReference {
        record_index: index,
        owner: result.direction.reference_owner(),
        protocol: result.protocol.clone(),
    });
    value.clone()
}

fn restore_at(root: &mut Value, parts: &[PathSegment], value: Value) {
    fn set(current: &mut Value, parts: &[PathSegment], value: Value) {
        if parts.is_empty() {
            *current = value;
            return;
        }
        match &parts[0] {
            PathSegment::Index(index) => {
                if !current.is_array() {
                    *current = Value::Array(Vec::new());
                }
                if let Some(items) = current.as_array_mut() {
                    let index = *index;
                    if index >= items.len() {
                        items.resize(index + 1, Value::Null);
                    }
                    set(&mut items[index], &parts[1..], value);
                }
            }
            PathSegment::Member(member) => {
                if !current.is_object() {
                    *current = Value::Object(Default::default());
                }
                let child = current
                    .as_object_mut()
                    .unwrap()
                    .entry(member.clone())
                    .or_insert(Value::Null);
                set(child, &parts[1..], value);
            }
        }
    }
    set(root, parts, value);
}

#[cfg(test)]
mod tests;
