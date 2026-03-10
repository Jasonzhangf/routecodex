fn normalize_tool_name_alias(raw: &str) -> String {
    match raw {
        "mcp__context7__query-docs" => "mcp__context7__query_docs".to_string(),
        "mcp__context7__resolve-library-id" => "mcp__context7__resolve_library_id".to_string(),
        "mcp__mcp-server-time__convert_time" => "mcp__mcp_server_time__convert_time".to_string(),
        "mcp__mcp-server-time__get_current_time" => {
            "mcp__mcp_server_time__get_current_time".to_string()
        }
        _ => raw.to_string(),
    }
}

fn normalize_schema_types(value: &Value) -> Value {
    match value {
        Value::Array(rows) => Value::Array(rows.iter().map(normalize_schema_types).collect()),
        Value::Object(row) => {
            let mut out = Map::new();
            for (key, val) in row {
                if key == "type" {
                    if let Some(raw) = val.as_str() {
                        out.insert(key.clone(), Value::String(raw.to_ascii_uppercase()));
                    } else {
                        out.insert(key.clone(), normalize_schema_types(val));
                    }
                } else {
                    out.insert(key.clone(), normalize_schema_types(val));
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

fn pick_description(value: Option<&Value>, fallback: &str) -> String {
    read_trimmed_string(value).unwrap_or_else(|| fallback.to_string())
}

fn make_typed_prop(entry: Option<&Value>, fallback_type: &str) -> Value {
    let mut out = Map::new();
    let fallback = read_trimmed_string(entry.and_then(|v| v.get("type")))
        .unwrap_or_else(|| fallback_type.to_string())
        .to_ascii_uppercase();
    out.insert("type".to_string(), Value::String(fallback));
    if let Some(desc) = read_trimmed_string(entry.and_then(|v| v.get("description"))) {
        out.insert("description".to_string(), Value::String(desc));
    }
    Value::Object(out)
}

