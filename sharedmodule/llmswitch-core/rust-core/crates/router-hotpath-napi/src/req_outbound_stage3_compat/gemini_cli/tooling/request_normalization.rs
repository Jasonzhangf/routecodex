fn normalize_tool_declarations(node: &mut Map<String, Value>) {
    let Some(tools) = node.get("tools").and_then(|v| v.as_array()) else {
        return;
    };

    let mut next_tools: Vec<Value> = Vec::new();
    for tool in tools {
        let Some(tool_obj) = tool.as_object() else {
            next_tools.push(tool.clone());
            continue;
        };

        let mut record = tool_obj.clone();
        if let Some(decls) = record
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
        {
            let mut next_decls: Vec<Value> = Vec::new();
            for decl in decls {
                if let Some(decl_obj) = decl.as_object() {
                    if let Some(normalized) = normalize_tool_declaration(decl_obj) {
                        next_decls.push(normalized);
                    }
                }
            }
            record.insert("functionDeclarations".to_string(), Value::Array(next_decls));
        } else if let Some(params) = record.get("parameters") {
            record.insert("parameters".to_string(), normalize_schema_types(params));
        }

        let keep = match record
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
        {
            Some(decls) => !decls.is_empty(),
            None => true,
        };
        if keep {
            next_tools.push(Value::Object(record));
        }
    }

    node.insert("tools".to_string(), Value::Array(next_tools));
}

fn normalize_function_call_args(node: &mut Map<String, Value>) {
    let Some(contents) = node.get("contents").and_then(|v| v.as_array()) else {
        return;
    };

    let mut next_contents: Vec<Value> = Vec::new();
    for entry in contents {
        let Some(entry_obj) = entry.as_object() else {
            next_contents.push(entry.clone());
            continue;
        };

        let mut entry_next = entry_obj.clone();
        let Some(parts) = entry_next.get("parts").and_then(|v| v.as_array()) else {
            next_contents.push(Value::Object(entry_next));
            continue;
        };

        let mut next_parts: Vec<Value> = Vec::new();
        for part in parts {
            let Some(part_obj) = part.as_object() else {
                next_parts.push(part.clone());
                continue;
            };
            let mut part_next = part_obj.clone();
            let Some(fn_call) = part_next.get("functionCall").and_then(|v| v.as_object()) else {
                next_parts.push(Value::Object(part_next));
                continue;
            };

            let mut fn_next = fn_call.clone();
            if let Some(raw_name) = read_trimmed_string(fn_next.get("name")) {
                let normalized_name = normalize_tool_name_alias(&raw_name);
                fn_next.insert("name".to_string(), Value::String(normalized_name.clone()));
                let lower = normalized_name.to_ascii_lowercase();
                if let Some(args) = fn_next.get("args").and_then(|v| v.as_object()) {
                    let mut args_next = args.clone();
                    if lower == "exec_command" {
                        if !args_next.contains_key("command") {
                            if let Some(cmd) = args_next.get("cmd") {
                                args_next.insert("command".to_string(), cmd.clone());
                            }
                        }
                        args_next.remove("cmd");
                    }
                    if lower == "write_stdin" {
                        if !args_next.contains_key("chars") {
                            if let Some(text) = args_next.get("text") {
                                args_next.insert("chars".to_string(), text.clone());
                            }
                        }
                    }
                    fn_next.insert("args".to_string(), Value::Object(args_next));
                }
            }

            part_next.insert("functionCall".to_string(), Value::Object(fn_next));
            next_parts.push(Value::Object(part_next));
        }

        entry_next.insert("parts".to_string(), Value::Array(next_parts));
        next_contents.push(Value::Object(entry_next));
    }

    node.insert("contents".to_string(), Value::Array(next_contents));
}

fn normalize_request_node(node: &Map<String, Value>) -> Map<String, Value> {
    let mut base = node.clone();
    let nested = base.get("request").and_then(|v| v.as_object()).cloned();
    let Some(mut merged) = nested else {
        return base;
    };
    base.remove("request");
    for (key, val) in base {
        if !merged.contains_key(&key) {
            merged.insert(key, val);
        }
    }
    merged
}

fn is_web_search_tool_name(value: Option<&Value>) -> bool {
    let Some(raw) = read_trimmed_string(value) else {
        return false;
    };
    let normalized = raw.to_ascii_lowercase();
    normalized == "web_search" || normalized.starts_with("web_search_")
}

fn strip_web_search_tools(request_node: &mut Map<String, Value>) {
    let Some(tools) = request_node.get("tools").and_then(|v| v.as_array()) else {
        return;
    };

    let mut next_tools: Vec<Value> = Vec::new();
    for tool in tools {
        let Some(tool_obj) = tool.as_object() else {
            next_tools.push(tool.clone());
            continue;
        };
        let mut record = tool_obj.clone();
        if let Some(fn_decls) = record
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
        {
            let filtered: Vec<Value> = fn_decls
                .iter()
                .filter(|decl| {
                    !decl
                        .as_object()
                        .map(|obj| is_web_search_tool_name(obj.get("name")))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            if filtered.is_empty() {
                continue;
            }
            record.insert("functionDeclarations".to_string(), Value::Array(filtered));
            next_tools.push(Value::Object(record));
            continue;
        }

        if is_web_search_tool_name(record.get("name")) {
            continue;
        }

        next_tools.push(Value::Object(record));
    }

    if next_tools.is_empty() {
        request_node.remove("tools");
    } else {
        request_node.insert("tools".to_string(), Value::Array(next_tools));
    }
}

