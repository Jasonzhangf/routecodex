fn scope_label(scope: &V3ErrorActionScope) -> String {
    match scope {
        V3ErrorActionScope::None => "none".to_string(),
        V3ErrorActionScope::ProviderInstance { provider_id } => {
            format!("provider_instance:{provider_id}")
        }
        V3ErrorActionScope::AuthKey {
            provider_id,
            auth_alias,
        } => format!("auth_key:{provider_id}:{auth_alias}"),
        V3ErrorActionScope::CanonicalModel {
            provider_id,
            model_id,
        } => format!("canonical_model:{provider_id}:{model_id}"),
    }
}
