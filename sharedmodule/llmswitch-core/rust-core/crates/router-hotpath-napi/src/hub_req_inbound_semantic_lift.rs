use crate::shared_tool_mapping::build_anthropic_tool_alias_map_from_slice;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Default)]
struct ReqInboundSemanticLiftInput<'a> {
    payload: Option<&'a Value>,
    protocol: Option<String>,
    entry_endpoint: Option<String>,
    has_client_tools_raw: bool,
    has_tool_alias_map: bool,
}

#[derive(Debug)]
pub struct ReqInboundSemanticLiftApplyInput<'a> {
    pub chat_envelope: Value,
    pub payload: Option<&'a Value>,
    pub protocol: Option<String>,
    pub entry_endpoint: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReqInboundSemanticLiftOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_tools_raw: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name_alias_map: Option<Map<String, Value>>,
}

fn read_raw_tools(payload: Option<&Value>) -> Vec<Value> {
    payload
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get("tools"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn should_capture_alias_map(protocol: Option<&str>, entry_endpoint: Option<&str>) -> bool {
    let protocol_value = protocol.unwrap_or("").trim().to_ascii_lowercase();
    if protocol_value == "anthropic-messages" {
        return true;
    }
    let endpoint = entry_endpoint.unwrap_or("").trim().to_ascii_lowercase();
    endpoint.contains("/v1/messages")
}

fn resolve_req_inbound_semantic_lift_plan(
    input: &ReqInboundSemanticLiftInput<'_>,
) -> ReqInboundSemanticLiftOutput {
    let mut output = ReqInboundSemanticLiftOutput::default();
    let raw_tools = read_raw_tools(input.payload);

    if !input.has_client_tools_raw && !raw_tools.is_empty() {
        output.client_tools_raw = Some(raw_tools.clone());
    }

    if !input.has_tool_alias_map
        && !raw_tools.is_empty()
        && should_capture_alias_map(input.protocol.as_deref(), input.entry_endpoint.as_deref())
    {
        output.tool_name_alias_map =
            build_anthropic_tool_alias_map_from_slice(raw_tools.as_slice());
    }

    output
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object just initialized")
}

pub fn apply_req_inbound_semantic_lift(input: ReqInboundSemanticLiftApplyInput<'_>) -> Value {
    let mut chat_envelope = input.chat_envelope;
    let envelope = ensure_object(&mut chat_envelope);
    let payload_value = envelope
        .entry("payload".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let payload = ensure_object(payload_value);

    let (has_client_tools_raw, has_tool_alias_map) = {
        let semantics_value = payload
            .entry("semantics".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let semantics = ensure_object(semantics_value);

        let tools_value = semantics
            .entry("tools".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let tools = ensure_object(tools_value);

        let has_tool_alias_map = tools
            .get("toolNameAliasMap")
            .and_then(|v| v.as_object())
            .is_some()
            || tools
                .get("toolAliasMap")
                .and_then(|v| v.as_object())
                .is_some();
        let has_client_tools_raw = tools.contains_key("clientToolsRaw");
        (has_client_tools_raw, has_tool_alias_map)
    };

    let plan = resolve_req_inbound_semantic_lift_plan(&ReqInboundSemanticLiftInput {
        payload: input.payload,
        protocol: input.protocol,
        entry_endpoint: input.entry_endpoint,
        has_client_tools_raw,
        has_tool_alias_map,
    });

    let ReqInboundSemanticLiftOutput {
        client_tools_raw,
        tool_name_alias_map,
    } = plan;

    {
        let envelope = ensure_object(&mut chat_envelope);
        let payload_value = envelope
            .entry("payload".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let payload = ensure_object(payload_value);
        let semantics_value = payload
            .entry("semantics".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let semantics = ensure_object(semantics_value);
        let tools_value = semantics
            .entry("tools".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let tools = ensure_object(tools_value);

        if !has_client_tools_raw {
            if let Some(client_tools_raw) = client_tools_raw {
                tools.insert("clientToolsRaw".to_string(), Value::Array(client_tools_raw));
            }
        }

        if !has_tool_alias_map {
            if let Some(alias_map) = tool_name_alias_map {
                tools.insert("toolNameAliasMap".to_string(), Value::Object(alias_map));
            }
        }
    }

    chat_envelope
}
