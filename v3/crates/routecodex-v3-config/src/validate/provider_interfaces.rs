fn normalize_v3_provider_compatibility_profile(profile: Option<String>) -> Option<String> {
    profile
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// v3-native inline provider 的 compatibility profile 编译默认：只允许已
/// 登记给 v3-native 的条目，避免 v2 provider-directory 的整表默认静默改变
/// v3-native 既有配置的 wire 行为。已登记条目包括 opencode-go 的
/// `responses:deepseek-console-go`（Console Go 网关工具映射 + 交错工具段
/// reasoning 注入契约）和 cc-sol 的 `responses:thinking-tags`（direct
/// 当前轮 thinking tag / reasoning_content 投影）。
fn resolve_v3_native_provider_default_compatibility_profile(provider_id: &str) -> Option<String> {
    match provider_id.trim() {
        "opencode-go" => Some("responses:deepseek-console-go".to_string()),
        "cc-sol" => Some("responses:thinking-tags".to_string()),
        _ => None,
    }
}

fn compile_provider_responses(
    provider_id: &str,
    responses: Option<V3ProviderResponsesAuthoringConfig>,
    _models: &BTreeMap<String, V3ProviderModelManifest>,
) -> Result<Option<V3ProviderResponsesAuthoringConfig>, V3ConfigError> {
    let Some(responses) = responses else {
        return Ok(None);
    };

    match responses.transport {
        V3ResponsesTransportKind::Http => {
            if responses.websocket_v2_url.is_some() {
                return Err(validation(format!(
                    "provider {provider_id} HTTP transport cannot declare websocket_v2_url"
                )));
            }
        }
        V3ResponsesTransportKind::WebsocketV2 => {
            let endpoint = responses
                .websocket_v2_url
                .as_deref()
                .map(str::trim)
                .filter(|endpoint| !endpoint.is_empty())
                .ok_or_else(|| {
                    validation(format!("provider {provider_id} websocket_v2_url is required for websocket_v2 transport"))
                })?;
            if !(endpoint.starts_with("ws://") || endpoint.starts_with("wss://")) {
                return Err(validation(format!(
                    "provider {provider_id} websocket_v2_url must use ws:// or wss://"
                )));
            }
            if endpoint.chars().any(char::is_whitespace) {
                return Err(validation(format!(
                    "provider {provider_id} websocket_v2_url cannot contain whitespace"
                )));
            }
        }
    }

    Ok(Some(responses))
}

const PROVIDER_INTERFACE_TYPES: [&str; 4] = ["responses", "anthropic", "gemini", "openai_chat"];

fn compile_provider_interfaces(
    provider_id: &str,
    legacy_provider_type: String,
    legacy_base_url: String,
    legacy_responses: Option<V3ProviderResponsesAuthoringConfig>,
    interfaces: BTreeMap<String, V3ProviderInterfaceAuthoringConfig>,
    _models: &BTreeMap<String, V3ProviderModelManifest>,
) -> Result<BTreeMap<String, V3ProviderInterfaceManifest>, V3ConfigError> {
    let legacy_scalars_present = !legacy_provider_type.trim().is_empty()
        || !legacy_base_url.trim().is_empty()
        || legacy_responses.is_some();
    let compiled = if interfaces.is_empty() {
        if !legacy_scalars_present {
            return Err(validation(format!(
                "provider {provider_id} must declare type/baseURL or interfaces"
            )));
        }
        if legacy_provider_type.trim().is_empty() {
            return Err(validation(format!("provider {provider_id} type is empty")));
        }
        if !PROVIDER_INTERFACE_TYPES.contains(&legacy_provider_type.as_str()) {
            return Err(validation(format!(
                "provider {provider_id} declares unknown protocol {legacy_provider_type}"
            )));
        }
        if legacy_base_url.trim().is_empty() {
            return Err(validation(format!(
                "provider {provider_id} base_url is empty"
            )));
        }
        let responses = compile_provider_responses(provider_id, legacy_responses, _models)?;
        BTreeMap::from([(
            "default".to_string(),
            V3ProviderInterfaceManifest {
                id: "default".to_string(),
                enabled: true,
                provider_type: legacy_provider_type,
                base_url: legacy_base_url.trim_end_matches('/').to_string(),
                responses,
                compatibility_profile: None,
            },
        )])
    } else {
        if legacy_scalars_present {
            return Err(validation(format!(
                "provider {provider_id} cannot declare interfaces together with type/baseURL/responses"
            )));
        }
        let mut compiled = BTreeMap::new();
        for (interface_id, interface) in interfaces {
            require_id("provider interface", &interface_id)?;
            if interface.interface_type.trim().is_empty() {
                return Err(validation(format!(
                    "provider {provider_id} interface {interface_id} type is empty"
                )));
            }
            if !PROVIDER_INTERFACE_TYPES.contains(&interface.interface_type.as_str()) {
                return Err(validation(format!(
                    "provider {provider_id} interface {interface_id} declares unknown protocol {}",
                    interface.interface_type
                )));
            }
            if interface.base_url.trim().is_empty() {
                return Err(validation(format!(
                    "provider {provider_id} interface {interface_id} base_url is empty"
                )));
            }
            let responses = compile_provider_responses(
                &format!("{provider_id}.{interface_id}"),
                interface.responses,
                _models,
            )?;
            let compatibility_profile =
                normalize_v3_provider_compatibility_profile(interface.compatibility_profile);
            compiled.insert(
                interface_id.clone(),
                V3ProviderInterfaceManifest {
                    id: interface_id,
                    enabled: interface.enabled,
                    provider_type: interface.interface_type,
                    base_url: interface.base_url.trim_end_matches('/').to_string(),
                    responses,
                    compatibility_profile,
                },
            );
        }
        compiled
    };
    if !compiled.values().any(|interface| interface.enabled) {
        return Err(validation(format!(
            "provider {provider_id} must enable at least one interface"
        )));
    }
    Ok(compiled)
}
