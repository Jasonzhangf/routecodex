fn scope_label(scope: &V3ErrorActionScope) -> String {
    match scope {
        V3ErrorActionScope::None => "none".to_string(),
        V3ErrorActionScope::ProviderInstance { provider_id } => {
            format!("provider_instance:{provider_id}")
        }
        V3ErrorActionScope::ProviderKeyModel {
            provider_id,
            auth_alias,
            model_id,
        } => format!("provider_key_model:{provider_id}:{auth_alias}:{model_id}"),
    }
}
