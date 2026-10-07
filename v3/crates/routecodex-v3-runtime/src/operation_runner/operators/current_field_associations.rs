use serde_json::Value;

use super::project_canonical_paths::{
    parse_path, parse_path_with_prefix, render_path, PathSegment,
};
use crate::operation_runner::RequestInverseContext;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentFieldAssociation {
    pub original_mapping_index: usize,
    pub current_destination: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentContainerAssociation {
    pub original_binding_index: usize,
    pub current_anchor: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CurrentFieldAssociations {
    associations: Vec<CurrentFieldAssociation>,
    container_associations: Vec<CurrentContainerAssociation>,
}

impl CurrentFieldAssociations {
    pub fn from_normalization(inverse: &RequestInverseContext) -> Self {
        let associations = inverse
            .field_mappings
            .iter()
            .enumerate()
            .map(
                |(original_mapping_index, mapping)| CurrentFieldAssociation {
                    original_mapping_index,
                    current_destination: mapping.destination.clone(),
                },
            )
            .collect();
        let container_associations = inverse
            .native_container_bindings
            .iter()
            .enumerate()
            .map(
                |(original_binding_index, binding)| CurrentContainerAssociation {
                    original_binding_index,
                    current_anchor: binding.canonical_anchor.clone(),
                },
            )
            .collect();
        Self {
            associations,
            container_associations,
        }
    }

    pub fn associations(&self) -> &[CurrentFieldAssociation] {
        &self.associations
    }

    pub fn container_associations(&self) -> &[CurrentContainerAssociation] {
        &self.container_associations
    }

    pub fn destination_for_original_mapping(&self, original_mapping_index: usize) -> Option<&str> {
        self.associations
            .iter()
            .find(|association| association.original_mapping_index == original_mapping_index)
            .map(|association| association.current_destination.as_str())
    }

    pub fn original_mapping_indices_for_destination(
        &self,
        current_destination: &str,
    ) -> Vec<usize> {
        let destination = parse_path(current_destination).ok();
        self.associations
            .iter()
            .filter_map(|association| {
                (association.current_destination == current_destination
                    || destination.as_ref().is_some_and(|destination| {
                        parse_path(&association.current_destination)
                            .ok()
                            .is_some_and(|path| path == *destination)
                    }))
                .then_some(association.original_mapping_index)
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CanonicalFieldEdit {
    Remove {
        path: String,
    },
    InsertArray {
        array_path: String,
        index: usize,
        value: Value,
    },
    MoveArray {
        array_path: String,
        from: usize,
        to: usize,
    },
    Replace {
        path: String,
        value: Value,
    },
}

pub fn apply_canonical_field_edit(
    canonical: &Value,
    associations: &CurrentFieldAssociations,
    edit: &CanonicalFieldEdit,
) -> Result<(Value, CurrentFieldAssociations), String> {
    let mut data = canonical.clone();
    let mut current = associations.clone();

    match edit {
        CanonicalFieldEdit::Remove { path } => {
            let segments = parse_path(path)?;
            if segments.is_empty() {
                return Err("cannot remove the canonical root".to_string());
            }
            remove_value(&mut data, &segments)?;
            current.associations = remove_associations(&current.associations, &segments);
            current.container_associations =
                remove_container_associations(&current.container_associations, &segments);
        }
        CanonicalFieldEdit::InsertArray {
            array_path,
            index,
            value,
        } => {
            let segments = parse_path(array_path)?;
            let array = value_at_mut(&mut data, &segments)?
                .as_array_mut()
                .ok_or_else(|| format!("insert target `{array_path}` is not an array"))?;
            if *index > array.len() {
                return Err(format!(
                    "insert index {index} is beyond array length {} at `{array_path}`",
                    array.len()
                ));
            }
            array.insert(*index, value.clone());
            current.associations = insert_associations(&current.associations, &segments, *index);
            current.container_associations =
                insert_container_associations(&current.container_associations, &segments, *index);
        }
        CanonicalFieldEdit::MoveArray {
            array_path,
            from,
            to,
        } => {
            let segments = parse_path(array_path)?;
            let array = value_at_mut(&mut data, &segments)?
                .as_array_mut()
                .ok_or_else(|| format!("move target `{array_path}` is not an array"))?;
            if *from >= array.len() || *to >= array.len() {
                return Err(format!(
                    "move indices ({from}, {to}) are outside array length {} at `{array_path}`",
                    array.len()
                ));
            }
            let moved = array.remove(*from);
            array.insert(*to, moved);
            current.associations = move_associations(&current.associations, &segments, *from, *to);
            current.container_associations =
                move_container_associations(&current.container_associations, &segments, *from, *to);
        }
        CanonicalFieldEdit::Replace { path, value } => {
            let segments = parse_path(path)?;
            let target = value_at_mut(&mut data, &segments)?;
            *target = value.clone();
        }
    }

    Ok((data, current))
}

fn value_at_mut<'a>(
    root: &'a mut Value,
    segments: &[PathSegment],
) -> Result<&'a mut Value, String> {
    let mut cursor = root;
    for segment in segments {
        cursor = match segment {
            PathSegment::Key(key) => cursor
                .as_object_mut()
                .ok_or_else(|| format!("noncontainer path collision at `{key}`"))?
                .get_mut(key)
                .ok_or_else(|| format!("missing structural path key `{key}`"))?,
            PathSegment::Index(index) => cursor
                .as_array_mut()
                .ok_or_else(|| format!("noncontainer path collision at index `{index}`"))?
                .get_mut(*index)
                .ok_or_else(|| format!("missing structural path index `{index}`"))?,
        };
    }
    Ok(cursor)
}

fn remove_value(root: &mut Value, segments: &[PathSegment]) -> Result<(), String> {
    let (last, parent_segments) = segments
        .split_last()
        .ok_or_else(|| "cannot remove the canonical root".to_string())?;
    let parent = value_at_mut(root, parent_segments)?;
    match last {
        PathSegment::Key(key) => {
            parent
                .as_object_mut()
                .ok_or_else(|| format!("remove target `{key}` is not an object member"))?
                .remove(key)
                .ok_or_else(|| format!("missing structural path key `{key}`"))?;
        }
        PathSegment::Index(index) => {
            let array = parent
                .as_array_mut()
                .ok_or_else(|| format!("remove target index `{index}` is not an array element"))?;
            if *index >= array.len() {
                return Err(format!("missing structural path index `{index}`"));
            }
            array.remove(*index);
        }
    }
    Ok(())
}

fn remove_associations(
    associations: &[CurrentFieldAssociation],
    removed: &[PathSegment],
) -> Vec<CurrentFieldAssociation> {
    associations
        .iter()
        .filter_map(|association| {
            removed_path(&association.current_destination, removed).map(|current_destination| {
                CurrentFieldAssociation {
                    original_mapping_index: association.original_mapping_index,
                    current_destination,
                }
            })
        })
        .collect()
}

fn insert_associations(
    associations: &[CurrentFieldAssociation],
    array: &[PathSegment],
    inserted_index: usize,
) -> Vec<CurrentFieldAssociation> {
    associations
        .iter()
        .map(|association| {
            let current_destination =
                inserted_path(&association.current_destination, array, inserted_index);
            CurrentFieldAssociation {
                original_mapping_index: association.original_mapping_index,
                current_destination,
            }
        })
        .collect()
}

fn move_associations(
    associations: &[CurrentFieldAssociation],
    array: &[PathSegment],
    from: usize,
    to: usize,
) -> Vec<CurrentFieldAssociation> {
    associations
        .iter()
        .map(|association| {
            let current_destination = moved_path(&association.current_destination, array, from, to);
            CurrentFieldAssociation {
                original_mapping_index: association.original_mapping_index,
                current_destination,
            }
        })
        .collect()
}

fn remove_container_associations(
    associations: &[CurrentContainerAssociation],
    removed: &[PathSegment],
) -> Vec<CurrentContainerAssociation> {
    associations
        .iter()
        .filter_map(|association| {
            removed_path(&association.current_anchor, removed).map(|current_anchor| {
                CurrentContainerAssociation {
                    original_binding_index: association.original_binding_index,
                    current_anchor,
                }
            })
        })
        .collect()
}

fn insert_container_associations(
    associations: &[CurrentContainerAssociation],
    array: &[PathSegment],
    inserted_index: usize,
) -> Vec<CurrentContainerAssociation> {
    associations
        .iter()
        .map(|association| CurrentContainerAssociation {
            original_binding_index: association.original_binding_index,
            current_anchor: inserted_path(&association.current_anchor, array, inserted_index),
        })
        .collect()
}

fn move_container_associations(
    associations: &[CurrentContainerAssociation],
    array: &[PathSegment],
    from: usize,
    to: usize,
) -> Vec<CurrentContainerAssociation> {
    associations
        .iter()
        .map(|association| CurrentContainerAssociation {
            original_binding_index: association.original_binding_index,
            current_anchor: moved_path(&association.current_anchor, array, from, to),
        })
        .collect()
}

fn removed_path(path: &str, removed: &[PathSegment]) -> Option<String> {
    let Ok((prefix, mut segments)) = parse_path_with_prefix(path) else {
        return Some(path.to_string());
    };
    if segments.starts_with(removed) {
        return None;
    }
    let Some((PathSegment::Index(removed_index), parent)) = removed.split_last() else {
        return Some(render_path(prefix, &segments));
    };
    if segments.len() > parent.len() && segments.starts_with(parent) {
        if let Some(PathSegment::Index(index)) = segments.get_mut(parent.len()) {
            if *index > *removed_index {
                *index -= 1;
            }
        }
    }
    Some(render_path(prefix, &segments))
}

fn inserted_path(path: &str, array: &[PathSegment], inserted_index: usize) -> String {
    let Ok((prefix, mut segments)) = parse_path_with_prefix(path) else {
        return path.to_string();
    };
    if segments.len() > array.len() && segments.starts_with(array) {
        if let Some(PathSegment::Index(index)) = segments.get_mut(array.len()) {
            if *index >= inserted_index {
                *index += 1;
            }
        }
    }
    render_path(prefix, &segments)
}

fn moved_path(path: &str, array: &[PathSegment], from: usize, to: usize) -> String {
    let Ok((prefix, mut segments)) = parse_path_with_prefix(path) else {
        return path.to_string();
    };
    if from == to || segments.len() <= array.len() || !segments.starts_with(array) {
        return render_path(prefix, &segments);
    }
    if let Some(PathSegment::Index(index)) = segments.get_mut(array.len()) {
        let previous = *index;
        *index = if previous == from {
            to
        } else if from < previous && previous <= to {
            previous - 1
        } else if to <= previous && previous < from {
            previous + 1
        } else {
            previous
        };
    }
    render_path(prefix, &segments)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_canonical_field_edit, CanonicalFieldEdit, CurrentFieldAssociation,
        CurrentFieldAssociations,
    };
    use crate::operation_runner::RequestInverseContext;
    use serde_json::json;

    fn associations(entries: &[(usize, &str)]) -> CurrentFieldAssociations {
        CurrentFieldAssociations {
            associations: entries
                .iter()
                .map(|(index, destination)| CurrentFieldAssociation {
                    original_mapping_index: *index,
                    current_destination: (*destination).to_string(),
                })
                .collect(),
            container_associations: Vec::new(),
        }
    }

    fn inverse(destinations: &[&str]) -> RequestInverseContext {
        RequestInverseContext {
            entry_protocol: "responses".to_string(),
            normalized_protocol: "chat".to_string(),
            field_mappings: destinations
                .iter()
                .map(|destination| crate::operation_runner::FieldMapping {
                    source_path: format!("request.source.{destination}"),
                    destination: (*destination).to_string(),
                    operator: "test".to_string(),
                    shape: None,
                    semantics: None,
                    transform_id: None,
                    collision_policy: None,
                    encoding: "json".to_string(),
                })
                .collect(),
            opaque_record_references: Vec::new(),
            tool_declarations: Vec::new(),
            native_container_bindings: Vec::new(),
        }
    }

    #[test]
    fn normalization_keeps_original_indices_and_duplicate_destinations() {
        let current = CurrentFieldAssociations::from_normalization(&inverse(&[
            "chat.tools[0]",
            "chat.tools[0]",
            "chat.tools[]",
        ]));

        assert_eq!(current.associations().len(), 3);
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[0]"),
            vec![0, 1]
        );
        assert_eq!(
            current.destination_for_original_mapping(1),
            Some("chat.tools[0]")
        );
        assert_eq!(
            current.destination_for_original_mapping(2),
            Some("chat.tools[]")
        );
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[]"),
            vec![2]
        );
    }

    #[test]
    fn remove_shifts_surviving_elements_and_descendants() {
        let data = json!({
            "tools": [
                {"name": "removed"},
                {"name": "survivor", "schema": {"properties": {"x": true}}}
            ]
        });
        let current = associations(&[
            (0, "chat.tools[0]"),
            (1, "chat.tools[1]"),
            (2, "chat.tools[1].schema.properties.x"),
        ]);

        let (data, current) = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::Remove {
                path: "chat.tools[0]".to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            data["tools"],
            json!([{"name": "survivor", "schema": {"properties": {"x": true}}}])
        );
        assert_eq!(current.destination_for_original_mapping(0), None);
        assert_eq!(
            current.destination_for_original_mapping(1),
            Some("chat.tools[0]")
        );
        assert_eq!(
            current.destination_for_original_mapping(2),
            Some("chat.tools[0].schema.properties.x")
        );
    }

    #[test]
    fn insert_shifts_existing_sources_without_creating_an_origin() {
        let data = json!({"tools": [{"name": "old"}]});
        let current = associations(&[(0, "chat.tools[0]")]);

        let (data, current) = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::InsertArray {
                array_path: "chat.tools".to_string(),
                index: 0,
                value: json!({"name": "new"}),
            },
        )
        .unwrap();

        assert_eq!(data["tools"], json!([{"name": "new"}, {"name": "old"}]));
        assert!(current
            .original_mapping_indices_for_destination("chat.tools[0]")
            .is_empty());
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[1]"),
            vec![0]
        );
    }

    #[test]
    fn move_keeps_both_sources_with_their_real_elements() {
        let data = json!({"tools": [{"name": "a"}, {"name": "b"}, {"name": "c"}]});
        let current = associations(&[
            (0, "chat.tools[0]"),
            (1, "chat.tools[1]"),
            (2, "chat.tools[2]"),
        ]);

        let (data, current) = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::MoveArray {
                array_path: "chat.tools".to_string(),
                from: 0,
                to: 2,
            },
        )
        .unwrap();

        assert_eq!(
            data["tools"],
            json!([{"name": "b"}, {"name": "c"}, {"name": "a"}])
        );
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[2]"),
            vec![0]
        );
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[0]"),
            vec![1]
        );
        assert_eq!(
            current.original_mapping_indices_for_destination("chat.tools[1]"),
            vec![2]
        );
    }

    #[test]
    fn replace_keeps_the_source_and_preserves_the_exact_value() {
        let value = format!(
            "{}\n*** Begin Patch\n+literal\n*** End Patch\n{}",
            "x".repeat(70_000),
            "y".repeat(70_000)
        );
        let data = json!({"tools": [{"parameters": {"old": true}}]});
        let current = associations(&[(7, "chat.tools[0].parameters")]);

        let (data, current) = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::Replace {
                path: "chat.tools[0].parameters".to_string(),
                value: json!(value.clone()),
            },
        )
        .unwrap();

        assert_eq!(data["tools"][0]["parameters"], json!(value));
        assert_eq!(
            current.destination_for_original_mapping(7),
            Some("chat.tools[0].parameters")
        );
    }

    #[test]
    fn quoted_literal_keys_use_the_existing_structural_parser() {
        let data = json!({"extension": {"a.b": [{"keep": true}]}});
        let current = associations(&[(3, r#"chat.extension["a.b"][0].keep"#)]);

        let (data, current) = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::Remove {
                path: r#"chat.extension["a.b"][0].keep"#.to_string(),
            },
        )
        .unwrap();

        assert_eq!(data, json!({"extension": {"a.b": [{}]}}));
        assert_eq!(current.destination_for_original_mapping(3), None);
    }

    #[test]
    fn failed_edits_leave_data_and_associations_unchanged() {
        let data = json!({"tools": [{"name": "only"}]});
        let current = associations(&[(0, "chat.tools[0]")]);
        let before_data = data.clone();
        let before_current = current.clone();

        let error = apply_canonical_field_edit(
            &data,
            &current,
            &CanonicalFieldEdit::Remove {
                path: "chat.tools[9]".to_string(),
            },
        )
        .expect_err("missing element must fail");

        assert!(error.contains("missing"));
        assert_eq!(data, before_data);
        assert_eq!(current, before_current);
    }
}
