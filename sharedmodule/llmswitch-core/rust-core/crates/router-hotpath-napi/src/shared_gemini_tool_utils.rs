use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

fn normalize_schema_map_entries(value: &Value) -> Option<Map<String, Value>> {
    let arr = value.as_array()?;
    let mut out = Map::new();
    for entry in arr {
        let row = entry.as_object()?;
        let key = row
            .get("key")
            .and_then(Value::as_str)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())?;
        let val = row.get("value")?;
        out.insert(key, val.clone());
    }
    Some(out)
}

fn score_schema_variant(value: &Value) -> i64 {
    let Some(row) = value.as_object() else {
        return 0;
    };
    let t = row
        .get("type")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if t == "string" {
        return 100;
    }
    if t == "object" {
        return 80;
    }
    if t == "array" {
        return 60;
    }
    if t == "integer" || t == "number" || t == "boolean" {
        return 50;
    }
    10
}

fn pick_best_schema_variant(variants: &[Value]) -> Value {
    if variants.is_empty() {
        return serde_json::json!({ "type": "object", "properties": {} });
    }
    let mut best = variants[0].clone();
    let mut best_score = score_schema_variant(&best);
    for candidate in variants.iter().skip(1) {
        let candidate_score = score_schema_variant(candidate);
        if candidate_score > best_score {
            best = candidate.clone();
            best_score = candidate_score;
        }
    }
    best
}

fn preferred_type_from_union(types: &[Value]) -> Option<String> {
    let mut candidates: Vec<String> = types
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty() && v != "null")
        .collect();
    if candidates.is_empty() {
        return None;
    }
    if candidates.iter().any(|v| v == "string") {
        return Some("string".to_string());
    }
    if candidates.iter().any(|v| v == "object") {
        return Some("object".to_string());
    }
    if candidates.iter().any(|v| v == "array") {
        return Some("array".to_string());
    }
    if candidates.iter().any(|v| v == "integer") {
        return Some("integer".to_string());
    }
    if candidates.iter().any(|v| v == "number") {
        return Some("number".to_string());
    }
    if candidates.iter().any(|v| v == "boolean") {
        return Some("boolean".to_string());
    }
    Some(candidates.remove(0))
}

fn normalize_schema_types(value: &Value) -> Value {
    if value.is_null() || value.is_boolean() || value.is_number() || value.is_string() {
        return value.clone();
    }
    if let Some(arr) = value.as_array() {
        return Value::Array(arr.iter().map(normalize_schema_types).collect());
    }
    let Some(row) = value.as_object() else {
        return value.clone();
    };
    let mut out = Map::new();
    for (key, val) in row {
        if key == "type" {
            if let Some(s) = val.as_str() {
                out.insert(key.clone(), Value::String(s.trim().to_ascii_lowercase()));
                continue;
            }
            if let Some(arr) = val.as_array() {
                if let Some(preferred) = preferred_type_from_union(arr) {
                    out.insert(key.clone(), Value::String(preferred));
                }
                continue;
            }
        }
        if key == "properties" {
            if let Some(map) = normalize_schema_map_entries(val) {
                out.insert(key.clone(), normalize_schema_types(&Value::Object(map)));
                continue;
            }
            if val.is_object() {
                out.insert(key.clone(), normalize_schema_types(val));
                continue;
            }
        }
        if key == "enum" {
            if let Some(arr) = val.as_array() {
                let normalized = arr
                    .iter()
                    .map(|entry| {
                        if let Some(s) = entry.as_str() {
                            Value::String(s.to_string())
                        } else if entry.is_null() {
                            Value::String("null".to_string())
                        } else if entry.is_number() || entry.is_boolean() {
                            Value::String(entry.to_string())
                        } else {
                            Value::String(
                                serde_json::to_string(entry).unwrap_or_else(|_| entry.to_string()),
                            )
                        }
                    })
                    .collect::<Vec<Value>>();
                out.insert(key.clone(), Value::Array(normalized));
                continue;
            }
        }
        if (key == "properties" || key == "items") && val.is_object() {
            out.insert(key.clone(), normalize_schema_types(val));
            continue;
        }
        if (key == "anyOf" || key == "oneOf" || key == "allOf") && val.is_array() {
            out.insert(
                key.clone(),
                Value::Array(
                    val.as_array()
                        .unwrap_or(&Vec::new())
                        .iter()
                        .map(normalize_schema_types)
                        .collect(),
                ),
            );
            continue;
        }
        out.insert(key.clone(), normalize_schema_types(val));
    }
    Value::Object(out)
}

fn should_drop_schema_key(key: &str) -> bool {
    if key.starts_with('$') {
        return true;
    }
    matches!(
        key,
        "const"
            | "default"
            | "examples"
            | "example"
            | "title"
            | "deprecated"
            | "readOnly"
            | "writeOnly"
            | "patternProperties"
            | "dependentRequired"
            | "dependentSchemas"
            | "unevaluatedProperties"
            | "unevaluatedItems"
            | "contains"
            | "minContains"
            | "maxContains"
            | "contentEncoding"
            | "contentMediaType"
            | "contentSchema"
            | "if"
            | "then"
            | "else"
            | "not"
            | "exclusiveMinimum"
            | "exclusiveMaximum"
            | "propertyNames"
            | "additionalProperties"
            | "external_web_access"
            | "oneOf"
            | "anyOf"
            | "allOf"
    )
}

fn clone_parameters(value: &Value) -> Value {
    if value.is_null() || value.is_string() || value.is_number() || value.is_boolean() {
        return value.clone();
    }
    if let Some(arr) = value.as_array() {
        return Value::Array(arr.iter().map(clone_parameters).collect());
    }
    let Some(row) = value.as_object() else {
        return serde_json::json!({ "type": "object", "properties": {} });
    };

    if row.contains_key("const") && !row.contains_key("enum") {
        let mut cloned = Map::new();
        for (key, entry) in row {
            if key == "const" {
                cloned.insert(
                    "enum".to_string(),
                    Value::Array(vec![clone_parameters(entry)]),
                );
            } else {
                cloned.insert(key.clone(), clone_parameters(entry));
            }
        }
        return Value::Object(cloned);
    }

    let combinator = if row.get("oneOf").and_then(Value::as_array).is_some() {
        Some("oneOf")
    } else if row.get("anyOf").and_then(Value::as_array).is_some() {
        Some("anyOf")
    } else if row.get("allOf").and_then(Value::as_array).is_some() {
        Some("allOf")
    } else {
        None
    };
    if let Some(combinator_key) = combinator {
        let variants = row
            .get(combinator_key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut simplified = clone_parameters(&pick_best_schema_variant(&variants));
        if let Some(desc) = row.get("description").and_then(Value::as_str) {
            if let Some(simplified_obj) = simplified.as_object_mut() {
                if !simplified_obj
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|v| !v.is_empty())
                    .unwrap_or(false)
                {
                    simplified_obj
                        .insert("description".to_string(), Value::String(desc.to_string()));
                }
            }
        }
        return simplified;
    }

    let mut cloned = Map::new();
    for (key, entry) in row {
        if key == "properties" {
            if let Some(map) = normalize_schema_map_entries(entry) {
                cloned.insert(key.clone(), clone_parameters(&Value::Object(map)));
                continue;
            }
        }
        if key == "type" {
            if let Some(arr) = entry.as_array() {
                if let Some(preferred) = preferred_type_from_union(arr) {
                    cloned.insert("type".to_string(), Value::String(preferred));
                }
                continue;
            }
        }
        if should_drop_schema_key(key) {
            continue;
        }
        cloned.insert(key.clone(), clone_parameters(entry));
    }

    if let Some(props_obj) = cloned.get("properties").and_then(Value::as_object) {
        if let Some(req_arr) = cloned.get("required").and_then(Value::as_array).cloned() {
            let valid: std::collections::HashSet<String> = props_obj.keys().cloned().collect();
            let filtered: Vec<Value> = req_arr
                .iter()
                .filter_map(Value::as_str)
                .filter(|key| valid.contains(*key))
                .map(|key| Value::String(key.to_string()))
                .collect();
            if filtered.is_empty() {
                cloned.remove("required");
            } else {
                cloned.insert("required".to_string(), Value::Array(filtered));
            }
        }
    }

    Value::Object(cloned)
}

fn declaration_to_bridge(declaration: &Value) -> Option<Value> {
    let row = declaration.as_object()?;
    let name = row.get("name").and_then(Value::as_str)?;
    let description = row.get("description").and_then(Value::as_str);
    let parameters = clone_parameters(
        row.get("parameters")
            .unwrap_or(&serde_json::json!({ "type": "object", "properties": {} })),
    );
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(desc) = description {
        function.insert("description".to_string(), Value::String(desc.to_string()));
    }
    function.insert("parameters".to_string(), parameters);

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(function));
    Some(Value::Object(out))
}

fn legacy_tool_to_bridge(entry: &Map<String, Value>) -> Option<Value> {
    let name = entry.get("name").and_then(Value::as_str)?;
    let description = entry.get("description").and_then(Value::as_str);
    let parameters = clone_parameters(
        entry
            .get("parameters")
            .unwrap_or(&serde_json::json!({ "type": "object", "properties": {} })),
    );

    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(desc) = description {
        function.insert("description".to_string(), Value::String(desc.to_string()));
    }
    function.insert("parameters".to_string(), parameters);

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(function));
    Some(Value::Object(out))
}

fn prepare_gemini_tools_for_bridge(raw_tools: &Value, missing: &Value) -> Value {
    let mut next_missing = missing.as_array().cloned().unwrap_or_default();
    if raw_tools.is_null() {
        return serde_json::json!({ "defs": Value::Null, "missing": next_missing });
    }
    let arr = if let Some(items) = raw_tools.as_array() {
        items.clone()
    } else {
        vec![raw_tools.clone()]
    };

    let mut defs: Vec<Value> = Vec::new();
    for (index, entry) in arr.iter().enumerate() {
        let Some(obj) = entry.as_object() else {
            next_missing.push(serde_json::json!({
              "path": format!("tools[{}]", index),
              "reason": "invalid_entry",
              "originalValue": entry
            }));
            continue;
        };
        let declarations = obj.get("functionDeclarations").and_then(Value::as_array);
        if let Some(declarations) = declarations {
            if !declarations.is_empty() {
                for (decl_index, decl) in declarations.iter().enumerate() {
                    if let Some(converted) = declaration_to_bridge(decl) {
                        defs.push(converted);
                    } else {
                        next_missing.push(serde_json::json!({
                          "path": format!("tools[{}].functionDeclarations[{}]", index, decl_index),
                          "reason": "invalid_entry"
                        }));
                    }
                }
                continue;
            }
        }
        if let Some(converted) = legacy_tool_to_bridge(obj) {
            defs.push(converted);
            continue;
        }
        next_missing.push(serde_json::json!({
          "path": format!("tools[{}]", index),
          "reason": "invalid_entry"
        }));
    }

    let defs_value = if defs.is_empty() {
        Value::Null
    } else {
        Value::Array(defs)
    };
    serde_json::json!({ "defs": defs_value, "missing": next_missing })
}

fn normalize_tool_name(name: &str, mode: &str) -> String {
    if mode == "antigravity" {
        name.replace('-', "_")
    } else {
        name.to_string()
    }
}

fn apply_fixups(name: &str, parameters: &Value, mode: &str) -> Value {
    let Some(params_obj) = parameters.as_object() else {
        return parameters.clone();
    };
    let mut params = params_obj.clone();
    let mut props = params
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let is_antigravity = mode == "antigravity";
    let lowered = name.trim().to_ascii_lowercase();

    if lowered == "exec_command" {
        if is_antigravity {
            props.remove("cmd");
            props.insert(
                "command".to_string(),
                serde_json::json!({ "type": "string", "description": "Shell command to execute." }),
            );
            props.insert(
                "workdir".to_string(),
                serde_json::json!({ "type": "string", "description": "Working directory." }),
            );
        } else {
            if !props.contains_key("cmd") && props.contains_key("command") {
                if let Some(v) = props.get("command") {
                    props.insert("cmd".to_string(), v.clone());
                }
            }
            if !props.contains_key("command") && props.contains_key("cmd") {
                if let Some(v) = props.get("cmd") {
                    props.insert("command".to_string(), v.clone());
                }
            }
            if !props.contains_key("cmd") {
                props.insert("cmd".to_string(), serde_json::json!({ "type": "string" }));
            }
            if !props.contains_key("command") {
                props.insert(
                    "command".to_string(),
                    serde_json::json!({ "type": "string" }),
                );
            }
            if !props.contains_key("workdir") {
                props.insert(
                    "workdir".to_string(),
                    serde_json::json!({ "type": "string" }),
                );
            }
        }
        params.insert("properties".to_string(), Value::Object(props));
        params.remove("required");
        return Value::Object(params);
    }

    if lowered == "write_stdin" {
        if !props.contains_key("chars") && props.contains_key("text") {
            if let Some(v) = props.get("text") {
                props.insert("chars".to_string(), v.clone());
            }
        }
        if !props.contains_key("text") && props.contains_key("chars") {
            if let Some(v) = props.get("chars") {
                props.insert("text".to_string(), v.clone());
            }
        }
        if !props.contains_key("session_id") {
            props.insert(
                "session_id".to_string(),
                serde_json::json!({ "type": "number" }),
            );
        }
        if !props.contains_key("chars") {
            props.insert("chars".to_string(), serde_json::json!({ "type": "string" }));
        }
        params.insert("properties".to_string(), Value::Object(props));
        params.remove("required");
        return Value::Object(params);
    }

    if lowered == "apply_patch" {
        if !props.contains_key("patch") {
            props.insert(
                "patch".to_string(),
                serde_json::json!({
                  "type": "string",
                  "description": "Patch text (*** Begin Patch / *** End Patch or GNU unified diff)."
                }),
            );
        }
        if !props.contains_key("input") {
            props.insert(
                "input".to_string(),
                serde_json::json!({ "type": "string", "description": "Alias of patch (patch text). Prefer patch." }),
            );
        }
        if !props.contains_key("instructions") {
            props.insert(
                "instructions".to_string(),
                serde_json::json!({ "type": "string", "description": "Alias of patch (patch text). Prefer patch." }),
            );
        }
        if !props.contains_key("text") {
            props.insert(
                "text".to_string(),
                serde_json::json!({ "type": "string", "description": "Alias of patch (patch text). Prefer patch." }),
            );
        }
        params.insert("properties".to_string(), Value::Object(props));
        params.remove("required");
        return Value::Object(params);
    }

    Value::Object(params)
}

fn rewrite_description(name: &str, description: Option<&str>, mode: &str) -> Option<String> {
    if mode != "antigravity" {
        return description.map(|v| v.to_string());
    }
    let lowered = name.trim().to_ascii_lowercase();
    if lowered == "apply_patch" {
        return Some(
            "Edit files by providing patch text in `patch` (string). Supports \"*** Begin Patch\" / \"*** End Patch\" or GNU unified diff. `input`/`instructions`/`text` are accepted as aliases.".to_string(),
        );
    }
    if lowered == "exec_command" {
        return Some(
            "Run a shell command. Provide `cmd` (string) (alias: `command`) and optional `workdir` (string)."
                .to_string(),
        );
    }
    if lowered == "write_stdin" {
        return Some(
            "Write to an existing exec session. Provide `session_id` (number) and optional `chars` (string)."
                .to_string(),
        );
    }
    description.map(|v| v.to_string())
}

fn build_gemini_tools_from_bridge(defs: &Value, mode_raw: Option<&str>) -> Value {
    let Some(defs_arr) = defs.as_array() else {
        return Value::Null;
    };
    if defs_arr.is_empty() {
        return Value::Null;
    }
    let mode = if mode_raw == Some("antigravity") {
        "antigravity"
    } else {
        "default"
    };

    let mut function_declarations: Vec<Value> = Vec::new();
    for def in defs_arr {
        let Some(def_obj) = def.as_object() else {
            continue;
        };
        let fn_node = def_obj.get("function").and_then(Value::as_object);
        let name = fn_node
            .and_then(|row| row.get("name").and_then(Value::as_str))
            .or_else(|| def_obj.get("name").and_then(Value::as_str));
        let Some(name) = name else {
            continue;
        };
        let final_name = normalize_tool_name(name, mode);
        let description = fn_node
            .and_then(|row| row.get("description").and_then(Value::as_str))
            .or_else(|| def_obj.get("description").and_then(Value::as_str));
        let default_params = serde_json::json!({ "type": "object", "properties": {} });
        let parameters_src = fn_node
            .and_then(|row| row.get("parameters"))
            .or_else(|| def_obj.get("parameters"))
            .unwrap_or(&default_params);
        let parameters = clone_parameters(parameters_src);
        let fixed = apply_fixups(final_name.as_str(), &parameters, mode);
        let normalized_parameters = if mode == "antigravity" {
            normalize_schema_types(&fixed)
        } else {
            fixed
        };

        let mut decl = Map::new();
        decl.insert("name".to_string(), Value::String(final_name.clone()));
        if let Some(desc) = rewrite_description(final_name.as_str(), description, mode) {
            decl.insert("description".to_string(), Value::String(desc));
        }
        decl.insert("parameters".to_string(), normalized_parameters);
        function_declarations.push(Value::Object(decl));
    }

    if function_declarations.is_empty() {
        return Value::Null;
    }
    Value::Array(vec![Value::Object(Map::from_iter(vec![(
        "functionDeclarations".to_string(),
        Value::Array(function_declarations),
    )]))])
}

#[napi_derive::napi]
pub fn prepare_gemini_tools_for_bridge_json(
    raw_tools_json: String,
    missing_json: String,
) -> NapiResult<String> {
    let raw_tools: Value = serde_json::from_str(&raw_tools_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let missing: Value =
        serde_json::from_str(&missing_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = prepare_gemini_tools_for_bridge(&raw_tools, &missing);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn build_gemini_tools_from_bridge_json(
    defs_json: String,
    mode: Option<String>,
) -> NapiResult<String> {
    let defs: Value =
        serde_json::from_str(&defs_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_gemini_tools_from_bridge(&defs, mode.as_deref());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
