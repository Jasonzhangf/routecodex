use routecodex_v4_config::{RuntimeProviderCandidate, RuntimeRoute};
use routecodex_v4_router::{select_target, TargetSelectionError};

fn providers() -> Vec<RuntimeProviderCandidate> {
    vec![RuntimeProviderCandidate {
        provider_id: "real-provider".to_string(),
        config_path: "/tmp/provider.toml".to_string(),
        protocol: "responses".to_string(),
        wire_model: "upstream-model".to_string(),
        priority: 1,
        entry_models: vec!["client-alias".to_string(), "upstream-model".to_string()],
    }]
}

fn routes() -> Vec<RuntimeRoute> {
    vec![RuntimeRoute {
        id: "default".to_string(),
        models: vec!["client-alias".to_string(), "upstream-model".to_string()],
        targets: vec!["real-provider".to_string()],
    }]
}

#[test]
fn client_alias_selects_configured_wire_model() {
    let selected = select_target(&providers(), &routes(), "client-alias").expect("selected");
    assert_eq!(selected.provider_id, "real-provider");
    assert_eq!(selected.wire_model, "upstream-model");
}

#[test]
fn unregistered_model_fails_without_default_or_fallback() {
    assert!(matches!(
        select_target(&providers(), &routes(), "missing"),
        Err(TargetSelectionError::ModelUnavailable(model)) if model == "missing"
    ));
}

#[test]
fn missing_route_target_fails_fast() {
    let mut invalid = routes();
    invalid[0].targets[0] = "missing-provider".to_string();
    assert!(matches!(
        select_target(&providers(), &invalid, "client-alias"),
        Err(TargetSelectionError::RouteTargetMissing(provider)) if provider == "missing-provider"
    ));
}
