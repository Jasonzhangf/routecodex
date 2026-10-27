use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::V3ProviderAvailabilityProjection;
use routecodex_v3_virtual_router::RouteClassification;

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
use routecodex_v3_virtual_router::{V3RouterRequestFacts, V3VirtualRouter};

struct Availability {
    blocked: BTreeSet<String>,
}

impl V3ProviderAvailabilityReader for Availability {
    fn availability_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let label = format!(
            "{provider_id}:{interface_id}:{}:{}",
            auth_alias.unwrap_or(""),
            model_id.unwrap_or("")
        );
        V3ProviderAvailabilityProjection {
            provider_id: provider_id.into(),
            interface_id: interface_id.into(),
            auth_alias: auth_alias.map(Into::into),
            model_id: model_id.map(Into::into),
            available: !self.blocked.contains(&label),
            blocked_scopes: self
                .blocked
                .contains(&label)
                .then_some(label)
                .into_iter()
                .collect(),
        }
    }

    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        self.availability_for_interface(provider_id, "default", auth_alias, model_id, now_ms)
    }
}

fn manifest() -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.a]
type = "responses"
base_url = "http://a.invalid/v1"
default_model = "m"
compatibility_profile = "chat:minimax"
provider_request_cleanup = { historical_fields = ["reasoning.encrypted_content"] }
auth = { type = "api_key", entries = [{ alias = "ka", env = "KEY_A" }] }
[providers.a.models.m]
capabilities = ["text", "tools", "multimodal"]
[providers.b]
type = "responses"
base_url = "http://b.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "kb", env = "KEY_B" }] }
[providers.b.models.m]
capabilities = ["text", "tools", "multimodal"]
[forwarders.inner]
model = "m"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "a", model = "m", key = "ka", priority = 1 },
  { kind = "provider_model", provider = "b", model = "m", key = "kb", priority = 2 }
]
[forwarders.outer]
model = "m"
selection = { strategy = "round_robin" }
targets = [{ kind = "forwarder", id = "inner" }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "outer", priority = 1 }]
[route_groups.g.pools.tools]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 100 }
targets = [{ kind = "provider_model", provider = "a", model = "m", key = "ka", priority = 1 }]
"#;
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap()
}

fn expanded() -> V3Target09CandidateSetExpanded {
    let manifest = manifest();
    expanded_with(&manifest, &V3TargetInterpreter::default(), 0)
}

fn expanded_with(
    manifest: &V3Config05ManifestPublished,
    target: &V3TargetInterpreter,
    sample: u64,
) -> V3Target09CandidateSetExpanded {
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request(manifest, "s", "/v1/responses")
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    target
        .expand_candidates(manifest, target.classify_kind(hit), sample)
        .unwrap()
}

fn weighted_priority_forwarder_manifest() -> V3Config05ManifestPublished {
    let mut manifest = manifest();
    let mut provider_c = manifest.providers.get("b").unwrap().clone();
    provider_c.id = "c".into();
    provider_c.base_url = "http://c.invalid/v1".into();
    provider_c.auth.entries[0].alias = "kc".into();
    provider_c.auth.entries[0].env = Some("KEY_C".into());
    manifest.providers.insert("c".into(), provider_c);

    let forwarder = manifest.forwarders.get_mut("inner").unwrap();
    forwarder.selection.strategy = V3SelectionStrategy::Weighted;
    forwarder.targets = vec![
        V3ForwarderTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("a".into()),
            model: Some("m".into()),
            key: Some("ka".into()),
            interface: None,
            priority: Some(1),
            weight: Some(1),
        },
        V3ForwarderTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("b".into()),
            model: Some("m".into()),
            key: Some("kb".into()),
            interface: None,
            priority: Some(1),
            weight: Some(3),
        },
        V3ForwarderTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("c".into()),
            model: Some("m".into()),
            key: Some("kc".into()),
            interface: None,
            priority: Some(2),
            weight: Some(100),
        },
    ];
    manifest
}

fn provider_priority_schedule_manifest() -> V3Config05ManifestPublished {
    let mut manifest = weighted_priority_forwarder_manifest();
    let default_pool = manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap();
    default_pool.targets = vec![
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("a".into()),
            model: Some("m".into()),
            key: Some("ka".into()),
            interface: None,
            priority: Some(100),
            weight: Some(1),
        },
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("b".into()),
            model: Some("m".into()),
            key: Some("kb".into()),
            interface: None,
            priority: Some(50),
            weight: Some(1),
        },
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("c".into()),
            model: Some("m".into()),
            key: Some("kc".into()),
            interface: None,
            priority: Some(10),
            weight: Some(1),
        },
    ];
    manifest
        .servers
        .get_mut("s")
        .unwrap()
        .provider_priority_schedule =
        routecodex_v3_config::V3ProviderPriorityScheduleAuthoringConfig {
            timezone: "Asia/Shanghai".into(),
            peak_periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
                start: "09:00".into(),
                end: "18:00".into(),
            }],
            providers: vec![
                routecodex_v3_config::V3ProviderPriorityScheduleEntryAuthoringConfig {
                    provider: "a".into(),
                    peak_tier: 3,
                    off_peak_tier: 1,
                },
            ],
        };
    manifest
}

#[test]
fn provider_priority_schedule_switches_tier_without_bypassing_availability() {
    let manifest = provider_priority_schedule_manifest();
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };

    let peak = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_229_200_000,
        )
        .unwrap();
    assert_eq!(peak.candidate.provider_id, "b");

    let off_peak = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_272_400_000,
        )
        .unwrap();
    assert_eq!(off_peak.candidate.provider_id, "a");

    let a_blocked = Availability {
        blocked: BTreeSet::from(["a:default:ka:m".into()]),
    };
    let blocked_off_peak = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &a_blocked,
            1_767_272_400_000,
        )
        .unwrap();
    assert_eq!(blocked_off_peak.candidate.provider_id, "b");
}

#[test]
fn provider_priority_schedule_honors_timezone_and_cross_midnight_window() {
    let mut manifest = provider_priority_schedule_manifest();
    let schedule = &mut manifest
        .servers
        .get_mut("s")
        .unwrap()
        .provider_priority_schedule;
    schedule.timezone = "America/Los_Angeles".into();
    schedule.peak_periods = vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
        start: "22:00".into(),
        end: "02:00".into(),
    }];

    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };
    // 2026-01-01 22:00 PST: provider a is in the configured peak tier.
    let peak = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_333_600_000,
        )
        .unwrap();
    assert_eq!(peak.candidate.provider_id, "b");

    // 2026-01-01 03:00 PST: the cross-midnight window has ended.
    let off_peak = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_265_200_000,
        )
        .unwrap();
    assert_eq!(off_peak.candidate.provider_id, "a");
}

#[test]
fn provider_priority_schedule_excludes_synthetic_implicit_pools() {
    let mut manifest = manifest();
    manifest
        .providers
        .get_mut("a")
        .unwrap()
        .models
        .get_mut("m")
        .unwrap()
        .capabilities
        .push("web_search".into());
    manifest
        .servers
        .get_mut("s")
        .unwrap()
        .provider_priority_schedule
        .providers = vec![
        routecodex_v3_config::V3ProviderPriorityScheduleEntryAuthoringConfig {
            provider: "a".into(),
            peak_tier: 2,
            off_peak_tier: 1,
        },
    ];

    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::from(["web_search".into()]),
                input_tokens: 10,
                route_classification: test_route("web_search", &["web_search", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert!(
        hit.target_plan
            .iter()
            .any(|entry| entry.pool_id == "implicit:web_search"),
        "test requires a synthetic implicit capability pool"
    );

    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    assert!(
        !expanded
            .route_pool_tier_priorities
            .contains_key("implicit:web_search"),
        "synthetic implicit pools must not receive declared route-pool tiers"
    );
    let candidate = expanded
        .candidates
        .iter()
        .find(|candidate| candidate.provider_id == "a")
        .expect("provider a must be expanded from the implicit pool");
    assert_eq!(
        target.provider_priority_schedule_priority(&expanded, candidate, 1_767_229_200_000),
        candidate.priority,
        "schedule must not alter an implicit-pool candidate"
    );
}

fn provider_model_availability_manifest(
    availability: Option<routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig>,
) -> V3Config05ManifestPublished {
    let mut manifest = provider_priority_schedule_manifest();
    manifest
        .servers
        .get_mut("s")
        .unwrap()
        .provider_priority_schedule
        .providers
        .clear();
    manifest
        .providers
        .get_mut("a")
        .unwrap()
        .models
        .get_mut("m")
        .unwrap()
        .availability = availability;
    manifest
}

fn free_window_availability(
    guard_minutes: u16,
) -> routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
    routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
        timezone: "Asia/Shanghai".into(),
        guard_minutes,
        periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
            start: "00:00".into(),
            end: "08:00".into(),
        }],
    }
}

#[test]
fn provider_model_availability_excludes_candidate_outside_window() {
    let manifest = provider_model_availability_manifest(Some(free_window_availability(0)));
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };
    // 10:00 Asia/Shanghai is outside 00:00-08:00, so provider a must not win.
    let selected = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_232_800_000,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "b");
}

#[test]
fn provider_model_availability_guard_shrinks_window_edges() {
    let manifest = provider_model_availability_manifest(Some(free_window_availability(10)));
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };
    // 07:45 Asia/Shanghai is inside the guarded 00:10-07:50 sub-window.
    let guarded = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_224_700_000,
        )
        .unwrap();
    assert_eq!(guarded.candidate.provider_id, "a");
    // 07:55 Asia/Shanghai is inside the declared window but inside the guard,
    // so the model must stay unused there and provider b must win.
    let expired = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_225_300_000,
        )
        .unwrap();
    assert_eq!(expired.candidate.provider_id, "b");
}

#[test]
fn provider_model_availability_outside_window_records_reason_and_keeps_health() {
    let manifest = provider_model_availability_manifest(Some(free_window_availability(0)));
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };
    let expanded = expanded_with(&manifest, &target, 0);
    let selected = target
        .select_available(expanded, &available, 1_767_232_800_000)
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "b");
    assert!(
        selected
            .unavailable_candidates
            .iter()
            .any(|reason| reason.contains(":availability_inactive")),
        "expected an availability_inactive reason, got {:?}",
        selected.unavailable_candidates
    );
}

#[test]
fn provider_model_availability_outside_window_and_cooled_stays_unavailable() {
    // Combination case: a candidate that is both outside its availability
    // window and reported blocked by the health reader must remain unavailable,
    // and its exclusion reason must still name the window.
    let manifest = provider_model_availability_manifest(Some(free_window_availability(0)));
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::from([
            "a:default:ka:m".to_string(),
            "b:default:kb:m".to_string(),
            "c:default:kc:m".to_string(),
        ]),
    };
    let error = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_232_800_000,
        )
        .expect_err("every candidate is either outside its window or cooled");
    let reasons = format!("{error}");
    assert!(
        reasons.contains("availability_inactive") || reasons.contains("provider_key_health"),
        "expected window or health exclusion reasons, got {reasons}"
    );
}

#[test]
fn provider_model_availability_omitted_keeps_model_available_any_time() {
    let manifest = provider_model_availability_manifest(None);
    let target = V3TargetInterpreter::default();
    let available = Availability {
        blocked: BTreeSet::new(),
    };
    let selected = target
        .select_available(
            expanded_with(&manifest, &target, 0),
            &available,
            1_767_232_800_000,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "a");
}

#[test]
fn provider_model_availability_admitted_count_ignores_window_inactive_siblings() {
    // The single-candidate automatic-cooldown exemption must count only
    // candidates admitted by capability and availability. Here provider a is
    // the only candidate admitted at 10:00 Asia/Shanghai (b and c declare
    // windows that exclude that instant), so a cooled provider a must still be
    // exempted: a window-inactive sibling must never inflate the pool size and
    // suppress the exemption.
    let mut manifest = provider_priority_schedule_manifest();
    let window_excluding_ten_am =
        routecodex_v3_config::V3ProviderModelAvailabilityAuthoringConfig {
            timezone: "Asia/Shanghai".into(),
            guard_minutes: 0,
            periods: vec![routecodex_v3_config::V3DailyTimeWindowAuthoringConfig {
                start: "00:00".into(),
                end: "08:00".into(),
            }],
        };
    for provider in ["b", "c"] {
        manifest
            .providers
            .get_mut(provider)
            .unwrap()
            .models
            .get_mut("m")
            .unwrap()
            .availability = Some(window_excluding_ten_am.clone());
    }
    let target = V3TargetInterpreter::default();
    let expanded = expanded_with(&manifest, &target, 0);
    let now_ms = 1_767_232_800_000;
    assert_eq!(
        V3TargetInterpreter::admitted_candidate_count(&expanded, now_ms),
        1,
        "only provider a is inside its availability window at 10:00 Asia/Shanghai"
    );
    struct OnlyProviderACooled;
    impl V3ProviderSchedulingReader for OnlyProviderACooled {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
            let mut projection =
                routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
                    provider_id,
                    "default",
                    auth_alias,
                    model_id,
                    priority,
                    1_000,
                    base_weight,
                );
            if provider_id == "a" {
                projection.available = false;
                projection.blocked_scopes = vec!["provider_key_health_cooldown".to_string()];
            }
            projection
        }
    }
    let selected = target
        .select_available_with_health(expanded, &OnlyProviderACooled, now_ms, 0)
        .expect("a must stay usable as the only admitted candidate");
    assert_eq!(selected.candidate.provider_id, "a");
}

#[test]
fn provider_model_availability_sibling_in_window_keeps_automatic_cooldown() {
    // Control for the exemption test: once a sibling is genuinely admitted the
    // pool is no longer a singleton, so the cooled candidate stays excluded and
    // the healthy sibling wins.
    let manifest = provider_model_availability_manifest(None);
    let target = V3TargetInterpreter::default();
    let expanded = expanded_with(&manifest, &target, 0);
    let now_ms = 1_767_232_800_000;
    assert_eq!(
        V3TargetInterpreter::admitted_candidate_count(&expanded, now_ms),
        expanded.candidates.len()
    );
    struct ProviderACooled;
    impl V3ProviderSchedulingReader for ProviderACooled {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
            let mut projection =
                routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
                    provider_id,
                    "default",
                    auth_alias,
                    model_id,
                    priority,
                    1_000,
                    base_weight,
                );
            if provider_id == "a" {
                projection.available = false;
                projection.blocked_scopes = vec!["provider_key_health_cooldown".to_string()];
            }
            projection
        }
    }
    let selected = target
        .select_available_with_health(expanded, &ProviderACooled, now_ms, 0)
        .expect("the healthy sibling must remain selectable");
    assert_ne!(selected.candidate.provider_id, "a");
}

#[test]
fn weighted_forwarder_advances_to_lower_priority_only_after_higher_tier_exhausts() {
    let manifest = weighted_priority_forwarder_manifest();
    let target = V3TargetInterpreter::default();
    let all_available = Availability {
        blocked: BTreeSet::new(),
    };
    let selected = target
        .select_available(expanded_with(&manifest, &target, 4), &all_available, 0)
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "c");

    let one_priority_one_available = Availability {
        blocked: BTreeSet::from(["b:default:kb:m".into()]),
    };
    let selected = target
        .select_available(
            expanded_with(&manifest, &target, 4),
            &one_priority_one_available,
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "c");

    let only_priority_two_available = Availability {
        blocked: BTreeSet::from(["a:default:ka:m".into(), "b:default:kb:m".into()]),
    };
    let selected = target
        .select_available(
            expanded_with(&manifest, &target, 4),
            &only_priority_two_available,
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "c");
}

fn expanded_tools() -> V3Target09CandidateSetExpanded {
    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client".into()),
                capabilities: BTreeSet::from(["tools".into()]),
                input_tokens: 10,
                route_classification: test_route("tools", &["tools", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap()
}

fn direct_selected(
    requested_model: &str,
    blocked: BTreeSet<String>,
) -> Result<V3Target10ConcreteProviderSelected, V3TargetExhaustion> {
    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let target = V3TargetInterpreter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some(requested_model.into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "direct");
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    target.select_available(expanded, &Availability { blocked }, 0)
}

#[test]
fn direct_provider_model_expands_pinned_provider_but_respects_health_cooldown() {
    let selected = direct_selected("a.m", BTreeSet::new()).unwrap();
    assert_eq!(selected.candidate.provider_id, "a");
    assert_eq!(selected.candidate.model_id, "m");

    let cooled = direct_selected("a.m", BTreeSet::from(["a:default:ka:m".into()]))
        .expect_err("health cooldown must veto an explicit pin");
    assert_eq!(
        cooled.attempted_candidates,
        vec!["a:default:ka:m:availability(a:default:ka:m)"],
        "cooldown must be reported as target exhaustion"
    );
}

#[test]
fn synthetic_direct_target_preserves_configured_priority_for_health_selection() {
    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let target = V3TargetInterpreter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("a.m".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.target_plan[0].priority, 1);
    assert_eq!(hit.target_plan[0].weight, 1);
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    struct HealthyPriority;
    impl V3ProviderSchedulingReader for HealthyPriority {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
            let mut projection =
                routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
                    provider_id,
                    "default",
                    auth_alias,
                    model_id,
                    priority,
                    1_000,
                    base_weight,
                );
            projection.available = priority > 0;
            projection
        }
    }

    let selected = target
        .select_available_with_health(expanded, &HealthyPriority, 0, 0)
        .expect("synthetic direct target priority must keep a healthy candidate available");
    assert_eq!(selected.candidate.provider_id, "a");
    assert_eq!(selected.candidate.priority, 1);
}

#[test]
fn direct_provider_model_never_selects_an_unavailable_candidate_without_a_scope_label() {
    struct UnavailableWithoutScope;
    impl V3ProviderSchedulingReader for UnavailableWithoutScope {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
            let mut projection =
                routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
                    provider_id,
                    "default",
                    auth_alias,
                    model_id,
                    priority,
                    1_000,
                    base_weight,
                );
            projection.available = false;
            projection
        }
    }

    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let target = V3TargetInterpreter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("a.m".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();

    let exhausted = target
        .select_available_with_health(expanded, &UnavailableWithoutScope, 0, 0)
        .expect_err("unavailable direct candidate must remain unavailable");
    assert_eq!(
        exhausted.attempted_candidates,
        vec!["a:default:ka:m:health_cooldown"]
    );
}

#[test]
fn direct_provider_model_respects_request_local_exclusion() {
    let manifest = manifest();
    let router = V3VirtualRouter::default();
    let target = V3TargetInterpreter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("a.m".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    struct ExcludedAvailability;
    impl V3ProviderAvailabilityReader for ExcludedAvailability {
        fn availability(
            &self,
            provider_id: &str,
            auth_alias: Option<&str>,
            model_id: Option<&str>,
            _now_ms: u64,
        ) -> V3ProviderAvailabilityProjection {
            V3ProviderAvailabilityProjection {
                provider_id: provider_id.into(),
                interface_id: "default".into(),
                auth_alias: auth_alias.map(Into::into),
                model_id: model_id.map(Into::into),
                available: false,
                blocked_scopes: vec!["request_local_provider_failure".into()],
            }
        }
    }
    let exhausted = target
        .select_available(expanded, &ExcludedAvailability, 0)
        .unwrap_err();
    assert_eq!(
        exhausted.attempted_candidates,
        vec!["a:default:ka:m:availability(request_local_provider_failure)"]
    );
}

#[test]
fn requested_forwarder_model_filters_default_pool_candidates() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.default_gpt]
type = "responses"
base_url = "http://gpt.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key", env = "GPT_KEY" }] }
[providers.default_gpt.models."gpt-5.5"]
capabilities = ["text"]
[providers.grok]
type = "responses"
base_url = "http://grok.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key", env = "GROK_KEY" }] }
[providers.grok.models."MiniMax-M3"]
capabilities = ["text"]
[forwarders.fwd_gpt]
model = "gpt-5.5"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default_gpt", model = "gpt-5.5", key = "key", priority = 1 }]
[forwarders.fwd_minimax]
model = "MiniMax-M3"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "grok", model = "MiniMax-M3", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "forwarder", id = "fwd_gpt", priority = 1 },
  { kind = "forwarder", id = "fwd_minimax", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "grok");
    assert_eq!(selected.candidate.model_id, "MiniMax-M3");
}

#[test]
fn requested_forwarder_model_can_differ_from_provider_model_id() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.upstream]
type = "responses"
base_url = "http://upstream.invalid/v1"
default_model = "wire-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "UPSTREAM_KEY" }] }
[providers.upstream.models.wire-model]
capabilities = ["text"]
[forwarders.client]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "upstream", model = "wire-model", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "client", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("client-model".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .expect("forwarder.model is the client-visible target identity");

    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].provider_id, "upstream");
    assert_eq!(expanded.candidates[0].model_id, "wire-model");
    // Symmetric with `pool_targets_route_model` Forwarder branch: the candidate
    // is addressable by the forwarder model and every target model it wraps.
    assert_eq!(
        expanded.candidates[0].visible_model_ids,
        vec!["client-model", "wire-model"]
    );
}

#[test]
fn unconfigured_provider_concurrency_defaults_to_forty_as_the_hard_maximum() {
    // The declared static `maxInFlight` is only the hard ceiling for the
    // adaptive budget; a provider that omits it gets the documented default of
    // forty, not the retired default of eight.
    let expanded = expanded();
    assert!(
        !expanded.candidates.is_empty(),
        "default manifest must expand at least one candidate"
    );
    for candidate in &expanded.candidates {
        assert_eq!(
            candidate.initial_concurrency_budget, 40,
            "provider {} must default to a static hard maximum of 40",
            candidate.provider_id
        );
    }
}

#[test]
fn requested_forwarder_model_without_matching_target_falls_back_to_route_conditions() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.default_gpt]
type = "responses"
base_url = "http://gpt.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key", env = "GPT_KEY" }] }
[providers.default_gpt.models."gpt-5.5"]
capabilities = ["text"]
[forwarders.fwd_gpt]
model = "gpt-5.5"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default_gpt", model = "gpt-5.5", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd_gpt", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .expect(
            "no explicit model route condition must fall back to route conditions; \
             the payload model is rewritten to the selected target model name",
        );
    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].provider_id, "default_gpt");
    assert_eq!(expanded.candidates[0].model_id, "gpt-5.5");
}

#[test]
fn requested_model_filter_ignores_provider_aliases_for_runtime_matching() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.default_gpt]
type = "responses"
base_url = "http://gpt.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key", env = "GPT_KEY" }] }
[providers.default_gpt.models."gpt-5.5"]
aliases = ["MiniMax-M3"]
capabilities = ["text"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default_gpt", model = "gpt-5.5", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let error = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap_err();
    assert_eq!(
        error,
        V3TargetError::RequestedModelUnavailable {
            model_id: "MiniMax-M3".into()
        }
    );
}

#[test]
fn requested_wire_model_matches_provider_with_distinct_local_id_when_available() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.minimax_anthropic]
type = "responses"
base_url = "http://anthropic.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_A_KEY" }] }
[providers.minimax_anthropic.models."MiniMax-M3"]
capabilities = ["web_search"]
[providers.minimax_openai]
type = "openai_chat"
base_url = "http://openai.invalid/v1"
default_model = "MiniMax-M3-local"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_O_KEY" }] }
[providers.minimax_openai.models."MiniMax-M3-local"]
wire_name = "MiniMax-M3"
capabilities = ["web_search"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax_anthropic", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.g.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [
  { kind = "provider_model", provider = "minimax_anthropic", model = "MiniMax-M3", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "minimax_openai", model = "MiniMax-M3-local", key = "key1", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::from(["web_search".into()]),
                input_tokens: 10,
                route_classification: test_route("web_search", &["web_search", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "web_search");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    assert_eq!(
        expanded
            .candidates
            .iter()
            .map(|candidate| candidate.provider_id.as_str())
            .collect::<Vec<_>>(),
        vec!["minimax_openai", "minimax_anthropic"]
    );
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from([format!(
                    "{}:{}:{}:{}",
                    "minimax_anthropic", "default", "key1", "MiniMax-M3"
                )]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "minimax_openai");
    assert_eq!(selected.candidate.model_id, "MiniMax-M3-local");
}

#[test]
fn requested_explicit_model_route_maps_to_declared_targets_without_alias_requirement() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.default_gpt]
type = "responses"
base_url = "http://gpt.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key", env = "GPT_KEY" }] }
[providers.default_gpt.models."gpt-5.5"]
capabilities = ["text"]
[providers.minimax]
type = "responses"
base_url = "http://minimax.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key", env = "MINIMAX_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text"]
[forwarders.fwd_gpt]
model = "gpt-5.5"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default_gpt", model = "gpt-5.5", key = "key", priority = 1 }]
[forwarders.fwd_minimax]
model = "MiniMax-M3"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd_gpt", priority = 1 }]
[route_groups.g.pools.minimax]
selection = { strategy = "priority" }
match = { precedence = 10, models = ["MiniMax-M3"] }
targets = [
  { kind = "forwarder", id = "fwd_gpt", priority = 1 },
  { kind = "forwarder", id = "fwd_minimax", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "minimax");
    assert_eq!(hit.request_client_model.as_deref(), Some("MiniMax-M3"));
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    assert_eq!(
        expanded
            .candidates
            .iter()
            .map(|candidate| candidate.provider_id.as_str())
            .collect::<Vec<_>>(),
        vec!["minimax", "default_gpt"]
    );
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "minimax");
}

#[test]
fn nested_forwarder_expands_and_reselects_inside_same_route_hit() {
    let expanded = expanded();
    assert_eq!(expanded.route.hit_count, 1);
    assert_eq!(expanded.candidates.len(), 2);
    assert_eq!(
        expanded.candidates[0].compatibility_profile.as_deref(),
        None
    );
    assert!(expanded.candidates[0]
        .provider_request_cleanup
        .historical_fields
        .is_empty());
    assert_eq!(
        expanded.candidates[1].compatibility_profile.as_deref(),
        Some("chat:minimax")
    );
    assert_eq!(
        expanded.candidates[1]
            .provider_request_cleanup
            .historical_fields,
        vec!["reasoning.encrypted_content"]
    );
    let selected = V3TargetInterpreter::default()
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["a:default:ka:m".into()]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.route.hit_count, 1);
    assert_eq!(selected.candidate.provider_id, "b");
    assert_eq!(selected.attempts, 1);
}

#[test]
fn optional_exhaustion_continues_inside_captured_default_floor() {
    let expanded = expanded_tools();
    assert_eq!(expanded.route.hit_count, 1);
    assert_eq!(expanded.route.target_plan[0].pool_id, "tools");
    assert!(expanded
        .route
        .target_plan
        .iter()
        .any(|entry| entry.pool_id == "default"));
    let selected = V3TargetInterpreter::default()
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["a:default:ka:m".into()]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.route.hit_count, 1);
    assert_eq!(selected.candidate.provider_id, "b");
    assert_eq!(selected.candidate.path[0], "pool:default");
    assert_eq!(selected.attempts, 2);
}

#[test]
fn route_tier_precedes_default_target_priority_when_both_are_available() {
    let expanded = expanded_tools();
    let selected = V3TargetInterpreter::default()
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.path[0], "pool:tools");
}

#[test]
fn streaming_is_not_a_candidate_capability_filter() {
    let expanded = expanded_tools();
    let mut candidate = expanded
        .candidates
        .first()
        .expect("tools route must expand candidates")
        .clone();
    candidate.required_capabilities = vec!["streaming".into()];
    candidate.model_capabilities = vec!["text".into(), "tools".into()];

    assert!(
        candidate_satisfies_required_capabilities(&candidate),
        "stream is a transport intent and must not make an otherwise valid candidate unavailable"
    );
}

#[test]
fn tools_are_route_signals_not_target_capability_filters() {
    let expanded = expanded_tools();
    let mut candidate = expanded
        .candidates
        .first()
        .expect("tools route must expand candidates")
        .clone();
    candidate.required_capabilities = vec!["tools".into()];
    candidate.model_capabilities = vec!["text".into()];

    assert!(
        candidate_satisfies_required_capabilities(&candidate),
        "tools are a request/route/protocol surface, not a provider model hard capability"
    );
}

#[test]
fn web_search_and_vision_are_the_only_target_hard_capability_filters() {
    let expanded = expanded_tools();
    let mut search_candidate = expanded
        .candidates
        .first()
        .expect("tools route must expand candidates")
        .clone();
    search_candidate.required_capabilities = vec!["web_search".into()];
    search_candidate.model_capabilities = vec!["text".into()];

    assert!(
        !candidate_satisfies_required_capabilities(&search_candidate),
        "web_search/search requires an explicit model/provider capability because the model may not have search"
    );

    let mut vision_candidate = search_candidate.clone();
    vision_candidate.required_capabilities = vec!["vision".into()];
    vision_candidate.model_capabilities = vec!["text".into(), "web_search".into()];

    assert!(
        !candidate_satisfies_required_capabilities(&vision_candidate),
        "vision/multimodal requires an explicit model/provider capability because the model may not read images"
    );
}

#[test]
fn no_image_reasoning_request_does_not_make_text_tool_candidate_capability_mismatch() {
    let expanded = expanded_tools();
    let mut candidate = expanded
        .candidates
        .first()
        .expect("tools route must expand candidates")
        .clone();
    candidate.required_capabilities = vec![
        "text".into(),
        "tools".into(),
        "reasoning".into(),
        "thinking".into(),
    ];
    candidate.model_capabilities = vec!["text".into(), "tools".into(), "web_search".into()];

    assert!(
        candidate_satisfies_required_capabilities(&candidate),
        "reasoning/thinking is a soft proxy compatibility request for no-image traffic; only hard execution semantics such as tools and vision should make a candidate unavailable"
    );
}

#[test]
fn health_cooldown_removes_default_floor_candidate_from_selection() {
    let selected = V3TargetInterpreter::default()
        .select_available(
            expanded(),
            &Availability {
                blocked: BTreeSet::from(["b:default:kb:m".into()]),
            },
            0,
        )
        .expect("the non-cooled candidate remains selectable");
    assert_eq!(selected.candidate_count, 1);

    let exhausted = V3TargetInterpreter::default()
        .select_available(
            expanded(),
            &Availability {
                blocked: BTreeSet::from(["a:default:ka:m".into(), "b:default:kb:m".into()]),
            },
            0,
        )
        .expect_err("health cooldown must remove every cooled candidate");
    assert_eq!(exhausted.attempted_candidates.len(), 2);
}

#[test]
fn default_floor_does_not_reselect_request_local_failed_candidate() {
    struct RequestLocalFailureAvailability;
    impl V3ProviderAvailabilityReader for RequestLocalFailureAvailability {
        fn availability(
            &self,
            provider_id: &str,
            auth_alias: Option<&str>,
            model_id: Option<&str>,
            _now_ms: u64,
        ) -> V3ProviderAvailabilityProjection {
            V3ProviderAvailabilityProjection {
                provider_id: provider_id.into(),
                interface_id: "default".into(),
                auth_alias: auth_alias.map(Into::into),
                model_id: model_id.map(Into::into),
                available: false,
                blocked_scopes: vec!["request_local_provider_failure".into()],
            }
        }
    }

    let exhausted = V3TargetInterpreter::default()
        .select_available(expanded(), &RequestLocalFailureAvailability, 0)
        .expect_err("default floor must not override current-request provider failure exclusion");
    assert_eq!(
        exhausted.attempted_candidates,
        vec![
            "b:default:kb:m:availability(request_local_provider_failure)".to_string(),
            "a:default:ka:m:availability(request_local_provider_failure)".to_string(),
        ]
    );
}

#[test]
fn duplicate_optional_candidate_retains_default_floor_provenance() {
    let expanded = expanded_tools();
    let first = expanded
        .candidates
        .first()
        .expect("tools route must keep first candidate");
    assert_eq!(first.provider_id, "a");
    assert!(
        first.default_pool_member,
        "deduped optional candidate must remember default membership"
    );
    assert!(first.pool_ids.iter().any(|pool_id| pool_id == "tools"));
    assert!(first.pool_ids.iter().any(|pool_id| pool_id == "default"));
}

#[test]
fn multimodal_route_skips_text_only_candidate_even_when_text_candidate_is_available() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.vision]
type = "responses"
base_url = "http://vision.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "VISION_KEY" }] }
[providers.vision.models.m]
capabilities = ["text", "multimodal"]
[providers.text]
type = "responses"
base_url = "http://text.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEXT_KEY" }] }
[providers.text.models.m]
capabilities = ["text"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "vision", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "text", model = "m", key = "key", priority = 2 }
]
[route_groups.g.pools.multimodal]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", required_capabilities = ["multimodal"] }
targets = [
  { kind = "provider_model", provider = "text", model = "m", key = "key", priority = 1 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::from(["multimodal".into()]),
                input_tokens: 10,
                route_classification: test_route("multimodal", &["multimodal", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["vision:default:key:m".into()]),
            },
            0,
        )
        .expect("cooled vision permits the default text projection");
    assert_eq!(selected.candidate.provider_id, "text");
    assert_eq!(selected.route.pool_id, "default");
    assert!(selected
        .unavailable_candidates
        .iter()
        .any(|reason| reason == "vision:default:key:m:availability(vision:default:key:m)"));
}

#[test]
fn image_bearing_longcontext_route_keeps_request_multimodal_as_target_requirement() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.text]
type = "responses"
base_url = "http://text.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEXT_KEY" }] }
[providers.text.models.m]
capabilities = ["text", "longcontext"]
max_context_tokens = 1000000
[providers.vision]
type = "responses"
base_url = "http://vision.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "VISION_KEY" }] }
[providers.vision.models.m]
capabilities = ["text", "longcontext", "multimodal", "vision"]
max_context_tokens = 1000000
[forwarders.live_like]
model = "m"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "text", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "vision", model = "m", key = "key", priority = 2 }
]
[route_groups.g.pools.longcontext]
selection = { strategy = "priority" }
match = { precedence = 1, entry_protocol = "responses", min_input_tokens = 1000 }
targets = [{ kind = "forwarder", id = "live_like", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "live_like", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::from(["multimodal".into(), "vision".into()]),
                input_tokens: 1000,
                route_classification: test_route(
                    "multimodal",
                    &["multimodal", "longcontext", "default"],
                ),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "longcontext");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("image-bearing longcontext request must skip text-only candidates");

    assert_eq!(selected.candidate.provider_id, "vision");
    assert_eq!(
        selected.unavailable_candidates,
        vec!["text:key:m:capability_mismatch"]
    );
}

#[test]
fn cooled_hosted_search_tier_selects_default_provider_without_search_capability() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.search]
type = "responses"
base_url = "http://search.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "SEARCH_KEY" }] }
[providers.search.models.m]
capabilities = ["text", "web_search"]
[providers.text]
type = "responses"
base_url = "http://text.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEXT_KEY" }] }
[providers.text.models.m]
capabilities = ["text"]
[route_groups.g.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "search", model = "m", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "text", model = "m", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::from(["web_search".into()]),
                input_tokens: 10,
                route_classification: test_route("web_search", &["web_search", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "web_search");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["search:default:key:m".to_string()]),
            },
            0,
        )
        .expect("default must serve when hosted search is cooled");
    assert_eq!(selected.candidate.provider_id, "text");
    assert_eq!(
        selected.route.pool_id, "default",
        "an empty web_search pool must not remain the selected pool"
    );
    assert!(selected.candidate.required_capabilities.is_empty());
}

#[test]
fn missing_web_search_pool_uses_default_without_hosted_capability() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.text]
type = "responses"
base_url = "http://text.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEXT_KEY" }] }
[providers.text.models.m]
capabilities = ["text"]
[providers.search]
type = "responses"
base_url = "http://search.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "SEARCH_KEY" }] }
[providers.search.models.m]
capabilities = ["text", "web_search"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "text", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "search", model = "m", key = "key", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
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
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["search:default:key:m".to_string()]),
            },
            0,
        )
        .expect("default tier remains available when hosted search is unavailable");

    assert_eq!(selected.candidate.provider_id, "text");
    assert!(!selected
        .candidate
        .required_capabilities
        .iter()
        .any(|capability| capability == "web_search"));
}

#[test]
fn context_admission_estimate_is_advisory_ordering() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.short]
type = "responses"
base_url = "http://short.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "SHORT_KEY" }] }
[providers.short.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[providers.long]
type = "responses"
base_url = "http://long.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "LONG_KEY" }] }
[providers.long.models.m]
capabilities = ["text"]
max_context_tokens = 4000
context_token_estimate_scale_bps = 17000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "short", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "long", model = "m", key = "key", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 899,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();

    assert_eq!(selected.candidate.provider_id, "long");
    assert!(selected.unavailable_candidates.is_empty());

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 950,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_near_limit = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected_near_limit.candidate.provider_id, "long");

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 1000,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_at_limit = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["long:default:key:m".into()]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected_at_limit.candidate.provider_id, "short");

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 1001,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_oversized = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected_oversized.candidate.provider_id, "long");
    assert!(
        selected_oversized.unavailable_candidates.is_empty(),
        "an eligible over-estimate candidate remains selectable and is not recorded unavailable"
    );

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 2400,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    // The estimate over-runs both windows, but the estimate is advisory: the
    // higher-priority candidate stays selectable so the request still reaches a
    // provider that can accept it, and the reason is kept as ordering evidence.
    let selected_scaled = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("an estimate over every declared window must not exhaust the pool");
    assert_eq!(selected_scaled.candidate.provider_id, "long");
    assert!(
        selected_scaled.unavailable_candidates.is_empty(),
        "eligible over-estimate ordering evidence is not recorded as unavailable"
    );

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 4001,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_all_over = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("every candidate over the estimate still yields a selectable candidate");
    assert_eq!(selected_all_over.candidate.provider_id, "long");
    assert!(
        selected_all_over.unavailable_candidates.is_empty(),
        "the estimate cannot make every otherwise-eligible candidate unavailable"
    );
}

#[test]
fn context_admission_uses_200k_default_for_unconfigured_candidates() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.implicit]
type = "responses"
base_url = "http://implicit.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "IMPLICIT_KEY" }] }
[providers.implicit.models.m]
capabilities = ["text"]
[providers.long]
type = "responses"
base_url = "http://long.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "LONG_KEY" }] }
[providers.long.models.m]
capabilities = ["text"]
max_context_tokens = 300000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "implicit", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "long", model = "m", key = "key", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    assert_eq!(
        manifest.providers["implicit"].models["m"].max_context_tokens,
        Some(200_000)
    );

    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 200_001,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();

    assert_eq!(selected.candidate.provider_id, "long");
    assert!(
        selected.unavailable_candidates.is_empty(),
        "an eligible default-floor over-estimate is ordering evidence, not unavailability"
    );
}

#[test]
fn context_near_limit_preserves_higher_route_tier_over_lower_normal_candidate() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.high]
type = "responses"
base_url = "http://high.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "HIGH_KEY" }] }
[providers.high.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[providers.low]
type = "responses"
base_url = "http://low.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "LOW_KEY" }] }
[providers.low.models.m]
capabilities = ["text"]
max_context_tokens = 100000
[route_groups.g.pools.high]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses" }
targets = [{ kind = "provider_model", provider = "high", model = "m", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "low", model = "m", key = "key", priority = 1000 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 950,
                route_classification: test_route("high", &["high", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();

    assert_eq!(
        selected.candidate.provider_id, "high",
        "a near-limit candidate in a higher route tier must not be filtered out by a lower-tier normal candidate"
    );
    assert!(
        selected.unavailable_candidates.is_empty(),
        "an eligible near-limit candidate is ordering evidence, not unavailable"
    );
}

#[test]
fn context_near_limit_preserves_higher_priority_tier_within_same_route_pool() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.high]
type = "responses"
base_url = "http://high.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "HIGH_KEY" }] }
[providers.high.models.m]
capabilities = ["text", "longcontext"]
max_context_tokens = 1000000
[providers.normal]
type = "responses"
base_url = "http://normal.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "NORMAL_KEY" }] }
[providers.normal.models.m]
capabilities = ["text", "longcontext"]
max_context_tokens = 1048576
[route_groups.g.pools.longcontext]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", min_input_tokens = 1000 }
targets = [
  { kind = "provider_model", provider = "high", model = "m", key = "key", priority = 3 },
  { kind = "provider_model", provider = "normal", model = "m", key = "key", priority = 1 }
]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "normal", model = "m", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 930_000,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();

    assert_eq!(
        selected.candidate.provider_id, "high",
        "a near-limit candidate in a higher route-pool priority tier must not yield to a lower-tier normal candidate"
    );
    assert!(
        selected.unavailable_candidates.is_empty(),
        "an eligible near-limit candidate is ordering evidence, not unavailable"
    );
}

#[test]
fn context_near_limit_is_demoted_below_normal_candidate_within_same_route_tier() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.near]
type = "responses"
base_url = "http://near.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "NEAR_KEY" }] }
[providers.near.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[providers.normal]
type = "responses"
base_url = "http://normal.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "NORMAL_KEY" }] }
[providers.normal.models.m]
capabilities = ["text"]
max_context_tokens = 100000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "near", model = "m", key = "key", priority = 1 },
  { kind = "provider_model", provider = "normal", model = "m", key = "key", priority = 1 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 950,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .unwrap();

    assert_eq!(selected.candidate.provider_id, "normal");
    assert!(
        selected.unavailable_candidates.is_empty(),
        "an eligible near-limit candidate is ordering evidence, not unavailable"
    );
}

#[test]
fn context_admission_admits_oversized_exact_pin_for_upstream_authority() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.pinned]
type = "responses"
base_url = "http://pinned.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "PINNED_KEY" }] }
[providers.pinned.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "pinned", model = "m", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("pinned.m".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 2000,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "direct");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("an exact pin stays selectable so the upstream owns the context verdict");
    assert_eq!(selected.candidate.provider_id, "pinned");
    assert!(
        selected.unavailable_candidates.is_empty(),
        "an eligible exact pin stays selectable without being marked unavailable"
    );

    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 1500,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_over_limit = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("an over-estimate candidate remains selectable");
    assert_eq!(selected_over_limit.candidate.provider_id, "pinned");
    assert!(
        selected_over_limit.unavailable_candidates.is_empty(),
        "eligible context overflow stays outside unavailable_candidates"
    );
}

#[test]
fn context_admission_admits_oversized_exact_pin() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.pinned]
type = "responses"
base_url = "http://pinned.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "PINNED_KEY" }] }
[providers.pinned.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "pinned", model = "m", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("pinned.m".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 2000,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "direct");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("an oversized exact pin stays selectable for the upstream verdict");
    assert_eq!(selected.candidate.provider_id, "pinned");
    assert!(
        selected.unavailable_candidates.is_empty(),
        "eligible context overflow stays outside unavailable_candidates"
    );
}

#[test]
fn context_admission_preserves_default_floor_resilience() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.pinned]
type = "responses"
base_url = "http://pinned.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "PINNED_KEY" }] }
[providers.pinned.models.m]
capabilities = ["text"]
max_context_tokens = 1000
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "pinned", model = "m", key = "key", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 1500,
                route_classification: test_route("longcontext", &["longcontext", "default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "default");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    let selected_floor = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("the default floor candidate stays selectable for the upstream verdict");
    assert_eq!(selected_floor.candidate.provider_id, "pinned");
    assert!(
        selected_floor.unavailable_candidates.is_empty(),
        "eligible context overflow stays outside unavailable_candidates"
    );
}

#[test]
fn forwarder_weighted_and_round_robin_order_are_deterministic() {
    let mut weighted = manifest();
    let inner = weighted.forwarders.get_mut("inner").unwrap();
    inner.selection.strategy = V3SelectionStrategy::Weighted;
    inner.targets[1].priority = Some(1);
    inner.targets[0].weight = Some(1);
    inner.targets[1].weight = Some(3);
    let interpreter = V3TargetInterpreter::default();
    assert_eq!(
        expanded_with(&weighted, &interpreter, 1).candidates[0].provider_id,
        "b"
    );

    let mut round_robin = manifest();
    round_robin
        .forwarders
        .get_mut("inner")
        .unwrap()
        .selection
        .strategy = V3SelectionStrategy::RoundRobin;
    let interpreter = V3TargetInterpreter::default();
    assert_eq!(
        expanded_with(&round_robin, &interpreter, 0).candidates[0].provider_id,
        "a"
    );
    assert_eq!(
        expanded_with(&round_robin, &interpreter, 0).candidates[0].provider_id,
        "b"
    );
}

#[test]
fn malformed_internal_member_does_not_escape_while_a_sibling_remains() {
    let mut malformed = manifest();
    malformed.forwarders.get_mut("inner").unwrap().targets[0].provider = Some("missing".into());
    let expanded = expanded_with(&malformed, &V3TargetInterpreter::default(), 0);
    assert_eq!(expanded.route.hit_count, 1);
    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].provider_id, "b");
}

#[test]
fn requested_model_with_pool_forwarder_route_condition_filters_to_that_model() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.default_gpt]
type = "responses"
base_url = "http://gpt.invalid/v1"
default_model = "gpt-5.6"
auth = { type = "api_key", entries = [{ alias = "key", env = "GPT_KEY" }] }
[providers.default_gpt.models."gpt-5.6"]
capabilities = ["text"]
[providers.minimax]
type = "openai_chat"
base_url = "http://minimax.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key", env = "MINIMAX_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
capabilities = ["text"]
[forwarders.fwd_gpt]
model = "gpt-5.6"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default_gpt", model = "gpt-5.6", key = "key", priority = 1 }]
[forwarders.fwd_minimax]
model = "MiniMax-M3"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "forwarder", id = "fwd_gpt", priority = 1 },
  { kind = "forwarder", id = "fwd_minimax", priority = 2 }
]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("MiniMax-M3".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "default");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .unwrap();
    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].provider_id, "minimax");
    assert_eq!(expanded.candidates[0].model_id, "MiniMax-M3");
}

#[test]
fn forwarder_target_model_visible_ids_match_requested_target_model() {
    // 22:34 生产 503 复刻：forwarder.model=gpt-5.6 而 forwarder target
    // model=gpt-5.6-sol（client 请求裸 gpt-5.6-sol）。pool_targets_route_model
    // 判定 Forwarder 分支命中 target.model，但 expand_forwarder 只把
    // forwarder.model 推入 visible_model_ids，导致 requested filter 把候选
    // 全部滤光 -> RequestedModelUnavailable -> 假 no-candidate 503。
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.cc_sol]
type = "responses"
base_url = "http://cc-sol.invalid/v1"
default_model = "gpt-5.6-sol"
auth = { type = "api_key", entries = [{ alias = "key1", env = "CC_SOL_KEY" }] }
[providers.cc_sol.models."gpt-5.6-sol"]
capabilities = ["text", "tools"]
[forwarders.fwd_free]
model = "gpt-5.6"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "cc_sol", model = "gpt-5.6-sol", key = "key1", priority = 1 }]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd_free", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: Some("gpt-5.6-sol".into()),
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: RouteClassification::default(),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    assert_eq!(hit.pool_id, "default");
    let target = V3TargetInterpreter::default();
    let expanded = target
        .expand_candidates(&manifest, target.classify_kind(hit), 0)
        .expect(
            "forwarder target model must be part of visible_model_ids so the \
             requested-model filter matches the same identity pool_targets_route_model \
             already matched",
        );
    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].provider_id, "cc_sol");
    assert_eq!(expanded.candidates[0].model_id, "gpt-5.6-sol");
    assert!(expanded.candidates[0]
        .visible_model_ids
        .iter()
        .any(|id| id == "gpt-5.6-sol"));
}

#[test]
fn keyless_provider_target_rotates_auth_entry_start_by_sample() {
    // target 不指明 key：展开 provider 全部 auth entries（key1/key2/key3 同
    // priority 候选）。select_available 选第一个可用 → 固定顺序永远命中 key1；
    // 按每请求 deterministic_sample 旋转展开起点，使多 key 轮流成为首选。
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.multi]
type = "responses"
base_url = "http://multi.invalid/v1"
default_model = "m"
auth = { type = "api_key", entries = [
  { alias = "key1", env = "M_KEY1" },
  { alias = "key2", env = "M_KEY2" },
  { alias = "key3", env = "M_KEY3" }
] }
[providers.multi.models.m]
capabilities = ["text", "tools"]
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "multi", model = "m", priority = 1 }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let target = V3TargetInterpreter::default();
    let aliases_at = |sample: u64| -> Vec<String> {
        expanded_with(&manifest, &target, sample)
            .candidates
            .iter()
            .map(|candidate| candidate.auth_alias.clone())
            .collect()
    };
    assert_eq!(aliases_at(0), vec!["key1", "key2", "key3"]);
    assert_eq!(aliases_at(1), vec!["key2", "key3", "key1"]);
    assert_eq!(aliases_at(2), vec!["key3", "key1", "key2"]);
    assert_eq!(
        aliases_at(6),
        aliases_at(0),
        "rotation is periodic in entry count"
    );
}

fn multi_interface_manifest() -> V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.multi]
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "key", env = "MULTI_KEY" }] }
[providers.multi.models.m]
capabilities = ["text"]
supports_streaming = true
[providers.multi.interfaces.responses]
type = "responses"
base_url = "http://multi.invalid/v1"
responses = { process = "chat", streaming = "always", transport = "http" }
[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://multi.invalid/chat/v1"
[route_groups.g.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "multi", model = "m", key = "key", priority = 1 }]
"#;
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap())
        .expect("multi-interface manifest")
}

fn expand_multi_interface_manifest(
    manifest: &V3Config05ManifestPublished,
) -> V3Target09CandidateSetExpanded {
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            manifest,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(manifest, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    V3TargetInterpreter::default()
        .expand_candidates(
            manifest,
            V3TargetInterpreter::default().classify_kind(hit),
            0,
        )
        .unwrap()
}

#[test]
fn multi_interface_provider_expands_every_enabled_interface() {
    let manifest = multi_interface_manifest();
    let expanded = expand_multi_interface_manifest(&manifest);
    let interfaces: BTreeSet<String> = expanded
        .candidates
        .iter()
        .map(|candidate| candidate.interface_id.clone())
        .collect();
    assert_eq!(
        interfaces,
        BTreeSet::from(["chat".into(), "responses".into()])
    );
    assert!(expanded
        .candidates
        .iter()
        .any(|candidate| candidate.base_url == "http://multi.invalid/chat/v1"));
    assert!(expanded
        .candidates
        .iter()
        .any(|candidate| candidate.base_url == "http://multi.invalid/v1"));
}

#[test]
fn multi_interface_provider_expands_only_pinned_interface() {
    let mut manifest = multi_interface_manifest();
    manifest
        .route_groups
        .get_mut("g")
        .expect("group")
        .pools
        .get_mut("default")
        .expect("pool")
        .targets[0]
        .interface = Some("chat".to_string());
    let expanded = expand_multi_interface_manifest(&manifest);
    assert_eq!(expanded.candidates.len(), 1);
    assert_eq!(expanded.candidates[0].interface_id, "chat");
    assert_eq!(
        expanded.candidates[0].base_url,
        "http://multi.invalid/chat/v1"
    );
}

#[test]
fn multi_interface_missing_or_disabled_pin_is_typed_interface_error() {
    let error = {
        let mut missing = multi_interface_manifest();
        missing
            .route_groups
            .get_mut("g")
            .expect("group")
            .pools
            .get_mut("default")
            .expect("pool")
            .targets[0]
            .interface = Some("missing".to_string());
        let router = V3VirtualRouter::default();
        let classified = router
            .classify_request_with_facts(
                &missing,
                "s",
                "/v1/responses",
                V3RouterRequestFacts {
                    entry_protocol: "responses".into(),
                    client_model: None,
                    capabilities: BTreeSet::new(),
                    input_tokens: 10,
                    route_classification: test_route("default", &["default"]),
                },
            )
            .unwrap();
        let plan = router
            .resolve_route_pool_plan(&missing, classified)
            .unwrap();
        let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
        V3TargetInterpreter::default()
            .expand_candidates(
                &missing,
                V3TargetInterpreter::default().classify_kind(hit),
                0,
            )
            .expect_err("missing interface pin must be a typed target error")
    };
    assert!(matches!(
        error,
        V3TargetError::InterfaceMissing {
            provider_id,
            interface_id
        } if provider_id == "multi" && interface_id == "missing"
    ));

    let mut disabled = multi_interface_manifest();
    disabled
        .route_groups
        .get_mut("g")
        .expect("group")
        .pools
        .get_mut("default")
        .expect("pool")
        .targets[0]
        .interface = Some("chat".to_string());
    disabled
        .providers
        .get_mut("multi")
        .expect("provider")
        .interfaces
        .get_mut("chat")
        .expect("interface")
        .enabled = false;
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request_with_facts(
            &disabled,
            "s",
            "/v1/responses",
            V3RouterRequestFacts {
                entry_protocol: "responses".into(),
                client_model: None,
                capabilities: BTreeSet::new(),
                input_tokens: 10,
                route_classification: test_route("default", &["default"]),
            },
        )
        .unwrap();
    let plan = router
        .resolve_route_pool_plan(&disabled, classified)
        .unwrap();
    let hit = router.hit_opaque_target_plan_once(plan, 0).unwrap();
    let error = V3TargetInterpreter::default()
        .expand_candidates(
            &disabled,
            V3TargetInterpreter::default().classify_kind(hit),
            0,
        )
        .expect_err("disabled interface pin must be a typed target error");
    assert!(matches!(
        error,
        V3TargetError::InterfaceMissing {
            provider_id,
            interface_id
        } if provider_id == "multi" && interface_id == "chat"
    ));
}

/// Two-member sticky pool: `a` (priority 1) and `b` (priority 1, lower weight),
/// so both sit in the same tier and sticky ordering decides between them.
fn sticky_pool_manifest() -> V3Config05ManifestPublished {
    let mut manifest = manifest();
    manifest.providers.insert("b".into(), {
        let mut provider = manifest.providers.get("a").unwrap().clone();
        provider.id = "b".into();
        provider.base_url = "http://b.invalid/v1".into();
        provider.auth.entries[0].alias = "kb".into();
        provider.auth.entries[0].env = Some("KEY_B".into());
        provider
    });
    let pool = manifest
        .route_groups
        .get_mut("g")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap();
    pool.selection.strategy = V3SelectionStrategy::Sticky;
    pool.targets = vec![
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("a".into()),
            model: Some("m".into()),
            key: Some("ka".into()),
            interface: None,
            priority: Some(1),
            weight: Some(2),
        },
        V3RoutePoolTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("b".into()),
            model: Some("m".into()),
            key: Some("kb".into()),
            interface: None,
            priority: Some(1),
            weight: Some(1),
        },
    ];
    manifest
}

struct AlwaysHealthy;
impl V3ProviderSchedulingReader for AlwaysHealthy {
    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        _now_ms: u64,
    ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
        routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
            provider_id,
            "default",
            auth_alias,
            model_id,
            priority,
            1_000,
            base_weight,
        )
    }
}

#[test]
fn sticky_pool_keeps_one_provider_per_session_across_attempts() {
    let manifest = sticky_pool_manifest();
    let target = V3TargetInterpreter::default();
    let scope = V3StickySelectionScope::new("sticky-keeps-srv", "g", "sticky-keeps-session");
    let scheduling = AlwaysHealthy;

    let first = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &scheduling,
            0,
            0,
            &scope,
        )
        .unwrap();
    // Walk through every deterministic sample; a sticky session must not drift
    // to the sibling provider just because the sample changed.
    for sample in [1_u64, 7, 99, 1_000] {
        let again = target
            .select_available_with_health_sticky(
                expanded_with(&manifest, &target, sample),
                &scheduling,
                0,
                sample,
                &scope,
            )
            .unwrap();
        assert_eq!(
            again.candidate.provider_id, first.candidate.provider_id,
            "a sticky session must keep its provider across attempts (sample {sample})"
        );
    }
}

#[test]
fn different_sticky_sessions_spread_over_the_pool() {
    let manifest = sticky_pool_manifest();
    let target = V3TargetInterpreter::default();
    let scheduling = AlwaysHealthy;
    let first = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &scheduling,
            0,
            0,
            &V3StickySelectionScope::new("sticky-spread-srv", "g", "spread-session-1"),
        )
        .unwrap();
    let second = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &scheduling,
            0,
            0,
            &V3StickySelectionScope::new("sticky-spread-srv", "g", "spread-session-2"),
        )
        .unwrap();
    assert_ne!(
        first.candidate.provider_id, second.candidate.provider_id,
        "different sessions must spread by hold count, not pile onto the heaviest member"
    );
}

#[test]
fn sticky_pool_rolls_to_standby_when_primary_cools_and_does_not_pull_back() {
    let manifest = sticky_pool_manifest();
    let target = V3TargetInterpreter::default();
    let scope = V3StickySelectionScope::new("sticky-roll-srv", "g", "roll-session");
    let healthy = AlwaysHealthy;

    struct ACooled;
    impl V3ProviderSchedulingReader for ACooled {
        fn scheduling_projection(
            &self,
            provider_id: &str,
            auth_alias: &str,
            model_id: &str,
            priority: i32,
            base_weight: u32,
            _now_ms: u64,
        ) -> routecodex_v3_provider_responses::V3ProviderSchedulingProjection {
            let mut projection =
                routecodex_v3_provider_responses::V3ProviderSchedulingProjection::new(
                    provider_id,
                    "default",
                    auth_alias,
                    model_id,
                    priority,
                    1_000,
                    base_weight,
                );
            if provider_id == "a" {
                projection.available = false;
                projection.blocked_scopes = vec!["provider_key_health_cooldown".to_string()];
            }
            projection
        }
    }

    let first = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &healthy,
            0,
            0,
            &scope,
        )
        .unwrap();
    assert_eq!(first.candidate.provider_id, "a");

    let rolled = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &ACooled,
            0,
            0,
            &scope,
        )
        .unwrap();
    assert_eq!(
        rolled.candidate.provider_id, "b",
        "cooldown must roll to the standby"
    );

    // Provider a recovers. Recovery is lazy: the session stays on b.
    let after = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &healthy,
            0,
            0,
            &scope,
        )
        .unwrap();
    assert_eq!(
        after.candidate.provider_id, "b",
        "primary recovery must not pull the session back"
    );
}

#[test]
fn request_scoped_candidate_shrink_does_not_evict_the_session_binding() {
    // A client model filter can shrink one request's candidate set to a subset
    // of the pool. The sticky universe is the pool's declared members, so the
    // session's remembered provider must survive that narrow request.
    let manifest = sticky_pool_manifest();
    let target = V3TargetInterpreter::default();
    let scope = V3StickySelectionScope::new("sticky-shrink-srv", "g", "sticky-shrink-session");
    let scheduling = AlwaysHealthy;

    let first = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &scheduling,
            0,
            0,
            &scope,
        )
        .unwrap();
    assert_eq!(first.candidate.provider_id, "a");

    // Simulate the request-scoped filter: only provider b's candidate remains
    // expandable for this one request, while the pool still declares both.
    let mut narrowed = expanded_with(&manifest, &target, 0);
    narrowed
        .candidates
        .retain(|candidate| candidate.provider_id != "a");
    let narrowed_selection = target
        .select_available_with_health_sticky(narrowed, &scheduling, 0, 0, &scope)
        .unwrap();
    assert_eq!(
        narrowed_selection.candidate.provider_id, "b",
        "the only eligible member serves the narrow request"
    );

    // The next normal request must return to the session's own provider.
    let after = target
        .select_available_with_health_sticky(
            expanded_with(&manifest, &target, 0),
            &scheduling,
            0,
            0,
            &scope,
        )
        .unwrap();
    assert_eq!(
        after.candidate.provider_id, "a",
        "a narrow request must not evict the session's remembered provider"
    );
}

#[test]
fn non_sticky_pool_keeps_weighted_sampling_and_ignores_the_scope() {
    // Control for the sticky tests: the same manifest without the sticky
    // strategy must keep changing with the deterministic sample.
    let manifest = {
        let mut manifest = sticky_pool_manifest();
        manifest
            .route_groups
            .get_mut("g")
            .unwrap()
            .pools
            .get_mut("default")
            .unwrap()
            .selection
            .strategy = V3SelectionStrategy::Weighted;
        manifest
    };
    let target = V3TargetInterpreter::default();
    let scope = V3StickySelectionScope::new("sticky-weighted-srv", "g", "weighted-control-session");
    let scheduling = AlwaysHealthy;
    let mut seen = BTreeSet::new();
    for sample in [0_u64, 1, 2] {
        let selected = target
            .select_available_with_health_sticky(
                expanded_with(&manifest, &target, sample),
                &scheduling,
                0,
                sample,
                &scope,
            )
            .unwrap();
        seen.insert(selected.candidate.provider_id);
    }
    assert_eq!(
        seen.len(),
        2,
        "a non-sticky pool must keep weighted sampling over all members"
    );
}
