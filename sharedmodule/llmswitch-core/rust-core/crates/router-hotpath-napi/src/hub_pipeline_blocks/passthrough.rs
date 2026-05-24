use crate::shared_json_utils::value_as_object_or_empty;
use serde_json::{Map, Value};

fn is_passthrough_canonical_chat_key(key: &str) -> bool {
    matches!(
        key,
        "model" | "messages" | "tools" | "parameters" | "metadata" | "semantics" | "stream"
    )
}

fn collect_passthrough_todo_top_level_keys(payload: &Map<String, Value>) -> Vec<Value> {
    let mut keys = payload
        .keys()
        .filter(|key| !is_passthrough_canonical_chat_key(key.as_str()))
        .cloned()
        .collect::<Vec<String>>();
    keys.sort();
    keys.into_iter().map(Value::String).collect::<Vec<Value>>()
}

pub(crate) fn build_passthrough_audit(raw_inbound: &Value, provider_protocol: &str) -> Value {
    let inbound_record = value_as_object_or_empty(raw_inbound);
    let mut raw = Map::<String, Value>::new();
    raw.insert("inbound".to_string(), Value::Object(inbound_record.clone()));

    let mut inbound_todo = Map::<String, Value>::new();
    inbound_todo.insert(
        "unmappedTopLevelKeys".to_string(),
        Value::Array(collect_passthrough_todo_top_level_keys(&inbound_record)),
    );
    inbound_todo.insert(
        "providerProtocol".to_string(),
        Value::String(provider_protocol.to_string()),
    );
    inbound_todo.insert(
        "note".to_string(),
        Value::String("passthrough_mode_parse_record_only".to_string()),
    );

    let mut todo = Map::<String, Value>::new();
    todo.insert("inbound".to_string(), Value::Object(inbound_todo));

    let mut out = Map::<String, Value>::new();
    out.insert("raw".to_string(), Value::Object(raw));
    out.insert("todo".to_string(), Value::Object(todo));
    Value::Object(out)
}

fn ensure_object_field_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    if !root.get(key).and_then(|v| v.as_object()).is_some() {
        root.insert(key.to_string(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("object field")
}

pub(crate) fn annotate_passthrough_governance_skip(audit: &Value) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let todo = ensure_object_field_mut(&mut out, "todo");
    let mut governance = Map::<String, Value>::new();
    governance.insert("skipped".to_string(), Value::Bool(true));
    governance.insert(
        "reason".to_string(),
        Value::String("process_mode_passthrough".to_string()),
    );
    todo.insert("governance".to_string(), Value::Object(governance));
    Value::Object(out)
}

pub(crate) fn attach_passthrough_provider_input_audit(
    audit: &Value,
    provider_payload: &Value,
    provider_protocol: &str,
) -> Value {
    let mut out = value_as_object_or_empty(audit);
    let provider_record = value_as_object_or_empty(provider_payload);
    {
        let raw = ensure_object_field_mut(&mut out, "raw");
        raw.insert(
            "providerInput".to_string(),
            Value::Object(provider_record.clone()),
        );
    }
    {
        let todo = ensure_object_field_mut(&mut out, "todo");
        let mut outbound = Map::<String, Value>::new();
        outbound.insert(
            "unmappedTopLevelKeys".to_string(),
            Value::Array(collect_passthrough_todo_top_level_keys(&provider_record)),
        );
        outbound.insert(
            "providerProtocol".to_string(),
            Value::String(provider_protocol.to_string()),
        );
        outbound.insert(
            "note".to_string(),
            Value::String("provider_payload_not_mapped_back_to_chat_semantics".to_string()),
        );
        todo.insert("outbound".to_string(), Value::Object(outbound));
    }
    Value::Object(out)
}
