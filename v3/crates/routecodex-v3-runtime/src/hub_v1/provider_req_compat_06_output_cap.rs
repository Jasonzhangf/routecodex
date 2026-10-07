use super::V3HubProviderWireProtocol;
use serde_json::Value;

// When the client did not express an output limit, the selected provider's
// declared model cap is projected onto the provider wire. A client-supplied
// limit always wins. This runs after the standard protocol projection and the
// provider compat profile, because the wire field names are protocol-specific:
// a canonical max_completion_tokens would not be representable for Gemini.
pub(crate) fn project_provider_declared_output_cap(
    payload: &mut Value,
    selected: &routecodex_v3_target::V3TargetCandidate,
    provider_protocol: V3HubProviderWireProtocol,
) {
    let Some(declared) = selected.max_tokens else {
        return;
    };
    let value = Value::from(declared);
    let insert = |payload: &mut Value, key: &str| {
        if let Some(root) = payload.as_object_mut() {
            if root.get(key).is_none() {
                root.insert(key.to_string(), value.clone());
            }
        }
    };
    match provider_protocol {
        V3HubProviderWireProtocol::Responses => {
            // Direct Responses standardization is lossless and a Responses-shaped
            // body can carry any of the three aliases, so all three are treated
            // as a client-supplied limit.
            let client_supplied = payload.get("max_output_tokens").is_some()
                || payload.get("max_completion_tokens").is_some()
                || payload.get("max_tokens").is_some();
            if client_supplied {
                return;
            }
            insert(payload, "max_output_tokens");
        }
        V3HubProviderWireProtocol::OpenAiChat => {
            let client_supplied = payload.get("max_completion_tokens").is_some()
                || payload.get("max_tokens").is_some();
            if client_supplied {
                return;
            }
            insert(payload, "max_completion_tokens");
        }
        V3HubProviderWireProtocol::Anthropic => insert(payload, "max_tokens"),
        V3HubProviderWireProtocol::Gemini => {
            // `generationConfig` is admitted by the Gemini whitelist without a
            // shape check, so a pre-existing non-object value is left exactly as
            // it is rather than failing a passable request. An existing object is
            // only added to, never replaced: client keys and a client-supplied
            // maxOutputTokens are preserved.
            if let Some(generation_config) = payload.get("generationConfig") {
                if !generation_config.is_object() {
                    return;
                }
                if generation_config
                    .as_object()
                    .map(|config| config.contains_key("maxOutputTokens"))
                    .unwrap_or(false)
                {
                    return;
                }
            }
            if let Some(root) = payload.as_object_mut() {
                let generation_config = root
                    .entry("generationConfig")
                    .or_insert_with(|| Value::Object(Default::default()));
                if let Some(config) = generation_config.as_object_mut() {
                    config.insert("maxOutputTokens".to_string(), value);
                }
            }
        }
    }
}
