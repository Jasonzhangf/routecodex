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
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        _now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let label = format!(
            "{provider_id}:{}:{}",
            auth_alias.unwrap_or(""),
            model_id.unwrap_or("")
        );
        V3ProviderAvailabilityProjection {
            provider_id: provider_id.into(),
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
            priority: Some(1),
            weight: Some(1),
        },
        V3ForwarderTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("b".into()),
            model: Some("m".into()),
            key: Some("kb".into()),
            priority: Some(1),
            weight: Some(3),
        },
        V3ForwarderTargetManifest {
            kind: V3RouteTargetKind::ProviderModel,
            id: None,
            provider: Some("c".into()),
            model: Some("m".into()),
            key: Some("kc".into()),
            priority: Some(2),
            weight: Some(100),
        },
    ];
    manifest
}

#[test]
fn weighted_forwarder_advances_priority_only_after_current_session_exhausts_lower_tier() {
    let manifest = weighted_priority_forwarder_manifest();
    let target = V3TargetInterpreter::default();
    let all_available = Availability {
        blocked: BTreeSet::new(),
    };
    let selected = target
        .select_available(expanded_with(&manifest, &target, 4), &all_available, 0)
        .unwrap();
    assert_ne!(selected.candidate.provider_id, "c");

    let one_priority_one_available = Availability {
        blocked: BTreeSet::from(["b:kb:m".into()]),
    };
    let selected = target
        .select_available(
            expanded_with(&manifest, &target, 4),
            &one_priority_one_available,
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "a");

    let only_priority_two_available = Availability {
        blocked: BTreeSet::from(["a:ka:m".into(), "b:kb:m".into()]),
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
fn direct_provider_model_expands_pinned_provider_and_bypasses_health_cooldown() {
    let selected = direct_selected("a.m", BTreeSet::new()).unwrap();
    assert_eq!(selected.candidate.provider_id, "a");
    assert_eq!(selected.candidate.model_id, "m");

    // Health cooldown must not veto an explicit pin.
    let cooled = direct_selected("a.m", BTreeSet::from(["a:ka:m".into()])).unwrap();
    assert_eq!(cooled.candidate.provider_id, "a");
    assert_eq!(
        cooled.unavailable_candidates,
        vec!["a:ka:m:availability(a:ka:m)"],
        "cooldown must still be reported even when bypassed"
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
        vec!["a:ka:m:availability(request_local_provider_failure)"]
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
        vec!["minimax_anthropic", "minimax_openai"]
    );
    let selected = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from([format!(
                    "{}:{}:{}",
                    "minimax_anthropic", "key1", "MiniMax-M3"
                )]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.candidate.provider_id, "minimax_openai");
    assert_eq!(selected.candidate.model_id, "MiniMax-M3-local");
}

#[test]
fn requested_explicit_model_route_maps_to_declared_targets_without_alias_requirement() {    let source = r#"
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
        vec!["default_gpt", "minimax"]
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
    assert_eq!(selected.candidate.provider_id, "default_gpt");
    assert_eq!(selected.candidate.model_id, "gpt-5.5");
}

#[test]
fn nested_forwarder_expands_and_reselects_inside_same_route_hit() {
    let expanded = expanded();
    assert_eq!(expanded.route.hit_count, 1);
    assert_eq!(expanded.candidates.len(), 2);
    assert_eq!(
        expanded.candidates[0].compatibility_profile.as_deref(),
        Some("chat:minimax")
    );
    assert_eq!(
        expanded.candidates[0]
            .provider_request_cleanup
            .historical_fields,
        vec!["reasoning.encrypted_content"]
    );
    assert_eq!(expanded.candidates[1].compatibility_profile, None);
    assert!(expanded.candidates[1]
        .provider_request_cleanup
        .historical_fields
        .is_empty());
    let selected = V3TargetInterpreter::default()
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["a:ka:m".into()]),
            },
            0,
        )
        .unwrap();
    assert_eq!(selected.route.hit_count, 1);
    assert_eq!(selected.candidate.provider_id, "b");
    assert_eq!(selected.attempts, 2);
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
                blocked: BTreeSet::from(["a:ka:m".into()]),
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
fn continuation_signals_are_owner_paths_not_target_capability_filters() {
    let expanded = expanded_tools();
    let mut candidate = expanded
        .candidates
        .first()
        .expect("tools route must expand candidates")
        .clone();
    candidate.required_capabilities = vec![
        "tool_outputs".into(),
        "remote_continuation".into(),
        "local_materialization".into(),
    ];
    candidate.model_capabilities = vec!["text".into()];

    assert!(
        candidate_satisfies_required_capabilities(&candidate),
        "previous_response_id must be resolved by continuation owner (direct remote vs relay local), not by Target model capability_mismatch"
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
    let exhausted = V3TargetInterpreter::default()
        .select_available(
            expanded(),
            &Availability {
                blocked: BTreeSet::from(["a:ka:m".into(), "b:kb:m".into()]),
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
            "a:ka:m:availability(request_local_provider_failure)".to_string(),
            "b:kb:m:availability(request_local_provider_failure)".to_string(),
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
    let exhausted = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["vision:key:m".into()]),
            },
            0,
        )
        .expect_err("health cooldown must remove the default-floor vision target");
    assert_eq!(exhausted.attempted_candidates.len(), 2);
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
    assert!(
        hit.target_plan
            .iter()
            .all(|entry| entry.pool_id == "longcontext"),
        "duplicated default targets are already deduped by Router07 and cannot repair candidate requirements"
    );
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
fn web_search_capability_filters_default_candidates_without_web_search_route_pool() {
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
                blocked: BTreeSet::new(),
            },
            0,
        )
        .expect("web_search is a target capability filter, not a VR route reason");

    assert_eq!(selected.candidate.provider_id, "search");
    assert!(selected
        .candidate
        .required_capabilities
        .iter()
        .any(|capability| capability == "web_search"));
}

#[test]
fn configured_priority_is_not_overridden_by_context_near_limit_heuristic() {
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
                input_tokens: 950,
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

    assert_eq!(selected.candidate.provider_id, "short");
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
    let selected_after_explicit_failure = target
        .select_available(
            expanded,
            &Availability {
                blocked: BTreeSet::from(["short:key:m".into()]),
            },
            0,
        )
        .unwrap();
    assert_eq!(
        selected_after_explicit_failure.candidate.provider_id,
        "long"
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
