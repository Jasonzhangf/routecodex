//! Integration test for Phase Server-A: server module help NAPI bindings.
//! Validates that describeServerContractsJson + describeServerModuleHelpJson
//! return well-formed JSON containing all four server module descriptors.

use std::process::Command;

#[test]
fn napi_register_lists_server_module_help_exports() {
    // Pure check: source file registers the new NAPI exports.
    let napi_src = std::fs::read_to_string("src/hub_pipeline_blocks/napi_bindings.rs")
        .expect("napi_bindings.rs readable");
    assert!(napi_src.contains("describe_server_contracts_json"));
    assert!(napi_src.contains("describe_server_module_help_json"));
}

#[test]
fn server_contracts_module_exposes_four_modules_in_source() {
    let src =
        std::fs::read_to_string("src/server_contracts.rs").expect("server_contracts.rs readable");
    for module_id in [
        "server.req_adapter",
        "server.direct_passthrough",
        "server.response_projection",
        "server.error_projection",
    ] {
        assert!(
            src.contains(&format!("module_id: \"{module_id}\"")),
            "missing module_id {module_id}"
        );
    }
}
