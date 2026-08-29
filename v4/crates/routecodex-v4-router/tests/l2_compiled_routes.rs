use routecodex_v4_config::{
    compile_product_config,
    RuntimeProductConfig, RuntimeProductModel, RuntimeProductPool, RuntimeProductProvider,
    RuntimeProductErrorPolicy, RuntimeProductPolicyAction, RuntimeProductRouteGroup,
    RuntimeProductTarget, RuntimeProviderCandidate, RuntimeRoute,
};
use routecodex_v4_router::{
    apply_product_error_policy, select_product_target, select_product_target_with_unavailable,
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
fn v3_product_default_pool_selects_target_matching_requested_model() {
    let product = compile_product_config(
        include_str!("../../../tests/resources/config/v3-responses-7777-product.toml"),
        Some(std::path::Path::new("/tmp/v4")),
    )
    .expect("compile product fixture");
    let selected = select_product_target(&product, "responses_v3_7777", "deepseek-v4-flash", "responses", &[], 0)
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
    assert!(matches!(selected, Err(TargetSelectionError::ProductPoolUnavailable(_))));
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

#[test]
fn product_error_policy_produces_typed_retry_cooldown_projection_facts() {
    let mut product = product_config();
    product.error_policies.push(RuntimeProductErrorPolicy {
        policy_id: "account-401".to_string(),
        scope_provider_id: Some("product-provider".to_string()),
        match_status: Some(401),
        match_content_contains_any: Vec::new(),
        reason_code: Some("provider_account_http_401".to_string()),
        actions: vec![
            RuntimeProductPolicyAction {
                step: "wait_retry".to_string(),
                retry_mode: Some("reselect_before_client_projection".to_string()),
                max_attempts: Some(2),
                backoff_ms: Some(1000),
                scope: None,
                duration_ms: None,
                provider_global_failure: None,
                status: None,
                reason_code: None,
                public_code: None,
                message_mode: None,
            },
            RuntimeProductPolicyAction {
                step: "cooldown".to_string(),
                retry_mode: None,
                max_attempts: None,
                backoff_ms: None,
                scope: Some("auth_key".to_string()),
                duration_ms: Some(3600000),
                provider_global_failure: None,
                status: None,
                reason_code: None,
                public_code: None,
                message_mode: None,
            },
            RuntimeProductPolicyAction {
                step: "project".to_string(),
                retry_mode: None,
                max_attempts: None,
                backoff_ms: None,
                scope: None,
                duration_ms: None,
                provider_global_failure: None,
                status: Some(502),
                reason_code: None,
                public_code: None,
                message_mode: Some("code_only".to_string()),
            },
        ],
    });
    let decision = apply_product_error_policy(&product, "product-provider", 401, "unauthorized")
        .expect("401 policy");
    assert_eq!(decision.policy_id, "account-401");
    assert!(decision.retry);
    assert!(decision.cooldown);
    assert_eq!(decision.project_status, Some(502));
    assert_eq!(decision.reason_code.as_deref(), Some("provider_account_http_401"));
    assert!(apply_product_error_policy(&product, "product-provider", 200, "completed").is_none());
    assert!(apply_product_error_policy(&product, "other", 500, "failed").is_none());
}
