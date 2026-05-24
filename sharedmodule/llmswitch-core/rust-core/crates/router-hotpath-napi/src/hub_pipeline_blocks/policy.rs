use serde_json::{Map, Value};

pub(crate) fn resolve_hub_policy_override(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubPolicyOverride")?;
    let override_obj = raw.as_object()?;

    let mode = normalize_policy_mode(override_obj.get("mode").and_then(|v| v.as_str()))?;
    let mut out = Map::<String, Value>::new();
    out.insert("mode".to_string(), Value::String(mode));

    if let Some(sample_rate) = override_obj.get("sampleRate").and_then(|v| v.as_f64()) {
        if sample_rate.is_finite() {
            if let Some(number) = serde_json::Number::from_f64(sample_rate) {
                out.insert("sampleRate".to_string(), Value::Number(number));
            }
        }
    }

    Some(Value::Object(out))
}

pub(crate) fn resolve_hub_shadow_compare_config(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let raw = metadata_obj.get("__hubShadowCompare")?;
    let shadow_obj = raw.as_object()?;

    let baseline_mode = normalize_policy_mode(
        shadow_obj
            .get("baselineMode")
            .and_then(|v| v.as_str())
            .or_else(|| shadow_obj.get("mode").and_then(|v| v.as_str())),
    )?;

    let mut out = Map::<String, Value>::new();
    out.insert("baselineMode".to_string(), Value::String(baseline_mode));
    Some(Value::Object(out))
}

fn normalize_policy_mode(raw: Option<&str>) -> Option<String> {
    let candidate = raw.unwrap_or("").trim().to_ascii_lowercase();
    match candidate.as_str() {
        "off" | "observe" | "enforce" => Some(candidate),
        _ => None,
    }
}
