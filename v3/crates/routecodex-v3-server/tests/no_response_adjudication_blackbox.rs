//! Public HTTP response regression. Run:
//! CARGO_NET_OFFLINE=true cargo test --locked --manifest-path v3/Cargo.toml
//! -p routecodex-v3-server --test no_response_adjudication_blackbox -- --nocapture
//!
//! Native error fixtures are representative protocol fixtures, NOT the QSA
//! sample: its retained body=[] does not identify its original native event.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());
const KEY_ENV: &str = "V3_NO_RESPONSE_TEST_KEY";

struct ProviderState {
    kind: String,
    health_enabled: bool,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    captures: mpsc::UnboundedSender<Value>,
}

#[tokio::test]
async fn tool_search_identity_and_opaque_parameters_survive_actual_client_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["function", "tool_search", "custom"] {
        let values = if kind == "custom" {
            vec![None, Some(json!({"input":" exact custom input "}))]
        } else {
            vec![
                None,
                Some(json!({"queries":["lookup"]})),
                Some(json!([])),
                Some(Value::Null),
                Some(json!(true)),
                Some(json!(7)),
                Some(json!(1.25)),
                Some(json!(" {broken ")),
                Some(json!("")),
                Some(json!("[1]")),
                Some(json!("{\"queries\":[\"lookup\"]}")),
            ]
        };
        for raw_arguments in values {
            for origin in 0..4 {
                let mut call =
                    json!({"id":"call_search","type":"function","function":{"name":"tool_search"}});
                if let Some(arguments) = &raw_arguments {
                    call["function"]["arguments"] = arguments.clone();
                }
                let initial = json!({"id":"chat-search","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]});
                let (media, wire) = if origin < 2 {
                    ("application/json", initial.to_string())
                } else if origin == 2 {
                    (
                        "text/event-stream",
                        format!(
                            "data: {}\n\ndata: [DONE]\n\n",
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]})
                        ),
                    )
                } else {
                    (
                        "text/event-stream",
                        format!(
                            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":null}]}),
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                        ),
                    )
                };
                let tools = if kind == "function" {
                    json!([{"type":"function","name":"tool_search","parameters":{"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}}}}])
                } else if kind == "custom" {
                    json!([{"type":"custom","name":"tool_search","format":{"type":"text"}}])
                } else {
                    json!([{"type":"tool_search","execution":"client","parameters":{"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}}}}])
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, wire).await;
                let (media, body) = successful_transfer(client().post(endpoint).json(&json!({"model":"test.test","input":"validate tool_search arguments","stream":origin != 0,"tools":tools})).send().await).await;
                let returned = if media.starts_with("application/json") {
                    serde_json::from_str::<Value>(&body).unwrap()["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| item["call_id"] == "call_search")
                        .unwrap()
                        .clone()
                } else {
                    events(&body)
                        .into_iter()
                        .find_map(|event| {
                            (event["type"] == "response.output_item.done"
                                && event["item"]["call_id"] == "call_search")
                                .then(|| event["item"].clone())
                        })
                        .unwrap()
                };
                assert_eq!(
                    returned["type"],
                    if kind == "tool_search" {
                        "tool_search_call"
                    } else if kind == "custom" {
                        "custom_tool_call"
                    } else {
                        "function_call"
                    },
                    "kind={kind} args={raw_arguments:?} origin={origin}: {returned}"
                );
                let expected_hosted = raw_arguments.as_ref().map(|value| match value {
                    Value::String(text) => serde_json::from_str::<Value>(text)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| value.clone()),
                    _ => value.clone(),
                });
                if kind == "tool_search" {
                    assert_eq!(
                        returned.get("arguments"),
                        expected_hosted.as_ref(),
                        "{returned}"
                    );
                } else if kind == "function" {
                    let text = raw_arguments.as_ref().map(|value| match value {
                        Value::String(text) => text.clone(),
                        value => value.to_string(),
                    });
                    assert_eq!(
                        returned.get("arguments").and_then(Value::as_str),
                        text.as_deref()
                    );
                } else {
                    assert_eq!(
                        returned.get("input"),
                        raw_arguments.as_ref().map(|value| &value["input"])
                    );
                }
                let execution = std::process::Command::new("node").args(["-e", "const c=JSON.parse(process.argv[1]);let p;try{p=c.type==='custom_tool_call'?c.input:c.type==='tool_search_call'?c.arguments:JSON.parse(c.arguments);if(c.type==='custom_tool_call'?typeof p!=='string':!p||typeof p!=='object'||Array.isArray(p)||!Array.isArray(p.queries))throw Error('invalid parameters');process.stdout.write(JSON.stringify({received:p}));}catch(e){process.stdout.write(JSON.stringify({error:e.message,call_id:c.call_id}));}", &returned.to_string()]).output().unwrap();
                assert!(execution.status.success());
                let output = String::from_utf8(execution.stdout).unwrap();
                assert!(serde_json::from_str::<Value>(&output).unwrap().is_object());
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let result_kind = if kind == "custom" {
                    "custom_tool_call_output"
                } else {
                    "function_call_output"
                };
                for next in ["openai_chat", "responses"] {
                    let completion = if next == "openai_chat" {
                        json!({"id":"chat-search-done","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"search roundtrip complete"},"finish_reason":"stop"}]})
                    } else {
                        text_response("search roundtrip complete")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next,
                        "chat",
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let (_, body) = successful_transfer(client().post(endpoint).json(&json!({"model":"test.test","tools":tools,"stream":origin != 0,"input":[{"role":"user","content":"validate tool_search arguments"},returned,{"type":result_kind,"call_id":"call_search","output":output}]})).send().await).await;
                    assert!(!body.is_empty());
                    stop_entry(handle, shutdown).await;
                    let wire = captures.recv().await.unwrap();
                    if next == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items
                            .iter()
                            .find(|item| {
                                item["call_id"] == "call_search" && item["type"] == returned["type"]
                            })
                            .unwrap_or_else(|| panic!("{wire}"));
                        for field in ["name", "arguments", "input"] {
                            assert_eq!(
                                sent.get(field),
                                returned.get(field),
                                "kind={kind} args={raw_arguments:?}: {wire}"
                            );
                        }
                        let result = items
                            .iter()
                            .find(|item| {
                                item["type"] == result_kind && item["call_id"] == "call_search"
                            })
                            .unwrap();
                        assert_eq!(result["output"], output);
                    } else {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|message| message["tool_calls"].as_array())
                            .unwrap()
                            .first()
                            .unwrap();
                        assert_eq!(sent["id"], "call_search");
                        assert_eq!(sent["function"]["name"], "tool_search");
                        let expected = if kind == "custom" {
                            raw_arguments.clone()
                        } else {
                            raw_arguments.as_ref().map(|value| match value {
                                Value::String(text) if kind == "tool_search" => {
                                    serde_json::from_str::<Value>(text)
                                        .ok()
                                        .filter(Value::is_object)
                                        .unwrap_or_else(|| value.clone())
                                }
                                _ => value.clone(),
                            })
                        };
                        match expected {
                            None => assert!(sent["function"].get("arguments").is_none(), "{wire}"),
                            Some(Value::String(text)) => {
                                assert_eq!(sent["function"]["arguments"], text, "{wire}")
                            }
                            Some(value) => assert_eq!(
                                serde_json::from_str::<Value>(
                                    sent["function"]["arguments"].as_str().unwrap()
                                )
                                .unwrap(),
                                value,
                                "{wire}"
                            ),
                        };
                        let result = messages
                            .iter()
                            .find(|message| message["role"] == "tool")
                            .unwrap();
                        assert_eq!(result["tool_call_id"], "call_search");
                        assert_eq!(result["content"], output);
                    }
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_reused_id_retains_each_actual_call_and_matching_result_kind() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for stream in [false, true] {
        let mut history = vec![json!({"role":"user","content":"execute both calls"})];
        let mut expected = Vec::new();
        for custom in [false, true] {
            let original = if custom {
                json!({"type":"custom_tool_call","id":"ctc_reused","call_id":"call_reused","name":"lookup","input":{"retain":[1,2]}})
            } else {
                json!({"type":"function_call","id":"fc_reused","call_id":"call_reused","name":"lookup","arguments":"{\"value\":3}"})
            };
            let mut response = text_response("call");
            response["output"] = json!([original]);
            let upstream = if stream {
                response_sse(&response)
            } else {
                response.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                "chat",
                StatusCode::OK,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let (_, body) = successful_transfer(
                client()
                    .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                    .json(&json!({"model":"test.test","stream":stream,"messages":[history[0]]}))
                    .send()
                    .await,
            )
            .await;
            let call = if stream {
                events(&body)
                    .into_iter()
                    .find_map(|event| {
                        event["choices"][0]["delta"]["tool_calls"]
                            .as_array()
                            .and_then(|calls| calls.first())
                            .cloned()
                    })
                    .unwrap()
            } else {
                serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]["tool_calls"]
                    [0]
                .clone()
            };
            assert_eq!(call["id"], "call_reused");
            assert_eq!(call["function"]["name"], "lookup");
            let arguments = call["function"]["arguments"].as_str().unwrap();
            let execution = std::process::Command::new("node")
                .args([
                    "-e",
                    "process.stdout.write(JSON.stringify({received:JSON.parse(process.argv[1])}));",
                    arguments,
                ])
                .output()
                .unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":if custom { json!({"input":{"retain":[1,2]}}) } else { json!({"value":3}) }})
            );
            history.push(json!({"role":"assistant","tool_calls":[call]}));
            history.push(json!({"role":"tool","tool_call_id":"call_reused","content":output}));
            expected.push((original, output));
            stop_entry(handle, shutdown).await;
            let _wire = captures.recv().await.unwrap();
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
        }
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "application/json",
            text_response("reused complete").to_string(),
        )
        .await;
        let (_, body) = successful_transfer(
            client()
                .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                .json(&json!({"model":"test.test","stream":stream,"messages":history}))
                .send()
                .await,
        )
        .await;
        assert!(!body.is_empty());
        stop_entry(handle, shutdown).await;
        let wire = captures.recv().await.unwrap();
        let calls: Vec<_> = wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                )
            })
            .collect();
        let results: Vec<_> = wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
            .collect();
        assert_eq!(calls.len(), 2, "{wire}");
        assert_eq!(results.len(), 2, "{wire}");
        for (index, (original, output)) in expected.iter().enumerate() {
            assert_eq!(calls[index]["type"], original["type"], "{wire}");
            assert_eq!(calls[index]["call_id"], "call_reused");
            assert_eq!(calls[index]["name"], "lookup");
            if index == 0 {
                assert_eq!(calls[index]["arguments"], original["arguments"]);
            } else {
                assert_eq!(calls[index]["input"], original["input"]);
            }
            assert_eq!(
                results[index]["type"],
                if index == 0 {
                    "function_call_output"
                } else {
                    "custom_tool_call_output"
                },
                "{wire}"
            );
            assert_eq!(results[index]["call_id"], "call_reused");
            assert_eq!(results[index]["output"], *output);
        }
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ));
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn custom_chat_history_preserves_plain_matching_tool_result() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        text_response("custom history complete").to_string(),
    )
    .await;
    let call = json!({"id":"call_original","type":"function","function":{"name":"lookup","arguments":"{\"input\":{\"retain\":[1,2]}}"},"routecodex_chat_extension":{"responses_tool_call_type":"custom_tool_call","responses_item_id":"ctc_original"}});
    let request = json!({"model":"test.test","stream":false,"messages":[{"role":"user","content":"custom history"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":"call_original","content":"actual custom result"}]});
    let (_, body) = successful_transfer(
        client()
            .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
            .json(&request)
            .send()
            .await,
    )
    .await;
    assert!(body.contains("mixed roundtrip complete"), "{body}");
    stop_entry(handle, shutdown).await;
    let wire = captures.recv().await.unwrap();
    let items = wire["input"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "custom_tool_call"
                && item["input"] == json!({"retain":[1,2]})),
        "{wire}"
    );
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "custom_tool_call_output"
                && item["call_id"] == "call_original"
                && item["output"] == "actual custom result"),
        "{wire}"
    );
    assert!(matches!(
        captures.try_recv(),
        Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
    ));
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_provider_custom_wrappers_decode_values_and_preserve_actual_next_turn() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let values = [
        Some(json!({"retain":[1,2],"input":{"nested":true}})),
        Some(json!([1, "two"])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
        Some(json!(1.25)),
        Some(json!(" raw input \n")),
        Some(json!("")),
        Some(json!({"input":"inner"})),
        None,
    ];
    for input in values {
        for structured_wire in [false, true] {
            for mode in 0..4 {
                let mut initial = json!({"id":"chat-custom","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_original","type":"function","function":{"name":"lookup"}}]},"finish_reason":"tool_calls"}]});
                if let Some(input) = &input {
                    let wrapper = json!({"input":input});
                    initial["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
                        if structured_wire {
                            wrapper
                        } else {
                            json!(wrapper.to_string())
                        };
                }
                let (media, upstream) = if mode < 2 {
                    ("application/json", initial.to_string())
                } else {
                    let mut call = initial["choices"][0]["message"]["tool_calls"][0].clone();
                    call["index"] = json!(0);
                    let body = format!(
                        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"id":"chat-custom","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":null}]}),
                        json!({"id":"chat-custom","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                    );
                    ("text/event-stream", body)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
                let tools = json!([{"type":"custom","name":"lookup","format":{"type":"text"}}]);
                let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","input":"execute custom","tools":tools,"stream":mode != 0})).send().await).await;
                let call = if media.starts_with("application/json") {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    value["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| item["type"] == "custom_tool_call")
                        .unwrap()
                        .clone()
                } else {
                    events(&body)
                        .into_iter()
                        .find_map(|event| {
                            event
                                .get("item")
                                .filter(|item| item["type"] == "custom_tool_call")
                                .cloned()
                                .or_else(|| {
                                    event["response"]["output"]
                                        .as_array()
                                        .and_then(|items| {
                                            items
                                                .iter()
                                                .find(|item| item["type"] == "custom_tool_call")
                                        })
                                        .cloned()
                                })
                        })
                        .unwrap_or_else(|| panic!("missing custom call: {body}"))
                };
                assert_eq!(call["call_id"], "call_original");
                assert_eq!(call["name"], "lookup");
                assert_eq!(
                    call.get("input"),
                    input.as_ref(),
                    "structured_wire={structured_wire} mode={mode}: {body}"
                );
                assert_one_attempt(&mut captures, "wire-test").await;
                let execution = std::process::Command::new("node").args(["-e","const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Object.hasOwn(c,'input')?{received:c.input}:{error:'missing custom input'}));",&call.to_string()]).output().unwrap();
                assert!(execution.status.success());
                let output = String::from_utf8(execution.stdout).unwrap();
                let expected = input
                    .as_ref()
                    .map(|value| json!({"received":value}))
                    .unwrap_or_else(|| json!({"error":"missing custom input"}));
                assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), expected);
                let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","tools":tools,"stream":mode != 0,"input":[{"role":"user","content":"execute custom"},call,{"type":"custom_tool_call_output","call_id":"call_original","output":output}]})).send().await).await;
                assert!(completed.contains("roundtrip complete"), "{completed}");
                stop_entry(handle, shutdown).await;
                let wire = captures.recv().await.unwrap();
                let messages = wire["messages"].as_array().unwrap();
                let sent = messages
                    .iter()
                    .find_map(|message| message["tool_calls"].as_array())
                    .unwrap()
                    .first()
                    .unwrap();
                assert_eq!(sent["id"], "call_original");
                match input.as_ref() {
                    Some(input) => assert_eq!(
                        serde_json::from_str::<Value>(
                            sent["function"]["arguments"].as_str().unwrap()
                        )
                        .unwrap(),
                        json!({"input":input})
                    ),
                    None => assert!(sent["function"].get("arguments").is_none()),
                }
                let result = messages
                    .iter()
                    .find(|message| message["role"] == "tool")
                    .unwrap();
                assert_eq!(result["tool_call_id"], "call_original");
                assert_eq!(result["content"], output);
                assert!(matches!(
                    captures.try_recv(),
                    Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
                ));
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn custom_chat_calls_retain_kind_input_and_actual_execution_result_on_next_provider() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for input in [
        json!({"retain":[1,2],"input":{"nested":true}}),
        json!([1, "two"]),
        Value::Null,
        json!(true),
        json!(7),
        json!(1.25),
        json!(" raw custom input \n"),
        json!(""),
        json!({"input":"inner"}),
    ] {
        for origin in 0..5 {
            let original = json!({"type":"custom_tool_call","id":"ctc_original","call_id":"call_original","name":"lookup","input":input});
            let mut initial = text_response("custom input");
            initial["output"] = json!([original]);
            let (media, upstream) = if origin < 2 {
                ("application/json", initial.to_string())
            } else if origin == 2 {
                ("text/event-stream", response_sse(&initial))
            } else if origin == 3 {
                (
                    "text/event-stream",
                    format!(
                        "{}{}",
                        sse(
                            "response.output_item.done",
                            &json!({"type":"response.output_item.done","output_index":0,"item":original})
                        ),
                        response_sse(&initial)
                    ),
                )
            } else {
                let mut added = original.clone();
                added.as_object_mut().unwrap().remove("input");
                let mut terminal = initial.clone();
                terminal.as_object_mut().unwrap().remove("output");
                (
                    "text/event-stream",
                    format!(
                        "{}{}{}",
                        sse(
                            "response.output_item.added",
                            &json!({"type":"response.output_item.added","output_index":0,"item":added})
                        ),
                        sse(
                            "response.custom_tool_call_input.done",
                            &json!({"type":"response.custom_tool_call_input.done","item_id":"ctc_original","output_index":0,"input":input})
                        ),
                        response_sse(&terminal)
                    ),
                )
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, media, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
            let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","messages":[{"role":"user","content":"execute custom"}],"stream":origin != 0})).send().await).await;
            let call = if media.starts_with("application/json") {
                serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]["tool_calls"]
                    [0]
                .clone()
            } else {
                events(&body)
                    .into_iter()
                    .find_map(|event| {
                        event["choices"][0]["delta"]["tool_calls"]
                            .as_array()
                            .and_then(|calls| calls.first())
                            .cloned()
                    })
                    .unwrap_or_else(|| panic!("input={input} origin={origin}: {body}"))
            };
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["function"]["name"], "lookup");
            assert_eq!(
                call["routecodex_chat_extension"]["responses_tool_call_type"], "custom_tool_call",
                "input={input} origin={origin}: {body}"
            );
            let arguments = call["function"]["arguments"].as_str().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(arguments).unwrap(),
                json!({"input":input})
            );
            let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:a.input}));",arguments]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":input})
            );
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            for (next_kind, process) in [
                ("responses", "responses"),
                ("responses", "chat"),
                ("openai_chat", "chat"),
                ("anthropic", "chat"),
            ] {
                for stream in [false, true] {
                    let completion = if next_kind == "openai_chat" {
                        json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"custom roundtrip complete"},"finish_reason":"stop"}]})
                    } else if next_kind == "anthropic" {
                        json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"custom roundtrip complete"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
                    } else {
                        text_response("custom roundtrip complete")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next_kind,
                        process,
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
                    let (_, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","stream":stream,"messages":[{"role":"user","content":"execute custom"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":"call_original","content":output}]})).send().await).await;
                    assert!(!body.is_empty());
                    stop_entry(handle, shutdown).await;
                    let wire = captures.recv().await.unwrap();
                    if next_kind == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items
                            .iter()
                            .find(|item| item["type"] == "custom_tool_call")
                            .expect("original custom type");
                        assert_eq!(sent["call_id"], "call_original");
                        assert_eq!(sent["name"], "lookup");
                        assert_eq!(sent["input"], input, "{wire}");
                        let result = items
                            .iter()
                            .find(|item| item["type"] == "custom_tool_call_output")
                            .expect("matching custom result");
                        assert_eq!(result["call_id"], "call_original");
                        assert_eq!(result["output"], output);
                    } else if next_kind == "openai_chat" {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|message| message["tool_calls"].as_array())
                            .unwrap()
                            .first()
                            .unwrap();
                        assert_eq!(sent["id"], "call_original");
                        assert_eq!(
                            serde_json::from_str::<Value>(
                                sent["function"]["arguments"].as_str().unwrap()
                            )
                            .unwrap(),
                            json!({"input":input})
                        );
                        let result = messages
                            .iter()
                            .find(|message| message["role"] == "tool")
                            .unwrap();
                        assert_eq!(result["tool_call_id"], "call_original");
                        assert_eq!(result["content"], output);
                    } else {
                        let blocks: Vec<_> = wire["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|message| message["content"].as_array().unwrap())
                            .collect();
                        let sent = blocks
                            .iter()
                            .find(|block| block["type"] == "tool_use")
                            .unwrap();
                        assert_eq!(sent["id"], "call_original");
                        assert_eq!(sent["input"], json!({"input":input}));
                        let result = blocks
                            .iter()
                            .find(|block| block["type"] == "tool_result")
                            .unwrap();
                        assert_eq!(result["tool_use_id"], "call_original");
                        assert_eq!(result["content"], output);
                    }
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn missing_tool_parameters_and_client_validation_results_survive_correction_turn() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["function_call", "custom_tool_call"] {
        let field = if kind == "function_call" {
            "arguments"
        } else {
            "input"
        };
        let output_kind = if kind == "function_call" {
            "function_call_output"
        } else {
            "custom_tool_call_output"
        };
        for origin in 0..5 {
            for original_client in ["responses", "chat"] {
                let original = json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
                let mut initial = text_response("validate original call");
                initial["output"] = json!([original]);
                let (media, upstream) = if origin < 2 {
                    ("application/json", initial.to_string())
                } else if origin == 2 {
                    ("text/event-stream", response_sse(&initial))
                } else if origin == 3 {
                    (
                        "text/event-stream",
                        format!(
                            "{}{}",
                            sse(
                                "response.output_item.done",
                                &json!({"type":"response.output_item.done","output_index":0,"item":original})
                            ),
                            response_sse(&initial)
                        ),
                    )
                } else {
                    let done_name = if kind == "function_call" {
                        "response.function_call_arguments.done"
                    } else {
                        "response.custom_tool_call_input.done"
                    };
                    let mut terminal = initial.clone();
                    terminal.as_object_mut().unwrap().remove("output");
                    (
                        "text/event-stream",
                        format!(
                            "{}{}{}",
                            sse(
                                "response.output_item.added",
                                &json!({"type":"response.output_item.added","output_index":0,"item":original})
                            ),
                            sse(
                                done_name,
                                &json!({"type":done_name,"item_id":"fc_original","output_index":0})
                            ),
                            response_sse(&terminal)
                        ),
                    )
                };
                let (endpoint, handle, mut captures, shutdown) = start_entry(
                    "responses",
                    if original_client == "chat" {
                        "chat"
                    } else {
                        "responses"
                    },
                    StatusCode::OK,
                    media,
                    upstream,
                )
                .await;
                let endpoint = if original_client == "chat" {
                    endpoint.replace("/v1/responses", "/v1/chat/completions")
                } else {
                    endpoint
                };
                let initial_request = if original_client == "chat" {
                    json!({"model":"test.test","messages":[{"role":"user","content":"validate tool call"}],"stream":origin != 0})
                } else {
                    json!({"model":"test.test","input":"validate tool call","stream":origin != 0})
                };
                let (media, body) = successful_transfer(
                    client().post(&endpoint).json(&initial_request).send().await,
                )
                .await;
                let call = if original_client == "chat" {
                    if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]
                            ["tool_calls"][0]
                            .clone()
                    } else {
                        events(&body)
                            .into_iter()
                            .find_map(|e| {
                                e["choices"][0]["delta"]["tool_calls"]
                                    .as_array()
                                    .and_then(|a| a.first())
                                    .cloned()
                            })
                            .unwrap()
                    }
                } else {
                    let returned = if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .filter_map(|e| e.get("response").cloned())
                            .last()
                            .unwrap()
                    };
                    if let Some(output) = returned.get("output") {
                        output
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|item| item["type"] == kind)
                            .unwrap()
                            .clone()
                    } else {
                        events(&body)
                            .into_iter()
                            .rev()
                            .filter_map(|event| event.get("item").cloned())
                            .find(|item| item["type"] == kind)
                            .expect(
                                "client accumulates an original item when terminal omits output",
                            )
                    }
                };
                let call_id = if original_client == "chat" {
                    &call["id"]
                } else {
                    &call["call_id"]
                };
                let name = if original_client == "chat" {
                    &call["function"]["name"]
                } else {
                    &call["name"]
                };
                let parameters = if original_client == "chat" {
                    &call["function"]
                } else {
                    &call
                };
                let parameter_field = if original_client == "chat" {
                    "arguments"
                } else {
                    field
                };
                let projected_kind = kind;
                let projected_output_kind = output_kind;
                assert_eq!(*call_id, original["call_id"]);
                assert_eq!(*name, original["name"]);
                assert!(
                    parameters.get(parameter_field).is_none(),
                    "missing parameter must reach the client unchanged: {body}"
                );
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let validation = std::process::Command::new("node").args(["-e", "const c=JSON.parse(process.argv[1]); const f=process.argv[2]; if(Object.hasOwn(c,f))process.exit(1); process.stdout.write('client validation error: missing '+f);", &parameters.to_string(), parameter_field]).output().unwrap();
                assert!(validation.status.success());
                let validation = String::from_utf8(validation.stdout).unwrap();
                for (next_kind, process) in [
                    ("responses", "responses"),
                    ("responses", "chat"),
                    ("openai_chat", "chat"),
                    ("anthropic", "chat"),
                ] {
                    for stream in [false, true] {
                        let completion = if next_kind == "anthropic" {
                            json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"correction received"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":3}})
                        } else if next_kind == "openai_chat" {
                            json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"correction received"},"finish_reason":"stop"}]})
                        } else {
                            text_response("correction received")
                        };
                        let (endpoint, handle, mut captures, shutdown) = start_entry(
                            next_kind,
                            process,
                            StatusCode::OK,
                            "application/json",
                            completion.to_string(),
                        )
                        .await;
                        let endpoint = if original_client == "chat" {
                            endpoint.replace("/v1/responses", "/v1/chat/completions")
                        } else {
                            endpoint
                        };
                        let correction = if original_client == "chat" {
                            json!({"model":"test.test","stream":stream,"messages":[{"role":"user","content":"validate tool call"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":call_id,"content":validation}]})
                        } else {
                            json!({"model":"test.test","stream":stream,"input":[{"role":"user","content":"validate tool call"},call,{"type":output_kind,"call_id":call_id,"output":validation}]})
                        };
                        eprintln!("R12 correction kind={kind} client={original_client} origin={origin} next={next_kind} process={process} stream={stream}");
                        let response = client().post(&endpoint).json(&correction).send().await;
                        let (_, completed) = successful_transfer(response).await;
                        stop_entry(handle, shutdown).await;
                        let wire = captures
                            .recv()
                            .await
                            .expect("original call and client error reach next provider");
                        if next_kind == "responses" {
                            let items = wire["input"].as_array().unwrap();
                            let sent = items
                                .iter()
                                .find(|item| item["type"] == projected_kind)
                                .unwrap();
                            assert_eq!(sent["call_id"], *call_id);
                            assert_eq!(sent["name"], *name);
                            assert!(sent.get(field).is_none(), "invented parameter: {wire}");
                            let result = items
                                .iter()
                                .find(|item| item["type"] == projected_output_kind)
                                .unwrap();
                            assert_eq!(result["call_id"], *call_id);
                            assert_eq!(result["output"], validation);
                        } else if next_kind == "openai_chat" {
                            let messages = wire["messages"].as_array().unwrap();
                            let sent = messages
                                .iter()
                                .find_map(|m| m["tool_calls"].as_array())
                                .unwrap();
                            assert_eq!(sent[0]["id"], *call_id);
                            assert_eq!(sent[0]["function"]["name"], *name);
                            assert!(
                                sent[0]["function"].get("arguments").is_none(),
                                "invented parameter: {wire}"
                            );
                            let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                            assert_eq!(result["tool_call_id"], *call_id);
                            assert_eq!(result["content"], validation);
                        } else {
                            let blocks: Vec<&Value> = wire["messages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .flat_map(|m| m["content"].as_array().unwrap())
                                .collect();
                            let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                            assert_eq!(sent["id"], *call_id);
                            assert_eq!(sent["name"], *name);
                            assert!(sent.get("input").is_none(), "invented parameter: {wire}");
                            let result =
                                blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                            assert_eq!(result["tool_use_id"], *call_id);
                            assert_eq!(result["content"], validation);
                        }
                        assert!(!completed.is_empty());
                        assert!(matches!(
                            captures.try_recv(),
                            Err(mpsc::error::TryRecvError::Empty
                                | mpsc::error::TryRecvError::Disconnected)
                        ));
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn tool_parameter_values_and_matching_results_survive_request_projection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let domain = [
        None,
        Some(json!({"retain":[1,2]})),
        Some(json!("{\"retain\":[1,2]}")),
        Some(json!("{\"q\":")),
        Some(json!("")),
        Some(json!([1,{"keep":true}])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
    ];
    for raw in domain {
        for kind in ["function_call", "custom_tool_call"] {
            let field = if kind == "function_call" {
                "arguments"
            } else {
                "input"
            };
            let output_kind = if kind == "function_call" {
                "function_call_output"
            } else {
                "custom_tool_call_output"
            };
            let mut call =
                json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
            if let Some(raw) = &raw {
                call[field] = raw.clone();
            }
            for (next_kind, process) in [
                ("responses", "responses"),
                ("responses", "chat"),
                ("openai_chat", "chat"),
                ("anthropic", "chat"),
            ] {
                for stream in [false, true] {
                    let completion = if next_kind == "anthropic" {
                        json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"correction received"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":3}})
                    } else {
                        text_response("correction received")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next_kind,
                        process,
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let result_text = "original client validation or execution result";
                    eprintln!("R11 values kind={kind} raw={raw:?} next={next_kind} process={process} stream={stream}");
                    let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","stream":stream,"input":[{"role":"user","content":"retain original history"},call,{"type":output_kind,"call_id":call["call_id"],"output":result_text}]})).send().await).await;
                    stop_entry(handle, shutdown).await;
                    let wire = captures
                        .recv()
                        .await
                        .expect("paired history reaches selected provider");
                    if next_kind == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items.iter().find(|item| item["type"] == kind).unwrap();
                        assert_eq!(sent["call_id"], call["call_id"]);
                        assert_eq!(sent["name"], call["name"]);
                        match &raw {
                            None => assert!(sent.get(field).is_none(), "{wire}"),
                            Some(raw)
                                if kind == "function_call"
                                    && !raw.is_string()
                                    && sent[field].is_string() =>
                            {
                                assert_eq!(
                                    serde_json::from_str::<Value>(sent[field].as_str().unwrap())
                                        .unwrap(),
                                    *raw,
                                    "{wire}"
                                )
                            }
                            Some(raw) => assert_eq!(sent[field], *raw, "{wire}"),
                        }
                        let result = items
                            .iter()
                            .find(|item| item["type"] == output_kind)
                            .unwrap();
                        assert_eq!(result["call_id"], call["call_id"]);
                        assert_eq!(result["output"], result_text);
                    } else if next_kind == "openai_chat" {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|m| m["tool_calls"].as_array())
                            .unwrap();
                        assert_eq!(sent[0]["id"], call["call_id"]);
                        assert_eq!(sent[0]["function"]["name"], call["name"]);
                        match &raw {
                            None => {
                                assert!(sent[0]["function"].get("arguments").is_none(), "{wire}")
                            }
                            Some(raw) if kind == "custom_tool_call" => assert_eq!(
                                serde_json::from_str::<Value>(
                                    sent[0]["function"]["arguments"].as_str().unwrap()
                                )
                                .unwrap(),
                                json!({"input":raw}),
                                "{wire}"
                            ),
                            Some(raw) => assert_eq!(
                                sent[0]["function"]["arguments"],
                                raw.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| raw.to_string()),
                                "{wire}"
                            ),
                        }
                        let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                        assert_eq!(result["tool_call_id"], call["call_id"]);
                        assert_eq!(result["content"], result_text);
                    } else {
                        let blocks: Vec<&Value> = wire["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|m| m["content"].as_array().unwrap())
                            .collect();
                        let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                        assert_eq!(sent["id"], call["call_id"]);
                        assert_eq!(sent["name"], call["name"]);
                        match &raw {
                            None => assert!(sent.get("input").is_none(), "{wire}"),
                            Some(raw) if kind == "custom_tool_call" => {
                                assert_eq!(sent["input"], json!({"input":raw}), "{wire}")
                            }
                            Some(Value::String(raw)) => assert_eq!(
                                sent["input"],
                                serde_json::from_str::<Value>(raw)
                                    .unwrap_or_else(|_| json!({"input":raw})),
                                "{wire}"
                            ),
                            Some(raw) => assert_eq!(sent["input"], *raw, "{wire}"),
                        }
                        let result = blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                        assert_eq!(result["tool_use_id"], call["call_id"]);
                        assert_eq!(result["content"], result_text);
                    }
                    assert!(!completed.is_empty());
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.send(body.clone()).unwrap();
    if body.to_string().contains("representation-valid-request")
        || (state.health_enabled && !body.to_string().contains("representation-invalid-"))
    {
        let completed = if state.kind == "openai_chat" {
            json!({"id":"chat-valid","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"representation-valid-completion"},"finish_reason":"stop"}]})
        } else {
            text_response("representation-valid-completion")
        };
        let wire = if state.content_type == "application/json" {
            completed.to_string()
        } else if state.kind == "openai_chat" {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chat-valid","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","content":"representation-valid-completion"},"finish_reason":"stop"}]})
            )
        } else {
            response_sse(&completed)
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(wire))
            .unwrap();
    }
    if body["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|m| m["role"] == "tool"))
    {
        let completion = json!({"id":"chatcmpl-followup","object":"chat.completion","model":"wire-test",
            "choices":[{"index":0,"message":{"role":"assistant","content":"chat roundtrip complete"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}});
        let response = if state.content_type == "application/json" {
            completion.to_string()
        } else {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chatcmpl-followup","object":"chat.completion.chunk","model":"wire-test",
                "choices":[{"index":0,"delta":{"role":"assistant","content":"chat roundtrip complete"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
            )
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(response))
            .unwrap();
    }
    if body
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
        })
    {
        let completed = text_response("mixed roundtrip complete");
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(if state.content_type == "application/json" {
                completed.to_string()
            } else {
                response_sse(&completed)
            }))
            .unwrap();
    }
    // Independently pinned candidate: this asserts listener isolation without
    // assuming recovery of the failed provider identity.
    if body["model"] == "wire-independent" {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(response_sse(&text_response("independent ok"))))
            .unwrap();
    }
    Response::builder()
        .status(state.status)
        .header("content-type", state.content_type)
        .body(Body::from(state.body.clone()))
        .unwrap()
}

fn text_response(text: &str) -> Value {
    json!({"id":"resp_control","object":"response","status":"completed","model":"wire-test",
        "output":[{"id":"msg_control","type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}]})
}

fn sse(event: &str, value: &Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

fn response_sse(response: &Value) -> String {
    let event = if response["status"] == "incomplete" {
        "response.incomplete"
    } else {
        "response.completed"
    };
    sse(event, &json!({"type":event,"response":response}))
}

async fn start_entry(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    start_entry_with_health(kind, process, status, content_type, body, false).await
}

async fn start_entry_with_health(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    health_enabled: bool,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("public regression requires loopback sockets");
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .route("/v1/chat/completions", post(controlled_upstream))
        .route("/v1/messages", post(controlled_upstream))
        .with_state(Arc::new(ProviderState {
            kind: kind.to_string(),
            health_enabled,
            status,
            content_type,
            body,
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    let port = test_ports::free_port();
    let alias = if health_enabled {
        format!("representation-key-{port}")
    } else {
        "key".to_string()
    };
    // Anthropic's transport appends /v1/messages; Responses and Chat append
    // their endpoint to an API base that already includes /v1.
    let provider_base_url = if kind == "anthropic" {
        format!("http://{upstream_addr}")
    } else {
        format!("http://{upstream_addr}/v1")
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses", "openai_chat", "anthropic"]
{execution}
[providers.test]
type = "{kind}"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "{alias}", env = "{KEY_ENV}" }}] }}
health = {{ enabled = {health_enabled}, failure_threshold = 2, cooldown_ms = 5000 }}
responses = {{ process = "{process}", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.independent]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.independent.models.test]
wire_name = "wire-independent"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "{alias}", priority = 1 }}]
"#
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    if let Ok(path) = std::env::var("V3_NO_RESPONSE_TEST_LOG_FILE") {
        manifest.debug.log_file = Some(path);
        manifest.debug.log_console = true;
        manifest.debug.snapshots = true;
        manifest.debug.codex_samples = true;
        manifest.debug.full_codex_sampling = true;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    (
        format!("http://{}/v1/responses", handle.listeners[0].addr),
        handle,
        captures_rx,
        shutdown_tx,
    )
}

async fn stop_entry(handle: V3ServerAggregateHandle, shutdown: oneshot::Sender<()>) {
    handle.shutdown().await;
    let _ = shutdown.send(());
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

async fn post_request(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client.post(endpoint).json(&json!({"model":model,"input":"controlled response regression","stream":true,
        "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}]})).send().await
}

fn events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .map(|data| serde_json::from_str(data).expect("client SSE must preserve valid JSON"))
        .collect()
}

#[tokio::test]
async fn duplicate_tool_ids_preserve_both_calls_across_public_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (custom, same_item_id) in [(false, false), (false, true), (true, false), (true, true)] {
        let calls: Vec<Value> = (0..2).map(|index| {
            let mut item = json!({"type":if custom {"custom_tool_call"} else {"function_call"},
                "id":format!("item_{}",if same_item_id {0} else {index}),"call_id":"same_call","name":format!("lookup{index}"),"status":"completed"});
            item[if custom {"input"} else {"arguments"}] = json!(if custom {
                format!(" raw {index}\ncomplete input ")
            } else { format!("{{\"q\":\"complete {index}\",\"nested\":{{\"value\":{index}}}}}") });
            item
        }).collect();
        let native = json!({"id":"resp_duplicate","object":"response","status":"completed","model":"wire-test","output":calls});
        for entry in ["responses", "openai_chat", "anthropic"] {
            for streaming in [false, true] {
                for upstream_type in if streaming {
                    vec!["application/json", "text/event-stream"]
                } else {
                    vec!["application/json"]
                } {
                    let upstream = if upstream_type == "application/json" {
                        native.to_string()
                    } else {
                        response_sse(&native)
                    };
                    let (endpoint, handle, mut captures, shutdown) =
                        start_entry("responses", "chat", StatusCode::OK, upstream_type, upstream)
                            .await;
                    let endpoint = endpoint.replace(
                        "/v1/responses",
                        match entry {
                            "openai_chat" => "/v1/chat/completions",
                            "anthropic" => "/v1/messages",
                            _ => "/v1/responses",
                        },
                    );
                    let request = if entry == "responses" {
                        json!({"model":"test.test","stream":streaming,"input":"preserve both calls"})
                    } else {
                        json!({"model":"test.test","stream":streaming,"max_tokens":100,"messages":[{"role":"user","content":"preserve both calls"}]})
                    };
                    let (content_type, body) =
                        successful_transfer(client().post(endpoint).json(&request).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    assert_one_attempt(&mut captures, "wire-test").await;
                    let projected_sse = content_type.starts_with("text/event-stream");
                    let payloads = if content_type.contains("application/json") {
                        vec![serde_json::from_str::<Value>(&body).unwrap()]
                    } else {
                        events(&body)
                    };
                    if entry == "responses" {
                        let value = if projected_sse {
                            &payloads
                                .iter()
                                .find(|event| event["type"] == "response.completed")
                                .unwrap()["response"]
                        } else {
                            &payloads[0]
                        };
                        assert_eq!(value["output"], native["output"], "{body}");
                    } else if entry == "anthropic" {
                        let blocks: Vec<Value> = if projected_sse {
                            payloads
                                .iter()
                                .filter(|event| event["type"] == "content_block_start")
                                .map(|event| event["content_block"].clone())
                                .collect()
                        } else {
                            payloads[0]["content"].as_array().unwrap().clone()
                        };
                        assert_eq!(blocks.len(), 2, "{body}");
                        for index in 0..2 {
                            assert_eq!(blocks[index]["id"], "same_call", "{body}");
                            assert_eq!(blocks[index]["name"], calls[index]["name"], "{body}");
                            let expected = if custom {
                                json!({"input":calls[index]["input"]})
                            } else {
                                serde_json::from_str(calls[index]["arguments"].as_str().unwrap())
                                    .unwrap()
                            };
                            let actual = if projected_sse {
                                let arguments: String = payloads
                                    .iter()
                                    .filter(|event| {
                                        event["type"] == "content_block_delta"
                                            && event["index"] == index
                                    })
                                    .filter_map(|event| event["delta"]["partial_json"].as_str())
                                    .collect();
                                if arguments.is_empty() {
                                    blocks[index]["input"].clone()
                                } else {
                                    serde_json::from_str::<Value>(&arguments).unwrap()
                                }
                            } else {
                                blocks[index]["input"].clone()
                            };
                            assert_eq!(actual, expected, "{body}");
                        }
                    } else {
                        let tools: Vec<Value> = if projected_sse {
                            payloads
                                .iter()
                                .filter_map(|event| {
                                    event["choices"][0]["delta"]["tool_calls"].as_array()
                                })
                                .flatten()
                                .cloned()
                                .collect()
                        } else {
                            payloads[0]["choices"][0]["message"]["tool_calls"]
                                .as_array()
                                .unwrap()
                                .clone()
                        };
                        for index in 0..2 {
                            let parts: Vec<&Value> = if projected_sse {
                                tools.iter().filter(|tool| tool["index"] == index).collect()
                            } else {
                                vec![&tools[index]]
                            };
                            assert!(
                                parts.iter().any(|tool| tool["id"] == "same_call"
                                    && tool["function"]["name"] == calls[index]["name"]),
                                "{body}"
                            );
                            let arguments: String = parts
                                .iter()
                                .filter_map(|tool| tool["function"]["arguments"].as_str())
                                .collect();
                            let expected = if custom {
                                json!({"input":calls[index]["input"]}).to_string()
                            } else {
                                calls[index]["arguments"].as_str().unwrap().to_string()
                            };
                            assert_eq!(arguments, expected, "{body}");
                        }
                        if !projected_sse {
                            assert_eq!(tools.len(), 2, "{body}");
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn assert_one_attempt(captures: &mut mpsc::UnboundedReceiver<Value>, wire_model: &str) {
    let request = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    assert_eq!(request["model"], wire_model);
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "exactly one upstream attempt per request"
    );
}

/// Stable public regression: both mixed calls sharing an ID must survive
/// actual client tool execution and the next request in either order.
#[tokio::test]
async fn mixed_duplicate_tool_kinds_complete_public_roundtrip() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let tools = json!([
        {"type":"namespace","name":"functions","tools":[{"type":"function","name":"lookup",
            "parameters":{"type":"object","properties":{"left":{"type":"number"},"right":{"type":"number"}},"required":["left","right"]}}]},
        {"type":"namespace","name":"customs","tools":[{"type":"custom","name":"echo","format":{"type":"text"}}]}
    ]);
    let function = json!({"type":"function_call","id":"function_item","call_id":"dup",
        "namespace":"functions","name":"lookup","status":"completed","arguments":"{\"left\":2,\"right\":3}"});
    let custom = json!({"type":"custom_tool_call","id":"custom_item","call_id":"dup",
        "namespace":"customs","name":"echo","status":"completed","input":" exact raw\n input "});
    for reverse in [false, true] {
        let calls = if reverse {
            vec![custom.clone(), function.clone()]
        } else {
            vec![function.clone(), custom.clone()]
        };
        let native = json!({"id":"resp_mixed","object":"response","status":"completed","model":"wire-test","output":calls});
        for process in ["direct", "chat"] {
            for streaming in [false, true] {
                let media: &[&str] = if streaming {
                    &["application/json", "text/event-stream"]
                } else {
                    &["application/json"]
                };
                for &upstream_type in media {
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        "responses",
                        process,
                        StatusCode::OK,
                        upstream_type,
                        if upstream_type == "application/json" {
                            native.to_string()
                        } else {
                            response_sse(&native)
                        },
                    )
                    .await;
                    let initial = json!({"model":"test.test","input":"execute both declared tools","tools":tools,"stream":streaming});
                    let (content_type, body) =
                        successful_transfer(client().post(&endpoint).json(&initial).send().await)
                            .await;
                    let returned = if content_type.contains("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .find(|event| event["type"] == "response.completed")
                            .expect("genuine tool terminal")["response"]
                            .clone()
                    };
                    assert_eq!(
                        returned["output"], native["output"],
                        "{process}/{upstream_type}: {body}"
                    );
                    assert_one_attempt(&mut captures, "wire-test").await;
                    let mut input = vec![
                        json!({"type":"message","role":"user","content":"execute both declared tools"}),
                    ];
                    input.extend(returned["output"].as_array().unwrap().iter().cloned());
                    for call in returned["output"].as_array().unwrap() {
                        let (kind, program, argument, expected) = if call["type"] == "function_call"
                        {
                            ("function_call_output", "const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({sum:a.left+a.right}));", call["arguments"].as_str().unwrap(), "{\"sum\":5}".to_owned())
                        } else {
                            (
                                "custom_tool_call_output",
                                "process.stdout.write(JSON.stringify({received:process.argv[1]}));",
                                call["input"].as_str().unwrap(),
                                json!({"received":" exact raw\n input "}).to_string(),
                            )
                        };
                        let receipt = std::process::Command::new("node")
                            .args(["-e", program, argument])
                            .output()
                            .unwrap();
                        assert!(
                            receipt.status.success(),
                            "client tool execution: {:?}",
                            receipt
                        );
                        let output = String::from_utf8(receipt.stdout).unwrap();
                        assert_eq!(output, expected);
                        input.push(json!({"type":kind,"call_id":call["call_id"],"output":output}));
                    }
                    let followup =
                        json!({"model":"test.test","input":input,"tools":tools,"stream":streaming});
                    let (content_type, body) =
                        successful_transfer(client().post(&endpoint).json(&followup).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    let wire = captures
                        .recv()
                        .await
                        .expect("both matching results reach provider");
                    let actual: Vec<_> = wire["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|item| {
                            matches!(
                                item["type"].as_str(),
                                Some(
                                    "function_call"
                                        | "custom_tool_call"
                                        | "function_call_output"
                                        | "custom_tool_call_output"
                                )
                            )
                        })
                        .cloned()
                        .collect();
                    assert_eq!(actual.len(), 4, "both calls and both results: {wire}");
                    for (actual, expected) in actual.iter().zip(&input[1..]) {
                        for field in ["type", "call_id", "arguments", "input", "output"] {
                            assert_eq!(
                                actual.get(field),
                                expected.get(field),
                                "complete ordered history {field}: {wire}"
                            );
                        }
                        if let Some(name) = expected.get("name").and_then(Value::as_str) {
                            if process == "direct" {
                                assert_eq!(actual.get("name"), expected.get("name"));
                                assert_eq!(actual.get("namespace"), expected.get("namespace"));
                            } else {
                                // Relay encodes the namespace in the declared provider
                                // name. Require the call to reference that declaration.
                                let qualified =
                                    format!("{}__{name}", expected["namespace"].as_str().unwrap());
                                assert_eq!(actual["name"], qualified, "{wire}");
                                assert!(
                                    wire["tools"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .any(|tool| tool["name"] == qualified),
                                    "undeclared provider dispatch identity: {wire}"
                                );
                            }
                        }
                    }
                    assert!(
                        matches!(
                            captures.try_recv(),
                            Err(mpsc::error::TryRecvError::Empty
                                | mpsc::error::TryRecvError::Disconnected)
                        ),
                        "one followup attempt"
                    );
                    let completed = if content_type.contains("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .find(|event| event["type"] == "response.completed")
                            .unwrap()["response"]
                            .clone()
                    };
                    assert_eq!(completed["status"], "completed");
                    assert_eq!(
                        completed["output"],
                        text_response("mixed roundtrip complete")["output"]
                    );
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn successful_transfer(
    result: Result<reqwest::Response, reqwest::Error>,
) -> (String, String) {
    let response = result.expect("representable response must reach client");
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_string();
    let body = response
        .text()
        .await
        .expect("successful transfer must finish");
    (content_type, body)
}

async fn successful_body(result: Result<reqwest::Response, reqwest::Error>) -> String {
    let (content_type, body) = successful_transfer(result).await;
    assert!(content_type.starts_with("text/event-stream"));
    assert!(!events(&body).iter().any(|event| matches!(
        event["type"].as_str(),
        Some("error" | "response.failed" | "response.error")
    )));
    body
}

/// Stable RED ID: content_filter and unknown incomplete reasons must survive
/// Direct and explicit Relay, including partial output and the actual reason.
#[tokio::test]
async fn responses_incomplete_semantics_survive_direct_and_relay() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "chat"] {
        for reason in [
            "content_filter",
            "provider_specific_reason",
            "max_output_tokens",
        ] {
            let mut expected = text_response("retained partial text");
            expected["status"] = json!("incomplete");
            expected["incomplete_details"] = json!({"reason":reason});
            expected["output"][0]["status"] = json!("incomplete");
            for content_type in ["text/event-stream", "application/json"] {
                let upstream = if content_type == "application/json" {
                    expected.to_string()
                } else {
                    response_sse(&expected)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", process, StatusCode::OK, content_type, upstream).await;
                let (actual_content_type, body) =
                    successful_transfer(post_request(&client(), &endpoint, "test.test").await)
                        .await;
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let terminal_response = if actual_content_type.starts_with("application/json") {
                    assert_eq!(process, "direct", "Relay must project the requested SSE");
                    assert_eq!(
                        content_type, "application/json",
                        "Direct preserves upstream framing"
                    );
                    let response: Value = serde_json::from_str(&body).expect("valid client JSON");
                    assert!(
                        response.get("error").is_none(),
                        "no client error envelope: {body}"
                    );
                    response
                } else {
                    assert!(actual_content_type.starts_with("text/event-stream"));
                    let payloads = events(&body);
                    assert!(
                        !payloads.iter().any(|event| matches!(
                            event["type"].as_str(),
                            Some(
                                "error"
                                    | "response.failed"
                                    | "response.error"
                                    | "response.completed"
                            )
                        )),
                        "incomplete cannot become failure or completed: {body}"
                    );
                    payloads
                        .iter()
                        .find(|event| event["type"] == "response.incomplete")
                        .expect("preserve incomplete terminal")["response"]
                        .clone()
                };
                assert_eq!(
                    terminal_response["status"], "incomplete",
                    "{process}/{reason}: {body}"
                );
                assert_eq!(
                    terminal_response["incomplete_details"],
                    expected["incomplete_details"]
                );
                assert_eq!(terminal_response["output"], expected["output"]);
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_refusal_text_and_tool_controls_preserve_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let mut refusal = text_response("placeholder");
    refusal["output"][0]["content"] =
        json!([{"type":"refusal","refusal":"provider declined this request"}]);
    let mut tool = text_response("placeholder");
    tool["output"] = json!([{"type":"function_call","id":"fc_control","call_id":"call_control","name":"lookup","arguments":"{\"q\":\"retained\"}","status":"completed"}]);
    for process in ["direct", "chat"] {
        for expected in [&refusal, &text_response("ordinary successful text"), &tool] {
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                process,
                StatusCode::OK,
                "text/event-stream",
                response_sse(expected),
            )
            .await;
            let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("control completes");
            assert_eq!(
                terminal["response"]["output"], expected["output"],
                "{process}: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public regression ID: Responses-wire refusal and content_filter keep
/// their representable content and terminal semantics on Chat/Anthropic entries.
#[tokio::test]
async fn responses_wire_representation_survives_chat_and_anthropic_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for entry in ["openai_chat", "anthropic"] {
        for streaming in [false, true] {
            for case in [
                "plain",
                "refusal",
                "content_filter",
                "max_output_tokens",
                "provider_specific_reason",
                "missing_details",
                "null_details",
                "empty_reason",
                "numeric_reason",
                "unknown_details",
                "whitespace_reason",
                "empty_completed",
            ] {
                let mut expected = text_response("NATIVE_OK");
                expected["usage"] = json!({"input_tokens":3,"output_tokens":2,"total_tokens":5});
                if case == "refusal" {
                    expected["output"][0]["content"] =
                        json!([{"type":"refusal","refusal":"NATIVE_REFUSAL"}]);
                } else if case != "plain" {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":case});
                    match case {
                        "missing_details" => {
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        "null_details" => expected["incomplete_details"] = Value::Null,
                        "empty_reason" => expected["incomplete_details"] = json!({"reason":""}),
                        "numeric_reason" => expected["incomplete_details"] = json!({"reason":42}),
                        "unknown_details" => {
                            expected["incomplete_details"] = json!({"opaque":true})
                        }
                        "whitespace_reason" => {
                            expected["incomplete_details"] = json!({"reason":" content_filter "})
                        }
                        "empty_completed" => {
                            expected["status"] = json!("completed");
                            expected["output"] = json!([]);
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        _ => {}
                    }
                }
                // Non-streaming provider requests require JSON. Streaming
                // requests may return either JSON or SSE under the transport contract.
                let upstream_types: &[&str] = if streaming {
                    &["application/json", "text/event-stream"]
                } else {
                    &["application/json"]
                };
                for &upstream_type in upstream_types {
                    let upstream = if upstream_type == "application/json" {
                        expected.to_string()
                    } else {
                        response_sse(&expected)
                    };
                    let (responses_endpoint, handle, mut captures, shutdown) =
                        start_entry("responses", "chat", StatusCode::OK, upstream_type, upstream)
                            .await;
                    let path = if entry == "openai_chat" {
                        "/v1/chat/completions"
                    } else {
                        "/v1/messages"
                    };
                    let endpoint = format!(
                        "{}{path}",
                        responses_endpoint.trim_end_matches("/v1/responses")
                    );
                    let mut request = json!({"model":"test.test", "stream":streaming,
                        "messages":[{"role":"user","content":"representation regression"}]});
                    if entry == "anthropic" {
                        request["max_tokens"] = json!(128);
                    } else if streaming {
                        request["stream_options"] = json!({"include_usage":true});
                    }
                    let (content_type, body) =
                        successful_transfer(client().post(endpoint).json(&request).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    assert_one_attempt(&mut captures, "wire-test").await;
                    assert!(!body.contains("\"error\""), "{entry}/{case}: {body}");
                    let expected_text = if case == "refusal" {
                        "NATIVE_REFUSAL"
                    } else if case == "empty_completed" {
                        ""
                    } else {
                        "NATIVE_OK"
                    };
                    let expected_finish = match (entry, case) {
                        ("openai_chat", "content_filter") => "content_filter",
                        ("openai_chat", "max_output_tokens") => "length",
                        ("openai_chat", _) => "stop",
                        (_, "content_filter") => "refusal",
                        (_, "max_output_tokens") => "max_tokens",
                        _ => "end_turn",
                    };
                    if content_type.starts_with("application/json") {
                        let payload: Value = serde_json::from_str(&body).unwrap();
                        if entry == "openai_chat" {
                            let message = &payload["choices"][0]["message"];
                            assert_eq!(
                                message[if case == "refusal" {
                                    "refusal"
                                } else {
                                    "content"
                                }],
                                expected_text
                            );
                            assert_eq!(payload["choices"][0]["finish_reason"], expected_finish);
                            assert_eq!(payload["id"], "resp_control");
                            assert_eq!(payload["usage"]["prompt_tokens"], 3);
                            assert_eq!(payload["usage"]["completion_tokens"], 2);
                        } else {
                            if case == "empty_completed" {
                                assert_eq!(payload["content"], json!([]));
                            } else {
                                assert_eq!(payload["content"][0]["text"], expected_text);
                            }
                            assert_eq!(payload["stop_reason"], expected_finish);
                            assert_eq!(payload["id"], "msg_control");
                            assert_eq!(payload["usage"]["input_tokens"], 3);
                            assert_eq!(payload["usage"]["output_tokens"], 2);
                        }
                    } else {
                        assert!(content_type.starts_with("text/event-stream"));
                        let payloads = events(&body);
                        if entry == "openai_chat" {
                            let field = if case == "refusal" {
                                "refusal"
                            } else {
                                "content"
                            };
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["choices"][0]["delta"][field].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads.iter().any(|event| event["choices"][0]
                                ["finish_reason"]
                                == expected_finish));
                            assert!(payloads
                                .iter()
                                .any(|event| event["usage"]["prompt_tokens"] == 3
                                    && event["usage"]["completion_tokens"] == 2));
                            assert!(body.contains("data: [DONE]"));
                        } else {
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["delta"]["text"].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads
                                .iter()
                                .any(|event| event["delta"]["stop_reason"] == expected_finish));
                            assert!(payloads.iter().any(|event| event["type"] == "message_stop"));
                            assert!(payloads
                                .iter()
                                .any(|event| event["message"]["usage"]["input_tokens"] == 3));
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_content_filter_and_refusal_keep_representable_semantics() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let pure_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    let mixed_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":"partial text","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        ),
    );
    let refusal_json = json!({"id":"chat_control","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"partial text","refusal":"provider declined this request"},"finish_reason":"content_filter"}]}).to_string();
    for (content_type, upstream, expected_text) in [
        ("text/event-stream", pure_refusal_sse, None),
        ("text/event-stream", mixed_refusal_sse, Some("partial text")),
        ("application/json", refusal_json, Some("partial text")),
    ] {
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "openai_chat",
            "chat",
            StatusCode::OK,
            content_type,
            upstream,
        )
        .await;
        let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let payloads = events(&body);
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.incomplete")
            .expect("content_filter maps to incomplete");
        assert_eq!(
            terminal["response"]["incomplete_details"]["reason"],
            "content_filter"
        );
        assert!(
            terminal["response"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "refusal"
                        && part["refusal"] == "provider declined this request"))),
            "retain refusal: {body}"
        );
        assert!(!payloads
            .iter()
            .any(|event| event["type"] == "response.completed"));
        if let Some(expected_text) = expected_text {
            assert!(
                terminal["response"]["output"]
                    .to_string()
                    .contains(expected_text),
                "co-located text must survive: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_refusal_details_survive_json_and_sse_public_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    // Opaque provider data covers the full JSON domain, independently of the
    // terminal reason. These cases traverse normalization and projection.
    for (stop_reason, status) in [
        ("refusal", "incomplete"),
        ("end_turn", "completed"),
        ("max_tokens", "incomplete"),
        ("stop_sequence", "completed"),
        ("tool_use", "completed"),
        ("pause_turn", "in_progress"),
    ] {
        for details in [
            json!({"type":"refusal","category":"cyber", "explanation":" exact policy\n", "vendor":{"items":[1,"opaque"]}}),
            json!(" exact opaque\n string "),
            json!([1, null, {"vendor":true}]),
            json!(42.5),
            json!(false),
            Value::Null,
        ] {
            for text in ["", " partial text "] {
                let mut content = if text.is_empty() {
                    json!([])
                } else {
                    json!([{"type":"text","text":text}])
                };
                if stop_reason == "tool_use" {
                    content.as_array_mut().unwrap().push(json!({"type":"tool_use","id":"call_details","name":"lookup","input":{"q":" exact input "}}));
                }
                let native = json!({"id":"msg_details","type":"message","role":"assistant",
                "model":"wire-test","content":content,"stop_reason":stop_reason,
                "stop_details":details,"usage":{"input_tokens":7,"output_tokens":2}});
                let mut native = native;
                if stop_reason == "stop_sequence" {
                    native["stop_sequence"] = json!(" exact stop ");
                }
                let mut upstream_sse = sse(
                    "message_start",
                    &json!({"type":"message_start",
                "message":{"id":"msg_details","type":"message","role":"assistant",
                    "model":"wire-test","content":[],"stop_reason":null,
                    "stop_details":null,"usage":{"input_tokens":7,"output_tokens":0}}}),
                );
                if !text.is_empty() {
                    upstream_sse.push_str(&sse(
                        "content_block_start",
                        &json!({"type":"content_block_start",
                    "index":0,"content_block":{"type":"text","text":""}}),
                    ));
                    upstream_sse.push_str(&sse(
                        "content_block_delta",
                        &json!({"type":"content_block_delta",
                    "index":0,"delta":{"type":"text_delta","text":text}}),
                    ));
                    upstream_sse.push_str(&sse(
                        "content_block_stop",
                        &json!({"type":"content_block_stop","index":0}),
                    ));
                }
                let mut delta = json!({"stop_reason":stop_reason,"stop_details":details});
                if stop_reason == "tool_use" {
                    let index = usize::from(!text.is_empty());
                    upstream_sse.push_str(&sse("content_block_start", &json!({"type":"content_block_start","index":index,"content_block":content[index]})));
                    upstream_sse.push_str(&sse(
                        "content_block_stop",
                        &json!({"type":"content_block_stop","index":index}),
                    ));
                }
                if stop_reason == "stop_sequence" {
                    delta["stop_sequence"] = json!(" exact stop ");
                }
                upstream_sse.push_str(&sse(
                    "message_delta",
                    &json!({"type":"message_delta",
                "delta":delta,"usage":{"output_tokens":2}}),
                ));
                upstream_sse.push_str(&sse("message_stop", &json!({"type":"message_stop"})));
                for streaming in [false, true] {
                    let media: &[&str] = if streaming {
                        &["application/json", "text/event-stream"]
                    } else {
                        &["application/json"]
                    };
                    for &upstream_type in media {
                        for entry in ["responses", "anthropic"] {
                            let upstream = if upstream_type == "application/json" {
                                native.to_string()
                            } else {
                                upstream_sse.clone()
                            };
                            let (endpoint, handle, mut captures, shutdown) = start_entry(
                                "anthropic",
                                "chat",
                                StatusCode::OK,
                                upstream_type,
                                upstream,
                            )
                            .await;
                            let request = if entry == "anthropic" {
                                json!({"model":"test.test","max_tokens":128,"stream":streaming,
                                "messages":[{"role":"user","content":"preserve refusal details"}]})
                            } else {
                                json!({"model":"test.test","stream":streaming,"input":"preserve refusal details"})
                            };
                            let endpoint = if entry == "anthropic" {
                                endpoint.replace("/v1/responses", "/v1/messages")
                            } else {
                                endpoint
                            };
                            let (content_type, body) = successful_transfer(
                                client().post(endpoint).json(&request).send().await,
                            )
                            .await;
                            stop_entry(handle, shutdown).await;
                            assert_one_attempt(&mut captures, "wire-test").await;
                            if content_type.contains("application/json") {
                                let value: Value = serde_json::from_str(&body).unwrap();
                                assert_eq!(
                                    value.get("stop_details"),
                                    Some(&details),
                                    "{entry}/{upstream_type}: {body}"
                                );
                                if entry == "anthropic" {
                                    assert_eq!(value, native);
                                } else {
                                    assert_eq!(value["status"], status);
                                    if !text.is_empty() {
                                        assert_eq!(value["output"][0]["content"][0]["text"], text);
                                    }
                                }
                            } else {
                                let payloads = events(&body);
                                let terminal = payloads
                                    .iter()
                                    .rev()
                                    .find(|event| {
                                        event["type"]
                                            == if entry == "anthropic" {
                                                "message_delta"
                                            } else {
                                                match status {
                                                    "incomplete" => "response.incomplete",
                                                    "in_progress" => "response.in_progress",
                                                    _ => "response.completed",
                                                }
                                            }
                                    })
                                    .expect("provider output must reach its client terminal");
                                let value = if entry == "anthropic" {
                                    &terminal["delta"]
                                } else {
                                    &terminal["response"]
                                };
                                assert_eq!(
                                    value.get("stop_details"),
                                    Some(&details),
                                    "{entry}/{upstream_type}: {body}"
                                );
                                if entry == "anthropic" {
                                    assert_eq!(value["stop_reason"], stop_reason);
                                    assert!(payloads
                                        .iter()
                                        .any(|event| event["type"] == "message_stop"));
                                } else {
                                    assert_eq!(value["status"], status);
                                    if !text.is_empty() {
                                        assert_eq!(
                                            value["output"][0]["content"][0]["text"], text,
                                            "{body}"
                                        );
                                    }
                                    if status == "in_progress" {
                                        assert!(
                                            !payloads
                                                .iter()
                                                .any(|event| event["type"] == "response.completed"),
                                            "pause_turn must remain in_progress: {body}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_refusal_remains_provider_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = [
        sse("message_start", &json!({"type":"message_start","message":{"id":"msg_refusal","type":"message","role":"assistant","model":"wire-test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})),
        sse("content_block_start", &json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
        sse("content_block_delta", &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider declined this request"}})),
        sse("content_block_stop", &json!({"type":"content_block_stop","index":0})),
        sse("message_delta", &json!({"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":5}})),
        sse("message_stop", &json!({"type":"message_stop"})),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    let payloads = events(&body);
    let terminal = payloads
        .iter()
        .find(|event| event["type"] == "response.incomplete")
        .expect("Anthropic refusal maps to incomplete/content_filter");
    assert!(
        terminal["response"]
            .to_string()
            .contains("provider declined this request"),
        "retain refusal content: {body}"
    );
    assert_eq!(
        terminal["response"]["incomplete_details"]["reason"],
        "content_filter"
    );
    assert!(
        !payloads
            .iter()
            .any(|event| event["type"] == "response.completed"),
        "refusal must not become a completed turn: {body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_incomplete_tools_preserve_terminal_reason_and_full_calls() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for reason in [None, Some("content_filter"), Some("max_output_tokens")] {
        for mode in 0..4 {
            let mut expected = text_response(" exact partial text \n");
            let tool = json!({"type":"function_call","call_id":"call_original","name":"lookup",
                "arguments":"{\"q\":\" exact input \\n\"}"});
            expected["output"]
                .as_array_mut()
                .unwrap()
                .push(tool.clone());
            expected["usage"] = json!({"input_tokens":7,"output_tokens":3,"total_tokens":10});
            if let Some(reason) = reason {
                expected["status"] = json!("incomplete");
                expected["incomplete_details"] = json!({"reason":reason});
            }
            let (content_type, upstream) = if mode < 2 {
                ("application/json", expected.to_string())
            } else {
                let mut upstream = String::new();
                if mode == 3 {
                    for (index, item) in expected["output"].as_array().unwrap().iter().enumerate() {
                        upstream.push_str(&sse("response.output_item.done",
                            &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                    }
                }
                upstream.push_str(&response_sse(&expected));
                ("text/event-stream", upstream)
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, content_type, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let response = client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"incomplete tool terminal"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await;
            let response = response.expect("successful upstream must reach Anthropic client");
            assert_eq!(response.status(), StatusCode::OK);
            let media = response.headers()["content-type"]
                .to_str()
                .unwrap()
                .to_owned();
            let body = response
                .text()
                .await
                .expect("Anthropic response must complete");
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let expected_reason = match reason {
                Some("content_filter") => "refusal",
                Some("max_output_tokens") => "max_tokens",
                _ => "tool_use",
            };
            let (content, actual_reason) = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["usage"]["input_tokens"], 7);
                assert_eq!(value["usage"]["output_tokens"], 3);
                (
                    value["content"].as_array().unwrap().clone(),
                    value["stop_reason"].clone(),
                )
            } else {
                let frames = events(&body);
                let terminal = frames
                    .iter()
                    .find(|frame| frame["type"] == "message_delta")
                    .unwrap();
                assert_eq!(terminal["usage"]["output_tokens"], 3);
                assert_eq!(
                    frames
                        .iter()
                        .filter(|frame| frame["type"] == "message_stop")
                        .count(),
                    1
                );
                (
                    frames
                        .iter()
                        .filter(|frame| frame["type"] == "content_block_start")
                        .map(|frame| frame["content_block"].clone())
                        .collect(),
                    terminal["delta"]["stop_reason"].clone(),
                )
            };
            assert_eq!(
                actual_reason, expected_reason,
                "reason={reason:?} mode={mode}: {body}"
            );
            let tools: Vec<_> = content
                .iter()
                .filter(|part| part["type"] == "tool_use")
                .collect();
            assert_eq!(tools.len(), 1, "{body}");
            assert_eq!(tools[0]["id"], tool["call_id"], "{body}");
            assert_eq!(tools[0]["name"], tool["name"], "{body}");
            assert_eq!(tools[0]["input"], json!({"q":" exact input \n"}), "{body}");
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_incomplete_tools_preserve_terminal_reason_and_full_calls() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for reason in [None, Some("content_filter"), Some("max_output_tokens")] {
        for tool_count in [1, 2] {
            for mode in 0..4 {
                let mut expected = text_response(" exact partial text \n");
                let calls: Vec<_> = (0..tool_count)
                    .map(|index| json!({"type":"function_call","call_id":format!("call_{index}"),
                        "name":"lookup","arguments":if index == 0 {"{\"q\":\"first\"}"} else {"{\"q\":\"partial"}}))
                    .collect();
                expected["output"]
                    .as_array_mut()
                    .unwrap()
                    .extend(calls.clone());
                expected["usage"] = json!({"input_tokens":7,"output_tokens":3,"total_tokens":10});
                if let Some(reason) = reason {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":reason});
                }
                let (content_type, upstream) = if mode < 2 {
                    ("application/json", expected.to_string())
                } else {
                    let mut upstream = String::new();
                    if mode == 3 {
                        for (index, item) in
                            expected["output"].as_array().unwrap().iter().enumerate()
                        {
                            upstream.push_str(&sse("response.output_item.done",
                                &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                        }
                    }
                    upstream.push_str(&response_sse(&expected));
                    ("text/event-stream", upstream)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", "chat", StatusCode::OK, content_type, upstream).await;
                let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
                let response = client().post(&endpoint).json(&json!({"model":"test.test",
                    "messages":[{"role":"user","content":"incomplete tool terminal"}],"stream":mode != 0,
                    "stream_options":{"include_usage":true},"tools":[{"type":"function",
                    "function":{"name":"lookup","parameters":{"type":"object"}}}]})).send().await;
                let response = response.expect("successful upstream must reach Chat client");
                assert_eq!(response.status(), StatusCode::OK);
                let media = response.headers()["content-type"]
                    .to_str()
                    .unwrap()
                    .to_owned();
                let body = response.text().await.expect("Chat response must complete");
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let finish_reason = match reason {
                    Some("content_filter") => "content_filter",
                    Some("max_output_tokens") => "length",
                    _ => "tool_calls",
                };
                let (actual_calls, text) = if media.starts_with("application/json") {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(
                        value["choices"][0]["finish_reason"], finish_reason,
                        "reason={reason:?} tools={tool_count} mode={mode}: {body}"
                    );
                    assert_eq!(value["usage"]["total_tokens"], 10);
                    (
                        value["choices"][0]["message"]["tool_calls"]
                            .as_array()
                            .unwrap()
                            .clone(),
                        value["choices"][0]["message"]["content"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    )
                } else {
                    let frames = events(&body);
                    let terminals: Vec<_> = frames
                        .iter()
                        .filter_map(|frame| frame["choices"][0]["finish_reason"].as_str())
                        .collect();
                    assert_eq!(
                        terminals,
                        vec![finish_reason],
                        "reason={reason:?} tools={tool_count} mode={mode}: {body}"
                    );
                    assert!(
                        frames
                            .iter()
                            .any(|frame| frame["usage"]["total_tokens"] == 10),
                        "{body}"
                    );
                    assert!(body.trim_end().ends_with("data: [DONE]"), "{body}");
                    (
                        frames
                            .iter()
                            .filter_map(|frame| {
                                frame["choices"][0]["delta"]["tool_calls"].as_array()
                            })
                            .flatten()
                            .cloned()
                            .collect(),
                        frames
                            .iter()
                            .filter_map(|frame| frame["choices"][0]["delta"]["content"].as_str())
                            .collect::<String>(),
                    )
                };
                assert_eq!(text, " exact partial text \n", "{body}");
                assert_eq!(actual_calls.len(), calls.len(), "{body}");
                for (actual, original) in actual_calls.iter().zip(&calls) {
                    assert_eq!(actual["id"], original["call_id"], "{body}");
                    assert_eq!(actual["function"]["name"], original["name"], "{body}");
                    assert_eq!(
                        actual["function"]["arguments"], original["arguments"],
                        "{body}"
                    );
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

fn chat_tool_fixture(arguments: Value, finish_reason: &str, mode: usize) -> (&'static str, String) {
    let tool = json!({"id":"call_original","type":"function","function":{"name":"lookup","arguments":arguments}});
    let message =
        json!({"role":"assistant","content":" exact partial text \n","tool_calls":[tool]});
    if mode < 2 {
        return (
            "application/json",
            json!({"id":"chatcmpl-original","object":"chat.completion","model":"wire-test",
            "choices":[{"index":0,"message":message,"finish_reason":finish_reason}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
            .to_string(),
        );
    }
    let mut delta = message;
    delta["tool_calls"][0]["index"] = json!(0);
    let (first, tail) = if mode == 3 && delta["tool_calls"][0]["function"]["arguments"].is_string()
    {
        let raw = delta["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_owned();
        let cut = raw.len() / 2;
        delta["tool_calls"][0]["function"]["arguments"] = json!(&raw[..cut]);
        (
            delta,
            json!({"tool_calls":[{"index":0,"function":{"arguments":&raw[cut..]}}]}),
        )
    } else {
        (delta, json!({}))
    };
    let mut body = String::new();
    for (delta, reason) in [(first, Value::Null), (tail, json!(finish_reason))] {
        body.push_str(&format!(
            "data: {}\n\n",
            json!({"id":"chatcmpl-original","object":"chat.completion.chunk","model":"wire-test",
            "choices":[{"index":0,"delta":delta,"finish_reason":reason}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
        ));
    }
    body.push_str("data: [DONE]\n\n");
    ("text/event-stream", body)
}

#[tokio::test]
async fn responses_structured_tool_values_survive_chat_and_responses_clients() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let input = json!({"left":2,"right":3,"q":" exact input \n","nested":{"retain":[1,2]}});
    let domain = [
        Some(input.clone()),
        Some(json!(input.to_string())),
        Some(json!("{\"q\":")),
        Some(json!("")),
        Some(json!([1,{"keep":true}])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
        None,
    ];
    for raw in domain {
        for kind in ["function_call", "custom_tool_call"] {
            let field = if kind == "function_call" {
                "arguments"
            } else {
                "input"
            };
            for reason in [
                None,
                Some("provider_specific_reason"),
                Some("content_filter"),
                Some("max_output_tokens"),
            ] {
                for mode in 0..5 {
                    for target in ["chat", "responses"] {
                        eprintln!("R10 case kind={kind} raw={raw:?} reason={reason:?} mode={mode} target={target}");
                        let mut original = json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
                        if let Some(raw) = &raw {
                            original[field] = raw.clone();
                        }
                        let mut expected = text_response(" exact partial text \n");
                        expected["output"]
                            .as_array_mut()
                            .unwrap()
                            .push(original.clone());
                        if let Some(reason) = reason {
                            expected["status"] = json!("incomplete");
                            expected["incomplete_details"] = json!({"reason":reason});
                        }
                        let (media, upstream) = if mode < 2 {
                            ("application/json", expected.to_string())
                        } else {
                            let mut wire = String::new();
                            if mode == 3 {
                                for (index, item) in
                                    expected["output"].as_array().unwrap().iter().enumerate()
                                {
                                    wire.push_str(&sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                                }
                            }
                            let mut terminal = expected.clone();
                            if mode == 4 {
                                wire.push_str(&sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":0,"item":expected["output"][0]})));
                                let mut added = original.clone();
                                added.as_object_mut().unwrap().remove(field);
                                wire.push_str(&sse("response.output_item.added", &json!({"type":"response.output_item.added","output_index":1,"item":added})));
                                let event_type = if kind == "function_call" {
                                    "response.function_call_arguments.done"
                                } else {
                                    "response.custom_tool_call_input.done"
                                };
                                let mut done = json!({"type":event_type,"item_id":"fc_original","output_index":1});
                                if let Some(raw) = &raw {
                                    done[field] = raw.clone();
                                }
                                wire.push_str(&sse(event_type, &done));
                                terminal.as_object_mut().unwrap().remove("output");
                            }
                            wire.push_str(&response_sse(&terminal));
                            ("text/event-stream", wire)
                        };
                        let (endpoint, handle, mut captures, shutdown) =
                            start_entry("responses", "chat", StatusCode::OK, media, upstream).await;
                        let endpoint = if target == "chat" {
                            endpoint.replace("/v1/responses", "/v1/chat/completions")
                        } else {
                            endpoint
                        };
                        let request = if target == "chat" {
                            json!({"model":"test.test","messages":[{"role":"user","content":"complete original input"}],"stream":mode != 0,
                                "stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]})
                        } else {
                            json!({"model":"test.test","input":"complete original input","stream":mode != 0,"tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]})
                        };
                        let (media, body) = successful_transfer(
                            client().post(&endpoint).json(&request).send().await,
                        )
                        .await;
                        assert_one_attempt(&mut captures, "wire-test").await;
                        if target == "responses" {
                            let returned = if media.starts_with("application/json") {
                                serde_json::from_str::<Value>(&body).unwrap()
                            } else {
                                events(&body)
                                    .into_iter()
                                    .filter_map(|event| event.get("response").cloned())
                                    .last()
                                    .expect("complete terminal response")
                            };
                            let actual = returned["output"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|item| item["type"] == kind)
                                .unwrap();
                            match (original.get(field), actual.get(field)) {
                                (Some(original), Some(Value::String(actual)))
                                    if !original.is_string() && kind == "function_call" =>
                                {
                                    assert_eq!(
                                        serde_json::from_str::<Value>(actual).unwrap(),
                                        *original,
                                        "mode={mode}: {body}"
                                    );
                                }
                                _ => assert_eq!(
                                    actual.get(field),
                                    original.get(field),
                                    "kind={kind} raw={raw:?} reason={reason:?} mode={mode}: {body}"
                                ),
                            }
                        } else {
                            let calls: Vec<Value> = if media.starts_with("application/json") {
                                let value: Value = serde_json::from_str(&body).unwrap();
                                value["choices"][0]["message"]["tool_calls"]
                                    .as_array()
                                    .unwrap()
                                    .clone()
                            } else {
                                events(&body)
                                    .iter()
                                    .filter_map(|event| {
                                        event["choices"][0]["delta"]["tool_calls"].as_array()
                                    })
                                    .flatten()
                                    .cloned()
                                    .collect()
                            };
                            assert_eq!(calls.len(), 1, "{body}");
                            let call = &calls[0];
                            assert_eq!(call["id"], "call_original");
                            assert_eq!(call["function"]["name"], "lookup");
                            let serialized = raw.as_ref().map(|value| {
                                if kind == "custom_tool_call" {
                                    json!({"input":value}).to_string()
                                } else {
                                    value
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| value.to_string())
                                }
                            });
                            if kind == "custom_tool_call" {
                                assert_eq!(
                                    call["routecodex_chat_extension"]["responses_tool_call_type"],
                                    "custom_tool_call",
                                    "{body}"
                                );
                            }
                            match &serialized {
                                Some(serialized) => assert_eq!(call["function"]["arguments"], *serialized, "kind={kind} raw={raw:?} reason={reason:?} mode={mode}: {body}"),
                                None => assert!(call["function"].get("arguments").is_none(), "missing original parameters must stay absent: kind={kind} mode={mode}: {body}"),
                            }
                            if kind == "function_call"
                                && (raw.as_ref() == Some(&input)
                                    || raw.as_ref() == Some(&json!(input.to_string())))
                            {
                                let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({sum:a.left+a.right,q:a.q,nested:a.nested}));",serialized.as_deref().expect("complete original parameters")]).output().unwrap();
                                assert!(execution.status.success());
                                let output = String::from_utf8(execution.stdout).unwrap();
                                assert_eq!(
                                    serde_json::from_str::<Value>(&output).unwrap(),
                                    json!({"sum":5,"q":" exact input \n","nested":{"retain":[1,2]}})
                                );
                                let mut followup = request.clone();
                                followup["messages"] = json!([{"role":"user","content":"complete original input"},{"role":"assistant","tool_calls":calls},
                                    {"role":"tool","tool_call_id":"call_original","content":output}]);
                                let (_, completed) = successful_transfer(
                                    client().post(&endpoint).json(&followup).send().await,
                                )
                                .await;
                                assert!(
                                    completed.contains("mixed roundtrip complete"),
                                    "{completed}"
                                );
                                let wire = captures
                                    .recv()
                                    .await
                                    .expect("actual client result reaches Responses provider");
                                let result = wire["input"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .find(|item| item["type"] == "function_call_output")
                                    .unwrap();
                                assert_eq!(result["call_id"], "call_original");
                                assert_eq!(result["output"], output);
                                assert!(matches!(
                                    captures.try_recv(),
                                    Err(mpsc::error::TryRecvError::Empty)
                                ));
                            }
                        }
                        stop_entry(handle, shutdown).await;
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_tools_preserve_filter_and_length_terminals() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (finish, expected) in [
        ("tool_calls", "tool_use"),
        ("content_filter", "refusal"),
        ("length", "max_tokens"),
        ("max_tokens", "max_tokens"),
        ("max_output_tokens", "max_tokens"),
    ] {
        for mode in 0..4 {
            let (media, upstream) =
                chat_tool_fixture(json!("{\"q\":\" exact input \\n\"}"), finish, mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let response = client()
                .post(endpoint.replace("/v1/responses", "/v1/messages"))
                .json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"chat tool terminal"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]}))
                .send()
                .await;
            let (media, body) = successful_transfer(response).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let (reason, content) = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["usage"]["input_tokens"], 7);
                assert_eq!(value["usage"]["output_tokens"], 3);
                (
                    value["stop_reason"].clone(),
                    value["content"].as_array().unwrap().clone(),
                )
            } else {
                let frames = events(&body);
                assert_eq!(
                    frames
                        .iter()
                        .filter(|f| f["type"] == "message_stop")
                        .count(),
                    1
                );
                let terminal = frames
                    .iter()
                    .find(|f| f["type"] == "message_delta")
                    .unwrap();
                assert_eq!(terminal["usage"]["output_tokens"], 3);
                (terminal["delta"]["stop_reason"].clone(), {
                    let mut content: Vec<Value> = frames
                        .iter()
                        .filter(|f| f["type"] == "content_block_start")
                        .map(|f| f["content_block"].clone())
                        .collect();
                    content[0]["text"] = json!(frames
                        .iter()
                        .filter_map(|f| f["delta"]["text"].as_str())
                        .collect::<String>());
                    content
                })
            };
            assert_eq!(reason, expected, "finish={finish} mode={mode}: {body}");
            assert_eq!(content[0]["text"], " exact partial text \n", "{body}");
            assert_eq!(
                content[1],
                json!({"type":"tool_use","id":"call_original","name":"lookup","input":{"q":" exact input \n"}}),
                "{body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_provider_missing_arguments_stay_absent_at_client_boundary() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for provider_stream in [false, true] {
        for target in ["responses", "chat"] {
            for client_stream in [false, true] {
                if provider_stream && !client_stream {
                    continue;
                }
                eprintln!("R12 Chat missing provider_stream={provider_stream} target={target} client_stream={client_stream}");
                let call =
                    json!({"id":"call_original","type":"function","function":{"name":"lookup"}});
                let (media, wire) = if provider_stream {
                    (
                        "text/event-stream",
                        format!(
                            "{}{}data: [DONE]\n\n",
                            sse(
                                "message",
                                &json!({"id":"chat_missing","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_original","type":"function","function":{"name":"lookup"}}]},"finish_reason":null}]})
                            ),
                            sse(
                                "message",
                                &json!({"id":"chat_missing","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                            )
                        ),
                    )
                } else {
                    ("application/json", json!({"id":"chat_missing","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]}).to_string())
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, wire).await;
                let response = if target == "chat" {
                    client().post(endpoint.replace("/v1/responses", "/v1/chat/completions")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"missing parameters"}],"stream":client_stream})).send().await
                } else {
                    client().post(&endpoint).json(&json!({"model":"test.test","input":"missing parameters","stream":client_stream})).send().await
                };
                let (media, body) = successful_transfer(response).await;
                if target == "responses" {
                    let returned = if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        body.lines()
                            .filter_map(|line| line.strip_prefix("data:"))
                            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                            .filter_map(|v| v.get("response").cloned())
                            .last()
                            .unwrap()
                    };
                    let actual = returned["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|v| v["type"] == "function_call")
                        .unwrap();
                    assert!(
                        actual.get("arguments").is_none(),
                        "provider_stream={provider_stream} client_stream={client_stream}: {body}"
                    );
                    assert_eq!(actual["call_id"], "call_original");
                } else if media.starts_with("application/json") {
                    let returned: Value = serde_json::from_str(&body).unwrap();
                    assert!(
                        returned["choices"][0]["message"]["tool_calls"][0]["function"]
                            .get("arguments")
                            .is_none(),
                        "{body}"
                    );
                } else {
                    for frame in body
                        .lines()
                        .filter_map(|line| line.strip_prefix("data:"))
                        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                    {
                        if let Some(calls) = frame["choices"][0]["delta"]["tool_calls"].as_array() {
                            for actual in calls {
                                assert!(actual["function"].get("arguments").is_none(), "{body}");
                            }
                        }
                    }
                }
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn unrepresentable_anthropic_tools_do_not_cool_a_healthy_provider_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["openai_chat", "responses", "responses_absent_custom"] {
        for mode in 0..4 {
            let (media, upstream) = if kind == "openai_chat" {
                chat_tool_fixture(json!("{\"q\":"), "tool_calls", mode)
            } else {
                let mut value = json!({"id":"resp-invalid","object":"response","status":"completed","model":"wire-test","output":[{"type":"function_call","id":"fc-invalid","call_id":"call_original","name":"lookup","arguments":"{\"q\":"}]});
                if kind == "responses_absent_custom" {
                    value["output"][0] = json!({"type":"custom_tool_call","id":"fc-invalid","call_id":"call_original","name":"lookup"});
                }
                if mode < 2 {
                    ("application/json", value.to_string())
                } else {
                    ("text/event-stream", response_sse(&value))
                }
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry_with_health(
                if kind == "responses_absent_custom" {
                    "responses"
                } else {
                    kind
                },
                "chat",
                StatusCode::OK,
                media,
                upstream,
                true,
            )
            .await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let base = endpoint.strip_suffix("/v1/messages").unwrap();
            let preflight = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":"representation-preflight"}],"stream":mode != 0});
            let (_, body) =
                successful_transfer(client().post(&endpoint).json(&preflight).send().await).await;
            assert!(body.contains("representation-valid-completion"), "{body}");
            let before: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                before["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["provider_id"] != "test"),
                "baseline healthy identity: {before}"
            );
            for index in 0..2 {
                let request = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":format!("representation-invalid-{index}")}],"stream":mode != 0});
                assert_incomplete_transport(client().post(&endpoint).json(&request).send().await)
                    .await;
            }
            let pool: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                pool["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["provider_id"] != "test"),
                "local tool projection must not cool provider: kind={kind} mode={mode} pool={pool}"
            );
            let request = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":"representation-valid-request"}],"stream":mode != 0});
            let (_, body) =
                successful_transfer(client().post(&endpoint).json(&request).send().await).await;
            assert!(body.contains("representation-valid-completion"), "{body}");
            stop_entry(handle, shutdown).await;
            let mut business = Vec::new();
            while let Ok(wire) = captures.try_recv() {
                if wire.to_string().contains("representation-") {
                    business.push(wire);
                }
            }
            for marker in [
                "representation-preflight",
                "representation-invalid-0",
                "representation-invalid-1",
                "representation-valid-request",
            ] {
                assert_eq!(
                    business
                        .iter()
                        .filter(|wire| wire.to_string().contains(marker))
                        .count(),
                    1,
                    "same identity reaches upstream once per request: {business:?}"
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_unrepresentable_arguments_never_execute_empty_input() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for raw in [
        json!("{\"q\":"),
        json!(""),
        json!("null"),
        json!("[]"),
        json!("true"),
        json!("7"),
        json!([]),
        Value::Null,
        json!(true),
        json!(7),
    ] {
        for mode in 0..4 {
            let (media, upstream) = chat_tool_fixture(raw.clone(), "tool_calls", mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let response = client().post(endpoint.replace("/v1/responses", "/v1/messages")).json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"unrepresentable tool input"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await;
            assert_incomplete_transport(response).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_complete_argument_objects_execute_and_follow_up_exactly() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let input = json!({"q":" exact input \n", "nested":{"retain":[1,2]}, "left":2,"right":3});
    for raw in [json!(input.to_string()), input.clone()] {
        for mode in 0..4 {
            let (media, upstream) = chat_tool_fixture(raw.clone(), "tool_calls", mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let user = json!({"role":"user","content":"complete tool input"});
            let tools = json!([{"name":"lookup","input_schema":{"type":"object"}}]);
            let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,"messages":[user],"stream":mode != 0,"tools":tools})).send().await).await;
            let content: Vec<Value> = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["stop_reason"], "tool_use");
                value["content"].as_array().unwrap().clone()
            } else {
                events(&body)
                    .into_iter()
                    .filter(|f| f["type"] == "content_block_start")
                    .map(|f| f["content_block"].clone())
                    .collect()
            };
            let call = content
                .iter()
                .find(|b| b["type"] == "tool_use")
                .expect("complete original tool");
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["name"], "lookup");
            assert_eq!(call["input"], input, "raw={raw} mode={mode}: {body}");
            assert_one_attempt(&mut captures, "wire-test").await;
            let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify({sum:a.left+a.right,q:a.q,nested:a.nested}));",&call["input"].to_string()]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"sum":5,"q":" exact input \n","nested":{"retain":[1,2]}})
            );
            let (media, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,"stream":mode != 0,"tools":tools,
                "messages":[user,{"role":"assistant","content":[call]},{"role":"user","content":[{"type":"tool_result","tool_use_id":call["id"],"content":output}]}]})).send().await).await;
            stop_entry(handle, shutdown).await;
            let wire = captures
                .recv()
                .await
                .expect("matching actual result reaches Chat provider");
            let messages = wire["messages"].as_array().unwrap();
            let original = messages
                .iter()
                .find_map(|m| m["tool_calls"].as_array())
                .unwrap();
            assert_eq!(original[0]["id"], call["id"]);
            assert_eq!(original[0]["function"]["name"], call["name"]);
            assert_eq!(
                serde_json::from_str::<Value>(
                    original[0]["function"]["arguments"].as_str().unwrap()
                )
                .unwrap(),
                input
            );
            let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
            assert_eq!(result["tool_call_id"], call["id"]);
            assert_eq!(result["content"], output);
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
            if media.starts_with("application/json") {
                let final_message: Value = serde_json::from_str(&completed).unwrap();
                assert_eq!(final_message["stop_reason"], "end_turn");
                assert_eq!(
                    final_message["content"][0]["text"],
                    "chat roundtrip complete"
                );
            } else {
                let frames = events(&completed);
                assert_eq!(
                    frames
                        .iter()
                        .filter_map(|f| f["delta"]["text"].as_str())
                        .collect::<String>(),
                    "chat roundtrip complete"
                );
                assert!(frames
                    .iter()
                    .any(|f| f["delta"]["stop_reason"] == "end_turn"));
                assert_eq!(
                    frames
                        .iter()
                        .filter(|f| f["type"] == "message_stop")
                        .count(),
                    1
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_custom_calls_execute_and_return_original_kind_and_input() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let previous =
        json!({"type":"tool_use","id":"call_original","name":"lookup","input":{"previous":1}});
    let previous_execution = std::process::Command::new("node").args([
        "-e", "const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:c.input}));", &previous.to_string()
    ]).output().unwrap();
    assert!(previous_execution.status.success());
    let previous_output = String::from_utf8(previous_execution.stdout).unwrap();
    for value in [
        json!({"q":1,"nested":{"input":"keep"}}),
        json!({"input":"natural object field"}),
        json!([1,{"keep":true}]),
        Value::Null,
        json!(true),
        json!(7),
        json!(7.25),
        json!(" exact input \n"),
        json!(""),
    ] {
        for mode in 0..4 {
            let item = json!({"type":"custom_tool_call","id":"custom_original","call_id":"call_original","name":"lookup","input":value});
            let mut response = text_response("execute actual custom call");
            response["output"] = json!([item]);
            let (media, wire) = if mode < 2 {
                ("application/json", response.to_string())
            } else {
                let prior = if mode == 3 {
                    sse(
                        "response.output_item.done",
                        &json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    )
                } else {
                    String::new()
                };
                ("text/event-stream", prior + &response_sse(&response))
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, media, wire).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let tools = json!([{"name":"lookup","input_schema":{"type":"object"}}]);
            let (media, body) = successful_transfer(
                client()
                    .post(&endpoint)
                    .json(&json!({
                        "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                        "messages":[{"role":"user","content":"execute custom"}]
                    }))
                    .send()
                    .await,
            )
            .await;
            let content: Vec<Value> = if media.starts_with("application/json") {
                serde_json::from_str::<Value>(&body).unwrap()["content"]
                    .as_array()
                    .unwrap()
                    .clone()
            } else {
                events(&body)
                    .into_iter()
                    .filter(|event| event["type"] == "content_block_start")
                    .map(|event| event["content_block"].clone())
                    .collect()
            };
            let call = content
                .iter()
                .find(|part| part["type"] == "tool_use")
                .unwrap()
                .clone();
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["name"], "lookup");
            let projected = if value.is_object() {
                value.clone()
            } else {
                json!({"input":value})
            };
            assert_eq!(call["input"], projected, "mode={mode}: {body}");
            assert_one_attempt(&mut captures, "wire-test").await;
            let execution = std::process::Command::new("node").args([
                "-e","const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:c.input}));", &call.to_string()
            ]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":projected})
            );
            let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({
                "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                "messages":[{"role":"user","content":"execute custom"},
                    {"role":"assistant","content":[previous]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":previous_output}]},
                    {"role":"assistant","content":[call]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":output}]}]
            })).send().await).await;
            assert!(
                completed.contains("mixed roundtrip complete"),
                "{completed}"
            );
            stop_entry(handle, shutdown).await;
            let wire = captures.recv().await.unwrap();
            let input = wire["input"].as_array().unwrap();
            let sent = input
                .iter()
                .find(|part| part["type"] == "custom_tool_call")
                .unwrap_or_else(|| panic!("custom call kind lost mode={mode}: {wire}"));
            assert_eq!(sent["id"], item["id"], "{wire}");
            assert_eq!(sent["call_id"], item["call_id"], "{wire}");
            assert_eq!(sent["name"], item["name"], "{wire}");
            assert_eq!(sent["input"], value, "mode={mode}: {wire}");
            let result = input
                .iter()
                .find(|part| part["type"] == "custom_tool_call_output")
                .unwrap_or_else(|| panic!("custom result kind lost: {wire}"));
            assert_eq!(result["call_id"], "call_original");
            assert_eq!(result["output"], output);
            assert!(
                input
                    .iter()
                    .any(|part| part["type"] == "function_call_output"
                        && part["output"] == previous_output),
                "{wire}"
            );
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
            for target in ["openai_chat", "anthropic"] {
                let completed = if target == "openai_chat" {
                    json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"custom followup complete"},"finish_reason":"stop"}]})
                } else {
                    json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"custom followup complete"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
                };
                let (next, next_handle, mut next_captures, next_shutdown) = start_entry(
                    target,
                    "chat",
                    StatusCode::OK,
                    "application/json",
                    completed.to_string(),
                )
                .await;
                let next = next.replace("/v1/responses", "/v1/messages");
                let (_, body) = successful_transfer(client().post(next).json(&json!({
                    "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                    "messages":[{"role":"user","content":"execute custom"},
                        {"role":"assistant","content":[call]},
                        {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":output}]}]
                })).send().await).await;
                assert!(
                    body.contains(if target == "openai_chat" {
                        "chat roundtrip complete"
                    } else {
                        "custom followup complete"
                    }),
                    "{body}"
                );
                stop_entry(next_handle, next_shutdown).await;
                let wire = next_captures.recv().await.unwrap();
                let messages = wire["messages"].as_array().unwrap();
                if target == "openai_chat" {
                    let sent = messages
                        .iter()
                        .find_map(|m| m["tool_calls"].as_array())
                        .unwrap()
                        .first()
                        .unwrap();
                    assert_eq!(sent["id"], "call_original");
                    assert_eq!(sent["function"]["name"], "lookup");
                    assert_eq!(
                        serde_json::from_str::<Value>(
                            sent["function"]["arguments"].as_str().unwrap()
                        )
                        .unwrap(),
                        json!({"input":value}),
                        "{wire}"
                    );
                    let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                    assert_eq!(result["tool_call_id"], "call_original");
                    assert_eq!(result["content"], output);
                } else {
                    let blocks: Vec<&Value> = messages
                        .iter()
                        .flat_map(|m| m["content"].as_array().unwrap())
                        .collect();
                    let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                    assert_eq!(sent["id"], "call_original");
                    assert_eq!(sent["name"], "lookup");
                    assert_eq!(sent["input"], json!({"input":value}), "{wire}");
                    let result = blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                    assert_eq!(result["tool_use_id"], "call_original");
                    assert_eq!(result["content"], output);
                }
                assert!(matches!(
                    next_captures.try_recv(),
                    Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
                ));
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_responses_custom_inputs_preserve_every_present_json_value() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let values = [
        json!({"q":" exact input \n","nested":[1,2]}),
        json!([1,{"keep":true}]),
        Value::Null,
        json!(true),
        json!(7),
        json!("{\"q\":\"exact\"}"),
        json!("{\"q\":"),
        json!(""),
    ];
    for value in values {
        for reason in [
            None,
            Some("provider_specific_reason"),
            Some("content_filter"),
            Some("max_output_tokens"),
        ] {
            for mode in 0..4 {
                let item = json!({"type":"custom_tool_call","call_id":"call_original","name":"lookup","input":value});
                let mut expected = text_response(" exact text \n");
                expected["output"]
                    .as_array_mut()
                    .unwrap()
                    .push(item.clone());
                if let Some(reason) = reason {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":reason});
                }
                let (media, wire) = if mode < 2 {
                    ("application/json", expected.to_string())
                } else {
                    let mut wire = String::new();
                    if mode == 3 {
                        wire.push_str(&sse("response.output_item.done",&json!({"type":"response.output_item.done","output_index":1,"item":item})));
                    }
                    wire.push_str(&response_sse(&expected));
                    ("text/event-stream", wire)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", "chat", StatusCode::OK, media, wire).await;
                let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
                let (media,body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,
                    "messages":[{"role":"user","content":"preserve complete custom input"}],"stream":mode != 0,"tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await).await;
                let content: Vec<Value> = if media.starts_with("application/json") {
                    serde_json::from_str::<Value>(&body).unwrap()["content"]
                        .as_array()
                        .unwrap()
                        .clone()
                } else {
                    events(&body)
                        .iter()
                        .filter(|event| event["type"] == "content_block_start")
                        .map(|event| event["content_block"].clone())
                        .collect()
                };
                let call = content
                    .iter()
                    .find(|block| block["type"] == "tool_use")
                    .unwrap();
                assert_eq!(call["id"], "call_original");
                assert_eq!(call["name"], "lookup");
                assert_eq!(
                    call["input"],
                    if value.is_object() {
                        value.clone()
                    } else {
                        json!({"input":value})
                    },
                    "reason={reason:?} mode={mode}: {body}"
                );
                assert_one_attempt(&mut captures, "wire-test").await;
                stop_entry(handle, shutdown).await;
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_preserves_each_responses_output_item_without_repetition() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let message = |text: &str| text_response(text)["output"][0].clone();
    let reasoning =
        json!({"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]});
    let tool = json!({"type":"function_call","call_id":"call_item","name":"lookup","arguments":"{\"q\":\"alpha\"}"});
    for layout in 0..4 {
        let (items, mut upstream, expected, expected_reasoning, has_tool) = match layout {
            0 => (vec![message("body")], String::new(), "body", "", false),
            1 => (
                vec![message("first"), message("second")],
                sse(
                    "response.output_text.delta",
                    &json!({"type":"response.output_text.delta","output_index":0,"delta":"first"}),
                ),
                "firstsecond",
                "",
                false,
            ),
            2 => (
                vec![tool.clone(), message("body")],
                String::new(),
                "body",
                "",
                true,
            ),
            _ => (
                vec![reasoning.clone(), message("body")],
                sse(
                    "response.reasoning_summary_text.delta",
                    &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking"}),
                ),
                "bodyextra",
                "thinking",
                false,
            ),
        };
        for (index, item) in items.iter().enumerate() {
            upstream.push_str(&sse(
                "response.output_item.done",
                &json!({"type":"response.output_item.done","output_index":index,"item":item}),
            ));
        }
        let mut output = if layout == 0 { vec![] } else { items };
        if layout == 3 {
            output.push(message("extra"));
        }
        upstream.push_str(&response_sse(&json!({"status":"incomplete","output":output,"usage":{"input_tokens":3,"output_tokens":2}})));
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
        let response = client().post(&endpoint).json(&json!({"model":"test.test","messages":[{"role":"user","content":"indexed output"}],"stream":true,"stream_options":{"include_usage":true}})).send().await;
        let body = successful_body(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let frames = events(&body);
        let text = |field: &str| {
            frames
                .iter()
                .filter_map(|frame| frame["choices"][0]["delta"][field].as_str())
                .collect::<String>()
        };
        assert_eq!(text("content"), expected, "layout {layout}: {body}");
        assert_eq!(
            text("reasoning_content"),
            expected_reasoning,
            "layout {layout}: {body}"
        );
        let calls: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["tool_calls"].as_array())
            .flatten()
            .collect();
        assert_eq!(
            calls.len(),
            usize::from(has_tool),
            "layout {layout}: {body}"
        );
        if has_tool {
            assert_eq!(calls[0]["function"]["arguments"], tool["arguments"]);
        }
        assert!(
            frames
                .iter()
                .any(|frame| frame["choices"][0]["finish_reason"]
                    == if has_tool { "tool_calls" } else { "stop" }),
            "{body}"
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame["usage"]["total_tokens"] == 5),
            "{body}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_multiple_reasoning_summary_parts_are_returned_once() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let item = json!({"type":"reasoning","summary":[{"type":"summary_text","text":"A"},{"type":"summary_text","text":"B"}]});
    let upstream = [
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"A"})),
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":1,"delta":"B"})),
        sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":0,"item":item})),
        response_sse(&json!({"status":"completed","output":[item]})),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let response = client().post(endpoint.replace("/v1/responses", "/v1/chat/completions")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"summary"}],"stream":true})).send().await;
    let body = successful_body(response).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    assert_eq!(
        events(&body)
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["reasoning_content"].as_str())
            .collect::<String>(),
        "A\nB",
        "{body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_entry_retains_chat_text_and_refusal_together() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    for stream in [false, true] {
        let (content_type, wire) = if stream {
            ("text/event-stream", upstream.clone())
        } else {
            ("application/json", json!({"id":"chat_mixed","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":"content_filter"}]}).to_string())
        };
        let (endpoint, handle, mut captures, shutdown) =
            start_entry("openai_chat", "chat", StatusCode::OK, content_type, wire).await;
        let response = client().post(endpoint.replace("/v1/responses", "/v1/messages")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"mixed refusal"}],"max_tokens":128,"stream":stream})).send().await;
        let (content_type, body) = successful_transfer(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let text = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| {
                    frame["delta"]["text"]
                        .as_str()
                        .or_else(|| frame["content_block"]["text"].as_str())
                })
                .collect::<String>()
        };
        assert_eq!(
            text, " partial answer  cannot continue ",
            "stream={stream}: {body}"
        );
        let thinking = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["thinking"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| frame["delta"]["thinking"].as_str())
                .collect::<String>()
        };
        assert_eq!(thinking, " preserved reasoning ", "stream={stream}: {body}");
    }
    std::env::remove_var(KEY_ENV);
}

async fn assert_incomplete_transport(result: Result<reqwest::Response, reqwest::Error>) {
    match result {
        Err(error) => assert!(
            !error.is_timeout() && !error.is_connect(),
            "must terminate admitted request, not time out/connect fail: {error}"
        ),
        Ok(mut response) => {
            assert_eq!(response.status(), StatusCode::OK, "no client HTTP error");
            let mut body = Vec::new();
            let incomplete = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break false,
                    Err(error) => {
                        assert!(!error.is_timeout(), "failure terminates promptly");
                        break true;
                    }
                }
            };
            let body = String::from_utf8(body).unwrap();
            assert!(
                !body.contains("provider secret error body")
                    && !body.contains("QSA pooled hold")
                    && !body.contains("controlled native error")
                    && !body.contains("response.failed")
                    && !body.contains("response.completed")
                    && !body.contains("event: error")
                    && !body.contains("\"error\""),
                "failure leaked or became fake success: {body}"
            );
            assert!(
                incomplete,
                "terminal failure requires incomplete transfer: {body}"
            );
        }
    }
}
/// HTTP500 and native HTTP200 SSE errors are distinct failure controls. Neither
/// may become a client error or a fabricated completion; independent traffic lives.
#[tokio::test]
async fn genuine_http_and_native_sse_errors_break_transport_without_client_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (kind, process) in [
        ("responses", "direct"),
        ("responses", "chat"),
        ("openai_chat", "chat"),
        ("anthropic", "chat"),
    ] {
        let mut failures = vec![
            (
                StatusCode::BAD_GATEWAY,
                "application/json",
                json!({"error":{"type":"server_error","message":"QSA pooled hold 46846 rows; resizing to 20480 would cut them"}})
                    .to_string(),
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "application/json",
                json!({"error":{"type":"server_error","message":"provider secret error body"}})
                    .to_string(),
            ),
            (
                StatusCode::OK,
                "text/event-stream",
                sse(
                    "error",
                    &json!({"type":"error","error":{"type":"server_error","message":"controlled native error"}}),
                ),
            ),
        ];
        if kind == "responses" {
            failures.push((StatusCode::OK, "text/event-stream", sse("response.failed",
                &json!({"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"code":"server_error","message":"controlled native error"},"output":[]}}))));
        } else if kind == "openai_chat" {
            failures.push((
                StatusCode::OK,
                "text/event-stream",
                format!(
                    "data: {}\n\n",
                    json!({"error":{"type":"server_error","message":"controlled native error"}})
                ),
            ));
        }
        for (status, content_type, upstream) in failures {
            let (endpoint, handle, mut captures, shutdown) =
                start_entry(kind, process, status, content_type, upstream).await;
            let client = client();
            assert_incomplete_transport(post_request(&client, &endpoint, "test.test").await).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let body =
                successful_body(post_request(&client, &endpoint, "independent.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-independent").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("independent request completes");
            assert_eq!(
                terminal["response"]["output"],
                text_response("independent ok")["output"]
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}
