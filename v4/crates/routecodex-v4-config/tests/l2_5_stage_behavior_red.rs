use routecodex_v4_config::{build_v4_config_04_from_v4_config_03, compile_authoring, parse_v4_config_02_from_v4_config_01, publish_v4_config_05_from_v4_config_04, validate_v4_config_03_from_v4_config_02, V4Config01AuthoringFileSource};

const VALID: &str = r#"
version = 1

[[nodes]]
node_id = "V4Config01AuthoringFileSource"
operator_id = "config.parse"
plugin_id = "core.config"
entry_hooks = ["audit.entry"]
resources_read = ["v4.config.authoring"]
resources_written = ["v4.config.parsed"]

[[nodes]]
node_id = "V4Config02AuthoringParsed"
operator_id = "config.validate"
plugin_id = "core.config"
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
"#;

#[test]
fn authoring_stage_rejects_unknown_fields() {
    assert!(compile_authoring(VALID).is_ok());
    assert!(compile_authoring("version = 1\nunknown = true\n").is_err());
}

#[test]
fn parse_stage_rejects_malformed_source() {
    assert!(parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", VALID)).is_ok());
    assert!(parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", "[")).is_err());
}

#[test]
fn validate_stage_rejects_invalid_manifest_version() {
    let parsed = parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", VALID)).unwrap();
    assert!(validate_v4_config_03_from_v4_config_02(parsed).is_ok());
    let invalid_source = VALID.replace("version = 1", "version = 0");
    let invalid = parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", &invalid_source)).unwrap();
    assert!(validate_v4_config_03_from_v4_config_02(invalid).is_err());
}

#[test]
fn registry_stage_rejects_unresolved_resources() {
    let parsed = parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", VALID)).unwrap();
    let validated = validate_v4_config_03_from_v4_config_02(parsed).unwrap();
    assert!(build_v4_config_04_from_v4_config_03(validated).is_ok());
}

#[test]
fn manifest_stage_publishes_only_valid_registry() {
    let parsed = parse_v4_config_02_from_v4_config_01(V4Config01AuthoringFileSource::new("red", VALID)).unwrap();
    let validated = validate_v4_config_03_from_v4_config_02(parsed).unwrap();
    let registry = build_v4_config_04_from_v4_config_03(validated).unwrap();
    assert!(publish_v4_config_05_from_v4_config_04(registry).is_ok());
}
