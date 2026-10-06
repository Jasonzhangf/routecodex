use serde_json::Value;

use crate::operation_runner::request_context_store::{
    OpaqueRecordReference, RequestInverseContext,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum PathSegment {
    Key(String),
    Index(usize),
}

pub(super) fn field_path(parent: &str, key: &str) -> String {
    if path_key_is_bare(key) {
        if parent.is_empty() {
            key.to_string()
        } else {
            format!("{parent}.{key}")
        }
    } else {
        format!(
            "{parent}[{}]",
            serde_json::to_string(key).expect("string path encoding")
        )
    }
}

fn path_key_is_bare(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn split_rooted_path(path: &str) -> Option<(&'static str, &str)> {
    for root in ["request", "chat"] {
        let Some(rest) = path.strip_prefix(root) else {
            continue;
        };
        if rest.is_empty() {
            return Some((root, rest));
        }
        if rest.starts_with(".[") {
            return Some((root, rest));
        }
        if let Some(rest) = rest.strip_prefix('.') {
            return Some((root, rest));
        }
        if rest.starts_with('[') {
            return Some((root, rest));
        }
    }
    None
}

pub(super) fn parse_path(path: &str) -> Result<Vec<PathSegment>, String> {
    parse_path_with_prefix(path).map(|(_, segments)| segments)
}

pub(super) fn parse_path_with_prefix(
    path: &str,
) -> Result<(Option<&'static str>, Vec<PathSegment>), String> {
    if path.is_empty() {
        return Ok((None, Vec::new()));
    }
    if path == "request" {
        return Ok((Some("request"), Vec::new()));
    }
    if path == "chat" {
        return Ok((Some("chat"), Vec::new()));
    }

    let (prefix, body) = match split_rooted_path(path) {
        Some((root, body)) => (Some(root), body),
        None => (None, path),
    };

    if body.is_empty() {
        return Err(format!("unsupported structural path: `{path}`"));
    }

    let mut segments = Vec::new();
    let mut rest = body;
    loop {
        let key_end = rest.find(['.', '[']).unwrap_or(rest.len());
        if key_end == 0 && !rest.starts_with('[') {
            return Err(format!("unsupported structural path: `{path}`"));
        }
        let key = &rest[..key_end];
        if key.contains(']') {
            return Err(format!("unsupported structural path: `{path}`"));
        }
        if !key.is_empty() {
            segments.push(PathSegment::Key(key.to_string()));
        }
        rest = &rest[key_end..];

        while let Some(after_open) = rest.strip_prefix('[') {
            if after_open.starts_with('"') {
                let mut strings =
                    serde_json::Deserializer::from_str(after_open).into_iter::<String>();
                let key = strings
                    .next()
                    .transpose()
                    .map_err(|_| format!("unsupported structural path: `{path}`"))?
                    .ok_or_else(|| format!("unsupported structural path: `{path}`"))?;
                let after_key = &after_open[strings.byte_offset()..];
                rest = after_key
                    .strip_prefix(']')
                    .ok_or_else(|| format!("unsupported structural path: `{path}`"))?;
                segments.push(PathSegment::Key(key));
                continue;
            }
            let close = after_open
                .find(']')
                .ok_or_else(|| format!("unsupported structural path: `{path}`"))?;
            let index_text = &after_open[..close];
            if index_text.is_empty()
                || (index_text.starts_with('0') && index_text.len() > 1)
                || !index_text.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(format!("unsupported structural path: `{path}`"));
            }
            let index = index_text
                .parse::<usize>()
                .map_err(|_| format!("unsupported structural path: `{path}`"))?;
            segments.push(PathSegment::Index(index));
            rest = &after_open[close + 1..];
        }

        if rest.is_empty() {
            break;
        }
        if let Some(next) = rest.strip_prefix('.') {
            if next.is_empty() {
                return Err(format!("unsupported structural path: `{path}`"));
            }
            rest = next;
            continue;
        }
        return Err(format!("unsupported structural path: `{path}`"));
    }

    Ok((prefix, segments))
}

pub(super) fn render_path(prefix: Option<&str>, segments: &[PathSegment]) -> String {
    let mut rendered = prefix.unwrap_or_default().to_string();
    for segment in segments {
        match segment {
            PathSegment::Key(key) => {
                if path_key_is_bare(key) {
                    if !rendered.is_empty() {
                        rendered.push('.');
                    }
                    rendered.push_str(key);
                } else {
                    rendered.push('[');
                    rendered.push_str(&serde_json::to_string(key).expect("string path encoding"));
                    rendered.push(']');
                }
            }
            PathSegment::Index(index) => {
                rendered.push('[');
                rendered.push_str(&index.to_string());
                rendered.push(']');
            }
        }
    }
    rendered
}

pub(super) fn read_path<'a>(root: &'a Value, path: &str) -> Result<Option<&'a Value>, String> {
    read_segments(root, &parse_path(path)?)
}

fn read_segments<'a>(
    root: &'a Value,
    segments: &[PathSegment],
) -> Result<Option<&'a Value>, String> {
    let mut cursor = root;
    for segment in segments {
        cursor = match segment {
            PathSegment::Key(key) => match cursor.get(key) {
                Some(value) => value,
                None => return Ok(None),
            },
            PathSegment::Index(index) => match cursor.get(*index) {
                Some(value) => value,
                None => return Ok(None),
            },
        };
    }
    Ok(Some(cursor))
}

/// Inspect the current data-plane source representation through its typed
/// reference. Nested fields share their original item reference. A removed
/// nearest reference stays removed; an ancestor does not resurrect it.
pub(super) fn source_value<'a>(
    canonical: &'a Value,
    inverse: &RequestInverseContext,
    source_path: &str,
) -> Result<Option<&'a Value>, String> {
    let source = parse_path(source_path)?;
    let mut nearest = None;
    for reference in &inverse.opaque_record_references {
        let path = parse_path(&reference.path)?;
        if source.starts_with(&path)
            && nearest
                .as_ref()
                .is_none_or(|(_, depth)| path.len() > *depth)
        {
            nearest = Some((reference, path.len()));
        }
    }
    let Some((reference, depth)) = nearest else {
        return Ok(None);
    };
    let Some(value) = opaque_value(canonical, reference)? else {
        return Ok(None);
    };
    read_segments(value, &source[depth..])
}

pub(super) fn direct_child_key(path: &str, parent: &str) -> Result<Option<String>, String> {
    let path = parse_path(path)?;
    let parent = parse_path(parent)?;
    if !path.starts_with(&parent) || path.len() != parent.len() + 1 {
        return Ok(None);
    }
    Ok(match path.last() {
        Some(PathSegment::Key(key)) => Some(key.clone()),
        _ => None,
    })
}

pub(super) fn write_path(root: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let segments = parse_path(path)?;
    if segments.is_empty() {
        *root = value;
        return Ok(());
    }

    let mut cursor = root;
    for (position, segment) in segments[..segments.len() - 1].iter().enumerate() {
        let next_container = || match &segments[position + 1] {
            PathSegment::Key(_) => Value::Object(Default::default()),
            PathSegment::Index(_) => Value::Array(Vec::new()),
        };
        cursor = match segment {
            PathSegment::Key(key) => cursor
                .as_object_mut()
                .ok_or_else(|| format!("noncontainer path collision at `{path}`"))?
                .entry(key.clone())
                .or_insert_with(next_container),
            PathSegment::Index(index) => {
                let array = cursor
                    .as_array_mut()
                    .ok_or_else(|| format!("noncontainer path collision at `{path}`"))?;
                if array.len() <= *index {
                    let next_len = index
                        .checked_add(1)
                        .ok_or_else(|| format!("unsupported structural path: `{path}`"))?;
                    array.resize(next_len, Value::Null);
                    array[*index] = next_container();
                }
                &mut array[*index]
            }
        };
    }

    match segments.last().expect("non-empty path") {
        PathSegment::Key(key) => {
            cursor
                .as_object_mut()
                .ok_or_else(|| format!("noncontainer path collision at `{path}`"))?
                .insert(key.clone(), value);
        }
        PathSegment::Index(index) => {
            let array = cursor
                .as_array_mut()
                .ok_or_else(|| format!("noncontainer path collision at `{path}`"))?;
            if array.len() <= *index {
                let next_len = index
                    .checked_add(1)
                    .ok_or_else(|| format!("unsupported structural path: `{path}`"))?;
                array.resize(next_len, Value::Null);
            }
            array[*index] = value;
        }
    }

    Ok(())
}

pub(super) fn opaque_value<'a>(
    canonical: &'a Value,
    reference: &OpaqueRecordReference,
) -> Result<Option<&'a Value>, String> {
    let Some(extension) = canonical.get("routecodex_chat_extension") else {
        return Ok(None);
    };
    let Some(records) = extension.get("chat_extension_opaque_record") else {
        return Ok(None);
    };
    let records = records.as_array().ok_or_else(|| {
        "routecodex_chat_extension.chat_extension_opaque_record must be an array".to_string()
    })?;

    for record in records {
        let Some(record_id) = record.get("record_id").and_then(Value::as_str) else {
            continue;
        };
        if record_id != reference.record_id {
            continue;
        }

        let path = record
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("opaque record `{record_id}` is missing `path`"))?;
        let encoding = record
            .get("encoding")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("opaque record `{record_id}` is missing `encoding`"))?;
        if path != reference.path || encoding != reference.encoding {
            return Err(format!("opaque record `{record_id}` identity mismatch"));
        }
        return Ok(record.get("value"));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{direct_child_key, opaque_value, parse_path, read_path, source_value, write_path};
    use crate::operation_runner::request_context_store::OpaqueRecordReference;

    fn reference(record_id: &str, path: &str, encoding: &str) -> OpaqueRecordReference {
        OpaqueRecordReference {
            record_id: record_id.to_string(),
            path: path.to_string(),
            encoding: encoding.to_string(),
        }
    }

    #[test]
    fn source_shape_reads_native_child_from_real_normalizer_reference() {
        use crate::operation_runner::operators::field_operator_library::normalize_client_request;
        use crate::operation_runner::RequestScopedContextPair;
        let normalized = normalize_client_request(
            "responses",
            &json!({
                "input":[{"role":"user","content":[
                    {"type":"input_image","image_url":{"url":"old","vendor.name[0]":null}}
                ]}]
            }),
        )
        .unwrap();
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        assert_eq!(
            source_value(
                &normalized.canonical_request,
                &pair.inverse_context,
                "request.input[0].content[0].type"
            )
            .unwrap(),
            Some(&json!("input_image"))
        );
        assert_eq!(
            source_value(
                &normalized.canonical_request,
                &pair.inverse_context,
                r#"request.input[0].content[0].image_url["vendor.name[0]"]"#
            )
            .unwrap(),
            Some(&Value::Null)
        );
        assert_eq!(
            source_value(
                &normalized.canonical_request,
                &pair.inverse_context,
                "request.input[0].missing"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn removed_nearest_source_reference_is_not_replayed_from_ancestor() {
        use crate::operation_runner::operators::field_operator_library::normalize_client_request;
        use crate::operation_runner::RequestScopedContextPair;
        let normalized = normalize_client_request(
            "responses",
            &json!({
                "instructions":[{"text":"old", "vendor":{"nested":true}}],
                "input":[]
            }),
        )
        .unwrap();
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        let mut canonical = normalized.canonical_request;
        let records = canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
            .as_array_mut()
            .unwrap();
        records.retain(|record| record["path"] != "request.instructions[0].vendor");
        assert_eq!(
            source_value(
                &canonical,
                &pair.inverse_context,
                "request.instructions[0].vendor.nested"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn direct_child_resolution_uses_structural_keys() {
        assert_eq!(
            direct_child_key(r#"request.input[0]["vendor.name[0]"]"#, "request.input[0]").unwrap(),
            Some("vendor.name[0]".into())
        );
        assert_eq!(
            direct_child_key("request.input[0].content[1]", "request.input[0]").unwrap(),
            None
        );
        assert_eq!(
            direct_child_key("request.input[1].vendor", "request.input[0]").unwrap(),
            None
        );
    }

    #[test]
    fn reads_nested_namespaces_and_array_segments() {
        let root = json!({
            "messages": [
                {"role": "user"},
                {"role": "assistant", "vendor": {"nested": {"value": "readable"}}}
            ],
            "routecodex_chat_extension": {
                "responses_request": {"include": ["reasoning.encrypted_content"]}
            }
        });

        assert_eq!(
            read_path(&root, "request.messages[1].vendor.nested.value").unwrap(),
            Some(&json!("readable"))
        );
        assert_eq!(
            read_path(
                &root,
                "chat.routecodex_chat_extension.responses_request.include[0]"
            )
            .unwrap(),
            Some(&json!("reasoning.encrypted_content"))
        );
        assert_eq!(
            read_path(&root, "messages[1].vendor.nested.value").unwrap(),
            Some(&json!("readable"))
        );
    }

    #[test]
    fn accepts_rooted_and_rootless_concrete_paths() {
        let root = json!({"value": 1, "routecodex_chat_extension": {"value": 2}});

        assert_eq!(read_path(&root, "request.value").unwrap(), Some(&json!(1)));
        assert_eq!(
            read_path(&json!({"value": 3}), "value").unwrap(),
            Some(&json!(3))
        );
        assert_eq!(read_path(&root, "request").unwrap(), Some(&root));
        assert_eq!(read_path(&root, "chat").unwrap(), Some(&root));
        assert_eq!(read_path(&root, "").unwrap(), Some(&root));
    }

    #[test]
    fn quoted_literal_keys_preserve_dots_brackets_and_escaped_quotes() {
        let path = r#"chat.extension["generationConfig.vendor"]["a]b\"c"][0]"#;
        let mut root = json!({"extension":{"untouched":true}});
        write_path(&mut root, path, json!("literal\nbytes")).unwrap();
        assert_eq!(
            root,
            json!({"extension":{"untouched":true,"generationConfig.vendor":{"a]b\"c":["literal\nbytes"]}}})
        );
        assert_eq!(
            read_path(&root, path).unwrap(),
            Some(&json!("literal\nbytes"))
        );
        assert_eq!(
            read_path(&json!({"x.y":null}), r#"request["x.y"]"#).unwrap(),
            Some(&Value::Null)
        );
    }

    #[test]
    fn missing_read_returns_none_but_null_returns_value() {
        let root = json!({"present": null});

        assert_eq!(
            read_path(&root, "request.present").unwrap(),
            Some(&Value::Null)
        );
        assert_eq!(read_path(&root, "request.absent").unwrap(), None);
        assert_eq!(read_path(&root, "request.arr[0]").unwrap(), None);
        assert!(read_path(&root, "request.[0]").is_err());
        assert!(read_path(&root, "request.arr[]").is_err());
        assert!(read_path(&root, "request.arr[-1]").is_err());
        assert!(read_path(&root, "request.arr[01]").is_err());
        assert!(read_path(&root, "request.arr.foo").unwrap().is_none());
    }

    #[test]
    fn write_creates_required_containers_and_sparse_slots_are_null() {
        let mut root = json!({});

        write_path(
            &mut root,
            "request.messages[2].content[1].text",
            json!("created"),
        )
        .unwrap();

        assert_eq!(
            root,
            json!({
                "messages": [
                        null,
                        null,
                        {"content": [null, {"text": "created"}]}
                ]
            })
        );
    }

    #[test]
    fn write_rootless_path_uses_the_current_root() {
        let mut root = json!({});

        write_path(&mut root, "value[0]", json!({"literal": "*** patch\n"})).unwrap();

        assert_eq!(root, json!({"value":[{"literal": "*** patch\n"}]}));
        write_path(&mut root, "request", json!({"root": true})).unwrap();
        assert_eq!(root, json!({"root": true}));
        write_path(&mut root, "", json!(["replaced"])).unwrap();
        assert_eq!(root, json!(["replaced"]));
    }

    #[test]
    fn write_preserves_unknown_values_exact_strings_and_untouched_siblings() {
        let literal = "*** Begin Patch\n*** Update File: a.rs\n+literal\n*** End Patch";
        let mut root = json!({
                "before": {"keep": ["exactly", null, 3]},
                "value": "old",
                "after": {"keep": true}
        });
        let before = root["before"].clone();
        let after = root["after"].clone();

        write_path(&mut root, "request.value", json!(literal)).unwrap();

        assert_eq!(root["value"], json!(literal));
        assert_eq!(root["before"], before);
        assert_eq!(root["after"], after);
    }

    #[test]
    fn write_70k_multiline_exec_and_patch_values_round_trip_byte_exactly() {
        let exec_lines = "cmd:\n  - sed -n '1,240p' a.rs\n  - cargo test\n".repeat(2_000);
        let patch =
            "*** Begin Patch\n*** Update File: a.rs\n+literal bytes\n*** End Patch\n".repeat(1_500);

        let mut root = json!({"untouched": ["sibling"]});
        write_path(
            &mut root,
            "request.messages[0].tool_calls[0].function.arguments",
            json!(exec_lines.clone()),
        )
        .unwrap();
        write_path(
            &mut root,
            "request.messages[0].tool_calls[0].function.patch",
            json!(patch.clone()),
        )
        .unwrap();

        assert_eq!(
            read_path(
                &root,
                "request.messages[0].tool_calls[0].function.arguments"
            )
            .unwrap(),
            Some(&json!(exec_lines))
        );
        assert_eq!(
            read_path(&root, "request.messages[0].tool_calls[0].function.patch").unwrap(),
            Some(&json!(patch))
        );
        assert_eq!(root["untouched"], json!(["sibling"]));
    }

    #[test]
    fn conflicting_noncontainer_write_is_explicit_and_preserves_truth() {
        let original = json!({"leaf": "business", "arr": [{"keep": true}]});
        let mut root = original.clone();

        let leaf_error = write_path(&mut root, "request.leaf.child", json!(1)).unwrap_err();
        assert!(leaf_error.contains("noncontainer path collision"));
        assert_eq!(root, original);

        let array_error = write_path(&mut root, "request.arr[0].keep.child", json!(1)).unwrap_err();
        assert!(array_error.contains("noncontainer path collision"));
        assert_eq!(root, original);
    }

    #[test]
    fn parser_grammar_is_concrete_and_has_no_wildcards() {
        assert_eq!(parse_path("a[0].b[12].c").unwrap().len(), 5);
        for invalid in [
            "a[]", "a[*]", "a[-1]", "a[01]", "a[0]b", "a..b", ".a", "request.",
        ] {
            assert!(parse_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn opaque_value_resolves_by_record_id_independent_of_list_order() {
        let first = json!({"record_id": "first", "path": "request.first", "encoding": "json-object", "value": {"n": 1}});
        let wanted = json!({"record_id": "wanted", "path": "request.original", "encoding": "string", "value": "*** literal\n"});
        let canonical = json!({
            "routecodex_chat_extension": {
                "chat_extension_opaque_record": [first.clone(), wanted.clone()]
            }
        });

        let found = opaque_value(
            &canonical,
            &reference("wanted", "request.original", "string"),
        )
        .unwrap();
        assert_eq!(found, Some(&wanted["value"]));
    }

    #[test]
    fn opaque_value_missing_record_is_none_and_mismatch_is_error() {
        let canonical = json!({
            "routecodex_chat_extension": {
                "chat_extension_opaque_record": [{
                    "record_id": "wanted",
                    "path": "request.original",
                    "encoding": "string",
                    "value": "value"
                }]
            }
        });

        assert_eq!(
            opaque_value(&canonical, &reference("missing", "request.x", "string")).unwrap(),
            None
        );
        assert!(opaque_value(&canonical, &reference("wanted", "request.other", "string")).is_err());
        assert!(opaque_value(
            &canonical,
            &reference("wanted", "request.original", "json-object")
        )
        .is_err());
        assert!(opaque_value(
            &json!({"routecodex_chat_extension": {"chat_extension_opaque_record": "bad"}}),
            &reference("missing", "request.x", "string")
        )
        .is_err());
    }
}
