use routecodex_v3_config::{V3Config05ManifestPublished, V3ConfigStore, V3UserConfigStore};
use routecodex_v3_debug::{V3DebugRuntime, V3DebugRuntimeConfig, V3DryRunFixture};
use routecodex_v3_runtime::execute_v3_responses_direct_dry_run_runtime;
use serde_json::{json, Value};

#[tokio::test]
async fn explicit_user_config_builds_representative_provider_requests_without_network() {
    let (Ok(old_path), Ok(new_path)) = (
        std::env::var("ROUTECODEX_TEST_OLD_CONFIG_PATH"),
        std::env::var("ROUTECODEX_TEST_USER_CONFIG_PATH"),
    ) else {
        return;
    };
    let old_manifest = V3ConfigStore::new(old_path).load_snapshot().unwrap();
    let new_manifest = V3UserConfigStore::new(new_path).load_manifest().unwrap();

    for (fixture_id, server_id, payload) in [
        (
            "user-config-4444-default",
            "routecodex_v3_4444",
            json!({"model":"gpt-5.5","input":"plain conversation"}),
        ),
        (
            "user-config-4444-multimodal",
            "routecodex_v3_4444",
            json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":[
                    {"type":"input_text","text":"describe"},
                    {"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}
                ]}]
            }),
        ),
        (
            "user-config-4444-web-search",
            "routecodex_v3_4444",
            json!({
                "model":"gpt-5.5",
                "input":"search current facts",
                "tools":[{"type":"web_search_preview"}]
            }),
        ),
        (
            "user-config-7777-default",
            "responses_v3_7777",
            json!({"model":"gpt-5.5","input":"plain conversation"}),
        ),
    ] {
        let old = run_dry_run(&old_manifest, fixture_id, server_id, payload.clone()).await;
        let new = run_dry_run(&new_manifest, fixture_id, server_id, payload).await;
        assert_eq!(
            provider_request(&old),
            provider_request(&new),
            "{fixture_id} old/new provider request differential"
        );
    }
}

async fn run_dry_run(
    manifest: &V3Config05ManifestPublished,
    fixture_id: &str,
    server_id: &str,
    payload: Value,
) -> Value {
    let debug = V3DebugRuntime::new(V3DebugRuntimeConfig {
        snapshots_enabled: true,
        dry_run_enabled: true,
        ..V3DebugRuntimeConfig::default()
    })
    .unwrap();
    let output = execute_v3_responses_direct_dry_run_runtime(
        V3DryRunFixture {
            fixture_id: fixture_id.to_string(),
            server_id: server_id.to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            request_payload: payload,
            response_payload: json!({
                "id": format!("resp_{fixture_id}"),
                "object":"response",
                "status":"completed",
                "output":[]
            }),
        },
        manifest,
        &debug,
    )
    .await;
    assert_eq!(output.status, 200, "{fixture_id}: {}", output.body);
    assert_eq!(
        output.body["dry_run"]["provider_network_send"], false,
        "{fixture_id} must remain no-network"
    );
    output.body
}

fn provider_request(body: &Value) -> Value {
    let request = &body["dry_run"]["provider_request"];
    assert!(request.is_object(), "captured provider request: {body}");
    request.clone()
}
