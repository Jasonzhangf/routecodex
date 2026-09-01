#![cfg(feature = "red-fixtures")]

use routecodex_v4_runtime::{ImmutableDataCarrier, ImmutableDiagnosticCarrier, ImmutableInformationCarrier, NodeServiceRegistry};

#[test]
fn adjacent_nodes_share_immutable_carriers_and_reject_stale_services() {
    let data = ImmutableDataCarrier::from_bytes(b"request");
    let information = ImmutableInformationCarrier::new("responses", "model");
    let diagnostic = ImmutableDiagnosticCarrier::new("request-a");
    assert!(data.shares_storage_with(&data.clone()));
    let mut services = NodeServiceRegistry::new("node-a", "scope-a", "plan-a", 1);
    services.bind_data(data).unwrap();
    services.bind_information(information).unwrap();
    services.bind_diagnostic(diagnostic).unwrap();
    services.dispose().unwrap();
    assert!(services.execute().is_err());
}
