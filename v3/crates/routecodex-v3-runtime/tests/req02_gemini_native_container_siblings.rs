use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_normalize_losslessly,
    project_canonical_direct_request, project_canonical_request, CanonicalFieldEdit,
    CurrentFieldAssociations, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, V3RequestContextHandle,
};
use routecodex_v3_runtime::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};

#[path = "support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

fn target() -> V3TargetCandidate {
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
        parse_v3_config_02_authoring(&source).expect("valid authoring"),
    )
    .expect("valid manifest");
    let router = V3VirtualRouter::default();
    let classified = router
        .classify_request(
            &manifest,
            "gemini_acceptance",
            "/v1beta/models/gemini-client/generateContent",
        )
        .expect("classify public entry");
    let plan = router
        .resolve_route_pool_plan(&manifest, classified)
        .expect("resolve route");
    let selected = router
        .hit_opaque_target_plan_once(plan, 0)
        .expect("select target");
    let interpreter = V3TargetInterpreter::default();
    interpreter
        .expand_candidates(&manifest, interpreter.classify_kind(selected), 0)
        .expect("expand target")
        .candidates
        .remove(0)
}

fn project(raw: &Value, edit: Option<CanonicalFieldEdit>, direct: bool) -> Value {
    let handle = V3RequestContextHandle::new("native-siblings".into(), "gemini".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "native-siblings-invocation".into(),
        "native-siblings-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw.clone()),
    )
    .expect("normalize public request");
    let pair = handle.original_pair().expect("published request pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let (canonical, current) = match edit {
        Some(edit) => apply_canonical_field_edit(&canonical, &current, &edit)
            .expect("apply public canonical edit"),
        None => (canonical, current),
    };
    if direct {
        project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .expect("project Direct request")
        .payload
    } else {
        project_canonical_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
            V3HubExecutionMode::Relay,
            V3HubProviderWireProtocol::Gemini,
            &target(),
            invocation.attempt_id(),
        )
        .expect("project Relay request")
        .payload
    }
}

fn six_containers(with_id: bool) -> Value {
    let mut call = json!({
        "name": "lookup_weather", "args": {"city": "Paris"}, "call_extra": "call-inner"
    });
    let mut result = json!({
        "name": "lookup_weather", "response": {"forecast": "sunny"},
        "result_extra": "result-inner"
    });
    if with_id {
        call["id"] = json!("call-weather");
        result["id"] = json!("call-weather");
    }
    json!({
        "contents": [
            {"role": "user", "message_extra": "content-row", "parts": [
                {"text": "lookup weather", "part_extra": "text-part"},
                {"inlineData": {"mimeType": "image/png", "data": "YWJj", "media_extra": "media-inner"},
                 "part_extra": "media-part"}
            ]},
            {"role": "model", "message_extra": "call-row", "parts": [
                {"functionCall": call, "part_extra": "call-part"}
            ]},
            {"role": "user", "message_extra": "result-row", "parts": [
                {"functionResponse": result, "part_extra": "result-part"}
            ]}
        ],
        "tools": [{"functionDeclarations": [{
            "name": "lookup_weather", "parameters": {"type": "object"},
            "declaration_extra": "declaration"
        }]}],
        "generationConfig": {"temperature": 0.2, "config_extra": "generation"},
        "stream": false
    })
}

#[test]
fn relay_six_native_containers_keep_all_siblings_with_and_without_id() {
    for with_id in [false, true] {
        let raw = six_containers(with_id);
        let output = project(&raw, None, false);
        for field in ["contents", "tools", "generationConfig"] {
            assert_eq!(output[field], raw[field], "complete {field}, id={with_id}");
        }
    }
}

#[test]
fn direct_six_native_containers_keep_all_siblings_with_and_without_id() {
    for with_id in [false, true] {
        let raw = six_containers(with_id);
        let output = project(&raw, None, true);
        for field in ["contents", "tools", "generationConfig"] {
            assert_eq!(output[field], raw[field], "complete {field}, id={with_id}");
        }
    }
}

fn two_messages() -> Value {
    json!({"contents": [
        {"role": "user", "message_extra": "first", "parts": [
            {"text": "first", "part_extra": "first-part"}
        ]},
        {"role": "user", "message_extra": "second", "parts": [
            {"text": "second", "part_extra": "second-part"}
        ]}
    ], "stream": false})
}

#[test]
fn moving_current_messages_moves_their_original_siblings() {
    let raw = two_messages();
    let output = project(
        &raw,
        Some(CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages".into(),
            from: 0,
            to: 1,
        }),
        false,
    );
    assert_eq!(
        output["contents"],
        json!([raw["contents"][1], raw["contents"][0]])
    );
}

#[test]
fn removing_current_message_keeps_survivor_and_does_not_restore_removed_row() {
    let raw = two_messages();
    let output = project(
        &raw,
        Some(CanonicalFieldEdit::Remove {
            path: "chat.messages[0]".into(),
        }),
        false,
    );
    assert_eq!(output["contents"], json!([raw["contents"][1]]));
}

#[test]
fn inserted_current_message_does_not_borrow_original_siblings() {
    let raw = two_messages();
    let output = project(
        &raw,
        Some(CanonicalFieldEdit::InsertArray {
            array_path: "chat.messages".into(),
            index: 1,
            value: json!({"role": "user", "content": [{"type": "text", "text": "inserted"}]}),
        }),
        false,
    );
    assert_eq!(
        output["contents"],
        json!([
            raw["contents"][0], {"role": "user", "parts": [{"text": "inserted"}]}, raw["contents"][1]
        ])
    );
}

#[test]
fn replacing_current_message_retains_same_address_sibling_origin() {
    let raw = two_messages();
    let output = project(
        &raw,
        Some(CanonicalFieldEdit::Replace {
            path: "chat.messages[0]".into(),
            value: json!({"role": "user", "content": [{"type": "text", "text": "replacement"}]}),
        }),
        false,
    );
    let mut expected = raw["contents"].clone();
    expected[0]["parts"][0]["text"] = json!("replacement");
    assert_eq!(output["contents"], expected);
}

#[test]
fn removing_role_leaf_preserves_message_and_part_siblings() {
    let raw = two_messages();
    let output = project(
        &raw,
        Some(CanonicalFieldEdit::Remove {
            path: "chat.messages[0].role".into(),
        }),
        false,
    );
    assert_eq!(output["contents"], raw["contents"]);
}

#[test]
fn system_instruction_prefix_keeps_native_message_origins_after_remap() {
    let mut raw = two_messages();
    raw["systemInstruction"] = json!({"parts": [{"text": "system instructions"}]});
    let output = project(&raw, None, false);
    assert_eq!(output["contents"], raw["contents"]);
    assert_eq!(output["systemInstruction"], raw["systemInstruction"]);
}

#[test]
fn generation_top_k_preserves_the_declared_native_field_in_both_modes() {
    let mut raw = two_messages();
    raw["generationConfig"] = json!({"temperature": 0.2, "topK": 20});
    for direct in [true, false] {
        let output = project(&raw, None, direct);
        assert_eq!(output["generationConfig"], raw["generationConfig"]);
    }
}
