use serde_json::Value;

use super::current_projection_view::CurrentProjectionView;
use super::project_canonical_paths::{field_path, parse_path, read_path, render_path, write_path};
use crate::operation_runner::{CurrentFieldAssociations, RequestInverseContext};

/// Restore a registered structural field's opaque siblings when its current
/// semantic contribution has actually been emitted by the standard encoder.
pub(crate) fn restore_standard_transform_siblings(
    emitted: &mut Value,
    canonical: &Value,
    inverse: &RequestInverseContext,
    current: &CurrentFieldAssociations,
    transform_id: &str,
    consumed_native_paths: &[&str],
) -> Result<(), String> {
    let view = CurrentProjectionView::new(canonical, inverse, current);
    for (index, mapping) in inverse.field_mappings.iter().enumerate() {
        if mapping.transform_id.as_deref() != Some(transform_id)
            || mapping.semantics.as_deref() == Some(super::project_canonical_instructions::GENERATED_INSTRUCTION_SEPARATOR)
            || view.read_mapping(index)?.is_none() {
            continue;
        }
        restore_current_source_siblings(emitted, &view, &mapping.source_path, consumed_native_paths)?;
    }
    Ok(())
}

/// Restore only opaque siblings of an actually emitted element. Current typed
/// associations locate its original element; the encoder supplies the native
/// leaves it consumed. Removed current records stay removed. No native/raw
/// request or alternative request pipeline is reconstructed here.
pub(crate) fn restore_standard_projection_siblings(
    emitted: &mut Value,
    canonical: &Value,
    inverse: &RequestInverseContext,
    current: &CurrentFieldAssociations,
    canonical_element_path: &str,
    additional_source_parent_levels: usize,
    consumed_native_paths: &[&str],
) -> Result<(), String> {
    let view = CurrentProjectionView::new(canonical, inverse, current);
    let canonical_prefix = parse_path(canonical_element_path)?;
    let mut sources = std::collections::BTreeSet::new();
    for (index, mapping) in inverse.field_mappings.iter().enumerate() {
        // Generated contributions have an instruction owner but no original
        // native element whose siblings could be restored onto this part.
        if mapping.semantics.as_deref() == Some(super::project_canonical_instructions::GENERATED_INSTRUCTION_SEPARATOR) {
            continue;
        }
        let Some(destination) = current.destination_for_original_mapping(index) else { continue; };
        let destination = parse_path(destination)?;
        if !destination.starts_with(&canonical_prefix) { continue; }
        let mut source = parse_path(&mapping.source_path)?;
        let suffix_depth = destination.len() - canonical_prefix.len() + additional_source_parent_levels;
        if source.len() < suffix_depth { continue; }
        source.truncate(source.len() - suffix_depth);
        sources.insert(render_path(Some("request"), &source));
    }
    // A whole-field contribution may share the current address of its scalar
    // leaf. The concrete leaf association owns this emitted element.
    let concrete_sources = sources.iter().filter(|source| !sources.iter().any(|child|
        child.strip_prefix(source.as_str()).is_some_and(|suffix|
            suffix.starts_with('.') || suffix.starts_with('[')))).cloned().collect::<Vec<_>>();
    for source in concrete_sources {
        restore_current_source_siblings(emitted, &view, &source, consumed_native_paths)?;
    }
    Ok(())
}

pub(super) fn restore_current_source_siblings(
    emitted: &mut Value,
    view: &CurrentProjectionView<'_>,
    source: &str,
    consumed_native_paths: &[&str],
) -> Result<(), String> {
        if let Some(value) = view.source_value(source)? {
            restore_current_siblings(emitted, view, source, "", value, consumed_native_paths)?;
        }
        for reference in &view.inverse().opaque_record_references {
            let Some(relative) = reference.path.strip_prefix(source)
                .and_then(|suffix| suffix.strip_prefix('.').or_else(|| suffix.starts_with('[').then_some(suffix))) else { continue; };
            let Some(value) = view.opaque_value(reference)? else { continue; };
            restore_current_siblings(emitted, view, &reference.path, relative, value, consumed_native_paths)?;
        }
    Ok(())
}

fn restore_current_siblings(
    emitted: &mut Value,
    view: &CurrentProjectionView<'_>,
    source_path: &str,
    relative: &str,
    shape: &Value,
    consumed: &[&str],
) -> Result<(), String> {
    if consumed.iter().any(|path| relative == *path || relative.strip_prefix(path)
        .is_some_and(|suffix| suffix.starts_with('.') || suffix.starts_with('['))) {
        return Ok(());
    }
    if let Some(fields) = shape.as_object() {
        for key in fields.keys() {
            let child = field_path(source_path, key);
            let Some(value) = view.source_value(&child)? else { continue; };
            restore_current_siblings(emitted, view, &child, &field_path(relative, key), value, consumed)?;
        }
    } else if !relative.is_empty() && read_path(emitted, relative)?.is_none() {
        if let Some(value) = view.source_value(source_path)? {
            write_path(emitted, relative, value.clone())?;
        }
    }
    Ok(())
}
