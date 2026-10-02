use super::*;
use serde_json::json;

// 上游 Responses 参考（lifeai 直连）对 max_output_tokens 截断返回
// `status=incomplete` + `incomplete_details.reason=max_output_tokens`，output 为 reasoning 项。
// 只产出 reasoning 的截断响应是合法的部分输出，不得被判成 provider 失败而进入冷却/切换路径。
#[test]
fn openai_chat_output_cap_truncation_is_incomplete_not_provider_failure() {
    let payload = json!({
        "id": "chatcmpl_output_cap",
        "model": "wb-deepseek-v4.1-flash",
        "choices": [{
            "index": 0,
            "finish_reason": "length",
            "message": {
                "role": "assistant",
                "content": "",
                "reasoning_content": "thinking hard about the ocean"
            }
        }],
        "usage": {"prompt_tokens": 45, "completion_tokens": 16, "total_tokens": 61}
    });

    assert!(
        responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
            None, None, &payload
        )
        .is_none(),
        "output-cap truncation must not be a provider semantic failure"
    );

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &payload,
        &json!({"tools": []}),
    )
    .expect("output-cap truncation must project a Responses response");
    assert_eq!(response["status"], "incomplete");
    assert_eq!(
        response["incomplete_details"]["reason"],
        "max_output_tokens"
    );
    // 本 bug 的核心是合法部分输出被丢弃，因此必须证明 reasoning 输出项仍然存在。
    let reasoning = response["output"]
        .as_array()
        .expect("projected response must carry output items")
        .iter()
        .find(|item| item["type"] == "reasoning")
        .expect("truncated reasoning output must survive projection");
    assert_eq!(
        reasoning["summary"][0]["text"],
        "thinking hard about the ocean"
    );
}

// guard 与投影必须对同一 payload 得出相同终态：投影只认第一个字符串 finish_reason，
// 因此 guard 也只能认第一个。否则首个 choice 是 stop、后续 choice 是 length 时，
// 空响应会被 guard 豁免并被投影成 completed（成功包裹空输出）。
#[test]
fn openai_chat_multi_choice_guard_follows_the_projected_terminal_choice() {
    let payload = json!({
        "id": "chatcmpl_multi_choice",
        "model": "wb-deepseek-v4.1-flash",
        "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": ""}},
            {"index": 1, "finish_reason": "length", "message": {"role": "assistant", "content": ""}}
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
    });

    let projection = responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
        None, None, &payload,
    )
    .expect("empty output on the projected terminal choice must stay a provider failure");
    assert_eq!(projection.status, 502);
    assert_eq!(projection.code, "provider_empty_visible_output");
}

// 截断词表的每个别名都必须既被 guard 豁免、又被投影判成 incomplete。
// 只映射 `length` 会让 `max_tokens` / `max_output_tokens` 落成 completed 空响应。
#[test]
fn openai_chat_output_cap_aliases_project_incomplete_not_completed() {
    for alias in ["length", "max_tokens", "max_output_tokens"] {
        let payload = json!({
            "id": format!("chatcmpl_{alias}"),
            "model": "wb-deepseek-v4.1-flash",
            "choices": [{
                "index": 0,
                "finish_reason": alias,
                "message": {"role": "assistant", "content": ""}
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
        });

        assert!(
            responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                None, None, &payload
            )
            .is_none(),
            "output-cap alias {alias} must not be a provider semantic failure"
        );

        let response = build_v3_responses_provider_response_from_openai_chat_payload(
            &payload,
            &json!({"tools": []}),
        )
        .expect("output-cap alias must project a Responses response");
        assert_eq!(
            response["status"], "incomplete",
            "output-cap alias {alias} must project incomplete, not a completed empty response"
        );
        assert_eq!(
            response["incomplete_details"]["reason"],
            "max_output_tokens"
        );
    }
}

// 修复前（origin/main）空 finish_reason 的首个 choice 不会让 guard 放行：
// 只要存在非空终态，空输出的响应就是 provider 失败，不得落成 completed 空成功。
#[test]
fn openai_chat_blank_first_reason_does_not_exempt_a_later_terminal() {
    for blank in ["", "   "] {
        let payload = json!({
            "id": "chatcmpl_blank_first",
            "model": "wb-deepseek-v4.1-flash",
            "choices": [
                {"index": 0, "finish_reason": blank, "message": {"role": "assistant", "content": ""}},
                {"index": 1, "finish_reason": "stop", "message": {"role": "assistant", "content": ""}}
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
        });

        let projection =
            responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
                None, None, &payload,
            )
            .expect("a blank first reason must not exempt a later terminal with empty output");
        assert_eq!(projection.status, 502);
        assert_eq!(projection.code, "provider_empty_visible_output");
    }
}

// 反向保护：模型自行 stop 却只有 reasoning 属于退化响应，仍须判为 provider 失败。
// 该契约由 responses_relay_runtime_tests::openai_chat_reasoning_only_stop_stream_is_not_a_successful_response
// 的流式路径覆盖，这里补非流式终态路径，避免把 output-cap 豁免扩大成“reasoning 即合法”。
#[test]
fn openai_chat_reasoning_only_stop_remains_provider_failure() {
    let payload = json!({
        "id": "chatcmpl_reasoning_only_stop",
        "model": "wb-deepseek-v4.1-flash",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "",
                "reasoning_content": "internal reasoning only"
            }
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 30, "total_tokens": 42}
    });

    let projection = responses_relay_diagnostics::provider_response_semantic_error_from_manifest(
        None, None, &payload,
    )
    .expect("reasoning-only stop must remain a provider semantic failure");
    assert_eq!(projection.status, 502);
    assert_eq!(projection.code, "provider_empty_visible_output");
}
