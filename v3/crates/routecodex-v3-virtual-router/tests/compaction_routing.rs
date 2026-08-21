use routecodex_v3_config::*;
use routecodex_v3_route_classifier::RouteClassification;
use routecodex_v3_virtual_router::{V3RouterRequestFacts, V3VirtualRouter};
use std::collections::{BTreeMap, BTreeSet};

fn target(id: &str) -> V3RoutePoolTargetManifest {
    V3RoutePoolTargetManifest {
        kind: V3RouteTargetKind::Forwarder,
        id: Some(id.into()),
        provider: None,
        model: None,
        key: None,
        priority: Some(1),
        weight: Some(1),
    }
}

fn manifest() -> V3Config05ManifestPublished {
    V3Config05ManifestPublished {
        version: 3,
        hub_v1: None,
        servers: BTreeMap::from([(
            "s".into(),
            V3ServerManifest {
                id: "s".into(),
                enabled: true,
                bind: "127.0.0.1".into(),
                port: 1,
                routing_group: "g".into(),
                endpoints: vec!["responses".into()],
                features: BTreeMap::new(),
                execution: None,
                http_sse_keepalive_ms: 3_000,
                expose_models: Vec::new(),
            },
        )]),
        providers: BTreeMap::from([(
            "prov".into(),
            V3ProviderManifest {
                id: "prov".into(),
                enabled: true,
                provider_type: "responses".into(),
                base_url: "http://127.0.0.1:9/v1".into(),
                default_model: "model-x".into(),
                auth: V3ProviderAuthManifest {
                    auth_type: V3ProviderAuthType::ApiKey,
                    selection: V3SelectionPolicy::default(),
                    entries: vec![V3ProviderAuthEntryManifest {
                        alias: "key1".into(),
                        priority: None,
                        weight: None,
                        env: Some("PROV_KEY".into()),
                        token_file: None,
                        secret_file: None,
                        secret_key: None,
                        api_key: None,
                    }],
                },
                models: BTreeMap::from([(
                    "model-x".into(),
                    V3ProviderModelManifest {
                        id: "model-x".into(),
                        wire_name: "model-x".into(),
                        aliases: Vec::new(),
                        capabilities: vec!["text".into()],
                        web_search_execution_mode: V3WebSearchExecutionMode::None,
                        web_search_backend_binding: None,
                        supports_streaming: true,
                        supports_thinking: false,
                        thinking: None,
                        max_tokens: None,
                        max_context_tokens: None,
                        context_token_estimate_scale_bps: 10_000,
                        features: BTreeMap::new(),
                    },
                )]),
                responses: None,
                concurrency: None,
                health: None,
                provider_request_cleanup: Default::default(),
                compatibility_profile: None,
                features: BTreeMap::new(),
                request_timeout_ms: 300_000,
                sse_first_frame_timeout_ms: None,
            },
        )]),
        forwarders: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: V3DebugManifest {
            log_console: false,
            log_file: None,
            snapshots: false,
            codex_samples: false,
            snapshot_stages: None,
            snapshot_direct: true,
            dry_run: false,
            retention: BTreeMap::new(),
            full_codex_sampling: false,
        },
        error: V3ErrorManifest {
            policies: BTreeMap::new(),
            provider_error_default_path: Vec::new(),
            provider_error_action_policy: Vec::new(),
            client_error_projection_policy: Vec::new(),
        },
        route_groups: BTreeMap::from([(
            "g".into(),
            V3RouteGroupManifest {
                id: "g".into(),
                compact_route_object: Some("compact".into()),
                route_policies: Vec::new(),
                features: BTreeMap::new(),
                pools: BTreeMap::from([
                    (
                        "default".into(),
                        V3RoutePoolManifest {
                            id: "default".into(),
                            selection: V3SelectionPolicy::default(),
                            match_rule: None,
                            route_object: None,
                            features: BTreeMap::new(),
                            targets: vec![target("default-target")],
                        },
                    ),
                    (
                        "compact".into(),
                        V3RoutePoolManifest {
                            id: "compact".into(),
                            selection: V3SelectionPolicy::default(),
                            match_rule: Some(V3RoutePoolMatchManifest {
                                precedence: 0,
                                entry_protocol: Some("responses".into()),
                                models: Vec::new(),
                                required_capabilities: Vec::new(),
                                min_input_tokens: None,
                                max_input_tokens: None,
                            }),
                            route_object: Some("compact".into()),
                            features: BTreeMap::new(),
                            targets: vec![target("compact-target")],
                        },
                    ),
                ]),
            },
        )]),
    }
}

#[test]
fn compact_pool_precedes_dotted_direct_model() {
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest(),
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("prov.model-x".into()),
                capabilities: BTreeSet::from(["text".into()]),
                input_tokens: 1,
                route_classification: RouteClassification {
                    route_name: "compact".into(),
                    reasoning: "compact:registered-ingress".into(),
                    candidates: vec!["compact".into(), "default".into()],
                    required_capabilities: Vec::new(),
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest(), classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "compact");
}

#[test]
fn compact_endpoint_precedes_thinking_route_policy_pool() {
    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses/compact",
            V3RouterRequestFacts::from_endpoint("/v1/responses/compact"),
        )
        .unwrap();
    let classified = V3VirtualRouter::with_route_policy_pool(
        classified,
        Some("thinking".to_string()),
    );
    let plan = router.resolve_route_pool_plan(&manifest, classified).unwrap();
    assert_eq!(
        router.hit_opaque_target_plan_once(plan, 0).unwrap().pool_id,
        "compact"
    );
}
