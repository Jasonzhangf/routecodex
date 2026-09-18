use routecodex_v4_config::{
    compile_product_config, RuntimeProductConfig, RuntimeProductModel, RuntimeProductPool,
    RuntimeProductProvider, RuntimeProductRouteGroup, RuntimeProductTarget,
    RuntimeProviderCandidate, RuntimeRoute,
};
use routecodex_v4_router::{
    resolve_direct_provider_model, select_product_target, select_product_target_with_unavailable,
    select_target, TargetSelectionError,
};

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

fn product_config() -> RuntimeProductConfig {
    RuntimeProductConfig {
        source: "test".to_string(),
        builtin_catalog_models: vec!["gpt-5.5".to_string()],
        providers: vec![RuntimeProductProvider {
            provider_id: "product-provider".to_string(),
            protocol: "responses".to_string(),
            config_path: "/tmp/product.toml".to_string(),
            models: vec![RuntimeProductModel {
                model_id: "client-model".to_string(),
                wire_name: "wire-model".to_string(),
                capabilities: vec!["thinking".to_string()],
                aliases: Vec::new(),
            }],
            auth_handles: Vec::new(),
        }],
        route_groups: vec![RuntimeProductRouteGroup {
            route_group_id: "responses".to_string(),
            pools: vec![RuntimeProductPool {
                pool_id: "thinking".to_string(),
                selection: "priority".to_string(),
                precedence: Some(2),
                entry_protocol: Some("responses".to_string()),
                models: Vec::new(),
                min_input_tokens: None,
                required_capabilities: vec!["thinking".to_string()],
                targets: vec![RuntimeProductTarget {
                    provider_id: "product-provider".to_string(),
                    model_id: "client-model".to_string(),
                    priority: 1,
                    weight: None,
                }],
            }],
        }],
        default_error_path: Vec::new(),
        error_policies: Vec::new(),
    }
}

#[test]
fn product_alias_selects_wire_model_without_rewriting_target() {
    let mut product = product_config();
    product.providers[0].models[0].aliases = vec!["client-alias".to_string()];
    let selected = select_product_target(
        &product,
        "responses",
        "client-alias",
        "responses",
        &["thinking"],
        0,
    )
    .expect("alias target");
    assert_eq!(selected.provider_id, "product-provider");
    assert_eq!(selected.wire_model, "wire-model");
}

#[test]
fn provider_model_pin_resolves_alias_and_wire_model_without_pool_selection() {
    let mut product = product_config();
    product.providers[0].models[0].aliases = vec!["client-alias".to_string()];
    product.providers[0].auth_handles = vec![routecodex_v4_config::RuntimeProductAuthHandle {
        alias: "key1".to_string(),
        source: "env:PRODUCT_PROVIDER_KEY".to_string(),
    }];
    let selected = resolve_direct_provider_model(&product, "product-provider.client-alias")
        .expect("known provider/model pin resolves")
        .expect("provider.model is a direct pin");
    assert_eq!(selected.provider_id, "product-provider");
    assert_eq!(selected.wire_model, "wire-model");
    assert_eq!(selected.auth_alias.as_deref(), Some("key1"));
}

#[test]
fn unknown_provider_prefix_falls_back_to_normal_routing() {
    let product = product_config();
    assert!(
        resolve_direct_provider_model(&product, "missing.client-model")
            .expect("unknown provider is not a direct pin")
            .is_none()
    );
}

#[test]
fn known_provider_with_unknown_model_pin_fails_without_pool_fallback() {
    let product = product_config();
    assert!(matches!(
        resolve_direct_provider_model(&product, "product-provider.missing"),
        Err(TargetSelectionError::ModelUnavailable(model))
            if model == "product-provider.missing"
    ));
}

#[test]
fn unavailable_direct_provider_pin_fails_without_pool_fallback() {
    let product = product_config();
    let request = routecodex_v4_router::TargetSelectionRequest {
        route_group_id: Some("responses".to_string()),
        requested_model: "product-provider.client-model".to_string(),
        entry_protocol: "responses".to_string(),
        execution_lane: "direct".to_string(),
        required_capabilities: vec!["thinking".to_string()],
        input_tokens: 0,
        unavailable_provider_ids: vec!["product-provider".to_string()],
    };
    assert!(matches!(
        routecodex_v4_router::TargetSelectionPort::select(&product, &request),
        Err(TargetSelectionError::ProductPoolUnavailable(provider))
            if provider == "product-provider"
    ));
}

#[test]
fn product_route_pool_selects_provider_wire_model() {
    let selected = select_product_target(
        &product_config(),
        "responses",
        "client-model",
        "responses",
        &["thinking"],
        0,
    )
    .expect("product target selected");
    assert_eq!(selected.provider_id, "product-provider");
    assert_eq!(selected.wire_model, "wire-model");
}

#[test]
fn builtin_catalog_model_reselects_within_captured_pool() {
    let mut product = product_config();
    product.providers[0].models[0].aliases = vec!["gpt-5.5".to_string()];
    product.providers.push(RuntimeProductProvider {
        provider_id: "fallback-provider".to_string(),
        protocol: "responses".to_string(),
        config_path: "/tmp/fallback.toml".to_string(),
        models: vec![RuntimeProductModel {
            model_id: "fallback-model".to_string(),
            wire_name: "fallback-wire".to_string(),
            capabilities: vec!["thinking".to_string()],
            aliases: Vec::new(),
        }],
        auth_handles: Vec::new(),
    });
    product.route_groups[0].pools[0]
        .targets
        .push(RuntimeProductTarget {
            provider_id: "fallback-provider".to_string(),
            model_id: "fallback-model".to_string(),
            priority: 2,
            weight: None,
        });

    let selected = select_product_target_with_unavailable(
        &product,
        "responses",
        "gpt-5.5",
        "responses",
        &["thinking"],
        0,
        &["product-provider"],
    )
    .expect("builtin catalog request keeps the captured pool candidates");

    assert_eq!(selected.provider_id, "fallback-provider");
    assert_eq!(selected.wire_model, "fallback-wire");
}

#[test]
fn explicit_model_pool_uses_highest_configured_priority() {
    let mut product = product_config();
    product.route_groups[0].pools[0].models = vec!["client-model".to_string()];
    product.providers.push(RuntimeProductProvider {
        provider_id: "preferred-provider".to_string(),
        protocol: "responses".to_string(),
        config_path: "/tmp/preferred.toml".to_string(),
        models: vec![RuntimeProductModel {
            model_id: "client-model".to_string(),
            wire_name: "preferred-wire".to_string(),
            capabilities: vec!["thinking".to_string()],
            aliases: Vec::new(),
        }],
        auth_handles: Vec::new(),
    });
    product.route_groups[0].pools[0]
        .targets
        .push(RuntimeProductTarget {
            provider_id: "preferred-provider".to_string(),
            model_id: "client-model".to_string(),
            priority: 2,
            weight: None,
        });

    let selected = select_product_target(
        &product,
        "responses",
        "client-model",
        "responses",
        &["thinking"],
        0,
    )
    .expect("explicit model pool selected");

    assert_eq!(selected.provider_id, "preferred-provider");
    assert_eq!(selected.wire_model, "preferred-wire");
}

#[test]
fn protocol_incompatible_priority_target_does_not_remove_captured_pool() {
    let mut product = product_config();
    product.providers.push(RuntimeProductProvider {
        provider_id: "anthropic-provider".to_string(),
        protocol: "anthropic".to_string(),
        config_path: "/tmp/anthropic.toml".to_string(),
        models: vec![RuntimeProductModel {
            model_id: "client-model".to_string(),
            wire_name: "wire-model".to_string(),
            capabilities: vec!["thinking".to_string()],
            aliases: Vec::new(),
        }],
        auth_handles: Vec::new(),
    });
    product.route_groups[0].pools[0].targets.insert(
        0,
        RuntimeProductTarget {
            provider_id: "anthropic-provider".to_string(),
            model_id: "client-model".to_string(),
            priority: 0,
            weight: None,
        },
    );
    let selected = select_product_target(
        &product,
        "responses",
        "client-model",
        "responses",
        &["thinking"],
        0,
    )
    .expect("captured pool keeps an executable responses target");
    assert_eq!(selected.provider_id, "product-provider");
}

#[test]
fn v3_product_default_pool_selects_target_matching_requested_model() {
    let product = compile_product_config(
        include_str!("../../../tests/resources/config/v3-responses-7777-product.toml"),
        Some(std::path::Path::new("/tmp/v4")),
    )
    .expect("compile product fixture");
    let selected = select_product_target(
        &product,
        "responses_v3_7777",
        "deepseek-v4-flash",
        "responses",
        &[],
        0,
    )
    .expect("select matching default target");
    assert_eq!(selected.provider_id, "opencode-go");
    assert_eq!(selected.wire_model, "deepseek-v4-flash");
}

#[test]
fn unavailable_provider_is_excluded_before_reselect() {
    let selected = select_product_target_with_unavailable(
        &product_config(),
        "responses",
        "client-model",
        "responses",
        &["thinking"],
        0,
        &["product-provider"],
    );
    assert!(matches!(
        selected,
        Err(TargetSelectionError::ProductPoolUnavailable(_))
    ));
}

#[test]
fn product_pool_capability_is_not_inferred_from_missing_request_facts() {
    assert!(matches!(
        select_product_target(
            &product_config(),
            "responses",
            "client-model",
            "responses",
            &[],
            0,
        ),
        Err(TargetSelectionError::ProductPoolUnavailable(group)) if group == "responses"
    ));
}
