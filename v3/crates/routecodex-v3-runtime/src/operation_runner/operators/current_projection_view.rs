use serde_json::Value;

use super::project_canonical_paths::{
    opaque_value, read_path, source_value as opaque_source_value,
};
use crate::operation_runner::{
    CurrentFieldAssociations, OpaqueRecordReference, RequestInverseContext,
};

/// A borrowed Direct projection view. Original mapping identity stays in the
/// immutable inverse; actual current values are read only through the paired
/// current association.
pub(super) struct CurrentProjectionView<'a> {
    canonical: &'a Value,
    inverse: &'a RequestInverseContext,
    associations: &'a CurrentFieldAssociations,
}

impl<'a> CurrentProjectionView<'a> {
    pub(super) fn new(
        canonical: &'a Value,
        inverse: &'a RequestInverseContext,
        associations: &'a CurrentFieldAssociations,
    ) -> Self {
        Self {
            canonical,
            inverse,
            associations,
        }
    }

    pub(super) fn canonical(&self) -> &'a Value {
        self.canonical
    }

    pub(super) fn inverse(&self) -> &'a RequestInverseContext {
        self.inverse
    }

    pub(super) fn current_destination(&self, mapping_index: usize) -> Option<&'a str> {
        self.associations
            .destination_for_original_mapping(mapping_index)
    }

    pub(super) fn read_mapping(&self, mapping_index: usize) -> Result<Option<&'a Value>, String> {
        let Some(destination) = self.current_destination(mapping_index) else {
            return Ok(None);
        };
        read_path(self.canonical, destination)
    }

    pub(super) fn mapping_index_for_source(&self, source_path: &str) -> Option<usize> {
        self.inverse
            .field_mappings
            .iter()
            .position(|mapping| mapping.source_path == source_path)
    }

    pub(super) fn mapped_source_value(
        &self,
        source_path: &str,
    ) -> Result<Option<&'a Value>, String> {
        for (mapping_index, mapping) in self.inverse.field_mappings.iter().enumerate() {
            if mapping.source_path != source_path {
                continue;
            }
            if let Some(value) = self.read_mapping(mapping_index)? {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    pub(super) fn source_value(&self, source_path: &str) -> Result<Option<&'a Value>, String> {
        opaque_source_value(self.canonical, self.inverse, source_path)
    }

    pub(super) fn empty_history_container(&self, source_path: &str) -> Result<Value, String> {
        Ok(
            if self.source_value(source_path)?.is_some_and(Value::is_null) {
                Value::Null
            } else {
                Value::Array(Vec::new())
            },
        )
    }

    pub(super) fn opaque_value(
        &self,
        reference: &OpaqueRecordReference,
    ) -> Result<Option<&'a Value>, String> {
        opaque_value(self.canonical, reference)
    }
}
