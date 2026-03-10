use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Number, Value};
use std::collections::HashMap;

fn is_object(value: &Value) -> bool {
    value.is_object()
}

fn norm_key(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn get_default_aliases(prop: &str) -> Vec<&'static str> {
    match prop.to_lowercase().as_str() {
        "file_path" => vec!["path", "file", "filepath", "filePath"],
        "pattern" => vec!["glob", "include", "includes", "query", "regex"],
        "content" => vec!["text", "data", "body"],
        "old_string" => vec!["old", "from", "before", "oldString", "previous"],
        "new_string" => vec!["new", "to", "after", "newString", "next"],
        "command" => vec!["cmd", "command_list", "commandList"],
        "path" => vec!["dir", "directory"],
        "glob" => vec!["include", "includes", "patterns"],
        "todos" => vec!["items", "list", "tasks"],
        "replace_all" => vec!["replaceAll", "all", "allOccurrences"],
        _ => vec![],
    }
}

fn build_property_map(schema: &Value) -> HashMap<String, String> {
    let mut map = HashMap::<String, String>::new();
    let props = schema
        .as_object()
        .and_then(|row| row.get("properties"))
        .and_then(Value::as_object);
    let Some(props) = props else {
        return map;
    };
    for (prop_name, prop_schema) in props {
        map.insert(norm_key(prop_name), prop_name.clone());
        if let Some(aliases) = prop_schema
            .as_object()
            .and_then(|row| row.get("x-aliases"))
            .and_then(Value::as_array)
        {
            for alias in aliases {
                if let Some(alias_text) = alias.as_str() {
                    map.insert(norm_key(alias_text), prop_name.clone());
                }
            }
        }
        for alias in get_default_aliases(prop_name) {
            map.insert(norm_key(alias), prop_name.clone());
        }
    }
    map
}

fn parse_want_type(schema: &Value) -> Option<String> {
    let t = schema.as_object().and_then(|row| row.get("type"))?;
    if let Some(s) = t.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = t.as_array() {
        for item in arr {
            if let Some(s) = item.as_str() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn js_like_to_string(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(items) => items
            .iter()
            .map(js_like_to_string)
            .collect::<Vec<String>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn parse_js_number_from_string(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(raw) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(raw, 16).ok().map(|v| v as f64);
    }
    if let Some(raw) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return i64::from_str_radix(raw, 8).ok().map(|v| v as f64);
    }
    if let Some(raw) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return i64::from_str_radix(raw, 2).ok().map(|v| v as f64);
    }
    trimmed.parse::<f64>().ok()
}

fn parse_js_integer_from_string(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars().peekable();
    let mut sign = "";
    if let Some(first) = chars.peek() {
        if *first == '+' || *first == '-' {
            sign = if *first == '-' { "-" } else { "" };
            chars.next();
        }
    }
    let digits: String = chars.take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    format!("{}{}", sign, digits).parse::<i64>().ok()
}

fn coerce_type(value: &Value, schema: &Value) -> Value {
    let want = parse_want_type(schema);
    let Some(want) = want else {
        return value.clone();
    };
    match want.as_str() {
        "string" => match value {
            Value::String(_) => value.clone(),
            Value::Array(items) => Value::String(
                items
                    .iter()
                    .map(js_like_to_string)
                    .collect::<Vec<String>>()
                    .join(" "),
            ),
            Value::Null => Value::Null,
            _ => Value::String(js_like_to_string(value)),
        },
        "number" => match value {
            Value::Number(_) => value.clone(),
            Value::String(text) => parse_js_number_from_string(text)
                .and_then(Number::from_f64)
                .map(Value::Number)
                .unwrap_or_else(|| value.clone()),
            _ => value.clone(),
        },
        "integer" => match value {
            Value::Number(num) => {
                if let Some(i) = num.as_i64() {
                    Value::Number(i.into())
                } else if let Some(f) = num.as_f64() {
                    Value::Number((f.trunc() as i64).into())
                } else {
                    value.clone()
                }
            }
            Value::String(text) => parse_js_integer_from_string(text)
                .map(|v| Value::Number(v.into()))
                .unwrap_or_else(|| value.clone()),
            _ => value.clone(),
        },
        "boolean" => match value {
            Value::Bool(_) => value.clone(),
            Value::String(text) => {
                let lower = text.to_lowercase();
                if lower == "true" {
                    Value::Bool(true)
                } else if lower == "false" {
                    Value::Bool(false)
                } else {
                    value.clone()
                }
            }
            _ => value.clone(),
        },
        "array" => match value {
            Value::Array(_) => value.clone(),
            Value::String(text) => {
                let parts = text
                    .split(|c| c == '\n' || c == ',')
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<String>>();
                if parts.is_empty() {
                    value.clone()
                } else {
                    Value::Array(parts.into_iter().map(Value::String).collect())
                }
            }
            _ => value.clone(),
        },
        "object" => {
            if value.is_object() {
                value.clone()
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

fn normalize_args_by_schema(input: &Value, schema: &Value) -> Value {
    let schema_props = schema
        .as_object()
        .and_then(|row| row.get("properties"))
        .and_then(Value::as_object);
    if schema_props.is_none() || !is_object(input) {
        let ok = input
            .as_object()
            .map(|row| !row.is_empty())
            .unwrap_or(false);
        if ok {
            return json!({ "ok": true, "value": input });
        }
        return json!({ "ok": false, "errors": ["no_schema_or_invalid_input"] });
    }

    let input_obj = input.as_object().unwrap();
    let prop_map = build_property_map(schema);
    let mut out = Map::<String, Value>::new();
    let mut errors = Vec::<String>::new();
    let additional = schema
        .as_object()
        .and_then(|row| row.get("additionalProperties"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let required_list = schema
        .as_object()
        .and_then(|row| row.get("required"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if input_obj.len() == 1 {
        if let Some(Value::String(raw_value)) = input_obj.get("_raw") {
            if required_list.len() == 1 {
                if let Some(only) = required_list[0].as_str() {
                    if let Some(child_schema) = schema_props.unwrap().get(only) {
                        let coerced = coerce_type(&Value::String(raw_value.clone()), child_schema);
                        if let Value::String(text) = &coerced {
                            if !text.trim().is_empty() {
                                out.insert(only.to_string(), coerced);
                            }
                        }
                    }
                }
            }
        }
    }

    for (key, value) in input_obj {
        let normalized = norm_key(key);
        if let Some(target) = prop_map.get(&normalized) {
            let child_schema = schema_props.unwrap().get(target).unwrap_or(&Value::Null);
            out.insert(target.clone(), coerce_type(value, child_schema));
        } else if additional {
            out.insert(key.clone(), value.clone());
        }
    }

    for required in required_list {
        let Some(required_key) = required.as_str() else {
            continue;
        };
        let missing = match out.get(required_key) {
            None => true,
            Some(Value::String(text)) => text.trim().is_empty(),
            Some(Value::Array(items)) => items.is_empty(),
            Some(Value::Object(row)) => row.is_empty(),
            _ => false,
        };
        if missing {
            errors.push(format!("missing_required:{}", required_key));
        }
    }

    if errors.is_empty() {
        json!({ "ok": true, "value": Value::Object(out) })
    } else {
        json!({ "ok": false, "value": Value::Object(out), "errors": errors })
    }
}

#[napi_derive::napi]
pub fn normalize_args_by_schema_json(
    input_json: String,
    schema_json: String,
) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let schema: Value =
        serde_json::from_str(&schema_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = normalize_args_by_schema(&input, &schema);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn normalize_tool_name(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn extract_tool_function_name(entry: &Map<String, Value>) -> String {
    if let Some(fn_name) = entry
        .get("function")
        .and_then(Value::as_object)
        .and_then(|row| row.get("name"))
        .and_then(Value::as_str)
    {
        let trimmed = fn_name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn is_shell_tool_name(name: &str) -> bool {
    matches!(name, "shell" | "shell_command" | "exec_command")
}

fn has_apply_patch_tool_declared(tools: &[Value]) -> bool {
    for entry in tools {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let name = extract_tool_function_name(row);
        if normalize_tool_name(Some(&Value::String(name))) == "apply_patch" {
            return true;
        }
    }
    false
}

fn build_shell_description(tool_display_name: &str, has_apply_patch: bool) -> String {
    let label = if tool_display_name.trim().is_empty() {
        "shell"
    } else {
        tool_display_name.trim()
    };
    let base = "Runs a shell command and returns its output.";
    let workdir_line = format!(
        "- Always set the `workdir` param when using the {} function. Avoid using `cd` unless absolutely necessary.",
        label
    );
    let apply_patch_line =
        "- Prefer apply_patch for editing files instead of shell redirection or here-doc usage.";
    if has_apply_patch {
        format!("{}\n{}\n{}", base, workdir_line, apply_patch_line)
    } else {
        format!("{}\n{}", base, workdir_line)
    }
}

fn ensure_shell_schema(params: &Value) -> Value {
    let mut base = params.as_object().cloned().unwrap_or_else(Map::new);
    let mut props = base
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    let existing_desc = props
        .get("command")
        .and_then(Value::as_object)
        .and_then(|row| row.get("description"))
        .and_then(Value::as_str)
        .map(|v| v.to_string());
    let mut command_schema = Map::new();
    command_schema.insert(
        "description".to_string(),
        Value::String(existing_desc.unwrap_or_else(|| {
            "Shell command. Prefer a single string; an array of argv tokens is also accepted."
                .to_string()
        })),
    );
    command_schema.insert(
        "oneOf".to_string(),
        Value::Array(vec![
            Value::Object({
                let mut map = Map::new();
                map.insert("type".to_string(), Value::String("string".to_string()));
                map
            }),
            Value::Object({
                let mut map = Map::new();
                map.insert("type".to_string(), Value::String("array".to_string()));
                map.insert(
                    "items".to_string(),
                    Value::Object({
                        let mut items = Map::new();
                        items.insert("type".to_string(), Value::String("string".to_string()));
                        items
                    }),
                );
                map
            }),
        ]),
    );
    props.insert("command".to_string(), Value::Object(command_schema));
    base.insert("type".to_string(), Value::String("object".to_string()));
    base.insert("properties".to_string(), Value::Object(props));
    let mut required = base
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(Vec::new);
    let mut has_command = false;
    for entry in required.iter() {
        if entry.as_str() == Some("command") {
            has_command = true;
            break;
        }
    }
    if !has_command {
        required.push(Value::String("command".to_string()));
    }
    base.insert("required".to_string(), Value::Array(required));
    if !base
        .get("additionalProperties")
        .and_then(Value::as_bool)
        .is_some()
    {
        base.insert("additionalProperties".to_string(), Value::Bool(false));
    }
    Value::Object(base)
}

fn normalize_tools(tools: &Value) -> Vec<Value> {
    let Some(rows) = tools.as_array() else {
        return Vec::new();
    };
    let has_apply_patch = has_apply_patch_tool_declared(rows);
    let mut out: Vec<Value> = Vec::new();
    for tool in rows {
        let Some(tool_row) = tool.as_object() else {
            continue;
        };
        let fn_row = tool_row.get("function").and_then(Value::as_object);
        let top_name = tool_row
            .get("name")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        let top_desc = tool_row
            .get("description")
            .and_then(Value::as_str)
            .map(|v| v.to_string());
        let top_params = tool_row.get("parameters");

        let name = fn_row
            .and_then(|row| row.get("name"))
            .and_then(Value::as_str)
            .map(|v| v.to_string())
            .or(top_name.clone());
        let Some(name) = name else {
            continue;
        };
        let name_trimmed = name.trim().to_string();
        if name_trimmed.is_empty() {
            continue;
        }

        let desc = fn_row
            .and_then(|row| row.get("description"))
            .and_then(Value::as_str)
            .map(|v| v.to_string())
            .or(top_desc.clone());

        let mut params = if let Some(row) = fn_row.and_then(|row| row.get("parameters")) {
            row.clone()
        } else {
            top_params.cloned().unwrap_or(Value::Null)
        };
        if let Value::String(text) = &params {
            params =
                serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::Object(Map::new()));
        }

        let is_shell = is_shell_tool_name(name_trimmed.as_str());
        let final_params = if is_shell {
            ensure_shell_schema(&params)
        } else if params.is_object() {
            params.clone()
        } else {
            let mut fallback = Map::new();
            fallback.insert("type".to_string(), Value::String("object".to_string()));
            fallback.insert("properties".to_string(), Value::Object(Map::new()));
            fallback.insert("additionalProperties".to_string(), Value::Bool(true));
            Value::Object(fallback)
        };

        let mut function_node = Map::new();
        function_node.insert("name".to_string(), Value::String(name_trimmed.clone()));
        if let Some(description) = desc {
            if !description.trim().is_empty() {
                function_node.insert("description".to_string(), Value::String(description));
            }
        }
        if is_shell {
            let display = if !name_trimmed.is_empty() {
                name_trimmed.clone()
            } else if let Some(top) = top_name.clone() {
                top.trim().to_string()
            } else {
                "shell".to_string()
            };
            function_node.insert(
                "description".to_string(),
                Value::String(build_shell_description(display.as_str(), has_apply_patch)),
            );
        }
        function_node.insert("parameters".to_string(), final_params);

        let mut norm = Map::new();
        norm.insert("type".to_string(), Value::String("function".to_string()));
        norm.insert("function".to_string(), Value::Object(function_node));
        out.push(Value::Object(norm));
    }
    out
}

#[napi_derive::napi]
pub fn normalize_tools_json(tools_json: String) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).unwrap_or_else(|_| Value::Array(Vec::new()));
    let output = normalize_tools(&tools);
    serde_json::to_string(&Value::Array(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
