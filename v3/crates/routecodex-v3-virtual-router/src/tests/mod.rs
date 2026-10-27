use super::*;
use routecodex_v3_config::*;

fn target(id: &str, priority: i32, weight: u32) -> V3RoutePoolTargetManifest {
    V3RoutePoolTargetManifest {
        kind: V3RouteTargetKind::Forwarder,
        id: Some(id.into()),
        provider: None,
        model: None,
        key: None,
        interface: None,
        priority: Some(priority),
        weight: Some(weight),
    }
}

fn manifest(strategy: V3SelectionStrategy) -> V3Config05ManifestPublished {
    V3Config05ManifestPublished {
        version: 3,
        hub_v1: None,
        memory_raw_capture: Default::default(),
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
                provider_priority_schedule: Default::default(),
            },
        )]),
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: V3DebugManifest {
            log_console: false,
            log_file: None,
            projection_drop_log_file: None,
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
        },
        route_groups: BTreeMap::from([(
            "g".into(),
            V3RouteGroupManifest {
                id: "g".into(),
                compact_route_object: None,
                route_policies: Vec::new(),
                features: BTreeMap::new(),
                pools: BTreeMap::from([
                    (
                        "default".into(),
                        V3RoutePoolManifest {
                            id: "default".into(),
                            selection: V3SelectionPolicy {
                                strategy: strategy.clone(),
                            },
                            route_object: None,
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
                            route_object: None,
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
        route_classification: test_route("tools", &["tools", "default"]),
    }
}

#[test]
fn empty_signal_pool_is_skipped_and_default_stays_last_tier() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("tools")
        .unwrap()
        .targets
        .clear();
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .expect("classify");
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("an empty signal pool is skipped instead of failing the request");
    assert!(
        plan.tiers.iter().all(|tier| tier.pool_id != "tools"),
        "empty tools pool must not become a tier: {:?}",
        plan.tiers
    );
    assert_eq!(
        plan.tiers.last().expect("default tier").pool_id,
        "default",
        "the explicit default pool stays the last tier"
    );
}

#[test]
fn empty_explicit_default_pool_fails_even_when_signal_pools_remain() {
    // 用户规则：default 是必须存在且非空的唯一最低池。非 default 池可空，
    // 但空 default 是配置错误，即使有其它可命中的池也要显式失败。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .clear();
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .expect("classify");
    assert_eq!(
        router.resolve_route_pool_plan(&manifest, classified),
        Err(V3VirtualRouterError::DefaultPoolEmpty("g".into())),
        "an empty default pool must fail instead of falling through to another tier"
    );
}

#[test]
fn classified_route_hits_pool_without_reclassifying_as_capability() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest.route_groups.get_mut("g").unwrap().pools.insert(
        "thinking".into(),
        V3RoutePoolManifest {
            id: "thinking".into(),
            selection: V3SelectionPolicy {
                strategy: V3SelectionStrategy::Priority,
            },
            route_object: None,
            match_rule: Some(V3RoutePoolMatchManifest {
                precedence: 2,
                entry_protocol: Some("responses".into()),
                models: Vec::new(),
                required_capabilities: vec!["thinking".into()],
                min_input_tokens: None,
                max_input_tokens: None,
            }),
            features: BTreeMap::new(),
            targets: vec![target("thinking-target", 1, 1)],
        },
    );
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::from(["text".into(), "tools".into()]),
                input_tokens: 1,
                route_classification: test_route("thinking", &["thinking", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers[0].pool_id, "thinking");
}

fn test_route(route: &str, candidates: &[&str]) -> RouteClassification {
    RouteClassification {
        route_name: route.to_string(),
        reasoning: format!("test:{route}"),
        candidates: candidates
            .iter()
            .map(|candidate| (*candidate).to_string())
            .collect(),
        required_capabilities: Vec::new(),
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
            interfaces: BTreeMap::new(),
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
                    oauth_declaration: None,
                }],
            },
            models: BTreeMap::from([(
                "model-x".into(),
                V3ProviderModelManifest {
                    id: "model-x".into(),
                    wire_name: "model-x-wire".into(),
                    aliases: vec!["mx".into()],
                    capabilities: vec!["text".into()],
                    web_search_execution_mode: V3WebSearchExecutionMode::None,
                    supports_streaming: true,
                    supports_thinking: false,
                    thinking: None,
                    max_tokens: None,
                    max_context_tokens: None,
                    context_token_estimate_scale_bps: 10_000,
                    features: BTreeMap::new(),
                    availability: None,
                },
            )]),
            responses: None,
            concurrency: None,
            health: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            reasoning_effort: None,
            compatibility_profile: None,
            headers: BTreeMap::new(),
            features: BTreeMap::new(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
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
        route_classification: RouteClassification::default(),
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
fn compact_route_signal_uses_configured_independent_route_object_pool() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    let group = manifest.route_groups.get_mut("g").unwrap();
    group.compact_route_object = Some("compact-default".into());
    group.pools.insert(
        "compact".into(),
        V3RoutePoolManifest {
            id: "compact".into(),
            selection: V3SelectionPolicy {
                strategy: V3SelectionStrategy::Priority,
            },
            route_object: Some("compact-default".into()),
            match_rule: None,
            features: BTreeMap::new(),
            targets: vec![target("compact-target", 1, 1)],
        },
    );
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 1,
                route_classification: test_route("compact", &["compact"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "compact");
    assert_eq!(hit.target_plan.len(), 1);
}

#[test]
fn route_policy_pool_action_is_consumed_as_one_explicit_pool() {
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    let classified = V3VirtualRouter::with_route_policy_pool(classified, Some("tools".to_string()));
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "tools");
    assert_eq!(hit.target_plan.len(), 2);
}

#[test]
fn direct_unknown_provider_falls_back_to_classification() {
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
fn direct_unknown_model_falls_back_to_normal_pool_routing() {
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
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(
        hit.pool_id, "default",
        "an enabled provider that declares no such model must fall back to normal pool routing"
    );
}

#[test]
fn direct_media_mismatch_fails_without_reroute() {
    let router = V3VirtualRouter::default();
    let manifest = manifest_with_direct_provider();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            direct_facts("prov.model-x", BTreeSet::from(["vision".into()])),
        )
        .unwrap();
    assert_eq!(
        router.resolve_route_pool_plan(&manifest, classified),
        Err(V3VirtualRouterError::DirectModelMediaUnsatisfied {
            provider: "prov".into(),
            model: "model-x".into(),
            capability: "vision".into(),
        })
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
    assert_eq!(hit.target_id.as_deref(), Some("a"));
    assert_eq!(hit.hit_count, 1);
    assert_eq!(hit.target_plan.len(), 2);
    assert_eq!(hit.target_plan[0].pool_id, "default");
}

#[test]
fn matched_pool_is_single_pool_without_default_floor() {
    // 红测：命中一个分类池后只交该池，不再追加 default 或其它分类池。
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(&manifest, "s", "/v1/responses", matching_facts())
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let tier_ids = plan
        .tiers
        .iter()
        .map(|tier| tier.pool_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        tier_ids,
        vec!["tools"],
        "a single matched pool must not append default or any other pool"
    );
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "tools");
    // tools pool: a(priority 2), c(priority 1) -> priority order a then c.
    let ids = hit
        .target_plan
        .iter()
        .map(|entry| entry.target_id.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![Some("a"), Some("c")]);
    assert!(hit.target_plan.iter().all(|entry| entry.pool_id == "tools"));
    assert_eq!(hit.hit_count, 1);
}

#[test]
fn tools_capability_without_current_turn_signal_stays_default() {
    // 红测：仅凭 request capability 声明不得选中 tools 池；唯一依据是
    // classifier 给出的当前轮候选信号。
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["tools".into()]),
                input_tokens: 10,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "default");
    assert!(hit
        .target_plan
        .iter()
        .all(|entry| entry.pool_id == "default"));
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
                // Declared capabilities alone are not a current-turn signal.
                route_classification: test_route("default", &["default"]),
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

#[test]
fn entry_protocol_uses_generic_route_signal_pool() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    let group = manifest.route_groups.get_mut("g").unwrap();
    group
        .pools
        .get_mut("tools")
        .unwrap()
        .match_rule
        .as_mut()
        .unwrap()
        .entry_protocol = None;
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/messages",
            V3RouterRequestFacts {
                entry_protocol: "anthropic".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["tools".into()]),
                input_tokens: 10,
                route_classification: test_route("tools", &["tools", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers[0].pool_id, "tools");
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
            route_object: None,
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
            route_object: None,
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
fn classifier_candidates_select_pool_regardless_of_declared_capabilities() {
    // 红测：能力声明不是选择依据；候选信号顺序决定命中池。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "web_search", 0, vec!["web_search"], None);

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
                route_classification: test_route("tools", &["tools", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "tools");
}

#[test]
fn web_search_capability_pool_is_not_generic_route_fallback() {
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .remove("tools");
    add_match_pool(&mut manifest, "web_search", 1, vec!["web_search"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["web_search".into()]),
                input_tokens: 10,
                route_classification: test_route("thinking", &["thinking", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "default");
}

#[test]
fn candidate_order_hosted_websearch_precedes_multimodal() {
    // 红测：hosted websearch 与图片同时成立时，按固定顺序命中 web_search。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "multimodal", 1, vec!["multimodal"], None);
    add_match_pool(&mut manifest, "web_search", 9, vec!["web_search"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["web_search".into(), "multimodal".into()]),
                input_tokens: 10,
                route_classification: test_route(
                    "web_search",
                    &["web_search", "multimodal", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "web_search");
}

#[test]
fn candidate_order_coding_precedes_thinking_and_websearch_precedes_all() {
    // 红测：coding > thinking；缺 coding 池时落到 thinking；多信号只按
    // hosted web_search > multimodal > longcontext > coding > thinking > search
    // > tools 判序。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
    add_match_pool(&mut manifest, "coding", 2, vec!["coding"], None);
    add_match_pool(&mut manifest, "tools", 3, vec!["tools"], None);
    add_match_pool(&mut manifest, "web_search", 4, vec!["web_search"], None);

    // coding active -> coding wins even though thinking/tools/web_search rules exist.
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from([
                    "thinking".into(),
                    "coding".into(),
                    "tools".into(),
                    "web_search".into(),
                ]),
                input_tokens: 10,
                route_classification: test_route(
                    "coding",
                    &["coding", "thinking", "tools", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "coding");

    // thinking active -> thinking wins over tools; web_search absent from
    // candidates, so declared capability cannot pull it in.
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["thinking".into(), "tools".into()]),
                input_tokens: 10,
                route_classification: test_route("thinking", &["thinking", "tools", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "thinking");
}

#[test]
fn longcontext_candidate_selects_configured_pool() {
    // 红测：longcontext 能力保留；配置了非空 longcontext 池就必须选中，
    // 并在候选顺序中优先于 multimodal。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "multimodal", 0, vec!["multimodal"], None);
    add_match_pool(&mut manifest, "longcontext", 10, vec!["longcontext"], None);

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["multimodal".into()]),
                input_tokens: 1_000,
                route_classification: test_route(
                    "longcontext",
                    &["longcontext", "multimodal", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "longcontext");
}

#[test]
fn candidate_priority_skips_absent_or_empty_pools() {
    // 红测：按 classifier 候选固定顺序，缺省池和空池都不能截断或抢占；
    // 首个已配置非空池是唯一交付池。
    let ordered = [
        "web_search",
        "multimodal",
        "longcontext",
        "coding",
        "thinking",
        "search",
        "tools",
    ];
    for (expected_index, expected) in ordered.iter().enumerate() {
        let router = V3VirtualRouter::default();
        let mut manifest = manifest(V3SelectionStrategy::Priority);
        for pool_id in ordered {
            add_match_pool(&mut manifest, pool_id, 0, vec![pool_id], None);
        }
        for (index, pool_id) in ordered.iter().enumerate() {
            if index >= expected_index {
                continue;
            }
            let pool = manifest
                .route_groups
                .get_mut("g")
                .unwrap()
                .pools
                .get_mut(*pool_id)
                .unwrap();
            if index % 2 == 0 {
                pool.targets.clear();
            } else {
                manifest
                    .route_groups
                    .get_mut("g")
                    .unwrap()
                    .pools
                    .remove(*pool_id);
            }
        }
        let mut candidates = ordered.to_vec();
        candidates.push("default");
        let classified = router
            .classify_request_with_facts(
                &manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some("client-model".into()),
                    capabilities: ordered.iter().map(|signal| (*signal).to_string()).collect(),
                    input_tokens: 10,
                    route_classification: test_route(expected, &candidates),
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
            vec![*expected],
            "first configured non-empty candidate must win"
        );
    }
}

#[test]
fn model_match_pool_does_not_preempt_candidate_signal() {
    // 红测：普通请求没有隐藏的 model 匹配路径；候选信号顺序决定池。
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
                route_classification: test_route("thinking", &["thinking", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();

    assert_eq!(hit.pool_id, "thinking");
}

#[test]
fn virtual_alias_and_auto_share_the_current_turn_classification_pool() {
    // 公开 crate 级反例：当前轮信号相同时，非 provider.model 的虚拟别名与
    // auto 必须命中同一个分类池；模型名命中的池不得额外抢占，也不得在没有
    // 分类池时被选中。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "thinking_primary", 5, vec!["thinking"], None);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("thinking_primary")
        .unwrap()
        .match_rule
        .as_mut()
        .unwrap()
        .models = vec!["virtual-alias".into()];
    add_match_pool(
        &mut manifest,
        "thinking_secondary",
        10,
        vec!["thinking"],
        None,
    );
    add_model_match_pool(&mut manifest, "alias_only", 0, "virtual-alias");

    let resolve = |manifest: &V3Config05ManifestPublished, model: &str| {
        let classified = router
            .classify_request_with_facts(
                manifest,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: Some(model.into()),
                    capabilities: BTreeSet::new(),
                    input_tokens: 10,
                    route_classification: test_route("thinking", &["thinking", "default"]),
                },
            )
            .unwrap();
        router
            .resolve_route_pool_plan(manifest, classified)
            .unwrap()
    };
    let pool_ids = |plan: &V3Router06RoutePoolResolved| {
        plan.tiers
            .iter()
            .map(|tier| tier.pool_id.clone())
            .collect::<Vec<_>>()
    };

    let auto = resolve(&manifest, "auto");
    let alias = resolve(&manifest, "virtual-alias");
    assert_eq!(
        pool_ids(&auto),
        pool_ids(&alias),
        "the virtual alias must not hit a model-named pool that auto does not hit"
    );
    assert_eq!(pool_ids(&alias), vec!["thinking_primary"]);

    // Without a configured pool for the current-turn signal both names must
    // land on the same required default pool, never on the model-named pool.
    let mut alias_only = manifest.clone();
    alias_only
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .remove("thinking_primary");
    alias_only
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .remove("thinking_secondary");
    let auto = resolve(&alias_only, "auto");
    let alias = resolve(&alias_only, "virtual-alias");
    assert_eq!(pool_ids(&auto), vec!["default"]);
    assert_eq!(pool_ids(&alias), vec!["default"]);
}

#[test]
fn model_match_pool_is_not_an_inbound_route() {
    // 红测：`match.models` 不是普通请求的路由维度；没有当前轮信号时，
    // 非 provider.model 的虚拟模型名和 auto 一样落到 default，不因模型名
    // 命中额外池。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_model_match_pool(&mut manifest, "client_test", 10, "client-test");

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-test".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "default");
}

#[test]
fn model_match_pool_without_signal_uses_default_pool() {
    // 红测：模型名声明不能在没有当前轮信号时改路；default 是唯一 no-match
    // 终点。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_model_match_pool(&mut manifest, "client_test", 99, "client-test");

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-test".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 1,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();

    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "default");
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
                route_classification: RouteClassification::default(),
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
        Some("a")
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
            expose_models: Vec::new(),
            provider_priority_schedule: Default::default(),
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
fn weighted_selection_never_opens_lower_numeric_priority_while_higher_tier_exists() {
    let router = V3VirtualRouter::default();
    let mut weighted = manifest(V3SelectionStrategy::Weighted);
    let pool = weighted
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap();
    pool.targets = vec![
        target("priority-1-a", 1, 1),
        target("priority-1-b", 1, 3),
        target("priority-2-heavy", 2, 100),
    ];

    let mut first_choices = Vec::new();
    for _request in 0..8 {
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

    assert!(
        first_choices
            .iter()
            .all(|target_id| target_id == "priority-2-heavy"),
        "priority-2 must remain selected while it is available: {first_choices:?}"
    );
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

#[test]
fn no_implicit_capability_pool_without_configured_pool() {
    // 红测：无显式 multimodal/web_search 池时，不得从 provider 能力构造隐式
    // 能力池；应直接落 default。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    manifest.providers.insert(
        "mm".into(),
        V3ProviderManifest {
            id: "mm".into(),
            enabled: true,
            provider_type: "anthropic".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            interfaces: BTreeMap::new(),
            default_model: "MiniMax-M3".into(),
            auth: V3ProviderAuthManifest {
                auth_type: V3ProviderAuthType::ApiKey,
                selection: V3SelectionPolicy::default(),
                entries: vec![V3ProviderAuthEntryManifest {
                    alias: "key1".into(),
                    priority: None,
                    weight: None,
                    env: Some("MM_KEY".into()),
                    token_file: None,
                    secret_file: None,
                    secret_key: None,
                    api_key: None,
                    oauth_declaration: None,
                }],
            },
            models: BTreeMap::from([(
                "MiniMax-M3".into(),
                V3ProviderModelManifest {
                    id: "MiniMax-M3".into(),
                    wire_name: "MiniMax-M3".into(),
                    aliases: vec![],
                    capabilities: vec!["text".into(), "multimodal".into(), "web_search".into()],
                    web_search_execution_mode: V3WebSearchExecutionMode::None,
                    supports_streaming: true,
                    supports_thinking: false,
                    thinking: None,
                    max_tokens: None,
                    max_context_tokens: None,
                    context_token_estimate_scale_bps: 10_000,
                    features: BTreeMap::new(),
                    availability: None,
                },
            )]),
            responses: None,
            concurrency: None,
            health: None,
            provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
            reasoning_effort: None,
            compatibility_profile: None,
            headers: BTreeMap::new(),
            features: BTreeMap::new(),
            request_timeout_ms: 300_000,
            sse_first_frame_timeout_ms: None,
        },
    );
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::from(["multimodal".into(), "web_search".into()]),
                input_tokens: 10,
                route_classification: test_route(
                    "web_search",
                    &["web_search", "multimodal", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let tier_ids: Vec<&str> = plan
        .tiers
        .iter()
        .map(|tier| tier.pool_id.as_str())
        .collect();
    assert_eq!(
        tier_ids,
        vec!["default"],
        "no implicit capability pool may be synthesized from provider capabilities: {tier_ids:?}"
    );
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "default");
    assert!(
        hit.target_plan
            .iter()
            .all(|entry| entry.direct_provider_model.is_none()),
        "no synthetic provider/model entry may be injected"
    );
}

#[test]
fn candidate_order_selects_first_configured_non_empty_pool() {
    // 红测：按 classifier 给出的候选顺序命中第一个已配置非空池，且只交一池。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "thinking", 1, vec!["thinking"], None);
    add_match_pool(&mut manifest, "coding", 3, vec!["coding"], None);
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["tools".into()]),
                input_tokens: 10,
                route_classification: test_route(
                    "coding",
                    &["coding", "thinking", "tools", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1, "exactly one pool must be handed off");
    assert_eq!(plan.tiers[0].pool_id, "coding");
}

#[test]
fn empty_configured_pool_is_skipped_for_next_candidate() {
    // 红测：已配置但为空的高优先级池不参与命中，落到下一个候选池。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest(V3SelectionStrategy::Priority);
    add_match_pool(&mut manifest, "multimodal", 0, vec!["multimodal"], None);
    add_match_pool(&mut manifest, "coding", 3, vec!["coding"], None);
    manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("multimodal")
        .unwrap()
        .targets
        .clear();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["multimodal".into(), "coding".into()]),
                input_tokens: 10,
                route_classification: test_route(
                    "multimodal",
                    &["multimodal", "coding", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "coding");
}

#[test]
fn absent_non_default_pool_falls_through_to_default() {
    // 红测：候选池缺省时无条件落到 default，且只交 default 一池。
    let router = V3VirtualRouter::default();
    let manifest = manifest(V3SelectionStrategy::Priority);
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::from(["multimodal".into(), "coding".into()]),
                input_tokens: 10,
                route_classification: test_route(
                    "multimodal",
                    &["multimodal", "coding", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    assert_eq!(plan.tiers.len(), 1);
    assert_eq!(plan.tiers[0].pool_id, "default");
}

#[test]
fn explicit_direct_model_ignores_classification_candidates() {
    // 红测：有效 provider.model 直接命中目标，classifier 候选不影响选择。
    let router = V3VirtualRouter::default();
    let mut manifest = manifest_with_direct_provider();
    add_match_pool(&mut manifest, "multimodal", 0, vec!["multimodal"], None);
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("prov.model-x".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: test_route("multimodal", &["multimodal", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "direct");
    assert_eq!(
        hit.target_plan[0].direct_provider_model,
        Some(("prov".to_string(), "model-x".to_string()))
    );
}
