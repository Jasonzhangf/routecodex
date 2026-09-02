//! RED tests: superseded keyless variants must not remain in the standard
//! plugin catalog or the production plan compiler.
//!
//! `wire_codec_proto` duplicates `wire_build` in the same provider wire codec
//! selection group, and the four provider `*_mock` plugins duplicate the real
//! production bindings (`v4.hook.relay.request` at the provider-semantic node,
//! `transport_validate` at the transport node). Keeping them registered while
//! excluding them from production would turn `EXCLUDED_PLUGINS` into the
//! "green" mechanism, so this file requires physical removal instead.

use routecodex_v4_standard_plugins::{
    compile_production_execution_plans, standard_plugins,
};
use routecodex_v4_skeleton::SkeletonPlan;
use std::fs;

const SUPERSEDED_PLUGINS: &[&str] = &[
    "v4.std.protocol.wire_codec_proto",
    "v4.std.provider.capability_mock",
    "v4.std.provider.auth_handle_mock",
    "v4.std.provider.wire_mock",
    "v4.std.provider.transport_mock",
];

fn production_skeleton() -> SkeletonPlan {
    let path = format!(
        "{}/../../contracts/skeleton-plan.contract.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = fs::read_to_string(&path).expect("production contract readable");
    SkeletonPlan::from_contract_json(&text).expect("production skeleton compiles")
}

#[test]
fn superseded_plugins_are_absent_from_catalog() {
    let plugins = standard_plugins();
    let declared: Vec<&str> = plugins
        .iter()
        .map(|plugin| plugin.plugin_id.as_str())
        .collect();
    let present: Vec<&str> = SUPERSEDED_PLUGINS
        .iter()
        .copied()
        .filter(|id| declared.contains(id))
        .collect();
    assert!(
        present.is_empty(),
        "superseded plugins must be physically removed from the catalog: {present:?}"
    );
}

#[test]
fn production_compiler_has_no_exclusion_filter() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/lib.rs"
    ))
    .expect("standard plugins source readable");
    assert!(
        !source.contains("EXCLUDED_PLUGINS"),
        "production compiler must not carry an exclusion list"
    );
    let compiled = compile_production_execution_plans(&production_skeleton())
        .expect("production plans compile");
    let bound: Vec<&str> = compiled
        .plans
        .iter()
        .flat_map(|plan| plan.entries.iter().map(|entry| entry.plugin_id.as_str()))
        .collect();
    let leaked: Vec<&str> = SUPERSEDED_PLUGINS
        .iter()
        .copied()
        .filter(|id| bound.contains(id))
        .collect();
    assert!(
        leaked.is_empty(),
        "superseded plugins must not appear in compiled production plans: {leaked:?}"
    );
}
