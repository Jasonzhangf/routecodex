use super::*;

const MARKER: &str = "anthropic invalid custom case ";
const ERROR: &str = "client argument error: expected two integer operands separated by +";

struct Case {
    custom: bool,
    namespace: Option<&'static str>,
    value: Value,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            custom: true,
            namespace: None,
            value: json!({"input":"raw","extra":true}),
        },
        Case {
            custom: true,
            namespace: Some(NESTED_NAMESPACE),
            value: json!({"input":{"patch":"raw"}}),
        },
        Case {
            custom: false,
            namespace: Some(ORDINARY_NAMESPACE),
            value: json!({"input":"raw"}),
        },
        Case {
            custom: true,
            namespace: Some(NESTED_NAMESPACE),
            value: json!({"input":CUSTOM_INPUT}),
        },
        Case {
            custom: true,
            namespace: Some(NESTED_NAMESPACE),
            value: json!({"input":"raw","extra":true,"reason":"why"}),
        },
        Case {
            custom: true,
            namespace: Some(NESTED_NAMESPACE),
            value: json!({"input":CUSTOM_INPUT,"reason":"why","goal_alignment_confidence":97,"model_id":"legacy-model"}),
        },
    ]
}

impl Case {
    fn leaf(&self) -> &'static str {
        if self.custom {
            CUSTOM_LEAF
        } else {
            FUNCTION_LEAF
        }
    }
    fn description(&self) -> &'static str {
        if self.custom {
            CUSTOM_DESCRIPTION
        } else {
            FUNCTION_DESCRIPTION
        }
    }
    fn client_input(&self) -> String {
        if self.custom && self.value["input"] == CUSTOM_INPUT {
            CUSTOM_INPUT.into()
        } else {
            self.value.to_string()
        }
    }
    fn tools(&self) -> Value {
        let tool = if self.custom {
            json!({"type":"custom","name":self.leaf(),"description":self.description(),"format":{"type":"text"}})
        } else {
            json!({"type":"function","name":self.leaf(),"description":self.description(),"parameters":{"type":"object","properties":{"left":{"type":"integer"},"right":{"type":"integer"}},"required":["left","right"]}})
        };
        match self.namespace {
            Some(namespace) => json!([{"type":"namespace","name":namespace,"tools":[tool]}]),
            None => json!([tool]),
        }
    }
}

// Validate the actual local arithmetic contract. Malformed custom text is
// consumed as delivered; JSON parsing cannot repair it into a valid command.
fn consume(call: &Value) -> String {
    let result = if call["type"] == "custom_tool_call" {
        call["input"]
            .as_str()
            .and_then(|text| text.split_once('+'))
            .and_then(|(a, b)| Some(a.parse::<i64>().ok()? + b.parse::<i64>().ok()?))
    } else {
        call["arguments"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|args| Some(args["left"].as_i64()? + args["right"].as_i64()?))
    };
    let receipt = result
        .map(|sum| sum.to_string())
        .unwrap_or_else(|| ERROR.into());
    eprintln!(
        "EVIDENCE_ANTHROPIC_CONSUMER call_id={} input={} output={receipt}",
        call["call_id"], call
    );
    receipt
}

fn blocks(body: &Value) -> Vec<&Value> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .collect()
}

pub(super) fn answer(body: &Value, declared: &HashMap<String, String>) -> Option<Response<Body>> {
    let marker = request_marker(body);
    let suffix = marker.split_once(MARKER)?.1;
    let index = suffix.chars().next()?.to_digit(10)? as usize;
    let cases = cases();
    let case = cases.get(index)?;
    let id = format!("toolu_invalid_{index}");
    let mut violations = upstream_violations(Target::Anthropic, body);
    let wire = declared.get(case.description());
    if wire.is_none()
        || declared.len() != 1
        || forced_choice_name(Target::Anthropic, body).as_ref() != wire
    {
        violations.push(format!("declaration/choice mismatch: {body}"));
    }
    let tool = body["tools"].as_array().and_then(|tools| tools.first());
    if !tool.is_some_and(|tool| {
        tool["input_schema"]["type"] == "object"
            && if case.custom {
                tool["input_schema"]["properties"]["input"]["type"] == "string"
            } else {
                tool["input_schema"]["properties"]["left"]["type"] == "integer"
            }
    }) {
        violations.push(format!("declared tool schema lost: {body}"));
    }
    let history = blocks(body);
    let followup = has_tool_result(body);
    if followup {
        let calls: Vec<_> = history
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .collect();
        let results: Vec<_> = history
            .iter()
            .filter(|block| block["type"] == "tool_result")
            .collect();
        let expected_input = if case.custom {
            json!({"input":case.client_input()})
        } else {
            case.value.clone()
        };
        let expected_receipt = if index == 3 || index == 5 {
            "42"
        } else {
            ERROR
        };
        if calls.len() != 1
            || results.len() != 1
            || calls[0]["id"] != id
            || calls[0]["name"].as_str() != wire.map(String::as_str)
            || calls[0]["input"] != expected_input
            || results[0]["tool_use_id"] != id
            || !request_marker(&json!({"messages":[{"content":results[0]["content"]}]}))
                .contains(expected_receipt)
        {
            violations.push(format!(
                "exact client string and paired consumer receipt lost: {body}"
            ));
        }
    } else if !history.iter().all(|block| block["type"] != "tool_use") {
        violations.push("first turn unexpectedly contained call history".into());
    }
    if !violations.is_empty() {
        return Some(
            Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"error":{"message":violations.join("; ")}}).to_string(),
                ))
                .unwrap(),
        );
    }
    if followup {
        return Some(json_response(
            Target::Anthropic,
            declared,
            ResponseShape::Text,
        ));
    }
    let call = json!({"type":"tool_use","id":id,"name":wire.unwrap(),"input":case.value});
    if body["stream"] == true {
        let mut frames = vec![
            json!({"type":"message_start","message":{"id":"msg_invalid_sse","type":"message","role":"assistant","model":Target::Anthropic.wire_model(),"content":[],"stop_reason":null}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":id,"name":wire.unwrap(),"input":{}}}),
        ];
        let input = case.value.to_string();
        let split = input.len() / 2;
        for partial in [&input[..split], &input[split..]] {
            frames.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":partial}}));
        }
        frames.extend([
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}),
            json!({"type":"message_stop"}),
        ]);
        let text: String = frames
            .iter()
            .map(|frame| {
                format!(
                    "event: {}\ndata: {frame}\n\n",
                    frame["type"].as_str().unwrap()
                )
            })
            .collect();
        Some(
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from(text))
                .unwrap(),
        )
    } else {
        Some(ok_json(
            json!({"id":"msg_invalid","type":"message","role":"assistant","model":Target::Anthropic.wire_model(),"content":[call],"stop_reason":"tool_use"}),
        ))
    }
}

pub(super) async fn run() {
    run_cases(false).await;
}

pub(super) async fn run_reason_wrapper() {
    run_cases(true).await;
}

async fn run_cases(tool_thinking: bool) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("anthropic-invalid");
    let (base, mut captures, shutdown) = spawn_upstream(Target::Anthropic).await;
    let mut config = manifest(Target::Anthropic, test_ports::free_port(), &base);
    if tool_thinking {
        for server in config.servers.values_mut() {
            server.features.insert("tool_thinking".into(), true);
        }
    }
    let handle = spawn_v3_server_aggregate(config).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();
    let variants = if tool_thinking {
        vec![(4, false), (4, true), (5, false), (5, true)]
    } else {
        vec![(0, false), (1, false), (2, false), (3, false), (1, true)]
    };
    for (index, stream) in variants {
        let case = cases().remove(index);
        let choice = case
            .namespace
            .map(|namespace| format!("{namespace}.{}", case.leaf()))
            .unwrap_or_else(|| case.leaf().into());
        let mut payload = first_turn_request(Target::Anthropic);
        payload["tools"] = case.tools();
        payload["tool_choice"] = json!({"type":"function","name":choice});
        payload["input"] = json!([{"role":"user","content":format!("{MARKER}{index}")}]);
        payload["stream"] = json!(stream);
        let (status, text) = send(&client, &endpoint, &payload).await.unwrap();
        let captured = capture(&mut captures).await.unwrap();
        assert!(captured_violations(&captured).is_empty(), "{captured}");
        assert!(
            captures.try_recv().is_err(),
            "one provider attempt per business turn"
        );
        eprintln!("EVIDENCE_ANTHROPIC_INVALID_UPSTREAM={captured}");
        let events = sse_events(&text);
        let body = if stream {
            assert_eq!(status, StatusCode::OK);
            events
                .iter()
                .find(|event| event["type"] == "response.completed")
                .unwrap_or_else(|| panic!("missing completed business terminal: {text}"))
                .get("response")
                .unwrap()
                .clone()
        } else {
            parsed(status, &text).unwrap()
        };
        let items = output_items(&body).unwrap();
        // The public runtime disables client Tool-Thinking projection. Resp03
        // unit controls separately verify reasoning authorization when enabled.
        assert!(
            items.iter().all(|item| item["type"] != "reasoning"),
            "{body}"
        );
        let calls = items;
        assert_eq!(calls.len(), 1, "{body}");
        let call = &calls[0];
        assert_eq!(
            call["type"],
            if case.custom {
                "custom_tool_call"
            } else {
                "function_call"
            }
        );
        assert_eq!(call["name"], case.leaf());
        assert_eq!(call["call_id"], format!("toolu_invalid_{index}"));
        if index == 5 {
            for key in ["reason", "goal_alignment_confidence", "model_id"] {
                assert!(call.get(key).is_none(), "governed field leaked: {call}");
            }
        }
        match case.namespace {
            Some(namespace) => assert_eq!(call["namespace"], namespace),
            None => assert!(call.get("namespace").is_none(), "{call}"),
        }
        let input = call[if case.custom { "input" } else { "arguments" }]
            .as_str()
            .expect("client input must be string-valued");
        assert_eq!(input, case.client_input());
        if index != 3 && index != 5 {
            assert_eq!(serde_json::from_str::<Value>(input).unwrap(), case.value);
        }
        if stream {
            let done = events
                .iter()
                .find(|event| {
                    event["type"] == "response.output_item.done"
                        && event["item"]["type"] == call["type"]
                })
                .expect("completed custom item");
            assert_eq!(done["item"], *call);
            let added = events
                .iter()
                .find(|event| {
                    event["type"] == "response.output_item.added"
                        && event["item"]["type"] == call["type"]
                })
                .expect("added custom item");
            for key in ["type", "name", "namespace", "call_id"] {
                assert_eq!(added["item"][key], call[key]);
            }
        }
        eprintln!("EVIDENCE_ANTHROPIC_INVALID_CLIENT={body}");
        let receipt = if index == 3 || index == 5 {
            execute_consumer(call)
        } else {
            consume(call)
        };
        assert_eq!(
            receipt,
            if index == 3 || index == 5 {
                "42"
            } else {
                ERROR
            }
        );
        payload["stream"] = json!(false);
        payload["input"] = json!([
            {"role":"user","content":format!("{MARKER}{index}")},
            call,
            {"type":if case.custom {"custom_tool_call_output"} else {"function_call_output"},"call_id":call["call_id"],"output":receipt}
        ]);
        let (status, text) = send(&client, &endpoint, &payload).await.unwrap();
        let followup = parsed(status, &text).unwrap();
        assert!(
            output_items(&followup)
                .unwrap()
                .iter()
                .any(|item| item["content"][0]["text"] == "namespace follow up"),
            "{followup}"
        );
        let captured = capture(&mut captures).await.unwrap();
        assert!(captured_violations(&captured).is_empty(), "{captured}");
        assert!(
            captures.try_recv().is_err(),
            "one provider attempt per correction turn"
        );
        eprintln!("EVIDENCE_ANTHROPIC_INVALID_FOLLOWUP={captured}");
    }
    handle.shutdown().await;
    shutdown.send(()).unwrap();
}
