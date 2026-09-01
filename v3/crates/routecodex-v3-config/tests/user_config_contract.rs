use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, parse_v3_user_config_02_routing,
    project_v3_user_config_03_authoring, V3Config05ManifestPublished, V3ConfigStore,
    V3UserConfigStore,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;

const INTERNAL_BASE: &str = r#"
version = 3

[pipelines.hub_v1]
skeleton = "hub_v1"

[servers.primary]
bind = "127.0.0.1"
port = 4444
routing_group = "primary"

[providers.cc-sol]
type = "responses"
base_url = "https://cc.invalid/v1"
default_model = "gpt-5.6-sol"
auth = { type = "api_key", entries = [{ alias = "key", env = "CC_KEY" }] }

[providers.cc-sol.models."gpt-5.6-sol"]
capabilities = ["text"]

[providers.opencode-go]
type = "responses"
base_url = "https://go.invalid/v1"
default_model = "deepseek-v4-flash"
auth = { type = "api_key", entries = [{ alias = "key", env = "GO_KEY" }] }

[providers.opencode-go.models."deepseek-v4-flash"]
capabilities = ["text"]

[providers.minimax_anthropic]
type = "anthropic"
base_url = "https://minimax.invalid"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key", env = "MINIMAX_KEY" }] }

[providers.minimax_anthropic.models."MiniMax-M3"]
capabilities = ["text"]

[route_groups.primary.pools.default]
targets = [{ kind = "provider_model", provider = "cc-sol", model = "gpt-5.6-sol", priority = 100 }]

[route_groups.primary.pools.search]
match = { precedence = 10, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "cc-sol", model = "gpt-5.6-sol", priority = 100 }]
"#;

#[test]
fn minimal_user_config_parses_ordered_provider_model_tiers() {
    let parsed = parse_v3_user_config_02_routing(
        r#"
version = 3

[route_groups.primary.default]
tiers = [
  [{ use = "cc-sol/gpt-5.6-sol" }],
  [
    { use = "opencode-go/deepseek-v4-flash", weight = 70 },
    { use = "minimax_anthropic/MiniMax-M3", weight = 30 },
  ],
]
"#,
    )
    .expect("minimal config.toml must parse");

    let pool = &parsed.route_groups["primary"]["default"];
    assert_eq!(pool.tiers.len(), 2);
    assert_eq!(pool.tiers[0][0].provider, "cc-sol");
    assert_eq!(pool.tiers[0][0].model, "gpt-5.6-sol");
    assert_eq!(pool.tiers[1][0].weight, Some(70));
    assert_eq!(pool.tiers[1][1].weight, Some(30));
}

#[test]
fn user_config_rejects_internal_runtime_fields() {
    let error = parse_v3_user_config_02_routing(
        r#"
version = 3
features = { responses_direct = true }

[route_groups.primary.default]
tiers = [[{ use = "cc-sol/gpt-5.6-sol" }]]
"#,
    )
    .expect_err("internal fields must not enter the user authoring surface");

    assert!(error.to_string().contains("unknown field"), "{error}");
}

#[test]
fn projection_uses_first_outer_tier_as_highest_priority_and_equalizes_omitted_weights() {
    let parsed = parse_v3_user_config_02_routing(
        r#"
version = 3

[route_groups.primary.default]
tiers = [
  [{ use = "cc-sol/gpt-5.6-sol" }],
  [
    { use = "opencode-go/deepseek-v4-flash" },
    { use = "minimax_anthropic/MiniMax-M3" },
  ],
]
"#,
    )
    .unwrap();
    let base = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
    let projected = project_v3_user_config_03_authoring(parsed, base, &provider_catalogue())
        .expect("valid user routes must project");
    let targets = &projected.route_groups["primary"].pools["default"].targets;

    assert_eq!(targets[0].priority, Some(2));
    assert_eq!(targets[1].priority, Some(1));
    assert_eq!(targets[2].priority, Some(1));
    assert_eq!(targets[1].weight, Some(1));
    assert_eq!(targets[2].weight, Some(1));
    assert!(projected.route_groups["primary"].pools["search"]
        .match_rule
        .is_some());
    let inherited = &projected.route_groups["primary"].pools["search"].targets;
    assert_eq!(inherited[0].provider.as_deref(), Some("cc-sol"));
    assert_eq!(inherited[1].provider.as_deref(), Some("opencode-go"));
}

#[test]
fn projection_rejects_unknown_provider_model_before_compiler_entry() {
    let parsed = parse_v3_user_config_02_routing(
        r#"
version = 3

[route_groups.primary.default]
tiers = [[{ use = "missing/model" }]]
"#,
    )
    .unwrap();
    let base = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
    let error = project_v3_user_config_03_authoring(parsed, base, &provider_catalogue())
        .expect_err("unknown provider/model must fail before Config03");

    assert!(error.to_string().contains("missing/model"), "{error}");
}

#[test]
fn projection_revalidates_programmatic_routing_selection() {
    let mut parsed = parse_v3_user_config_02_routing(
        r#"
version = 3

[route_groups.primary.default]
tiers = [[{ use = "cc-sol/gpt-5.6-sol", weight = 1 }]]
"#,
    )
    .unwrap();
    parsed
        .route_groups
        .get_mut("primary")
        .unwrap()
        .get_mut("default")
        .unwrap()
        .tiers[0][0]
        .weight = Some(0);

    let base = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
    let error = project_v3_user_config_03_authoring(parsed, base, &provider_catalogue())
        .expect_err("programmatic Config02 selection must retain parser invariants");

    assert!(
        error.to_string().contains("weights must be positive"),
        "{error}"
    );
}

#[test]
fn parser_rejects_invalid_user_routing_shapes() {
    let invalid_cases = [
        (
            "missing default",
            "version = 3\n[route_groups.primary.search]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }]]",
            "must declare default pool",
        ),
        (
            "empty tier",
            "version = 3\n[route_groups.primary.default]\ntiers = [[]]",
            "must not be empty",
        ),
        (
            "duplicate member",
            "version = 3\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }], [{ use = \"cc-sol/gpt-5.6-sol\" }]]",
            "repeats provider/model",
        ),
        (
            "mixed weights",
            "version = 3\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\", weight = 2 }, { use = \"opencode-go/deepseek-v4-flash\" }]]",
            "set every weight or omit every weight",
        ),
        (
            "zero weight",
            "version = 3\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\", weight = 0 }]]",
            "weights must be positive",
        ),
        (
            "malformed reference",
            "version = 3\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol\" }]]",
            "expected <provider-id>/<model-id>",
        ),
    ];

    for (name, raw, expected) in invalid_cases {
        let error = parse_v3_user_config_02_routing(raw).expect_err(name);
        assert!(error.to_string().contains(expected), "{name}: {error}");
    }
}

#[test]
fn projection_rejects_unknown_group_and_pool() {
    for (raw, expected) in [
        (
            "version = 3\n[route_groups.missing.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }]]",
            "unknown route group",
        ),
        (
            "version = 3\n[route_groups.primary.missing]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }]]\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }]]",
            "unknown route pool",
        ),
    ] {
        let user = parse_v3_user_config_02_routing(raw).unwrap();
        let base = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
        let error = project_v3_user_config_03_authoring(user, base, &provider_catalogue())
            .expect_err(expected);
        assert!(error.to_string().contains(expected), "{error}");
    }
}

#[test]
fn omitted_and_explicit_equal_weights_project_identically() {
    let omitted = project_default_tier(
        "[{ use = \"opencode-go/deepseek-v4-flash\" }, { use = \"minimax_anthropic/MiniMax-M3\" }]",
    );
    let explicit = project_default_tier(
        "[{ use = \"opencode-go/deepseek-v4-flash\", weight = 1 }, { use = \"minimax_anthropic/MiniMax-M3\", weight = 1 }]",
    );

    let omitted_targets = &omitted.route_groups["primary"].pools["default"].targets;
    let explicit_targets = &explicit.route_groups["primary"].pools["default"].targets;
    assert_eq!(omitted_targets.len(), explicit_targets.len());
    for (left, right) in omitted_targets.iter().zip(explicit_targets) {
        assert_eq!(left.provider, right.provider);
        assert_eq!(left.model, right.model);
        assert_eq!(left.priority, right.priority);
        assert_eq!(left.weight, right.weight);
    }
}

#[test]
fn projected_authoring_uses_existing_config03_to_config05_compiler() {
    let projected = project_default_tier("[{ use = \"cc-sol/gpt-5.6-sol\" }]");
    let manifest = compile_v3_config_05_manifest(projected)
        .expect("projected Config02 must enter the existing Config03-05 compiler");

    assert_eq!(manifest.version, 3);
    assert_eq!(
        manifest.route_groups["primary"].pools["default"]
            .targets
            .len(),
        1
    );
}

#[test]
fn standalone_store_resolves_provider_directory_and_publishes_manifest() {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-user-config-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let provider_dir = root.join("provider/cc-sol");
    fs::create_dir_all(&provider_dir).unwrap();
    fs::write(
        root.join("config.toml"),
        "version = 3\n[route_groups.primary.default]\ntiers = [[{ use = \"cc-sol/gpt-5.6-sol\" }]]\n",
    )
    .unwrap();
    fs::write(
        provider_dir.join("config.v2.toml"),
        r#"version = "2.0.0"
providerId = "cc-sol"
[provider]
id = "cc-sol"
enabled = true
type = "responses"
baseURL = "https://cc.invalid/v1"
defaultModel = "gpt-5.6-sol"
[provider.responses]
process = "direct"
streaming = "always"
[provider.auth]
env = "CC_KEY"
[provider.models."gpt-5.6-sol"]
capabilities = ["text"]
"#,
    )
    .unwrap();

    let mut internal = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
    internal.providers.clear();
    internal.debug.log_file = Some("logs/server-v3-7777.log".to_string());
    let manifest = V3UserConfigStore::with_internal_authoring(root.join("config.toml"), internal)
        .load_manifest()
        .expect("standalone store must resolve only selected provider files and compile Config05");
    assert!(manifest.providers.contains_key("cc-sol"));
    assert_eq!(
        manifest.route_groups["primary"].pools["search"].targets[0]
            .provider
            .as_deref(),
        Some("cc-sol")
    );
    assert_eq!(
        manifest.debug.log_file.as_deref(),
        Some(
            root.join("logs/server-v3-7777.log")
                .to_string_lossy()
                .as_ref()
        ),
        "internal relative paths must resolve from the selected config.toml directory"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn embedded_internal_user_config_topology_is_typed_and_provider_free() {
    let internal = routecodex_v3_config::internal::v3_internal_user_config_authoring();
    assert!(internal.providers.is_empty());
    assert!(internal.forwarders.is_empty());
    assert_eq!(internal.servers.len(), 2);
    assert!(internal.route_groups.contains_key("routecodex_v3_4444"));
    assert!(internal.route_groups.contains_key("responses_v3_7777"));
    assert!(!internal.route_groups.contains_key("anthropic_v3_10000"));
}

#[test]
fn explicit_real_user_config_compiles_when_requested() {
    let Ok(path) = std::env::var("ROUTECODEX_TEST_USER_CONFIG_PATH") else {
        return;
    };
    let manifest = V3UserConfigStore::new(path)
        .load_manifest()
        .expect("explicit real config.toml must compile through the standalone store");
    assert_eq!(manifest.servers.len(), 2);
    assert_eq!(manifest.route_groups.len(), 2);
    assert!(manifest.providers.len() >= 8);
}

#[test]
fn explicit_old_and_new_configs_have_equal_normalized_manifests() {
    let (Ok(old_path), Ok(new_path)) = (
        std::env::var("ROUTECODEX_TEST_OLD_CONFIG_PATH"),
        std::env::var("ROUTECODEX_TEST_USER_CONFIG_PATH"),
    ) else {
        return;
    };
    let old_snapshot = V3ConfigStore::new(old_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let new_manifest = V3UserConfigStore::new(new_path).load_manifest().unwrap();

    let old = normalize_runtime_manifest(old_snapshot.manifest);
    let new = normalize_runtime_manifest(new_manifest);
    assert_eq!(old.version, new.version, "version differential");
    assert!(old.hub_v1 == new.hub_v1, "Hub differential");
    assert!(old.servers == new.servers, "server differential");
    assert!(old.providers == new.providers, "provider differential");
    assert!(old.forwarders == new.forwarders, "forwarder differential");
    for (group_id, old_group) in &old.route_groups {
        let new_group = &new.route_groups[group_id];
        assert_eq!(
            old_group.compact_route_object, new_group.compact_route_object,
            "{group_id} compact route object"
        );
        assert!(
            old_group.route_policies == new_group.route_policies,
            "{group_id} route policies"
        );
        assert_eq!(
            old_group.features, new_group.features,
            "{group_id} features"
        );
        assert_eq!(
            old_group.pools.len(),
            new_group.pools.len(),
            "{group_id} pool count"
        );
        for (pool_id, old_pool) in &old_group.pools {
            let new_pool = &new_group.pools[pool_id];
            assert_eq!(
                old_pool.selection, new_pool.selection,
                "{group_id}.{pool_id} selection"
            );
            assert_eq!(
                old_pool.route_object, new_pool.route_object,
                "{group_id}.{pool_id} route object"
            );
            assert!(
                old_pool.match_rule == new_pool.match_rule,
                "{group_id}.{pool_id} match"
            );
            assert_eq!(
                old_pool.features, new_pool.features,
                "{group_id}.{pool_id} features"
            );
            assert!(
                old_pool.targets == new_pool.targets,
                "{group_id}.{pool_id} targets"
            );
        }
    }
    assert!(old.features == new.features, "feature differential");
    assert!(old.debug == new.debug, "debug differential");
    assert!(old.error == new.error, "error differential");

    let mut reversed_tier = new.clone();
    reversed_tier
        .route_groups
        .get_mut("responses_v3_7777")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets
        .swap(0, 1);
    assert_ne!(old, reversed_tier, "reversed tier must fail differential");

    let mut changed_candidate = new.clone();
    changed_candidate
        .route_groups
        .get_mut("routecodex_v3_4444")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets[0]
        .model = Some("changed-model".to_string());
    assert_ne!(
        old, changed_candidate,
        "changed candidate must fail differential"
    );

    let mut changed_weight = new.clone();
    changed_weight
        .route_groups
        .get_mut("responses_v3_7777")
        .unwrap()
        .pools
        .get_mut("thinking")
        .unwrap()
        .targets[0]
        .weight = Some(2);
    assert_ne!(old, changed_weight, "changed weight must fail differential");

    let mut missing_internal = new.clone();
    missing_internal.features.remove("responses_direct");
    assert_ne!(
        old, missing_internal,
        "missing internal default must fail differential"
    );

    let mut changed_provider = new.clone();
    changed_provider
        .providers
        .get_mut("cc-sol")
        .unwrap()
        .base_url = "https://different.invalid/v1".to_string();
    assert_ne!(
        old, changed_provider,
        "changed provider resolution must fail differential"
    );

    let old_admin = old_snapshot.admin_webui.unwrap();
    let new_admin = routecodex_v3_config::internal::v3_internal_user_config_authoring().admin_webui;
    assert_eq!(old_admin.enabled, new_admin.enabled);
    assert_eq!(old_admin.bind, new_admin.bind);
    assert_eq!(old_admin.port, new_admin.port);
}

fn normalize_runtime_manifest(
    mut manifest: V3Config05ManifestPublished,
) -> V3Config05ManifestPublished {
    let enabled_groups = manifest
        .servers
        .values()
        .map(|server| server.routing_group.clone())
        .collect::<BTreeSet<_>>();
    manifest
        .route_groups
        .retain(|group_id, _| enabled_groups.contains(group_id));

    let mut referenced = BTreeMap::<String, BTreeSet<String>>::new();
    for group in manifest.route_groups.values_mut() {
        for pool in group.pools.values_mut() {
            pool.targets.sort_by(|left, right| {
                right.priority.unwrap_or(0).cmp(&left.priority.unwrap_or(0))
            });
            let mut priorities = pool
                .targets
                .iter()
                .map(|target| target.priority.unwrap_or(0))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            priorities.sort_by(|left, right| right.cmp(left));
            let normalized = priorities
                .into_iter()
                .enumerate()
                .map(|(index, priority)| (priority, i32::try_from(index + 1).unwrap()))
                .collect::<BTreeMap<_, _>>();
            for target in &mut pool.targets {
                target.priority = Some(normalized[&target.priority.unwrap_or(0)]);
                target.weight = Some(target.weight.unwrap_or(1));
                if let (Some(provider), Some(model)) = (&target.provider, &target.model) {
                    referenced
                        .entry(provider.clone())
                        .or_default()
                        .insert(model.clone());
                }
            }
        }
    }
    manifest
        .providers
        .retain(|provider_id, _| referenced.contains_key(provider_id));
    for (provider_id, provider) in &mut manifest.providers {
        let models = &referenced[provider_id];
        provider
            .models
            .retain(|model_id, _| models.contains(model_id));
    }
    manifest
}

fn project_default_tier(tier: &str) -> routecodex_v3_config::V3Config02AuthoringParsed {
    let raw = format!("version = 3\n[route_groups.primary.default]\ntiers = [{tier}]");
    let user = parse_v3_user_config_02_routing(&raw).unwrap();
    let base = parse_v3_config_02_authoring(INTERNAL_BASE).unwrap();
    project_v3_user_config_03_authoring(user, base, &provider_catalogue()).unwrap()
}

fn provider_catalogue() -> BTreeMap<String, BTreeSet<String>> {
    BTreeMap::from([
        (
            "cc-sol".to_string(),
            BTreeSet::from(["gpt-5.6-sol".to_string()]),
        ),
        (
            "opencode-go".to_string(),
            BTreeSet::from(["deepseek-v4-flash".to_string()]),
        ),
        (
            "minimax_anthropic".to_string(),
            BTreeSet::from(["MiniMax-M3".to_string()]),
        ),
    ])
}
