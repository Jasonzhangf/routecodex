use serde_json::{json, Map, Value};

pub(crate) fn apply_claude_thinking_tool_schema_compat(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let model = root
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .unwrap_or_default();
    if !model.starts_with("claude-") {
        return Value::Object(root.clone());
    }

    let mut next_root = root.clone();
    let request_is_object = next_root
        .get("request")
        .and_then(|v| v.as_object())
        .is_some();
    let tools = if request_is_object {
        next_root
            .get("request")
            .and_then(|v| v.as_object())
            .and_then(|request| request.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
    } else {
        next_root.get("tools").and_then(|v| v.as_array()).cloned()
    };
    let Some(tools) = tools else {
        return Value::Object(next_root);
    };

    let mut next_tools: Vec<Value> = Vec::new();
    for entry in tools {
        let Some(entry_obj) = entry.as_object() else {
            next_tools.push(entry);
            continue;
        };
        let Some(decls) = entry_obj
            .get("functionDeclarations")
            .and_then(|v| v.as_array())
            .cloned()
        else {
            next_tools.push(Value::Object(entry_obj.clone()));
            continue;
        };

        let mut next_decls: Vec<Value> = Vec::new();
        for decl in decls {
            let Some(decl_obj) = decl.as_object() else {
                next_decls.push(decl);
                continue;
            };
            let mut next_decl = decl_obj.clone();
            next_decl.insert(
                "parameters".to_string(),
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": true
                }),
            );
            next_decl.remove("strict");
            next_decls.push(Value::Object(next_decl));
        }
        let mut tool_node = Map::<String, Value>::new();
        tool_node.insert("functionDeclarations".to_string(), Value::Array(next_decls));
        next_tools.push(Value::Object(tool_node));
    }

    if request_is_object {
        if let Some(request) = next_root.get_mut("request").and_then(|v| v.as_object_mut()) {
            request.insert("tools".to_string(), Value::Array(next_tools));
        }
    } else {
        next_root.insert("tools".to_string(), Value::Array(next_tools));
    }

    Value::Object(next_root)
}
