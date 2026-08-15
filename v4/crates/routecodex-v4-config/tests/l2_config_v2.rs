use routecodex_v4_config::v2::{
    build_v2_registry, compile_v2, parse_v2_authoring, publish_v2_manifest, validate_v2_authoring,
    ConfigV2Error,
};

const VALID_V2: &str = r#"
version = 2

[[roles]]
role_id = "request.inbound"
chain = "request"
allowed_capabilities = ["parse", "normalize"]

[[roles]]
role_id = "request.govern"
chain = "request"
allowed_capabilities = ["govern"]

[[roles]]
role_id = "request.outbound"
chain = "request"
allowed_capabilities = ["encode"]

[[nodes]]
node_id = "V4ReqInbound01Raw"
chain = "request"
position = 1
role_id = "request.inbound"
terminal = false
kernel = false
selection_group = "inbound.variant"
plugin_bindings = [{ plugin_id = "core.parse", effect = "normalize", phase = "req_inbound" }]
capabilities = ["parse", "normalize"]
resource_permissions = [
    { resource_id = "v4.request.raw", read = true, write = false },
]
checkpoints = [
    { node_id = "V4ReqInbound01Raw", semantic = "raw_preserved", owner = "routecodex-v4-config" },
]

[[nodes]]
node_id = "V4ReqGovern02Normalized"
chain = "request"
position = 2
role_id = "request.govern"
terminal = false
kernel = false
selection_group = "govern.variant"
plugin_bindings = [{ plugin_id = "core.govern", effect = "govern", phase = "req_chatprocess" }]
capabilities = ["govern"]
resource_permissions = [
    { resource_id = "v4.request.normalized", read = true, write = true },
]
checkpoints = [
    { node_id = "V4ReqGovern02Normalized", semantic = "governed", owner = "routecodex-v4-runtime" },
]

[[nodes]]
node_id = "V4ReqOutbound03Wire"
chain = "request"
position = 3
role_id = "request.outbound"
terminal = true
kernel = true
selection_group = "outbound.variant"
plugin_bindings = [{ plugin_id = "core.encode", effect = "encode", phase = "req_outbound" }]
capabilities = ["encode"]
resource_permissions = [
    { resource_id = "v4.request.wire", read = false, write = true },
]
checkpoints = [
    { node_id = "V4ReqOutbound03Wire", semantic = "wire_ready", owner = "routecodex-v4-runtime" },
]

[[edges]]
from = "V4ReqInbound01Raw"
to = "V4ReqGovern02Normalized"
direction = "forward"
resource_id = "v4.request.normalized"

[[edges]]
from = "V4ReqGovern02Normalized"
to = "V4ReqOutbound03Wire"
direction = "forward"
resource_id = "v4.request.wire"

[[selection_groups]]
group_id = "inbound.variant"
variants = ["default", "strict"]
active = ["default"]

[[selection_groups]]
group_id = "govern.variant"
variants = ["default"]
active = ["default"]

[[selection_groups]]
group_id = "outbound.variant"
variants = ["default"]
active = ["default"]
"#;

fn replace_once(source: &str, from: &str, to: &str) -> String {
    source.replacen(from, to, 1)
}

#[test]
fn v2_compile_positive_manifest_verify_and_registry() {
    let manifest = compile_v2(VALID_V2).expect("valid v2 authoring must compile");
    assert_eq!(manifest.manifest_version(), 2);
    assert_eq!(manifest.nodes().len(), 3);
    assert_eq!(manifest.edges().len(), 2);
    assert_eq!(manifest.checkpoints().len(), 3);
    assert!(manifest.plan_hash().starts_with("sha256:"));
    assert!(manifest.checkpoint_hash().starts_with("sha256:"));
    assert!(manifest.artifact_hash().starts_with("sha256:"));
    manifest.verify().expect("untampered manifest must verify");

    let authoring = parse_v2_authoring(VALID_V2).unwrap();
    let validated = validate_v2_authoring(authoring).unwrap();
    let registry = build_v2_registry(validated).unwrap();
    assert!(registry.can_read("V4ReqInbound01Raw", "v4.request.raw"));
    assert!(!registry.can_write("V4ReqInbound01Raw", "v4.request.raw"));
    assert!(registry.can_read("V4ReqGovern02Normalized", "v4.request.normalized"));
    assert!(registry.can_write("V4ReqGovern02Normalized", "v4.request.normalized"));
    assert!(!registry.can_read("V4ReqOutbound03Wire", "v4.request.raw"));
    assert!(registry.can_write("V4ReqOutbound03Wire", "v4.request.wire"));
}

#[test]
fn v2_compile_is_deterministic() {
    let reordered = replace_once(
        VALID_V2,
        "[[nodes]]\nnode_id = \"V4ReqGovern02Normalized\"",
        "[[nodes]]\nnode_id = \"V4ReqGovern02Normalized\"",
    );
    let first = compile_v2(VALID_V2).unwrap();
    let second = compile_v2(&reordered).unwrap();
    assert_eq!(first.plan_hash(), second.plan_hash());
    assert_eq!(first.artifact_hash(), second.artifact_hash());
}

#[test]
fn v2_rejects_version_not_supported() {
    let invalid = replace_once(VALID_V2, "version = 2", "version = 1");
    assert!(matches!(
        compile_v2(&invalid),
        Err(ConfigV2Error::VersionNotSupported(1))
    ));
}

#[test]
fn v2_rejects_selection_group_with_multiple_active_variants() {
    let invalid = replace_once(
        VALID_V2,
        "variants = [\"default\", \"strict\"]\nactive = [\"default\"]",
        "variants = [\"default\", \"strict\"]\nactive = [\"default\", \"strict\"]",
    );
    assert!(matches!(
        compile_v2(&invalid),
        Err(ConfigV2Error::SelectionGroupMultipleActive(_))
    ));
}

#[test]
fn v2_rejects_non_adjacent_edge() {
    let invalid = replace_once(
        VALID_V2,
        "from = \"V4ReqInbound01Raw\"\nto = \"V4ReqGovern02Normalized\"",
        "from = \"V4ReqInbound01Raw\"\nto = \"V4ReqOutbound03Wire\"",
    );
    assert!(matches!(
        compile_v2(&invalid),
        Err(ConfigV2Error::EdgeNonAdjacent(_, _))
    ));
}

#[test]
fn v2_rejects_checkpoint_without_owner() {
    let invalid = replace_once(
        VALID_V2,
        "semantic = \"raw_preserved\", owner = \"routecodex-v4-config\"",
        "semantic = \"raw_preserved\", owner = \"\"",
    );
    assert!(matches!(
        compile_v2(&invalid),
        Err(ConfigV2Error::CheckpointMissingOwner(_))
    ));
}

#[test]
fn v2_rejects_capability_outside_role_allowlist() {
    let invalid = replace_once(
        VALID_V2,
        "capabilities = [\"parse\", \"normalize\"]",
        "capabilities = [\"parse\", \"govern\"]",
    );
    assert!(matches!(
        compile_v2(&invalid),
        Err(ConfigV2Error::UnknownCapability(_, _))
    ));
}

#[test]
fn v2_rejects_tampered_plan_hash() {
    let manifest = compile_v2(VALID_V2).unwrap();
    let tampered_plan = "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    assert!(matches!(
        manifest.verify_against(
            tampered_plan,
            manifest.checkpoint_hash(),
            manifest.artifact_hash()
        ),
        Err(ConfigV2Error::HashMismatch(_, _, _))
    ));
    manifest.verify().expect("stored hashes still verify");
}

#[test]
fn v2_staged_chain_positive_regression() {
    let authoring = parse_v2_authoring(VALID_V2).expect("parse must succeed");
    let validated = validate_v2_authoring(authoring).expect("validate must succeed");
    assert_eq!(validated.authoring().nodes.len(), 3);
    let registry = build_v2_registry(validated).expect("registry must build");
    let manifest = publish_v2_manifest(registry).expect("publish must succeed");
    manifest.verify().expect("published manifest must verify");
    assert_eq!(manifest.chain_version(), "v4-config-2");
}
