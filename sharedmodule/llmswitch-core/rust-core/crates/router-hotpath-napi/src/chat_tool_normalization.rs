use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn is_object(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn default_tool_parameters() -> Value {
    let mut obj = Map::new();
    obj.insert("type".to_string(), Value::String("object".to_string()));
    obj.insert("properties".to_string(), Value::Object(Map::new()));
    obj.insert("additionalProperties".to_string(), Value::Bool(true));
    Value::Object(obj)
}

fn ensure_apply_patch_schema() -> Value {
    let mut patch = Map::new();
    patch.insert("type".to_string(), Value::String("string".to_string()));
    patch.insert(
        "description".to_string(),
        Value::String(
            "Patch text (*** Begin Patch / *** End Patch or GNU unified diff).".to_string(),
        ),
    );

    let mut input = Map::new();
    input.insert("type".to_string(), Value::String("string".to_string()));
    input.insert(
        "description".to_string(),
        Value::String("Alias of patch (patch text). Prefer patch.".to_string()),
    );

    let mut properties = Map::new();
    properties.insert("patch".to_string(), Value::Object(patch));
    properties.insert("input".to_string(), Value::Object(input));

    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("object".to_string()));
    schema.insert("properties".to_string(), Value::Object(properties));
    schema.insert(
        "required".to_string(),
        Value::Array(vec![Value::String("patch".to_string())]),
    );
    schema.insert("additionalProperties".to_string(), Value::Bool(false));
    Value::Object(schema)
}

fn cast_tool_parameters(value: Option<&Value>) -> Value {
    let mut schema = match value {
        Some(Value::Object(obj)) => Value::Object(obj.clone()),
        _ => return default_tool_parameters(),
    };

    let schema_obj = match schema.as_object_mut() {
        Some(v) => v,
        None => return default_tool_parameters(),
    };

    if !schema_obj.contains_key("type") {
        schema_obj.insert("type".to_string(), Value::String("object".to_string()));
    }
    if !schema_obj.get("properties").map(is_object).unwrap_or(false) {
        schema_obj.insert("properties".to_string(), Value::Object(Map::new()));
    }

    Value::Object(schema_obj.clone())
}

fn cast_single_tool(tool: &Value) -> Option<Value> {
    let tool_obj = as_object(tool)?;
    let fn_node = tool_obj.get("function")?;
    let fn_obj = as_object(fn_node)?;

    let name = fn_obj.get("name")?.as_str()?.to_string();
    let parameters = cast_tool_parameters(fn_obj.get("parameters"));
    let description = fn_obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let strict_flag = fn_obj
        .get("strict")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || tool_obj
            .get("strict")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    let mut fn_out = Map::new();
    fn_out.insert("name".to_string(), Value::String(name));
    if let Some(text) = description {
        fn_out.insert("description".to_string(), Value::String(text));
    }
    fn_out.insert("parameters".to_string(), parameters);
    if strict_flag {
        fn_out.insert("strict".to_string(), Value::Bool(true));
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(fn_out));
    Some(Value::Object(out))
}

fn cast_custom_tool(tool: &Value) -> Option<Value> {
    let tool_obj = as_object(tool)?;
    let tool_type = tool_obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let name = tool_obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if tool_type != "custom" || name.trim() != "apply_patch" {
        return None;
    }

    let description = tool_obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    let mut fn_out = Map::new();
    fn_out.insert("name".to_string(), Value::String("apply_patch".to_string()));
    if let Some(text) = description {
        fn_out.insert("description".to_string(), Value::String(text));
    }
    fn_out.insert("parameters".to_string(), ensure_apply_patch_schema());
    fn_out.insert("strict".to_string(), Value::Bool(true));

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(fn_out));
    Some(Value::Object(out))
}

fn cast_governed_tools(tools: &Value) -> Option<Value> {
    let rows = tools.as_array()?;
    let mut normalized: Vec<Value> = Vec::new();
    for tool in rows {
        if let Some(converted) = cast_single_tool(tool).or_else(|| cast_custom_tool(tool)) {
            normalized.push(converted);
        }
    }
    Some(Value::Array(normalized))
}

#[napi]
pub fn cast_governed_tools_json(tools_json: String) -> NapiResult<String> {
    let tools: Value =
        serde_json::from_str(&tools_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = cast_governed_tools(&tools).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
