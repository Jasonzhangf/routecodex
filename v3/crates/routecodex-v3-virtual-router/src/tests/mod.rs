use super::*;
use routecodex_v3_config::*;

fn target(id: &str, priority: i32, weight: u32) -> V3RoutePoolTargetManifest {
    V3RoutePoolTargetManifest {
        kind: V3RouteTargetKind::Forwarder,
        id: Some(id.into()),
        provider: None,
        model: None,
        key: None,
        priority: Some(priority),
        weight: Some(weight),
    }
}

fn manifest(strategy: V3SelectionStrategy) -> V3Config05ManifestPublished {
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
            },
        )]),
        providers: BTreeMap::new(),
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
        },
        error: V3ErrorManifest {
            policies: BTreeMap::new(),
            provider_error_action_policy: Vec::new(),
            client_error_projection_policy: Vec::new(),
        },
        route_groups: BTreeMap::from([(
            "g".into(),
            V3RouteGroupManifest {
                id: "g".into(),
                features: BTreeMap::new(),
                pools: BTreeMap::from([
                    (
                        "default".into(),
                        V3RoutePoolManifest {
                            id: "default".into(),
                            selection: V3SelectionPolicy {
                                strategy: strategy.clone(),
                            },
                            match_rule: None,
                            features: BTreeMap::new(),
                            targets: vec![target("a", 2, 1), target("b", 1, 3)],
                        },
                    ),
                    (
                        "tools".into(),
                        V3RoutePoolManifest {
                            id: "tools".into(),
                            selection: V3SelectionPolicy { strategy },
                            match_rule: Some(V3RoutePoolMatchManifest {
                                precedence: 10,
                                entry_protocol: Some("responses".into()),
                                models: vec!["client-model".into()],
                                required_capabilities: vec!["tools".into()],
                                min_input_tokens: Some(1),
                                max_input_tokens: Some(100),
                            }),
                            features: BTreeMap::new(),
                            targets: vec![target("c", 1, 1), target("a", 2, 1)],
                        },
                    ),
                ]),
            },
        )]),
    }
}

fn matching_facts() -> V3RouterRequestFacts {
    V3RouterRequestFacts {
        entry_protocol: "responses".into(),
        client_model: Some("client-model".into()),
        capabilities: BTreeSet::from(["tools".into()]),
        input_tokens: 10,
        route_signals: V3RouteClassifierSignals {
            has_current_turn_tool_output: true,
            last_assistant_tool_category: Some("other".into()),
            ..Default::default()
        },
    }
}

fn manifest_with_direct_provider() -> V3Config05ManifestPublished {
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest.providers.insert(
        "prov".into(),
        V3ProviderManifest {
            id: "prov".into(),
            enabled: true,
            provider_type: "responses".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            default_model: "model-x".into(),
            auth: V3ProviderAuthManifest {
                auth_type: V3ProviderAuthType::ApiKey,
                entries: vec![V3ProviderAuthEntryManifest {
                    alias: "key1".into(),
                    env: Some("PROV_KEY".into()),
                    token_file: None,
                }],
            },
            models: BTreeMap::from([(
                "model-x".into(),
                V3ProviderModelManifest {
                    id: "model-x".into(),
                    wire_name: "model-x-wire".into(),
                    aliases: vec!["mx".into()],
                    capabilities: vec!["text".into()],
                    supports_streaming: true,
                    supports_thinking: false,
                    thinking: None,
                    max_tokens: None,
                    max_context_tokens: None,
                    features: BTreeMap::new(),
                },
            )]),
            responses: None,
            concurrency: None,
            health: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            compatibility_profile: None,
            features: BTreeMap::new(),
        },
    );
    manifest
}

fn direct_facts(model: &str, capabilities: BTreeSet<String>) -> V3RouterRequestFacts {
    V3RouterRequestFacts {
        entry_protocol: "responses".into(),
        client_model: Some(model.into()),
        capabilities,
        input_tokens: 10,
        route_signals: Default::default(),
    }
}

#[test]
fn direct_provider_model_short_circuits_pool_matching() {
    let router = V3VirtualRouter::default();
    let manifest = manifest_with_direct_provider();
    for requested in ["prov.model-x", "prov.mx"] {
        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                direct_facts(requested, BTreeSet::new()),
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&manifest, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        assert_eq!(hit.pool_id, "direct");
        assert_eq!(hit.target_plan.len(), 1);
        assert_eq!(
            hit.target_plan[0].direct_provider_model,
            Some(("prov".to_string(), "model-x".to_string()))
        );
        assert_eq!(
            hit.request_client_model.as_deref(),
            Some("model-x"),
            "client model must be rewritten to the bare canonical id"
        );
    }
}

#[test]
fn direct_unknown_provider_continues_to_normal_classification() {
    let router = V3VirtualRouter::default();
    let manifest = manifest_with_direct_provider();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            direct_facts("nosuch.model-x", BTreeSet::new()),
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(
        hit.pool_id, "default",
        "unknown provider segment must fall back to normal pool routing"
    );
}

#[test]
fn direct_unknown_model_fails_but_media_capability_does_not_block_direct_route() {
    let router = V3VirtualRouter::default();
    let manifest = manifest_with_direct_provider();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            direct_facts("prov.absent-model", BTreeSet::new()),
        )
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&manifest, classified),
        Err(V3VirtualRouterError::DirectModelUnknown {
            provider: "prov".into(),
            model: "absent-model".into(),
        })
    );

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            direct_facts("prov.model-x", BTreeSet::from(["vision".into()])),
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("direct provider.model route must not be blocked by request route signals");
    assert_eq!(plan.tiers[0].pool_id, "direct");
    assert_eq!(
        plan.tiers[0].direct_provider_model.as_ref(),
        Some(&("prov".to_string(), "model-x".to_string()))
    );
}

#[test]
fn resolves_listener_default_and_hits_one_opaque_plan() {
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request(&manifest, "s", "/v1/responses")
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.target_id.as_deref(), Some("b"));
    assert_eq!(hit.hit_count, 1);
    assert_eq!(hit.target_plan.len(), 2);
    assert_eq!(hit.target_plan[0].pool_id, "default");
}

#[test]
fn matched_pool_and_default_floor_are_captured_before_one_hit() {
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let ids = hit
        .target_plan
        .iter()
        .map(|entry| entry.target_id.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![Some("c"), Some("a"), Some("b")]);
    assert_eq!(hit.pool_id, "tools");
    assert_eq!(hit.hit_count, 1);
}

#[test]
fn no_match_uses_default_and_only_equal_best_precedence_is_ambiguous() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("different-model".into()),
                capabilities: BTreeSet::from(["tools".into()]),
                input_tokens: 10,
                route_signals: V3RouteClassifierSignals {
                    has_current_turn_tool_output: true,
                    last_assistant_tool_category: Some("other".into()),
                    ..Default::default()
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "default");

    let mut duplicate = manifest.route_groups["g"].pools["tools"].clone();
    duplicate.id = "tools-copy".into();
    duplicate.match_rule.as_mut().unwrap().precedence = 20;
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .insert("tools-copy".into(), duplicate);
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers[0].pool_id, "tools");

    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("tools-copy")
        .unwrap()
        .match_rule
        .as_mut()
        .unwrap()
        .precedence = 10;
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&manifest, classified),
        Err(V3VirtualRouterError::AmbiguousPoolMatches {
            group_id: "g".into(),
            pool_ids: vec!["tools".into(), "tools-copy".into()],
        })
    );
}

fn add_match_pool(
    manifest: &mut V3Config05ManifestPublished,
    pool_id: &str,
    precedence: i32,
    required_capabilities: Vec<&str>,
    min_input_tokens: Option<u64>,
) {
    manifest.route_groups.get_mut("g").unwrap().pools.insert(
        pool_id.into(),
        V3RoutePoolManifest {
            id: pool_id.into(),
            selection: V3SelectionPolicy {
                strategy: V3SelectionStrategy::Priority,
            },
            match_rule: Some(V3RoutePoolMatchManifest {
                precedence,
                entry_protocol: Some("responses".into()),
                models: Vec::new(),
                required_capabilities: required_capabilities
                    .into_iter()
                    .map(ToOwned::to_owned)
                    .collect(),
                min_input_tokens,
                max_input_tokens: None,
            }),
            features: BTreeMap::new(),
            targets: vec![target(pool_id, 1, 1)],
        },
    );
}

fn add_model_match_pool(
    manifest: &mut V3Config05ManifestPublished,
    pool_id: &str,
    precedence: i32,
    model: &str,
) {
    manifest.route_groups.get_mut("g").unwrap().pools.insert(
        pool_id.into(),
        V3RoutePoolManifest {
            id: pool_id.into(),
            selection: V3SelectionPolicy {
                strategy: V3SelectionStrategy::Priority,
            },
            match_rule: Some(V3RoutePoolMatchManifest {
                precedence,
                entry_protocol: Some("responses".into()),
                models: vec![model.into()],
                required_capabilities: Vec::new(),
                min_input_tokens: None,
                max_input_tokens: None,
            }),
            features: BTreeMap::new(),
            targets: vec![target(pool_id, 1, 1)],
        },
    );
}

#[test]
fn route_contract_prefers_web_search_over_generic_tools_even_when_precedence_is_lower() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("tools")
        .unwrap()
        .match_rule
        .as_mut()
        .unwrap()
        .precedence = 20;
    add_match_pool(&mut manifest, "web_search", 22, vec!["web_search"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["tools".into(), "web_search".into()]),
                input_tokens: 10,
                route_signals: V3RouteClassifierSignals {
                    latest_message_from_user: true,
                    route_owned_websearch_tool_declared: true,
                    current_user_web_search_intent: true,
                    ..Default::default()
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "web_search");
}

#[test]
fn route_contract_prefers_multimodal_over_all_non_context_route_signals() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
    add_match_pool(&mut manifest, "coding", 2, vec!["coding"], None);
    add_match_pool(&mut manifest, "search", 3, vec!["search"], None);
    add_match_pool(&mut manifest, "web_search", 4, vec!["web_search"], None);
    add_match_pool(&mut manifest, "multimodal", 99, vec!["multimodal"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from([
                    "tools".into(),
                    "coding".into(),
                    "search".into(),
                    "web_search".into(),
                    "thinking".into(),
                    "multimodal".into(),
                ]),
                input_tokens: 10,
                route_signals: V3RouteClassifierSignals {
                    has_visual: true,
                    latest_message_from_user: true,
                    ..Default::default()
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "multimodal");
}

#[test]
fn route_contract_treats_min_token_longcontext_as_context_safety_first() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "multimodal", 1, vec!["multimodal"], None);
    add_match_pool(&mut manifest, "web_search", 2, vec!["web_search"], None);
    add_match_pool(&mut manifest, "longcontext", 100, Vec::new(), Some(1_000));

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["multimodal".into(), "web_search".into()]),
                input_tokens: 1_000,
                route_signals: Default::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "longcontext");
}

#[test]
fn route_contract_captures_search_tools_default_in_one_plan() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "search", 1, vec!["search"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["search".into(), "tools".into()]),
                input_tokens: 10,
                route_signals: V3RouteClassifierSignals {
                    has_current_turn_tool_output: true,
                    last_assistant_tool_category: Some("search".into()),
                    ..Default::default()
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();

    assert_eq!(
        plan.tiers
            .iter()
            .map(|tier| tier.pool_id.as_str())
            .collect::<Vec<_>>(),
        vec!["search", "tools", "default"]
    );
}

#[test]
fn route_contract_prefers_explicit_model_pool_over_generic_thinking() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
    add_model_match_pool(&mut manifest, "client_test", 99, "client-test");

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-test".into()),
                capabilities: BTreeSet::from(["thinking".into()]),
                input_tokens: 10,
                route_signals: V3RouteClassifierSignals {
                    latest_message_from_user: true,
                    ..Default::default()
                },
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "client_test");
}

#[test]
fn entry_protocol_is_a_pool_predicate() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("tools")
        .unwrap()
        .match_rule
        .as_mut()
        .unwrap()
        .entry_protocol = Some("anthropic".into());
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "default");
}

#[test]
fn missing_non_default_match_and_invalid_protocol_facts_fail_explicitly() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("tools")
        .unwrap()
        .match_rule = None;
    let classified = router
        .classify_request(&manifest, "s", "/v1/responses")
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&manifest, classified),
        Err(V3VirtualRouterError::PoolMatchMissing {
            group_id: "g".into(),
            pool_id: "tools".into(),
        })
    );

    assert_eq!(
        router.classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "anthropic".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 0,
                route_signals: Default::default(),
            },
        ),
        Err(V3VirtualRouterError::InvalidRoutingFacts(
            "/v1/responses".into()
        ))
    );
}

#[test]
fn weighted_and_round_robin_are_deterministic_and_listener_scoped() {
    let router = V3VirtualRouter::default();
    let weighted = manifest(V3SelectionStrategy::Weighted);
    let plan = router
        .resolve_route_pool_plan(
            &weighted,
            router
                .classify_request(&weighted, "s", "/v1/responses")
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        router
            .hit_opaque_target_plan_once(plan, 1)
            .unwrap()
            .target_id
            .as_deref(),
        Some("b")
    );

    let mut rr = manifest(V3SelectionStrategy::RoundRobin);
    rr.servers.insert(
        "s2".into(),
        V3ServerManifest {
            id: "s2".into(),
            enabled: true,
            bind: "127.0.0.1".into(),
            port: 2,
            routing_group: "g".into(),
            endpoints: vec!["responses".into()],
            features: BTreeMap::new(),
            execution: None,
            http_sse_keepalive_ms: 3_000,
        },
    );
    let plan = |server_id: &str| {
        router
            .resolve_route_pool_plan(
                &rr,
                router
                    .classify_request(&rr, server_id, "/v1/responses")
                    .unwrap(),
            )
            .unwrap()
    };
    assert_eq!(
        router
            .hit_opaque_target_plan_once(plan("s"), 0)
            .unwrap()
            .target_id
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        router
            .hit_opaque_target_plan_once(plan("s2"), 0)
            .unwrap()
            .target_id
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        router
            .hit_opaque_target_plan_once(plan("s"), 0)
            .unwrap()
            .target_id
            .as_deref(),
        Some("b")
    );
}

#[test]
fn weighted_selection_follows_smooth_weighted_round_robin_sequence() {
    let router = V3VirtualRouter::default();
    let mut weighted = manifest(V3SelectionStrategy::Weighted);
    let pool = weighted
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap();
    pool.targets = vec![target("a", 1, 5), target("b", 1, 1), target("c", 1, 1)];
    let mut first_choices = Vec::new();
    for _request in 0..7 {
        let plan = router
            .resolve_route_pool_plan(
                &weighted,
                router
                    .classify_request(&weighted, "s", "/v1/responses")
                    .unwrap(),
            )
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        first_choices.push(hit.target_id.unwrap());
    }
    // Canonical nginx SWRR emission for weights 5/1/1.
    assert_eq!(first_choices, vec!["a", "a", "b", "a", "c", "a", "a"]);
}

#[test]
fn peek_does_not_advance_selection_state() {
    let router = V3VirtualRouter::default();
    let rr = manifest(V3SelectionStrategy::RoundRobin);
    let plan = |router: &V3VirtualRouter| {
        router
            .resolve_route_pool_plan(
                &rr,
                router.classify_request(&rr, "s", "/v1/responses").unwrap(),
            )
            .unwrap()
    };
    let peek_one = router
        .hit_opaque_target_plan_once_peek(plan(&router), 0)
        .unwrap();
    let peek_two = router
        .hit_opaque_target_plan_once_peek(plan(&router), 0)
        .unwrap();
    assert_eq!(peek_one.target_id, peek_two.target_id);
    let live = router
        .hit_opaque_target_plan_once(plan(&router), 0)
        .unwrap();
    assert_eq!(live.target_id, peek_one.target_id);
    let peek_after = router
        .hit_opaque_target_plan_once_peek(plan(&router), 0)
        .unwrap();
    assert_ne!(peek_after.target_id, live.target_id);

    let weighted = manifest(V3SelectionStrategy::Weighted);
    let wplan = |router: &V3VirtualRouter| {
        router
            .resolve_route_pool_plan(
                &weighted,
                router
                    .classify_request(&weighted, "s", "/v1/responses")
                    .unwrap(),
            )
            .unwrap()
    };
    let wpeek_one = router
        .hit_opaque_target_plan_once_peek(wplan(&router), 0)
        .unwrap();
    let wpeek_two = router
        .hit_opaque_target_plan_once_peek(wplan(&router), 0)
        .unwrap();
    assert_eq!(wpeek_one.target_id, wpeek_two.target_id);
}

#[test]
fn process_shared_router_persists_selection_state_across_instances() {
    let rr = manifest(V3SelectionStrategy::RoundRobin);
    // Unique group id so this test never shares state with other tests
    // using the process-wide router.
    let mut rr_scoped = rr.clone();
    let group = rr_scoped.route_groups.remove("g").unwrap();
    rr_scoped.route_groups.insert("g-shared-test".into(), group);
    rr_scoped.servers.get_mut("s").unwrap().routing_group = "g-shared-test".into();
    let hit = |router: &V3VirtualRouter| {
        let plan = router
            .resolve_route_pool_plan(
                &rr_scoped,
                router
                    .classify_request(&rr_scoped, "s", "/v1/responses")
                    .unwrap(),
            )
            .unwrap();
        router
            .hit_opaque_target_plan_once(plan, 0)
            .unwrap()
            .target_id
            .unwrap()
    };
    let first = hit(&V3VirtualRouter::process_shared());
    let second = hit(&V3VirtualRouter::process_shared());
    assert_ne!(
        first, second,
        "process-shared router instances must rotate the same cursor"
    );
}

#[test]
fn missing_or_empty_explicit_default_pool_is_rejected() {
    let router = V3VirtualRouter::default();
    let mut missing = manifest(V3SelectionStrategy::Priority);
    missing
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .remove("default");
    let classified = router
        .classify_request(&missing, "s", "/v1/responses")
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&missing, classified),
        Err(V3VirtualRouterError::DefaultPoolMissing("g".into()))
    );

    let mut empty = manifest(V3SelectionStrategy::Priority);
    empty
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .clear();
    let classified = router
        .classify_request(&empty, "s", "/v1/responses")
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&empty, classified),
        Err(V3VirtualRouterError::DefaultPoolEmpty("g".into()))
    );
}
