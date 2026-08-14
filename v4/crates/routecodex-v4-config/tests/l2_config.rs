use routecodex_v4_config::{
    build_v4_config_04_from_v4_config_03, compile_authoring, parse_v4_config_02_from_v4_config_01,
    publish_v4_config_05_from_v4_config_04, validate_v4_config_03_from_v4_config_02, ConfigError,
    V4Config01AuthoringFileSource,
};

const VALID: &str = r#"
version = 1

[[nodes]]
node_id = "V4Config01AuthoringFileSource"
operator_id = "config.parse"
plugin_id = "core.config"
entry_hooks = ["audit.entry"]
exit_hooks = []
resources_read = ["v4.config.authoring"]
resources_written = ["v4.config.parsed"]

[[nodes]]
node_id = "V4Config02AuthoringParsed"
operator_id = "config.validate"
plugin_id = "core.config"
entry_hooks = []
exit_hooks = ["audit.exit"]
resources_read = ["v4.config.parsed"]
resources_written = ["v4.config.schema_validated"]

[[edges]]
edge_id = "edge.config.01-to-02"
from = "V4Config01AuthoringFileSource"
to = "V4Config02AuthoringParsed"
resource_id = "v4.config.parsed"

[[operators]]
operator_id = "config.parse"
plugin_id = "core.config"

[[operators]]
operator_id = "config.validate"
plugin_id = "core.config"

[[plugins]]
plugin_id = "core.config"
action = "config"

[[hooks]]
hook_id = "audit.entry"
kind = "entry"
owner = "routecodex-v4-config"

[[hooks]]
hook_id = "audit.exit"
kind = "exit"
owner = "routecodex-v4-config"

[[resources]]
resource_id = "v4.config.authoring"
axis = "information"

[[resources]]
resource_id = "v4.config.parsed"
axis = "information"

[[resources]]
resource_id = "v4.config.schema_validated"
axis = "information"

[[auth_handles]]
provider_id = "provider-a"
alias = "primary"
source = "env:PROVIDER_A_TOKEN"
"#;

fn replace_once(source: &str, from: &str, to: &str) -> String {
    source.replacen(from, to, 1)
}

#[test]
fn config_chain_public_api_blackbox_regression() {
    let manifest = compile_authoring(VALID).expect("valid authoring must compile");
    assert_eq!(manifest.manifest_version(), 1);
    assert_eq!(manifest.nodes().len(), 2);
    assert_eq!(manifest.edges().len(), 1);
    assert_eq!(manifest.auth_handles().len(), 1);
    assert!(manifest.hash().starts_with("sha256:"));
    assert_eq!(
        manifest.to_canonical_string(),
        manifest.to_canonical_string()
    );
}

#[test]
fn config_compile_is_deterministic_across_authoring_order() {
    let reordered = VALID.replace(
        "[[operators]]\noperator_id = \"config.parse\"\nplugin_id = \"core.config\"\n\n[[operators]]\noperator_id = \"config.validate\"\nplugin_id = \"core.config\"",
        "[[operators]]\noperator_id = \"config.validate\"\nplugin_id = \"core.config\"\n\n[[operators]]\noperator_id = \"config.parse\"\nplugin_id = \"core.config\"",
    );
    let first = compile_authoring(VALID).unwrap();
    let second = compile_authoring(&reordered).unwrap();
    assert_eq!(first.hash(), second.hash());
    assert_eq!(first.to_canonical_string(), second.to_canonical_string());
}

#[test]
fn config_parse_rejects_unknown_fields() {
    let invalid = replace_once(VALID, "version = 1", "version = 1\nunknown = true");
    assert!(matches!(
        parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new(
            "inline", &invalid
        )),
        Err(ConfigError::Parse(_))
    ));
}

#[test]
fn config_rejects_unknown_node_reference() {
    let invalid = replace_once(
        VALID,
        "to = \"V4Config02AuthoringParsed\"",
        "to = \"V4Config99Missing\"",
    );
    assert_eq!(compile_authoring(&invalid), Err(ConfigError::UnknownNode));
}

#[test]
fn config_rejects_unknown_operator_reference() {
    let invalid = replace_once(
        VALID,
        "operator_id = \"config.parse\"",
        "operator_id = \"missing\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::UnknownOperator)
    );
}

#[test]
fn config_rejects_operator_plugin_mismatch() {
    let invalid = replace_once(
        VALID,
        "action = \"config\"",
        "action = \"config\"\n\n[[plugins]]\nplugin_id = \"other.config\"\naction = \"config\"",
    );
    let invalid = replace_once(
        &invalid,
        "node_id = \"V4Config01AuthoringFileSource\"\noperator_id = \"config.parse\"\nplugin_id = \"core.config\"",
        "node_id = \"V4Config01AuthoringFileSource\"\noperator_id = \"config.parse\"\nplugin_id = \"other.config\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::OperatorPluginMismatch)
    );
}

#[test]
fn config_rejects_unknown_plugin_reference() {
    let invalid = replace_once(
        VALID,
        "plugin_id = \"core.config\"\n\n[[plugins]]",
        "plugin_id = \"missing.plugin\"\n\n[[plugins]]",
    );
    assert_eq!(compile_authoring(&invalid), Err(ConfigError::UnknownPlugin));
}

#[test]
fn config_rejects_unknown_hook_reference() {
    let invalid = replace_once(
        VALID,
        "entry_hooks = [\"audit.entry\"]",
        "entry_hooks = [\"missing\"]",
    );
    assert_eq!(compile_authoring(&invalid), Err(ConfigError::UnknownHook));
}

#[test]
fn config_rejects_unknown_resource_reference() {
    let invalid = replace_once(
        VALID,
        "resource_id = \"v4.config.parsed\"",
        "resource_id = \"v4.config.missing\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::UnknownResource)
    );
}

#[test]
fn config_rejects_non_adjacent_edge() {
    let third = r#"
[[nodes]]
node_id = "V4Config03SchemaValidated"
operator_id = "config.validate"
plugin_id = "core.config"
entry_hooks = []
exit_hooks = []
resources_read = ["v4.config.schema_validated"]
resources_written = ["v4.config.schema_validated"]
"#;
    let invalid = replace_once(
        &format!("{VALID}{third}"),
        "to = \"V4Config02AuthoringParsed\"",
        "to = \"V4Config03SchemaValidated\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::NonAdjacentEdge)
    );
}

#[test]
fn config_rejects_control_resource_on_information_edge() {
    let invalid = replace_once(
        VALID,
        "resource_id = \"v4.config.parsed\"\naxis = \"information\"",
        "resource_id = \"v4.config.parsed\"\naxis = \"control\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::ResourceAxisMismatch)
    );
}

#[test]
fn config_rejects_secret_material() {
    let invalid = replace_once(
        VALID,
        "source = \"env:PROVIDER_A_TOKEN\"",
        "source = \"sk-live-secret-value\"",
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::SecretMaterialForbidden)
    );
}

#[test]
fn manifest_contains_secret_handle_not_secret_material() {
    let manifest = compile_authoring(VALID).unwrap();
    let canonical = manifest.to_canonical_string();
    assert!(canonical.contains("env:PROVIDER_A_TOKEN"));
    assert!(!canonical.contains("sk-live-secret-value"));
}

#[test]
fn config_rejects_payload_resource_binding() {
    let invalid = replace_once(
        VALID,
        "resources_written = [\"v4.config.parsed\"]",
        "resources_written = [\"v4.request.normal_payload\"]",
    );
    let invalid = format!(
        "{invalid}\n[[resources]]\nresource_id = \"v4.request.normal_payload\"\naxis = \"data\"\n"
    );
    assert_eq!(
        compile_authoring(&invalid),
        Err(ConfigError::PayloadBindingForbidden)
    );
}

#[test]
fn config_chain_stages_are_explicit() {
    let source = V4Config01AuthoringFileSource::new("fixture.toml", VALID);
    assert_eq!(source.base().identity().position(), 1);
    let parsed = parse_v4_config_02_from_v4_config_01(source).unwrap();
    assert_eq!(parsed.base().identity().position(), 2);
    let validated = validate_v4_config_03_from_v4_config_02(parsed).unwrap();
    assert_eq!(validated.base().identity().position(), 3);
    let registry = build_v4_config_04_from_v4_config_03(validated).unwrap();
    assert_eq!(registry.base().identity().position(), 4);
    let published = publish_v4_config_05_from_v4_config_04(registry).unwrap();
    assert_eq!(published.base().identity().position(), 5);
    assert_eq!(published.manifest().manifest_version(), 1);
}
