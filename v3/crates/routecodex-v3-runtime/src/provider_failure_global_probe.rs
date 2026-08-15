pub fn build_v3_provider_global_probe_target(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Result<V3ResponsesProviderTarget, String> {
    let provider = manifest
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("probe provider {provider_id} missing"))?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| auth_alias.is_none_or(|alias| entry.alias == alias))
        .ok_or_else(|| format!("probe provider {provider_id} has no auth entry"))?;
    let secret = match (
        &auth.env,
        &auth.token_file,
        &auth.secret_file,
        &auth.secret_key,
        &auth.api_key,
    ) {
        (Some(env), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => {
            return Err(format!(
                "probe provider {provider_id} auth entry is invalid"
            ))
        }
    };
    let model = provider
        .models
        .get(model_id.unwrap_or(&provider.default_model))
        .ok_or_else(|| format!("probe provider {provider_id} default model missing"))?;
    let responses = provider.responses.as_ref();
    Ok(V3ResponsesProviderTarget {
        provider_id: provider.id.clone(),
        provider_type: provider.provider_type.clone(),
        base_url: provider.base_url.clone(),
        canonical_model_id: model.id.clone(),
        wire_model: model.wire_name.clone(),
        compatibility_profile: provider.compatibility_profile.clone(),
        auth: V3ProviderAuthHandle {
            alias: auth.alias.clone(),
            secret,
        },
        responses_transport: responses.map(|value| value.transport).unwrap_or_default(),
        websocket_v2_url: responses.and_then(|value| value.websocket_v2_url.clone()),
        provider_request_cleanup: provider.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        initial_concurrency_budget: provider
            .concurrency
            .as_ref()
            .map(|value| value.max_in_flight)
            .unwrap_or(8),
    })
}

async fn probe_v3_provider_global_target_impl(
    target: V3ResponsesProviderTarget,
) -> Result<(), String> {
    let provider_id = target.provider_id.clone();
    let request = build_v3_provider_global_probe_request(
        target,
        format!("provider-global-probe-{provider_id}"),
    )?;
    let response = ReqwestResponsesTransport::default()
        .send(request)
        .await
        .map_err(|error| error.to_string())?;
    if !(200..=299).contains(&response.status()) {
        return Err(format!(
            "provider global probe returned {}",
            response.status()
        ));
    }
    Ok(())
}
