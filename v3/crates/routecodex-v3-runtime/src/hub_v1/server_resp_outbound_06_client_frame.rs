use super::{
    V3HubRespOutbound05ClientSemantic, V3HubTransportIntent, V3ResponsesRelayClientStream,
};
use crate::operation_runner::{run_v3_single_node_operator, V3OperationGraph};
use pipeline_runtime::{Operator, OperatorContext, ValueType};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const OPERATOR_NAME: &str = "routecodex.v3.operation.frame_committed_client_response";
const OPERATOR_VERSION: &str = "1";

#[derive(Debug, Clone, PartialEq)]
pub struct V3ServerRespOutbound06ClientFrame {
    pub(crate) previous: V3HubRespOutbound05ClientSemantic,
    framed_client_payload: Arc<Value>,
}

pub fn build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(
    input: V3HubRespOutbound05ClientSemantic,
) -> V3ServerRespOutbound06ClientFrame {
    let framed_client_payload = input.client_payload.clone();
    V3ServerRespOutbound06ClientFrame {
        previous: input,
        framed_client_payload,
    }
}

pub(crate) fn try_build_v3_server_resp_outbound_06_with_framer<F>(
    input: V3HubRespOutbound05ClientSemantic,
    frame_json_fn: F,
) -> Result<V3ServerRespOutbound06ClientFrame, String>
where
    F: FnOnce(Value) -> Result<Value, String> + Send + Sync + 'static,
{
    let framed_client_payload = execute_v3_operation_runner_response_frame_committed_client_json(
        input.client_payload().clone(),
        frame_json_fn,
    )?;
    Ok(V3ServerRespOutbound06ClientFrame {
        previous: input,
        framed_client_payload: Arc::new(framed_client_payload),
    })
}

struct FrameCommittedClientResponseJsonOperator<F> {
    frame_json: Mutex<Option<F>>,
}

impl<F> Operator for FrameCommittedClientResponseJsonOperator<F>
where
    F: FnOnce(Value) -> Result<Value, String> + Send + Sync + 'static,
{
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let frame_json = self
            .frame_json
            .lock()
            .map_err(|_| "client frame JSON callback holder is poisoned".to_string())?
            .take()
            .ok_or_else(|| "client frame JSON callback already consumed".to_string())?;
        frame_json(input)
    }
}

struct FrameCommittedClientResponseSseOperator<F> {
    frame_sse: Mutex<Option<F>>,
    framed_stream: Arc<Mutex<Option<Box<V3ResponsesRelayClientStream>>>>,
}

impl<F> Operator for FrameCommittedClientResponseSseOperator<F>
where
    F: FnOnce(Value) -> Result<(Value, V3ResponsesRelayClientStream), String>
        + Send
        + Sync
        + 'static,
{
    fn name(&self) -> &'static str {
        OPERATOR_NAME
    }

    fn version(&self) -> &'static str {
        OPERATOR_VERSION
    }

    fn input_type(&self) -> ValueType {
        ValueType::Object
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn execute(&self, input: Value, _: &OperatorContext) -> Result<Value, String> {
        let frame_sse = self
            .frame_sse
            .lock()
            .map_err(|_| "client frame SSE callback holder is poisoned".to_string())?
            .take()
            .ok_or_else(|| "client frame SSE callback already consumed".to_string())?;
        let (framed_client_payload, stream) = frame_sse(input)?;
        let mut holder = self
            .framed_stream
            .lock()
            .map_err(|_| "client frame SSE side-output holder is poisoned".to_string())?;
        *holder = Some(Box::new(stream));
        Ok(framed_client_payload)
    }
}

pub(crate) fn execute_v3_operation_runner_response_frame_committed_client_json<F>(
    client_semantic_response: Value,
    frame_json_fn: F,
) -> Result<Value, String>
where
    F: FnOnce(Value) -> Result<Value, String> + Send + Sync + 'static,
{
    let operator = FrameCommittedClientResponseJsonOperator {
        frame_json: Mutex::new(Some(frame_json_fn)),
    };
    run_v3_single_node_operator(
        V3OperationGraph::Response,
        "frame_committed_client_response",
        client_semantic_response,
        operator,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn execute_v3_operation_runner_response_frame_committed_client_sse<F>(
    client_semantic_response: Value,
    frame_sse_fn: F,
) -> Result<(Value, V3ResponsesRelayClientStream), String>
where
    F: FnOnce(Value) -> Result<(Value, V3ResponsesRelayClientStream), String>
        + Send
        + Sync
        + 'static,
{
    let framed_stream = Arc::new(Mutex::new(None));
    let operator = FrameCommittedClientResponseSseOperator {
        frame_sse: Mutex::new(Some(frame_sse_fn)),
        framed_stream: framed_stream.clone(),
    };
    let framed_client_payload = run_v3_single_node_operator(
        V3OperationGraph::Response,
        "frame_committed_client_response",
        client_semantic_response,
        operator,
    )
    .map_err(|error| error.to_string())?;
    let stream = framed_stream
        .lock()
        .map_err(|_| "client frame SSE side-output holder is poisoned".to_string())?
        .take()
        .ok_or_else(|| "client frame SSE operator omitted its typed side output".to_string())?;
    Ok((framed_client_payload, *stream))
}

impl V3ServerRespOutbound06ClientFrame {
    pub fn response_exit_node(&self) -> &'static str {
        "V3ServerRespOutbound06ClientFrame"
    }

    pub fn transport_intent(&self) -> V3HubTransportIntent {
        self.previous
            .previous
            .previous
            .provider_raw()
            .transport_intent
    }

    pub fn into_client_payload(self) -> Value {
        Arc::try_unwrap(self.framed_client_payload)
            .unwrap_or_else(|payload| payload.as_ref().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;

    async fn collect_response_frames(response: Value) -> Vec<Value> {
        let stream =
            super::super::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
                response,
            )
            .expect("valid Responses input must produce a committed stream");
        stream
            .map(|frame| {
                let text = String::from_utf8(frame).expect("SSE frame must be UTF-8");
                let data = text
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .expect("SSE frame must carry a data line");
                serde_json::from_str(data).expect("SSE data must be JSON")
            })
            .collect()
            .await
    }

    fn event<'a>(frames: &'a [Value], event_type: &str) -> &'a Value {
        frames
            .iter()
            .find(|frame| frame["type"] == event_type)
            .unwrap_or_else(|| panic!("missing {event_type} frame"))
    }

    fn assert_no_client_failure(frames: &[Value]) {
        assert!(
            frames
                .iter()
                .all(|frame| frame["type"] != "response.failed" && frame["type"] != "error"),
            "legal business terminals must not fabricate a client failure: {frames:?}"
        );
    }

    #[test]
    fn frame_committed_client_response_json_operator_returns_sdk_output() {
        use super::super::*;
        let raw = build_v3_provider_resp_inbound_01_raw(
            json!({"status":"completed","output":[],"semantic":"candidate"}),
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(raw).unwrap();
        let normalized = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap();
        let governed = build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02(normalized);
        let semantic = build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03(governed);
        let output = try_build_v3_server_resp_outbound_06_with_framer(semantic, |mut input| {
            input["finalized"] = json!(true);
            Ok(input)
        })
        .expect("JSON finalization operator must run")
        .into_client_payload();
        assert_eq!(output["semantic"], "candidate");
        assert_eq!(output["finalized"], true);
    }

    #[test]
    fn frame_committed_client_response_json_operator_preserves_finalization_error() {
        let error = execute_v3_operation_runner_response_frame_committed_client_json(
            json!({"semantic": "candidate"}),
            |_| Err("JSON finalization failed explicitly".to_string()),
        )
        .expect_err("SDK output cannot mask a finalization error");
        assert!(
            error.contains("JSON finalization failed explicitly"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn frame_committed_client_response_completed_preserves_usage_and_opaque_fields() {
        let frames = collect_response_frames(json!({
            "id": "resp_completed_frame",
            "status": "completed",
            "opaque_provider_field": {"keep": [null, true]},
            "output": [{"type": "output_text", "text": "complete"}]
        }))
        .await;
        assert_no_client_failure(&frames);
        let terminal = event(&frames, "response.completed");
        assert_eq!(terminal["response"]["status"], "completed");
        assert_eq!(
            terminal["response"]["opaque_provider_field"]["keep"][1],
            true
        );
        assert_eq!(terminal["response"]["usage"]["input_tokens"], 0);
        assert_eq!(terminal["response"]["usage"]["output_tokens"], 0);
        assert_eq!(terminal["response"]["usage"]["total_tokens"], 0);
        assert_eq!(
            frames.last().map(|frame| frame["type"].clone()),
            Some(json!("response.completed"))
        );
    }

    #[tokio::test]
    async fn frame_committed_client_response_content_filter_is_legal_incomplete() {
        let frames = collect_response_frames(json!({
            "id": "resp_content_filter_frame",
            "status": "incomplete",
            "incomplete_details": {"reason": "content_filter"},
            "usage": {"input_tokens": 2, "output_tokens": 1},
            "output": []
        }))
        .await;
        assert_no_client_failure(&frames);
        let terminal = event(&frames, "response.incomplete");
        assert_eq!(terminal["response"]["status"], "incomplete");
        assert_eq!(
            terminal["response"]["incomplete_details"]["reason"],
            "content_filter"
        );
        assert_eq!(terminal["response"]["usage"]["input_tokens"], 2);
        assert_eq!(terminal["response"]["usage"]["output_tokens"], 1);
        assert_eq!(terminal["response"]["usage"]["total_tokens"], 3);
        assert_eq!(
            frames.last().map(|frame| frame["type"].clone()),
            Some(json!("response.incomplete"))
        );
    }

    #[tokio::test]
    async fn frame_committed_client_response_preserves_paired_invalid_tool_arguments() {
        let arguments = json!({"command": ["not", "valid"], "nested": {"keep": null}});
        let frames = collect_response_frames(json!({
            "id": "resp_invalid_tool_frame",
            "status": "completed",
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_invalid",
                    "call_id": "call_invalid",
                    "name": "shell",
                    "arguments": arguments
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_invalid",
                    "output": {"observed": "invalid arguments"}
                }
            ]
        }))
        .await;
        assert_no_client_failure(&frames);
        let progress = event(&frames, "response.function_call_arguments.done");
        let progress_arguments: Value = serde_json::from_str(
            progress["arguments"]
                .as_str()
                .expect("function-call progress arguments must be a string"),
        )
        .expect("structured arguments must serialize as complete JSON");
        assert_eq!(progress_arguments, arguments);
        assert_eq!(progress["call_id"], "call_invalid");

        let terminal = event(&frames, "response.completed");
        assert_eq!(terminal["response"]["output"][0]["arguments"], arguments);
        assert_eq!(terminal["response"]["output"][0]["call_id"], "call_invalid");
        assert_eq!(terminal["response"]["output"][1]["call_id"], "call_invalid");
        assert_eq!(
            terminal["response"]["output"][1]["output"]["observed"],
            "invalid arguments"
        );
    }

    #[tokio::test]
    async fn frame_committed_client_response_reports_framing_failure() {
        let error =
            super::super::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(
                json!({
                    "id": "resp_missing_call_id",
                    "status": "completed",
                    "output": [{
                        "type": "function_call",
                        "name": "shell",
                        "arguments": {"command": "pwd"}
                    }]
                }),
            )
            .expect_err("a function call without call_id cannot be framed");
        assert!(error.contains("missing call_id"), "{error}");
    }
}
