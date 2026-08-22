use serde_json::{Map, Value};

use super::client_metadata_projection::unsupported_client_metadata_paths;

pub(super) fn project_openai_client_metadata_to_metadata(
    projected: &mut Value,
    target_protocol: &str,
) -> Result<(), String> {
    let Some(row) = projected.as_object_mut() else {
        return Ok(());
    };
    let Some(client_metadata) = row.remove("client_metadata") else {
        return Ok(());
    };
    let client_metadata = client_metadata.as_object().ok_or_else(|| {
        format!("MalformedOutboundField target_protocol={target_protocol} path=$.client_metadata")
    })?;
    let unsupported = unsupported_client_metadata_paths(client_metadata);
    if !unsupported.is_empty() {
        return Err(format!(
            "UnmappedOutboundFields target_protocol={target_protocol} paths={}",
            unsupported.join(",")
        ));
    }
    let Some(user_id) = client_metadata.get("user_id") else {
        return Ok(());
    };
    let user_id = user_id
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("MalformedOutboundField target_protocol={target_protocol} path=$.client_metadata.user_id")
        })?;
    let metadata = row
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata")
        })?;
    if metadata
        .get("user_id")
        .is_some_and(|existing| existing != user_id)
    {
        return Err(format!(
            "ConflictingOutboundFields target_protocol={target_protocol} paths=$.metadata.user_id,$.client_metadata.user_id"
        ));
    }
    metadata.insert("user_id".to_string(), Value::String(user_id.to_string()));
    Ok(())
}

pub(super) fn validate_openai_metadata(
    projected: &Value,
    target_protocol: &str,
) -> Result<(), String> {
    let Some(metadata) = projected.get("metadata") else {
        return Ok(());
    };
    let metadata = metadata.as_object().ok_or_else(|| {
        format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata")
    })?;
    if metadata.len() > 16 {
        return Err(format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata reason=max_16_pairs"));
    }
    for (key, value) in metadata {
        if key.chars().count() > 64 {
            return Err(format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata[{key:?}] reason=key_max_64"));
        }
        let value = value.as_str().ok_or_else(|| format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata[{key:?}] reason=value_must_be_string"))?;
        if value.chars().count() > 512 {
            return Err(format!("MalformedOutboundField target_protocol={target_protocol} path=$.metadata[{key:?}] reason=value_max_512"));
        }
    }
    Ok(())
}

pub(super) fn project_openai_chat_reasoning_summary_policy(
    projected: &mut Value,
) -> Result<(), String> {
    let Some(row) = projected.as_object_mut() else {
        return Ok(());
    };
    let Some(summary) = row.remove("reasoning_summary_policy") else {
        return Ok(());
    };
    let summary_effort = match summary.as_str() {
        Some("auto") => "medium",
        Some("concise") => "low",
        Some("detailed") => "high",
        _ => {
            return Err(
                "MalformedOutboundField target_protocol=openai_chat path=$.request.reasoning_summary_policy"
                    .to_string(),
            )
        }
    };
    let selected = match row.get("reasoning_effort") {
        None => summary_effort,
        Some(Value::String(value)) => {
            let explicit = value.trim().to_ascii_lowercase();
            let explicit = if reasoning_effort_rank(explicit.as_str()).is_some() {
                explicit
            } else {
                "medium".to_string()
            };
            if reasoning_effort_rank(explicit.as_str()) >= reasoning_effort_rank(summary_effort) {
                row.insert("reasoning_effort".to_string(), Value::String(explicit));
                return Ok(());
            }
            summary_effort
        }
        Some(_) => return Err(
            "MalformedOutboundField target_protocol=openai_chat path=$.request.reasoning_effort"
                .to_string(),
        ),
    };
    row.insert(
        "reasoning_effort".to_string(),
        Value::String(selected.to_string()),
    );
    Ok(())
}

fn reasoning_effort_rank(value: &str) -> Option<u8> {
    match value {
        "none" | "minimal" => Some(0),
        "low" => Some(1),
        "medium" => Some(2),
        "high" => Some(3),
        "xhigh" | "max" => Some(4),
        _ => None,
    }
}
