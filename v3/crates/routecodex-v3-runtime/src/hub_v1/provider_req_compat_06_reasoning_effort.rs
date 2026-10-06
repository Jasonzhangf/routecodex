use super::{is_v3_deepseek_v4_compat_model, V3HubProviderWireProtocol, V3ProviderCompatError};
use serde_json::Value;

pub(super) fn project_reasoning_effort_for_selected_target(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3ProviderCompatError> {
    let is_deepseek = matches!(
        selected.compatibility_profile.as_deref(),
        Some("chat:deepseek-max" | "responses:deepseek-console-go")
    ) || is_v3_deepseek_v4_compat_model(&selected.model_id)
        || is_v3_deepseek_v4_compat_model(&selected.wire_model);
    let is_minimax = selected.compatibility_profile.as_deref() == Some("chat:minimax");
    let is_opencode_go_zen = selected.provider_id == "opencode-go-zen";

    let effort_path = match provider_protocol {
        V3HubProviderWireProtocol::Responses => "/reasoning/effort",
        V3HubProviderWireProtocol::OpenAiChat => "/reasoning_effort",
        V3HubProviderWireProtocol::Anthropic => "/output_config/effort",
        V3HubProviderWireProtocol::Gemini => return Ok(()),
    };
    let Some(raw_effort) = payload.pointer(effort_path).cloned() else {
        return Ok(());
    };
    let effort = raw_effort
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            V3ProviderCompatError::other(
                "request_reasoning_effort_projection",
                selected
                    .compatibility_profile
                    .clone()
                    .unwrap_or_else(|| "protocol-default".to_string()),
                format!("non_empty_string_required path={effort_path}"),
            )
        })?
        .to_ascii_lowercase();

    if is_minimax {
        match provider_protocol {
            V3HubProviderWireProtocol::Anthropic => {
                if let Some(root) = payload.as_object_mut() {
                    if let Some(output_config) =
                        root.get_mut("output_config").and_then(Value::as_object_mut)
                    {
                        output_config.remove("effort");
                        if output_config.is_empty() {
                            root.remove("output_config");
                        }
                    }
                    if effort != "none" {
                        root.insert(
                            "thinking".to_string(),
                            serde_json::json!({"type":"adaptive"}),
                        );
                    }
                }
            }
            V3HubProviderWireProtocol::OpenAiChat => {
                if let Some(root) = payload.as_object_mut() {
                    root.remove("reasoning_effort");
                }
            }
            _ => {}
        }
        return Ok(());
    }

    // Anthropic `output_config.effort` is a standard wire field. The
    // protocol codec has already validated/projected it; only provider
    // deviations belong in this compat owner. Do not rewrite the standard
    // Anthropic value here.
    if matches!(provider_protocol, V3HubProviderWireProtocol::Anthropic) {
        return Ok(());
    }

    let projected = if is_opencode_go_zen {
        match effort.as_str() {
            "low" | "minimal" | "medium" => "low",
            "high" | "xhigh" => "high",
            "max" => "max",
            // OpenCode Zen always thinks. Its provider contract rejects the
            // standard `none` value and explicitly requires low/high/max;
            // low is the deterministic provider-compatible representation.
            "none" => "low",
            _ => {
                return Err(V3ProviderCompatError::other(
                    "request_reasoning_effort_projection",
                    selected
                        .compatibility_profile
                        .clone()
                        .unwrap_or_else(|| "compat:passthrough".to_string()),
                    format!(
                        "opencode-go-zen does not support reasoning effort {effort}; supported values are low/high/max"
                    ),
                ));
            }
        }
    } else if is_deepseek {
        match effort.as_str() {
            "none" => "none",
            "xhigh" | "max" => "max",
            "ultra" => "max",
            _ => "high",
        }
    } else {
        match provider_protocol {
            V3HubProviderWireProtocol::Responses | V3HubProviderWireProtocol::OpenAiChat => {
                match effort.as_str() {
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => effort.as_str(),
                    "max" => "xhigh",
                    _ => "medium",
                }
            }
            V3HubProviderWireProtocol::Anthropic => unreachable!(),
            V3HubProviderWireProtocol::Gemini => unreachable!(),
        }
    };

    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            if let Some(reasoning) = payload.get_mut("reasoning").and_then(Value::as_object_mut) {
                reasoning.insert("effort".to_string(), Value::String(projected.to_string()));
            }
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            if let Some(root) = payload.as_object_mut() {
                root.insert(
                    "reasoning_effort".to_string(),
                    Value::String(projected.to_string()),
                );
            }
        }
        V3HubProviderWireProtocol::Anthropic => {
            unreachable!("standard Anthropic effort returned before provider compat projection")
        }
        V3HubProviderWireProtocol::Gemini => unreachable!(),
    }
    Ok(())
}
