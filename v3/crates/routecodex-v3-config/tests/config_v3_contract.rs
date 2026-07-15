use routecodex_v3_config::{
    compile_v3_config_05_manifest, default_v3_config_path, parse_v3_config_02_authoring,
    V3ConfigStore, V3HubFixedNode, V3HubHookPhase, V3HubHookProfile, V3HubHookRequirement,
    V3RouteTargetKind, V3SelectionStrategy,
};
use std::fs;

const FULL_CONFIG: &str = r#"
version = 3

[features]
responses_direct = true
debug_events = true

[debug]
log_console = true
log_file = "/tmp/routecodex-v3.log"
snapshots = true
dry_run = true
retention = { raw_requests = 10, raw_responses = 10 }

[error.policies.provider_unavailable]
action = "target_local_reselect"
cooldown_ms = 1000
max_attempts = 3

[servers.primary]
bind = "127.0.0.1"
port = 4444
routing_group = "primary"
endpoints = ["responses"]

[servers.secondary]
bind = "127.0.0.1"
port = 4445
routing_group = "secondary"
endpoints = ["responses"]

[providers.cc]
type = "responses"
base_url = "https://api.anyint.ai/openai/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "CC_API_KEY" }] }
responses = { process = "chat", streaming = "always" }
concurrency = { max_in_flight = 8, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }
health = { enabled = true, failure_threshold = 3, cooldown_ms = 30000 }

[providers.cc.models."gpt-5.5"]
wire_name = "gpt-5.5"
aliases = ["cc-gpt-5.6"]
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
supports_thinking = true
thinking = "low"
max_tokens = 64000
max_context_tokens = 200000

[providers.asxs]
type = "responses"
base_url = "https://api.asxs.top/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [
  { alias = "crsa", env = "ASXS_CRSA_API_KEY" },
  { alias = "crsb", env = "ASXS_CRSB_API_KEY" }
] }
responses = { process = "chat", streaming = "always" }

[providers.asxs.models."gpt-5.5"]
wire_name = "gpt-5.5"
aliases = ["asxs-gpt-5.6"]
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
supports_thinking = true

[forwarders."fwd.gpt-5.6"]
model = "gpt-5.6"
aliases = ["gpt-latest"]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5", key = "crsa", priority = 2 }
]

[forwarders."nested.gpt-5.6"]
model = "gpt-5.6"
selection = { strategy = "round_robin" }
targets = [{ kind = "forwarder", id = "fwd.gpt-5.6" }]

[route_groups.primary.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "fwd.gpt-5.6", priority = 1 }]

[route_groups.primary.pools.search]
selection = { strategy = "weighted" }
match = { precedence = 10, entry_protocol = "responses", models = ["gpt-5.6"], required_capabilities = ["tools"], min_input_tokens = 1, max_input_tokens = 200000 }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5", weight = 70 },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5", weight = 30 }
]

[route_groups.secondary.pools.default]
selection = { strategy = "round_robin" }
targets = [
  { kind = "provider_model", provider = "cc", model = "gpt-5.5" },
  { kind = "provider_model", provider = "asxs", model = "gpt-5.5" }
]
"#;

#[test]
fn parses_full_config_v3_without_interpreting_targets() {
    let authoring = parse_v3_config_02_authoring(FULL_CONFIG).unwrap();
    let manifest = compile_v3_config_05_manifest(authoring).unwrap();

    assert_eq!(manifest.version, 3);
    assert_eq!(manifest.servers.len(), 2);
    assert_eq!(manifest.servers["primary"].port, 4444);
    assert_eq!(manifest.servers["secondary"].port, 4445);
    assert_eq!(manifest.providers.len(), 2);
    assert_eq!(
        manifest.providers["cc"].models["gpt-5.5"].wire_name,
        "gpt-5.5"
    );
    assert_eq!(
        manifest.providers["cc"].models["gpt-5.5"].aliases,
        vec!["cc-gpt-5.6"]
    );
    assert_eq!(manifest.providers["asxs"].auth.entries.len(), 2);
    assert_eq!(
        manifest.providers["cc"]
            .health
            .as_ref()
            .expect("health declaration")
            .failure_threshold,
        3
    );

    let forwarder = &manifest.forwarders["fwd.gpt-5.6"];
    assert_eq!(forwarder.selection.strategy, V3SelectionStrategy::Priority);
    assert_eq!(forwarder.targets.len(), 2);
    assert_eq!(forwarder.targets[0].provider.as_deref(), Some("cc"));
    assert_eq!(
        manifest.forwarders["nested.gpt-5.6"].targets[0]
            .id
            .as_deref(),
        Some("fwd.gpt-5.6")
    );
    assert!(manifest.debug.dry_run);
    assert_eq!(
        manifest.error.policies["provider_unavailable"].max_attempts,
        Some(3)
    );

    let route_target = &manifest.route_groups["primary"].pools["default"].targets[0];
    assert_eq!(route_target.kind, V3RouteTargetKind::Forwarder);
    assert_eq!(route_target.id.as_deref(), Some("fwd.gpt-5.6"));
    assert!(
        route_target.provider.is_none(),
        "config compiler must not interpret a forwarder into a provider"
    );
    let pool_match = manifest.route_groups["primary"].pools["search"]
        .match_rule
        .as_ref()
        .expect("typed pool match declaration");
    assert_eq!(pool_match.models, vec!["gpt-5.6"]);
    assert_eq!(pool_match.required_capabilities, vec!["tools"]);
    assert_eq!(pool_match.precedence, 10);
    assert_eq!(pool_match.entry_protocol.as_deref(), Some("responses"));
}

#[test]
fn rejects_recursive_forwarder_cycle() {
    let invalid = FULL_CONFIG.replace(
        "targets = [{ kind = \"forwarder\", id = \"fwd.gpt-5.6\" }]",
        "targets = [{ kind = \"forwarder\", id = \"nested.gpt-5.6\" }]",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&invalid).unwrap()).unwrap_err();
    assert!(error.to_string().contains("contains cycle"));
}

#[test]
fn rejects_unknown_auth_alias_and_ambiguous_model_alias() {
    let bad_key = FULL_CONFIG.replace("key = \"key1\"", "key = \"missing\"");
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&bad_key).unwrap()).unwrap_err();
    assert!(error.to_string().contains("unknown auth alias missing"));

    let ambiguous = FULL_CONFIG.replace("aliases = [\"cc-gpt-5.6\"]", "aliases = [\"gpt-5.5\"]");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&ambiguous).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous model name gpt-5.5"));
}

#[test]
fn published_manifest_is_declaration_only_and_deterministic() {
    let first =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(FULL_CONFIG).unwrap()).unwrap();
    let second =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(FULL_CONFIG).unwrap()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.servers.len(), 2);
}

#[test]
fn rejects_duplicate_listener_empty_default_and_no_enabled_server() {
    let duplicate = FULL_CONFIG.replace("port = 4445", "port = 4444");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&duplicate).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("share listen address"));

    let empty_default = FULL_CONFIG.replace(
        "targets = [{ kind = \"forwarder\", id = \"fwd.gpt-5.6\", priority = 1 }]",
        "targets = []",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&empty_default).unwrap())
            .unwrap_err();
    assert!(error.to_string().contains("default pool is empty"));

    let disabled = FULL_CONFIG
        .replace(
            "[servers.primary]\n",
            "[servers.primary]\nenabled = false\n",
        )
        .replace(
            "[servers.secondary]\n",
            "[servers.secondary]\nenabled = false\n",
        );
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&disabled).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("at least one enabled server"));
}

#[test]
fn rejects_invalid_auth_handle_shapes_and_unknown_forwarder() {
    let empty_env = FULL_CONFIG.replace("env = \"CC_API_KEY\"", "env = \"\"");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&empty_env).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("secret handle name"));

    let unknown = FULL_CONFIG.replace(
        "id = \"fwd.gpt-5.6\", priority",
        "id = \"missing.forwarder\", priority",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&unknown).unwrap()).unwrap_err();
    assert!(error
        .to_string()
        .contains("unknown forwarder missing.forwarder"));
}

#[test]
fn requires_default_pool_for_every_route_group() {
    let invalid = FULL_CONFIG.replace(
        "[route_groups.secondary.pools.default]",
        "[route_groups.secondary.pools.coding]",
    );
    let authoring = parse_v3_config_02_authoring(&invalid).unwrap();
    let error = compile_v3_config_05_manifest(authoring).unwrap_err();
    assert!(error.to_string().contains("must define default pool"));
}

#[test]
fn rejects_unknown_fields_and_secret_literals() {
    let unknown = FULL_CONFIG.replace(
        "routing_group = \"primary\"",
        "routing_group = \"primary\"\nunknown_server_field = true",
    );
    assert!(parse_v3_config_02_authoring(&unknown).is_err());

    let secret = FULL_CONFIG.replace("env = \"CC_API_KEY\"", "env = \"sk-secret-value\"");
    let authoring = parse_v3_config_02_authoring(&secret).unwrap();
    assert!(compile_v3_config_05_manifest(authoring).is_err());
}

#[test]
fn validates_provider_model_and_forwarder_references() {
    let invalid = FULL_CONFIG.replace(
        "provider = \"cc\", model = \"gpt-5.5\", key = \"key1\"",
        "provider = \"cc\", model = \"alias-only\", key = \"key1\"",
    );
    let authoring = parse_v3_config_02_authoring(&invalid).unwrap();
    let error = compile_v3_config_05_manifest(authoring).unwrap_err();
    assert!(error
        .to_string()
        .contains("does not declare canonical model alias-only"));
}

#[test]
fn config_store_is_the_single_read_write_interface() {
    let root =
        std::env::temp_dir().join(format!("routecodex-v3-config-store-{}", std::process::id()));
    let path = root.join("config.v3.toml");
    let store = V3ConfigStore::new(&path);
    let authoring = parse_v3_config_02_authoring(FULL_CONFIG).unwrap();
    let plan = store.plan_write(&authoring).unwrap();
    store.commit_write_atomic(plan).unwrap();

    let snapshot = store.load_snapshot().unwrap();
    assert_eq!(snapshot.servers["primary"].port, 4444);
    assert_eq!(store.path(), path);
    assert!(!path
        .with_extension(format!("toml.tmp-{}", std::process::id()))
        .exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn default_path_is_config_v3_toml() {
    assert_eq!(
        default_v3_config_path("/tmp/home"),
        std::path::PathBuf::from("/tmp/home/.rcc/config.v3.toml")
    );
}

#[test]
fn compiles_hub_v1_declarations_without_request_branch_decisions() {
    let raw = format!(
        "{}\n{}\n{}",
        FULL_CONFIG, HUB_V1_DECLARATION, HUB_V1_SERVER_EXECUTION
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&raw).unwrap()).unwrap();
    let hub = manifest.hub_v1.expect("hub_v1 declaration");
    assert_eq!(hub.skeleton, "hub_v1");
    assert_eq!(
        hub.entry_protocols,
        vec!["responses", "anthropic", "gemini", "openai_chat"]
    );
    assert_eq!(hub.hooks.len(), 30);
    assert_eq!(hub.resources.len(), 6);
    assert!(hub
        .resources
        .values()
        .all(|resource| !resource.may_enter_provider_body && !resource.may_enter_client_body));
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            assert!(hub
                .hooks
                .iter()
                .any(|hook| hook.node == node && hook.phase == phase));
        }
    }
    let servertool = hub
        .hooks
        .iter()
        .filter(|hook| hook.profile == Some(V3HubHookProfile::Servertool))
        .collect::<Vec<_>>();
    assert_eq!(servertool.len(), 2);
    assert!(servertool.iter().all(|hook| matches!(
        hook.node,
        V3HubFixedNode::V3HubReqChatProcess04Governed
            | V3HubFixedNode::V3HubRespChatProcess03Governed
    )));
    assert!(!format!("{hub:?}").contains("selected_target"));
    assert!(!format!("{hub:?}").contains("selected_execution_mode"));
}

#[test]
fn rejects_invalid_hub_v1_declarations_fail_fast() {
    for (invalid, expected) in [
        (
            HUB_V1_DECLARATION.replace("skeleton = \"hub_v1\"", "skeleton = \"hub_v2\""),
            "skeleton must be hub_v1",
        ),
        (
            HUB_V1_DECLARATION.replace(
                "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented",
                "hub_v1.unknown",
            ),
            "unknown hook",
        ),
        (
            HUB_V1_DECLARATION.replace("  { hook_id = \"hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented\", node = \"V3ServerRespOutbound06ClientFrame\", phase = \"exit\", requirement = \"required\", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },\n", ""),
            "missing required exit hook",
        ),
        (
            HUB_V1_DECLARATION.replace(
                "{ hook_id = \"hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented\", node = \"V3ServerRespOutbound06ClientFrame\", phase = \"exit\"",
                "{ hook_id = \"hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented\", node = \"V3ServerRespOutbound06ClientFrame\", phase = \"entry\"",
            ),
            "duplicate hook",
        ),
        (
            HUB_V1_DECLARATION.replace("\"responses\"", "\"unsupported\""),
            "unknown entry protocol",
        ),
    ] {
        let raw = format!("{}\n{}\n{}", FULL_CONFIG, invalid, HUB_V1_SERVER_EXECUTION);
        let err =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(&raw).unwrap()).unwrap_err();
        assert!(err.to_string().contains(expected), "{err}");
    }
}

#[test]
fn enforces_hook_resource_profile_and_optional_contracts() {
    let implicit_permissions = HUB_V1_DECLARATION.replacen(
        ", allowed_resources = [], forbidden_resources = []",
        ", forbidden_resources = []",
        1,
    );
    let raw = format!(
        "{}\n{}\n{}",
        FULL_CONFIG, implicit_permissions, HUB_V1_SERVER_EXECUTION
    );
    assert!(parse_v3_config_02_authoring(&raw).is_err());

    let cases = [
        (
            HUB_V1_DECLARATION.replace(
                "allowed_resources = [\"metadata_center\"]",
                "allowed_resources = [\"unknown_resource\"]",
            ),
            "unknown resource",
        ),
        (
            HUB_V1_DECLARATION.replace(
                "allowed_resources = [\"metadata_center\"], forbidden_resources = []",
                "allowed_resources = [\"metadata_center\"], forbidden_resources = [\"metadata_center\"]",
            ),
            "both allows and forbids",
        ),
        (
            HUB_V1_DECLARATION.replace(
                "node = \"V3HubReqInbound02Normalized\", phase = \"entry\", requirement = \"required\", priority",
                "node = \"V3HubReqInbound02Normalized\", phase = \"entry\", requirement = \"required\", enabled = false, priority",
            ),
            "required hook",
        ),
        (
            HUB_V1_DECLARATION.replace(
                "forbidden_resources = [\"continuation_store\"]",
                "forbidden_resources = [\"continuation_store\"], profile = \"servertool\"",
            ),
            "servertool profile is forbidden",
        ),
    ];
    for (invalid, expected) in cases {
        let raw = format!("{}\n{}\n{}", FULL_CONFIG, invalid, HUB_V1_SERVER_EXECUTION);
        let error =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(&raw).unwrap()).unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
    }

    let raw = format!(
        "{}\n{}\n{}",
        FULL_CONFIG, HUB_V1_DECLARATION, HUB_V1_SERVER_EXECUTION
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&raw).unwrap()).unwrap();
    let hooks = &manifest.hub_v1.unwrap().hooks;
    assert!(hooks.windows(2).all(|pair| {
        (pair[0].priority, pair[0].order, pair[0].hook_id.as_str())
            <= (pair[1].priority, pair[1].order, pair[1].hook_id.as_str())
    }));
    let optional = hooks
        .iter()
        .find(|hook| hook.requirement == V3HubHookRequirement::Optional)
        .expect("typed optional hook");
    assert!(!optional.enabled);
}

#[test]
fn rejects_unknown_hub_capability_and_execution_declarations() {
    let unknown_capability = FULL_CONFIG.replace(
        "capabilities = [\"text\", \"reasoning\", \"tools\"]",
        "capabilities = [\"text\", \"unknown_hub_capability\"]",
    );
    let err =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&unknown_capability).unwrap())
            .unwrap_err();
    assert!(err.to_string().contains("unknown capability"));

    let invalid_execution = HUB_V1_SERVER_EXECUTION.replace(
        "allowed_modes = [\"direct\", \"relay\"]",
        "allowed_modes = [\"direct\", \"automatic\"]",
    );
    let raw = format!(
        "{}\n{}\n{}",
        FULL_CONFIG, HUB_V1_DECLARATION, invalid_execution
    );
    let err =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&raw).unwrap()).unwrap_err();
    assert!(err.to_string().contains("hub_v1 server"));
    assert!(err.to_string().contains("unknown value automatic"));
}

#[test]
fn rejects_invalid_pool_match_and_capability_combinations() {
    let empty_match = FULL_CONFIG.replace(
        "match = { precedence = 10, entry_protocol = \"responses\", models = [\"gpt-5.6\"], required_capabilities = [\"tools\"], min_input_tokens = 1, max_input_tokens = 200000 }",
        "match = { precedence = 10 }",
    );
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&empty_match).unwrap())
        .unwrap_err();
    assert!(error.to_string().contains("pool match has no criteria"));

    let reversed_range = FULL_CONFIG.replace("min_input_tokens = 1", "min_input_tokens = 300000");
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&reversed_range).unwrap())
            .unwrap_err();
    assert!(error.to_string().contains("token range is invalid"));

    let incompatible = FULL_CONFIG.replace(
        "capabilities = [\"text\", \"reasoning\", \"tools\"]",
        "capabilities = [\"text\", \"remote_continuation\"]",
    );
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&incompatible).unwrap())
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("remote_continuation requires tool_outputs"));
}

#[test]
fn enforces_default_and_non_default_pool_match_contracts() {
    let default_match = FULL_CONFIG.replace(
        "[route_groups.primary.pools.default]\nselection = { strategy = \"priority\" }",
        "[route_groups.primary.pools.default]\nselection = { strategy = \"priority\" }\nmatch = { precedence = 1, entry_protocol = \"responses\" }",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&default_match).unwrap())
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("default pool cannot declare match"));

    let missing_match = FULL_CONFIG.replace(
        "match = { precedence = 10, entry_protocol = \"responses\", models = [\"gpt-5.6\"], required_capabilities = [\"tools\"], min_input_tokens = 1, max_input_tokens = 200000 }\n",
        "",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&missing_match).unwrap())
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("non-default pool search must declare match"));
}

#[test]
fn rejects_missing_precedence_and_unknown_entry_protocol() {
    let missing_precedence = FULL_CONFIG.replace("precedence = 10, ", "");
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&missing_precedence).unwrap())
            .unwrap_err();
    assert!(error.to_string().contains("must declare precedence"));

    let unknown_protocol = FULL_CONFIG.replace(
        "entry_protocol = \"responses\"",
        "entry_protocol = \"unknown\"",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&unknown_protocol).unwrap())
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("pool match entry_protocol contains unknown value unknown"));
}

#[test]
fn rejects_ambiguous_cross_provider_alias_invalid_health_and_unknown_endpoint() {
    let ambiguous = FULL_CONFIG.replace("aliases = [\"gpt-latest\"]", "aliases = [\"cc-gpt-5.6\"]");
    let error = compile_v3_config_05_manifest(parse_v3_config_02_authoring(&ambiguous).unwrap())
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("ambiguous client alias cc-gpt-5.6"));

    let invalid_health = FULL_CONFIG.replace("failure_threshold = 3", "failure_threshold = 0");
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&invalid_health).unwrap())
            .unwrap_err();
    assert!(error.to_string().contains("health failure_threshold"));

    let unknown_endpoint = FULL_CONFIG.replace(
        "endpoints = [\"responses\"]",
        "endpoints = [\"responses\", \"unknown_protocol\"]",
    );
    let error =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&unknown_endpoint).unwrap())
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("unknown endpoint unknown_protocol"));
}

const HUB_V1_DECLARATION: &str = r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
resources = { metadata_center = { kind = "control", scope = "request" }, continuation_store = { kind = "continuation", scope = "server" }, error_chain = { kind = "error", scope = "request" }, debug_artifact = { kind = "debug", scope = "debug" }, snapshot_buffer = { kind = "snapshot", scope = "debug" }, provider_health = { kind = "provider_health", scope = "provider" } }
hooks = [
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.entry.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "entry", requirement = "required", priority = 0, order = 0, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.exit.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "exit", requirement = "required", priority = 0, order = 1, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.entry.not_implemented", node = "V3HubReqInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 2, allowed_resources = ["metadata_center"], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.exit.not_implemented", node = "V3HubReqInbound02Normalized", phase = "exit", requirement = "optional", enabled = false, priority = 0, order = 3, allowed_resources = [], forbidden_resources = ["continuation_store"] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.entry.not_implemented", node = "V3HubReqContinuation03Classified", phase = "entry", requirement = "required", priority = 0, order = 4, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.exit.not_implemented", node = "V3HubReqContinuation03Classified", phase = "exit", requirement = "required", priority = 0, order = 5, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.entry.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "entry", requirement = "required", priority = 0, order = 6, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.exit.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "exit", requirement = "required", priority = 0, order = 7, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.entry.not_implemented", node = "V3HubReqExecution05Planned", phase = "entry", requirement = "required", priority = 0, order = 8, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.exit.not_implemented", node = "V3HubReqExecution05Planned", phase = "exit", requirement = "required", priority = 0, order = 9, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.entry.not_implemented", node = "V3HubReqTarget06Resolved", phase = "entry", requirement = "required", priority = 0, order = 10, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.exit.not_implemented", node = "V3HubReqTarget06Resolved", phase = "exit", requirement = "required", priority = 0, order = 11, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.entry.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "entry", requirement = "required", priority = 0, order = 12, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.exit.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "exit", requirement = "required", priority = 0, order = 13, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.entry.not_implemented", node = "V3HubRespContinuation04Committed", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.exit.not_implemented", node = "V3HubRespContinuation04Committed", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },
]
"#;

const HUB_V1_SERVER_EXECUTION: &str = r#"
[servers.primary.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[servers.secondary.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
"#;
