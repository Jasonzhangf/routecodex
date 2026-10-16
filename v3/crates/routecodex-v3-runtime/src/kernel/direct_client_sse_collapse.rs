//! Buffer a Direct client SSE replay back into the JSON body the client asked for.
//!
//! A declared provider contract can force an upstream SSE request (for example
//! OpenCode Zen free tier rejects `stream:false`) while the client requested
//! `stream:false`. The client-facing body must remain the JSON shape the client
//! requested, not a leaked SSE stream, so the already-projected client frames are
//! reduced back through the canonical Chat chunk reducer.

use super::direct_runtime_helpers_stream::parse_direct_sse_json_frames;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};

pub(crate) async fn collapse_direct_client_sse_to_json(
    mut stream: crate::nodes::V3CommittedClientSseStream,
) -> Result<serde_json::Value, V3Error01SourceRaised> {
    use futures_util::StreamExt;
    let mut reducer = crate::hub_v1::V3OpenAiChatSseReducerState::default();
    while let Some(frame) = stream.next().await {
        for value in parse_direct_sse_json_frames(&frame) {
            reducer.apply_chunk(&value).map_err(|error| {
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::RuntimeFailure,
                    "V3HubRespChatProcess03Governed",
                    "direct_sse_non_stream_reduce_failed",
                    error.to_string(),
                )
            })?;
        }
    }
    reducer.materialize_completion().map_err(|error| {
        build_v3_error_01_source_raised(
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
}
