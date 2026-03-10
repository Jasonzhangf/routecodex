use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

fn read_engine_id(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let id = obj.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(id)
}

fn read_engine_description(entry: &Value) -> String {
    let obj = match entry.as_object() {
        Some(v) => v,
        None => return String::new(),
    };
    obj.get("description")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

fn build_web_search_tool_append_operations(engines: &Value) -> Option<Value> {
    let rows = engines.as_array()?;
    let mut engine_ids: Vec<Value> = Vec::new();
    let mut engine_desc_parts: Vec<String> = Vec::new();

    for entry in rows {
        let id = match read_engine_id(entry) {
            Some(v) => v,
            None => continue,
        };
        let desc = read_engine_description(entry);
        if desc.is_empty() {
            engine_desc_parts.push(id.clone());
        } else {
            engine_desc_parts.push(format!("{}: {}", id, desc));
        }
        engine_ids.push(Value::String(id));
    }

    if engine_ids.is_empty() {
        return Some(Value::Array(Vec::new()));
    }

    let mut engine_schema = Map::new();
    engine_schema.insert("type".to_string(), Value::String("string".to_string()));
    engine_schema.insert("enum".to_string(), Value::Array(engine_ids));
    engine_schema.insert(
        "description".to_string(),
        Value::String(engine_desc_parts.join("; ")),
    );

    let mut query_schema = Map::new();
    query_schema.insert("type".to_string(), Value::String("string".to_string()));
    query_schema.insert(
        "description".to_string(),
        Value::String("Search query or user question.".to_string()),
    );

    let mut recency_schema = Map::new();
    recency_schema.insert("type".to_string(), Value::String("string".to_string()));
    recency_schema.insert(
        "enum".to_string(),
        Value::Array(vec![
            Value::String("oneDay".to_string()),
            Value::String("oneWeek".to_string()),
            Value::String("oneMonth".to_string()),
            Value::String("oneYear".to_string()),
            Value::String("noLimit".to_string()),
        ]),
    );
    recency_schema.insert(
        "description".to_string(),
        Value::String("Optional recency filter for web search results.".to_string()),
    );

    let mut count_schema = Map::new();
    count_schema.insert("type".to_string(), Value::String("integer".to_string()));
    count_schema.insert("minimum".to_string(), Value::Number(1.into()));
    count_schema.insert("maximum".to_string(), Value::Number(50.into()));
    count_schema.insert(
        "description".to_string(),
        Value::String("Number of results to retrieve.".to_string()),
    );

    let mut properties = Map::new();
    properties.insert("engine".to_string(), Value::Object(engine_schema));
    properties.insert("query".to_string(), Value::Object(query_schema));
    properties.insert("recency".to_string(), Value::Object(recency_schema));
    properties.insert("count".to_string(), Value::Object(count_schema));

    let mut parameters = Map::new();
    parameters.insert("type".to_string(), Value::String("object".to_string()));
    parameters.insert("properties".to_string(), Value::Object(properties));
    parameters.insert(
        "required".to_string(),
        Value::Array(vec![
            Value::String("engine".to_string()),
            Value::String("query".to_string()),
            Value::String("recency".to_string()),
            Value::String("count".to_string()),
        ]),
    );
    parameters.insert("additionalProperties".to_string(), Value::Bool(false));

    let mut function = Map::new();
    function.insert("name".to_string(), Value::String("web_search".to_string()));
    function.insert(
    "description".to_string(),
    Value::String(
      "Perform web search using configured search engines. Use this when the user asks for up-to-date information or news."
        .to_string(),
    ),
  );
    function.insert("parameters".to_string(), Value::Object(parameters));
    function.insert("strict".to_string(), Value::Bool(true));

    let mut tool = Map::new();
    tool.insert("type".to_string(), Value::String("function".to_string()));
    tool.insert("function".to_string(), Value::Object(function));

    let mut metadata_op = Map::new();
    metadata_op.insert(
        "op".to_string(),
        Value::String("set_request_metadata_fields".to_string()),
    );
    let mut metadata_fields = Map::new();
    metadata_fields.insert("webSearchEnabled".to_string(), Value::Bool(true));
    metadata_op.insert("fields".to_string(), Value::Object(metadata_fields));

    let mut append_op = Map::new();
    append_op.insert(
        "op".to_string(),
        Value::String("append_tool_if_missing".to_string()),
    );
    append_op.insert(
        "toolName".to_string(),
        Value::String("web_search".to_string()),
    );
    append_op.insert("tool".to_string(), Value::Object(tool));

    Some(Value::Array(vec![
        Value::Object(metadata_op),
        Value::Object(append_op),
    ]))
}

#[napi]
pub fn build_web_search_tool_append_operations_json(engines_json: String) -> NapiResult<String> {
    let engines: Value =
        serde_json::from_str(&engines_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        build_web_search_tool_append_operations(&engines).unwrap_or(Value::Array(Vec::new()));
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
