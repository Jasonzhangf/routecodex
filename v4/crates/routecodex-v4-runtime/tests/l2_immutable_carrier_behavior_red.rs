#![cfg(feature = "red-fixtures")]
use routecodex_v4_runtime::{
    ImmutableDataCarrier, ImmutableDiagnosticCarrier, ImmutableInformationCarrier,
    NodeServiceRegistry,
};

#[test]
fn node_scoped_carriers_share_storage_and_release_stale_services() {
    let data = ImmutableDataCarrier::from_bytes(b"request");
    let information = ImmutableInformationCarrier::new("responses", "model");
    let diagnostics = ImmutableDiagnosticCarrier::new("scope-a");
    assert!(data.shares_storage_with(&data.clone()));
    let mut registry = NodeServiceRegistry::new("node-a", "scope-a", "plan-a", 1);
    registry.bind_data(data).unwrap();
    registry.bind_information(information).unwrap();
    registry.bind_diagnostic(diagnostics).unwrap();
    registry.dispose().unwrap();
    assert!(registry.execute().is_err());
}
