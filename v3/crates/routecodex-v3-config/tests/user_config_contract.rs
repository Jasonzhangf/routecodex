use routecodex_v3_config::{
    parse_v3_config_02_authoring, parse_v3_user_config_02_routing,
    project_v3_user_config_03_authoring, V3UserConfig02RoutingSelectionParsed,
};
use std::collections::{BTreeMap, BTreeSet};

const INTERNAL_BASE: &str = r#"
version = 3
[providers.cc]
type = "responses"
base_url = "https://cc.invalid/v1"
default_model = "model"
auth = { type = "api_key", entries = [{ alias = "key", env = "CC_KEY" }] }
[providers.cc.models.model]
capabilities = ["text"]
[route_groups.routecodex_v3_4444.pools.default]
targets = [{ kind = "provider_model", provider = "cc", model = "model", priority = 1 }]
[route_groups.routecodex_v3_4444.pools.thinking]
match = { precedence = 10 }
targets = [{ kind = "provider_model", provider = "cc", model = "model", priority = 1 }]
[route_groups.routecodex_v3_4444.pools.coding]
targets = [{ kind = "provider_model", provider = "cc", model = "model", priority = 1 }]
[route_groups.routecodex_v3_4444.pools.longcontext]
targets = [{ kind = "provider_model", provider = "cc", model = "model", priority = 1 }]
"#;

fn user_config(routes: &str) -> String {
    format!("version = 3\n[servers.any-name]\nbind = \"127.0.0.1\"\nport = 12345\n{routes}")
}

fn catalogue() -> BTreeMap<String, BTreeSet<String>> {
    BTreeMap::from([(String::from("cc"), BTreeSet::from([String::from("model")]))])
}

fn project(routes: &str) -> routecodex_v3_config::V3Config02AuthoringParsed {
    project_v3_user_config_03_authoring(
        parse_v3_user_config_02_routing(&user_config(routes)).unwrap(),
        parse_v3_config_02_authoring(INTERNAL_BASE).unwrap(),
        &catalogue(),
    )
    .unwrap()
}

#[test]
fn server_local_standard_routes_parse_without_group_or_port_contract() {
    let parsed = parse_v3_user_config_02_routing(&user_config(
        "[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]",
    ))
    .unwrap();
    assert_eq!(parsed.servers["any-name"].port, 12345);
    assert!(parsed.servers["any-name"].routes.contains_key("default"));
}

#[test]
fn arbitrary_server_and_port_project_to_isolated_runtime_groups() {
    let projected =
        project("[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]");
    assert_eq!(projected.servers["any-name"].port, 12345);
    assert_eq!(projected.servers["any-name"].routing_group, "any-name");
    assert!(projected.route_groups.contains_key("any-name"));
}

#[test]
fn omitted_standard_pool_inherits_default_targets() {
    let projected =
        project("[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]");
    assert_eq!(
        projected.route_groups["any-name"].pools["coding"].targets[0]
            .model
            .as_deref(),
        Some("model")
    );
}

#[test]
fn rejects_custom_pool_and_legacy_group_fields() {
    for raw in [
        user_config("[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]\n[servers.any-name.routes.custom]\ntiers = [[{ use = \"cc/model\" }]]"),
        String::from("version = 3\n[route_groups.custom.default]\ntiers = [[{ use = \"cc/model\" }]]"),
        user_config("routing_group = \"custom\"\n[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]"),
    ] {
        assert!(parse_v3_user_config_02_routing(&raw).is_err(), "accepted: {raw}");
    }
}

#[test]
fn rejects_missing_default_empty_tier_and_duplicate_member() {
    for routes in [
        "[servers.any-name.routes.thinking]\ntiers = [[{ use = \"cc/model\" }]]",
        "[servers.any-name.routes.default]\ntiers = [[]]",
        "[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }], [{ use = \"cc/model\" }]]",
    ] {
        assert!(parse_v3_user_config_02_routing(&user_config(routes)).is_err());
    }
}

#[test]
fn programmatic_selection_is_revalidated() {
    let mut parsed = parse_v3_user_config_02_routing(&user_config(
        "[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\", weight = 1 }]]",
    ))
    .unwrap();
    parsed
        .servers
        .get_mut("any-name")
        .unwrap()
        .routes
        .get_mut("default")
        .unwrap()
        .tiers[0][0]
        .weight = Some(0);
    assert!(project_v3_user_config_03_authoring(
        parsed,
        parse_v3_config_02_authoring(INTERNAL_BASE).unwrap(),
        &catalogue(),
    )
    .is_err());
}

#[test]
fn parsed_roundtrip_keeps_server_local_routes() {
    let parsed = parse_v3_user_config_02_routing(&user_config(
        "[servers.any-name.routes.default]\ntiers = [[{ use = \"cc/model\" }]]",
    ))
    .unwrap();
    let generated = toml::to_string(&parsed).unwrap();
    let reparsed: V3UserConfig02RoutingSelectionParsed =
        parse_v3_user_config_02_routing(&generated).unwrap();
    assert_eq!(parsed, reparsed);
}
