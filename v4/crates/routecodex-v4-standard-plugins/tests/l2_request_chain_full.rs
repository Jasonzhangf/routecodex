use std::collections::BTreeSet;

use routecodex_v4_standard_plugins::standard_plugins;

#[test]
fn request_chain_ships_node_01_07_and_vr_small_plugins_without_mocks() {
    let ids = standard_plugins()
        .into_iter()
        .map(|plugin| plugin.plugin_id)
        .collect::<BTreeSet<_>>();
    let required = [
        "v4.std.protocol.server_input",
        "v4.std.protocol.sse_in",
        "v4.std.protocol.responses_inbound",
        "v4.std.chat_process.scope_restore",
        "v4.std.chat_process.continuation_restore",
        "v4.std.chat_process.tool_governance",
        "v4.std.routing.entry_model_admission",
        "v4.std.routing.candidate_filter",
        "v4.std.routing.target_selection",
        "v4.std.routing.model_replacement",
        "v4.std.provider.compat",
        "v4.std.provider.wire_boundary",
    ];
    for id in required {
        assert!(ids.contains(id), "missing request-chain plugin {id}");
    }
    assert!(
        ids.iter().all(|id| !id.contains("mock")),
        "active standard plugin ids must not contain mock"
    );
}
