use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    project_canonical_request, CurrentFieldAssociations, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
};
use routecodex_v3_runtime::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_target::V3TargetInterpreter;
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};

#[path = "support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

fn target() -> routecodex_v3_target::V3TargetCandidate {
    let source = format!(
        r#"version = 3
{}
[servers.gemini_acceptance]
bind = "127.0.0.1"
port = 1
routing_group = "gemini_acceptance"
endpoints = ["gemini"]
{}
[providers.gemini_acceptance]
type = "gemini"
base_url = "http://gemini-acceptance.invalid/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_GEMINI_ACCEPTANCE_KEY" }}] }}
[providers.gemini_acceptance.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.gemini_acceptance.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "gemini_acceptance", model = "gemini-wire", key = "key", priority = 1 }}]
"#,
        hub_v1_fixture::hub_v1_test_declaration(),
        hub_v1_fixture::hub_v1_server_execution("gemini_acceptance"),
    );
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("valid acceptance authoring"),
    )
    .expect("valid acceptance manifest");
    let router = V3VirtualRouter::default();
    let classification = router
        .classify_request(
            &manifest,
            "gemini_acceptance",
            "/v1beta/models/gemini-client/generateContent",
        )
        .expect("classify real public entry");
    let plan = router
        .resolve_route_pool_plan(&manifest, classification)
        .expect("resolve real route");
    let selected = router
        .hit_opaque_target_plan_once(plan, 0)
        .expect("select configured opaque target");
    let interpreter = V3TargetInterpreter::default();
    interpreter
        .expand_candidates(&manifest, interpreter.classify_kind(selected), 0)
        .expect("expand configured target")
        .candidates
        .remove(0)
}

fn request(with_id: bool) -> Value {
    let mut call = json!({"name":"lookup_weather","args":{"city":"Paris"}});
    let mut result = json!({"name":"lookup_weather","response":{"forecast":"sunny"}});
    if with_id {
        call["id"] = json!("call-weather");
        result["id"] = json!("call-weather");
    }
    json!({
        "contents":[
            {"role":"user","parts":[{"text":"lookup weather"}]},
            {"role":"model","parts":[{"functionCall":call}]},
            {"role":"user","parts":[{"functionResponse":result}]}
        ],
        "tools":[{"functionDeclarations":[{"name":"lookup_weather","parameters":{"type":"object"}}]}],
        "generationConfig":{"temperature":0.2},
        "stream":false
    })
}

fn assert_request_roundtrip(with_id: bool, direct: bool) {
    let raw = request(with_id);
    let handle = V3RequestContextHandle::new(
        format!("gemini-public-{with_id}-{direct}"),
        "gemini".to_owned(),
    );
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("gemini-invocation-{with_id}-{direct}"),
        format!("gemini-attempt-{with_id}-{direct}"),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw.clone()),
    )
    .expect("lossless normalization must preserve valid Gemini tool history");
    let pair = handle.original_pair().expect("original pair published once");
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let projected = if direct {
        project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &associations,
            &pair.explicit_history_pairing,
        )
        .expect("registered Direct inverse must preserve the same request")
        .payload
    } else {
        project_canonical_request(
            &canonical,
            &pair.inverse_context,
            &associations,
            &pair.explicit_history_pairing,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Gemini,
            &target(),
            invocation.attempt_id(),
        )
        .expect("standard Gemini projection must accept a result with optional ID")
        .payload
    };
    assert_eq!(projected["contents"], raw["contents"], "complete history and element boundaries");
    assert_eq!(projected["tools"], raw["tools"], "actual tool declarations");
    assert_eq!(projected["generationConfig"], raw["generationConfig"], "request generation semantics");
    if !with_id {
        assert!(projected["contents"][1]["parts"][0]["functionCall"].get("id").is_none());
        assert!(projected["contents"][2]["parts"][0]["functionResponse"].get("id").is_none());
    }
}

#[test]
fn gemini_public_relay_preserves_named_result_without_optional_id() {
    assert_request_roundtrip(false, false);
}

#[test]
fn gemini_public_relay_preserves_paired_id_and_parent_boundaries() {
    assert_request_roundtrip(true, false);
}

#[test]
fn gemini_public_direct_preserves_named_result_without_optional_id() {
    assert_request_roundtrip(false, true);
}

#[test]
fn gemini_public_direct_preserves_paired_id_and_parent_boundaries() {
    assert_request_roundtrip(true, true);
}
