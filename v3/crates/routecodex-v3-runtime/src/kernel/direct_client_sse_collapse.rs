//! Buffer a Direct client SSE replay back into the JSON body the client asked for.
//!
//! A declared provider contract can force an upstream SSE request (for example
//! OpenCode Zen free tier rejects `stream:false`) while the client requested
//! `stream:false`. The client-facing body must remain the JSON shape the client
//! requested, not a leaked SSE stream, so the already-projected client frames are
//! reduced back through the canonical Chat chunk reducer.

use super::direct_runtime_helpers_stream::parse_direct_sse_json_frames;
use routecodex_v3_error::V3ErrorSourceKind;

pub(crate) async fn collapse_direct_client_sse_to_json(
    mut stream: crate::nodes::V3CommittedClientSseStream,
) -> crate::shared::V3DirectSourceResult<serde_json::Value> {
    use futures_util::StreamExt;
    let mut reducer = crate::hub_v1::V3OpenAiChatSseReducerState::default();
    while let Some(frame) = stream.next().await {
        for value in parse_direct_sse_json_frames(&frame) {
            reducer.apply_chunk(&value).map_err(|error| {
                crate::shared::direct_plain_error(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3HubRespChatProcess03Governed",
                    "direct_sse_non_stream_reduce_failed",
                    error.to_string(),
                )
            })?;
        }
    }
    reducer.materialize_completion().map_err(|error| {
        crate::shared::direct_plain_error(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRespChatProcess03Governed",
            "direct_sse_non_stream_materialize_failed",
            error.to_string(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_control::V3CommittedClientSseBuilder;

    fn sealed_replay(frames: &[&str]) -> crate::nodes::V3CommittedClientSseStream {
        let mut builder = V3CommittedClientSseBuilder::new();
        for frame in frames {
            builder.push(frame.as_bytes().to_vec()).expect("push frame");
        }
        builder
            .mark_last_frame_as_terminal()
            .expect("mark terminal");
        builder
            .seal_after_validated_terminal()
            .expect("seal committed replay")
    }

    #[tokio::test]
    async fn collapses_chat_client_sse_replay_into_single_completion() {
        let stream = sealed_replay(&[
            ": keepalive\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"think\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"FREE_OK\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        ]);
        let completion = collapse_direct_client_sse_to_json(stream)
            .await
            .expect("collapse chat client replay");
        assert_eq!(completion["object"], "chat.completion");
        assert_eq!(completion["id"], "chatcmpl_x");
        assert_eq!(completion["choices"][0]["message"]["content"], "FREE_OK");
        assert_eq!(
            completion["choices"][0]["message"]["reasoning_content"],
            "think"
        );
        assert_eq!(completion["choices"][0]["finish_reason"], "stop");
        assert_eq!(completion["usage"]["total_tokens"], 5);
    }

    #[tokio::test]
    async fn collapses_chat_client_sse_replay_preserving_tool_calls() {
        let stream = sealed_replay(&[
            "data: {\"id\":\"chatcmpl_t\",\"object\":\"chat.completion.chunk\",\"created\":9,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"filePath\\\":\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_t\",\"object\":\"chat.completion.chunk\",\"created\":9,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"/tmp/x\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_t\",\"object\":\"chat.completion.chunk\",\"created\":9,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        ]);
        let completion = collapse_direct_client_sse_to_json(stream)
            .await
            .expect("collapse chat client replay");
        assert_eq!(completion["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "read"
        );
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{\"filePath\":\"/tmp/x\"}"
        );
    }

    #[tokio::test]
    async fn collapses_chat_client_sse_replay_preserving_extensions_and_fingerprint() {
        let stream = sealed_replay(&[
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"system_fingerprint\":\"fp_x\",\"service_tier\":\"tier-a\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"logprobs\":{\"content\":[{\"token\":\"a\",\"logprob\":-1.0}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"FREE_OK\",\"mirror\":\"kept\"},\"logprobs\":{\"content\":[{\"token\":\"b\",\"logprob\":-2.0}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        ]);
        let completion = collapse_direct_client_sse_to_json(stream)
            .await
            .expect("collapse chat client replay");
        assert_eq!(completion["system_fingerprint"], "fp_x");
        assert_eq!(completion["service_tier"], "tier-a");
        assert_eq!(
            completion["choices"][0]["logprobs"]["content"][0]["token"],
            "a"
        );
        assert_eq!(
            completion["choices"][0]["logprobs"]["content"][1]["token"], "b",
            "logprobs tokens emitted across chunks must be merged in stream order"
        );
        assert_eq!(
            completion["choices"][0]["message"]["mirror"], "kept",
            "unconsumed delta extensions must stay on the message object"
        );
    }

    #[tokio::test]
    async fn collapses_chat_client_sse_replay_keeps_logprobs_when_a_field_is_null() {
        let stream = sealed_replay(&[
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"logprobs\":{\"content\":[{\"token\":\"a\",\"logprob\":-1.0}],\"refusal\":null},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"FREE_OK\"},\"logprobs\":{\"content\":[{\"token\":\"b\",\"logprob\":-2.0}],\"refusal\":null},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_x\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"logprobs\":{\"content\":null,\"refusal\":[{\"token\":\"c\",\"logprob\":-3.0}]},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}\n\n",
            "data: [DONE]\n\n",
        ]);
        let completion = collapse_direct_client_sse_to_json(stream)
            .await
            .expect("collapse chat client replay");
        assert_eq!(
            completion["choices"][0]["logprobs"]["content"][0]["token"],
            "a"
        );
        assert_eq!(
            completion["choices"][0]["logprobs"]["content"][1]["token"], "b",
            "a later null field must not erase earlier logprobs: {completion}"
        );
        assert_eq!(
            completion["choices"][0]["logprobs"]["refusal"][0]["token"], "c",
            "a later non-null field must still accumulate after a null observation: {completion}"
        );
    }

    // RED before fix: the ordinary collapse failure paths must route through the
    // canonical Error01 (Source01) SDK instead of a raw V3Error01SourceRaised
    // builder, and must keep the typed source so the caller can preserve an
    // injected operator fault. The old return type `Result<_, V3Error01SourceRaised>`
    // could not express an operator fault and could not prove the SDK ran.
    #[tokio::test]
    async fn collapse_failure_executes_error01_sdk_and_preserves_typed_cause() {
        use crate::operation_runner::err01_execution_count_for_test;

        // Malformed chunk: the reducer rejects an unknown `finish_reason` value,
        // so the reduce path fails inside the collapse owner.
        let bad_reduce = sealed_replay(&[
            "data: {\"id\":\"chatcmpl_bad\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"x\"},\"finish_reason\":\"not_a_real_reason\"}]}\n\n",
            "data: [DONE]\n\n",
        ]);
        let before = err01_execution_count_for_test();
        let result = collapse_direct_client_sse_to_json(bad_reduce).await;
        let after = err01_execution_count_for_test();
        let err = result.expect_err("malformed collapse must fail through Error01 SDK");
        // The nested result must preserve the typed source so injected operator
        // faults survive into the caller's source_failure_output path.
        let source = err.expect("collapse failure must carry the typed V3Error01SourceRaised");
        assert_eq!(
            source.source_stage, "V3HubRespChatProcess03Governed",
            "collapse failure must keep its full typed cause"
        );
        assert_eq!(
            source.code, "direct_sse_non_stream_reduce_failed",
            "collapse failure must keep its full typed cause"
        );
        assert!(
            after > before,
            "collapse failure must execute the Error01 (Source01) SDK operator"
        );

        // A tool call without a function name applies as a chunk but fails when
        // the reducer materializes the completion.
        let bad_materialize = sealed_replay(&[
            "data: {\"id\":\"chatcmpl_missing_name\",\"object\":\"chat.completion.chunk\",\"created\":7,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        ]);
        let before2 = err01_execution_count_for_test();
        let result2 = collapse_direct_client_sse_to_json(bad_materialize).await;
        let after2 = err01_execution_count_for_test();
        let err2 = result2.expect_err("empty collapse must fail through Error01 SDK");
        let source2 = err2.expect("materialize failure must carry the typed V3Error01SourceRaised");
        assert_eq!(
            source2.source_stage, "V3HubRespChatProcess03Governed",
            "materialize failure must keep its full typed cause"
        );
        assert_eq!(
            source2.code, "direct_sse_non_stream_materialize_failed",
            "materialize failure must keep its full typed cause"
        );
        assert!(
            after2 > before2,
            "materialize failure must execute the Error01 (Source01) SDK operator"
        );
    }

    #[test]
    fn collapse_error_caller_preserves_injected_err01_fault_and_external_http() {
        let original = routecodex_v3_error::build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRespChatProcess03Governed",
            "seeded_original_source",
            "seeded original collapse failure",
        );
        let fault = crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault {
            policy_failure: routecodex_v3_error::build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Error01SourceRaised",
                "err01_source_operator_sdk_failure",
                "seeded Err01 operator failure",
            ),
            original_source: Some(original.clone()),
        };
        let witness = routecodex_v3_error::V3ExternalHttpWitness::new(
            502,
            vec![("content-type".to_string(), b"application/json".to_vec())],
            br#"{"error":"upstream collapse failure"}"#.to_vec(),
        );

        let output = super::super::direct_runtime_helpers_stream::source_failure_output(
            Err(fault.clone()),
            Some(witness.clone()),
            vec!["V3HubRespChatProcess03Governed"],
            &crate::hooks::register_responses_direct_hooks(),
        );

        assert_eq!(
            output.diagnostic_source,
            Some(fault.policy_failure),
            "collapse caller must preserve the Err01 SDK fault"
        );
        assert_eq!(
            output.diagnostic_cause,
            Some(original),
            "collapse caller must preserve the original typed cause"
        );
        assert_eq!(
            output.terminal_disposition,
            Some(routecodex_v3_error::V3ProviderTerminalDisposition::ExternalHttp(witness)),
            "collapse caller must retain the last external HTTP witness"
        );
        assert_eq!(output.client_payload.status, 599);
    }
}
