use serde_json::json;

use routecodex_v4_cordis_bridge::ExecCtx;

const FORBIDDEN_CONTROL_KEYS: &[&str] = &[
    "control",
    "error_chain",
    "metadata_center",
    "payload_cycle",
    "route_facts",
    "scope_session",
    "stopless_state",
    "target_selection",
];

fn reject_control_payload(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(key) = FORBIDDEN_CONTROL_KEYS
                .iter()
                .find(|key| object.contains_key(**key))
            {
                return Err(format!("protocol_decode rejects control payload key {key}"));
            }
            for nested in object.values() {
                reject_control_payload(nested)?;
            }
        }
        serde_json::Value::Array(items) => {
            for nested in items {
                reject_control_payload(nested)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Decode provider raw response at the response-inbound node boundary.
pub fn protocol_decode(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let data = ctx.read_data();
    if !data.is_string() {
        return Err("protocol_decode requires provider raw string".to_string());
    }
    let raw = data.as_str().unwrap_or("");
    if raw.trim_start().is_empty() {
        return Err("protocol_decode rejects empty provider raw".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("protocol_decode rejects malformed provider raw: {error}"))?;
    if !parsed.is_object() {
        return Err("protocol_decode requires provider raw JSON object".to_string());
    }
    reject_control_payload(&parsed)?;
    ctx.write_data(json!({"parsed_response": parsed}))
        .map_err(|error| error.to_string())
}
