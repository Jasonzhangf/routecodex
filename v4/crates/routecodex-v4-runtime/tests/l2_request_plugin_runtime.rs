use routecodex_v4_runtime::RequestPluginRuntime;
use serde_json::json;

fn runtime() -> RequestPluginRuntime {
    RequestPluginRuntime::new(json!({
        "candidates": [
            {
                "provider_id": "real_responses",
                "config_path": "/tmp/provider.toml",
                "protocol": "responses",
                "model": "upstream-direct",
                "priority": 10,
                "entry_models": ["entry-direct"],
                "execution_mode": "direct"
            },
            {
                "provider_id": "real_responses",
                "config_path": "/tmp/provider.toml",
                "protocol": "responses",
                "model": "upstream-relay",
                "priority": 20,
                "entry_models": ["entry-relay"],
                "execution_mode": "relay"
            }
        ]
    }))
    .expect("request plugin runtime compiles")
}

#[test]
fn direct_runs_node_01_07_and_replaces_entry_model() {
    let output = runtime()
        .execute_responses(br#"{"model":"entry-direct","input":"hello","stream":false}"#)
        .expect("direct request executes");
    assert_eq!(output.target.execution_mode, "direct");
    assert_eq!(output.provider_wire["model"], "upstream-direct");
    assert_eq!(output.executed_nodes.len(), 9);
    assert_eq!(output.executed_nodes[0], "V4ServerReqInbound01ClientRaw");
    assert_eq!(output.executed_nodes[8], "V4ProviderSseOut07WireBoundary");
}

#[test]
fn relay_uses_registered_adjacent_responses_compat() {
    let output = runtime()
        .execute_responses(
            b"data: {\"model\":\"entry-relay\",\"input\":\"hello\",\"stream\":true}\n\n",
        )
        .expect("relay request executes");
    assert_eq!(output.target.execution_mode, "relay");
    assert_eq!(output.provider_wire["model"], "upstream-relay");
    assert!(output.stream);
}

#[test]
fn unknown_entry_model_and_control_leak_fail_fast() {
    let unknown = runtime()
        .execute_responses(br#"{"model":"unknown","input":"hello"}"#)
        .expect_err("unknown entry model must fail in VR");
    assert!(unknown
        .to_string()
        .contains("no compiled provider candidate"));

    let leak = runtime()
        .execute_responses(
            br#"{"model":"entry-direct","input":"hello","route_facts":{"bad":true}}"#,
        )
        .expect_err("control-shaped field must fail at provider wire boundary");
    assert!(leak.to_string().contains("control field route_facts"));
}
