use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_target::{V3ActiveKeyIdentity, V3TargetError, V3TargetInterpreter};

#[test]
fn control_universe_expands_only_the_pool_declared_model_interface_and_key() {
    let source = r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 12345
routing_group = "g"
[providers.p]
default_model = "m"
auth = { type = "api_key", entries = [{ alias = "a", env = "CONTROLLED_A" }, { alias = "b", env = "CONTROLLED_B" }] }
[providers.p.models.m]
capabilities = ["text"]
[providers.p.models.other]
capabilities = ["text"]
[providers.p.interfaces.responses]
type = "responses"
base_url = "http://controlled.invalid/v1"
[providers.p.interfaces.chat]
type = "openai_chat"
base_url = "http://controlled.invalid/chat/v1"
[route_groups.g.pools.default]
selection = { strategy = "active_queue" }
active_keys = { members = [{ provider = "p", alias = "a" }] }
targets = [{ kind = "provider_model", provider = "p", model = "m", interface = "chat", key = "a" }]
"#;
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(source).unwrap()).unwrap();
    let target = V3TargetInterpreter::default();
    let declarations = target.active_key_pool_declarations(&manifest, "g").unwrap();
    assert_eq!(
        declarations["default"].universe,
        vec![V3ActiveKeyIdentity {
            provider_id: "p".into(),
            interface_id: "chat".into(),
            model_id: "m".into(),
            auth_alias: "a".into(),
        }]
    );
    assert_eq!(
        target.active_key_pool_declarations(&manifest, "absent"),
        Err(V3TargetError::SelectedPoolMissing)
    );
}
