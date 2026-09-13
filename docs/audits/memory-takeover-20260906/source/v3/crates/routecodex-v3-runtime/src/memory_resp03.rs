use routecodex_v3_agent_memory::{
    CanonicalCompletedStopProof, MemorySkillHandle, MemorySourceKind, MemorySourceWindow,
};

use crate::execution_control::V3CommittedSseTerminal;
use crate::hub_v1::{
    collect_v3_provider_sse_json_data, parse_v3_provider_sse_json_data, V3RuntimeStreamObservation,
};
use crate::nodes::{V3ClientBody, V3Resp15ClientPayload};
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3MemoryResp03Observation {
    pub(crate) admitted: usize,
    pub(crate) deduplicated: usize,
    pub(crate) diagnostics: usize,
    pub(crate) append_errors: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3MemoryResp03ObservationOutcome {
    NotEligible,
    Observed(V3MemoryResp03Observation),
    ObserverError(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3MemoryResp03SseObservationAttachOutcome {
    NotEligible,
    Attached,
}

pub(crate) fn observe_v3_responses_direct_memory_at_resp03(
    skill: Option<&MemorySkillHandle>,
    client_payload: &V3Resp15ClientPayload,
    request_id: &str,
) -> V3MemoryResp03ObservationOutcome {
    let Some(skill) = skill else {
        return V3MemoryResp03ObservationOutcome::NotEligible;
    };
    let V3ClientBody::Json(value) = &client_payload.body else {
        return V3MemoryResp03ObservationOutcome::NotEligible;
    };
    let response_status = explicit_response_status(value);
    let finish_reason = explicit_finish_reason(value);
    let Some(proof) = CanonicalCompletedStopProof::from_fields(response_status, finish_reason)
    else {
        return V3MemoryResp03ObservationOutcome::NotEligible;
    };
    let output_json = match serde_json::to_string(value) {
        Ok(output_json) => output_json,
        Err(error) => return V3MemoryResp03ObservationOutcome::ObserverError(error.to_string()),
    };
    let source = MemorySourceWindow::new(MemorySourceKind::EndTurn, [request_id.to_string()]);
    match skill.observe_terminal(proof, &output_json, source) {
        Ok(report) => V3MemoryResp03ObservationOutcome::Observed(V3MemoryResp03Observation {
            admitted: report.admitted.len(),
            deduplicated: report.deduplicated,
            diagnostics: report.observation.diagnostics.len(),
            append_errors: report.append_errors.len(),
        }),
        Err(error) => V3MemoryResp03ObservationOutcome::ObserverError(error),
    }
}

pub(crate) fn apply_v3_responses_direct_memory_resp03_observer(
    client_payload: &mut V3Resp15ClientPayload,
    skill: Option<&MemorySkillHandle>,
    request_id: &str,
    stream_observation: Option<&V3RuntimeStreamObservation>,
    committed_client_sse: bool,
    trace: &mut Vec<&'static str>,
) {
    if committed_client_sse {
        if matches!(
            attach_v3_responses_direct_memory_sse_observer_at_resp03(
                client_payload,
                skill,
                request_id,
                stream_observation,
            ),
            V3MemoryResp03SseObservationAttachOutcome::Attached
        ) {
            trace.push("V3Resp03MemoryObserverAttached");
        }
        return;
    }
    match observe_v3_responses_direct_memory_at_resp03(skill, client_payload, request_id) {
        V3MemoryResp03ObservationOutcome::NotEligible => {}
        V3MemoryResp03ObservationOutcome::Observed(observation) => {
            trace.push("V3Resp03MemoryObserved");
            if observation.append_errors > 0 {
                trace.push("V3Resp03MemoryObserverError");
            }
        }
        V3MemoryResp03ObservationOutcome::ObserverError(_) => {
            trace.push("V3Resp03MemoryObserverError");
        }
    }
}

/// Attach a bounded observer to an already sealed client SSE stream. The
/// observer sees the exact bytes sent to the client and keeps only the
/// terminal `response.completed` event; it never buffers the full response or
/// rewrites a frame. Admission runs only when the sealed stream reports
/// `Completed`, so a client-side drop before the terminal frame cannot create
/// memory.
pub(crate) fn attach_v3_responses_direct_memory_sse_observer_at_resp03(
    client_payload: &mut V3Resp15ClientPayload,
    skill: Option<&MemorySkillHandle>,
    request_id: &str,
    stream_observation: Option<&V3RuntimeStreamObservation>,
) -> V3MemoryResp03SseObservationAttachOutcome {
    let Some(skill) = skill else {
        return V3MemoryResp03SseObservationAttachOutcome::NotEligible;
    };
    let body = std::mem::replace(&mut client_payload.body, V3ClientBody::Bytes(Vec::new()));
    let V3ClientBody::CommittedSse(stream) = body else {
        client_payload.body = body;
        return V3MemoryResp03SseObservationAttachOutcome::NotEligible;
    };

    let capture = Arc::new(Mutex::new(V3SseMemoryCapture::default()));
    let frame_capture = Arc::clone(&capture);
    let terminal_capture = Arc::clone(&capture);
    let skill = skill.clone();
    let request_id = request_id.to_owned();
    let frame_observation = stream_observation.cloned();
    let terminal_observation = stream_observation.cloned();
    let stream = stream.observe(
        move |frame| {
            let Ok(mut capture) = frame_capture.lock() else {
                record_v3_memory_sse_observation_error(
                    frame_observation.as_ref(),
                    "memory SSE capture state lock is poisoned",
                );
                return;
            };
            capture.observe_frame(frame);
        },
        move |terminal| {
            let Ok(mut capture) = terminal_capture.lock() else {
                record_v3_memory_sse_observation_error(
                    terminal_observation.as_ref(),
                    "memory SSE capture state lock is poisoned",
                );
                return;
            };
            if terminal != V3CommittedSseTerminal::Completed {
                if let Some(error) = capture.error.take() {
                    record_v3_memory_sse_observation_error(terminal_observation.as_ref(), error);
                }
                return;
            }
            let result = capture.finish();
            match result {
                Ok(Some((proof, output_json))) => {
                    let source = MemorySourceWindow::new(MemorySourceKind::EndTurn, [request_id]);
                    match skill.observe_terminal(proof, &output_json, source) {
                        Ok(report) if !report.append_errors.is_empty() => {
                            record_v3_memory_sse_observation_error(
                                terminal_observation.as_ref(),
                                format!(
                                    "memory SSE pending append errors: {}",
                                    report.append_errors.len()
                                ),
                            );
                        }
                        Ok(_) => {}
                        Err(error) => record_v3_memory_sse_observation_error(
                            terminal_observation.as_ref(),
                            format!("memory SSE observer failed: {error}"),
                        ),
                    }
                }
                Ok(None) => {}
                Err(error) => record_v3_memory_sse_observation_error(
                    terminal_observation.as_ref(),
                    format!("memory SSE capture failed: {error}"),
                ),
            }
        },
    );
    client_payload.body = V3ClientBody::CommittedSse(stream);
    V3MemoryResp03SseObservationAttachOutcome::Attached
}

fn record_v3_memory_sse_observation_error(
    observation: Option<&V3RuntimeStreamObservation>,
    error: impl Into<String>,
) {
    let Some(observation) = observation else {
        return;
    };
    let error = format!("memory_resp03_sse: {}", error.into());
    if let Err(record_error) = observation.record_observation_error(&error) {
        eprintln!("V3 memory SSE observation failure could not be recorded: {record_error}; original: {error}");
    }
}

#[derive(Debug)]
struct V3SseMemoryCapture {
    decoder: SseIncrementalDecoder,
    terminal_event: Option<Value>,
    error: Option<String>,
}

impl Default for V3SseMemoryCapture {
    fn default() -> Self {
        Self {
            decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
            terminal_event: None,
            error: None,
        }
    }
}

impl V3SseMemoryCapture {
    fn observe_frame(&mut self, frame: &[u8]) {
        if self.error.is_some() || self.terminal_event.is_some() {
            return;
        }
        let frames = match self
            .decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(frame))
        {
            Ok(frames) => frames,
            Err(error) => {
                self.error = Some(error.to_string());
                return;
            }
        };
        for frame in frames {
            let data = collect_v3_provider_sse_json_data(frame.frame().fields());
            if data.trim() == "[DONE]" || data.trim().is_empty() {
                continue;
            }
            let event = match parse_v3_provider_sse_json_data(&data) {
                Ok(Some(event)) => event,
                Ok(None) => continue,
                Err(error) => {
                    self.error = Some(error);
                    return;
                }
            };
            if event.get("type").and_then(Value::as_str) == Some("response.completed") {
                self.terminal_event = Some(event);
                return;
            }
        }
    }

    fn finish(&mut self) -> Result<Option<(CanonicalCompletedStopProof, String)>, String> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        let decoder = std::mem::replace(
            &mut self.decoder,
            SseIncrementalDecoder::new(SseTransportLimits::default()),
        );
        decoder.finish().map_err(|error| error.to_string())?;
        let Some(event) = self.terminal_event.take() else {
            return Ok(None);
        };
        let response_status = explicit_response_status(&event);
        let finish_reason = explicit_finish_reason(&event);
        let proof = CanonicalCompletedStopProof::from_fields(response_status, finish_reason)
            .or_else(|| {
                CanonicalCompletedStopProof::from_responses_completed_event(
                    event.get("type").and_then(Value::as_str),
                    event.pointer("/response/status").and_then(Value::as_str),
                )
            });
        let Some(proof) = proof else {
            return Ok(None);
        };
        let output = if event.get("memory").is_some() {
            event
        } else if event.pointer("/response/memory").is_some() {
            event.get("response").cloned().unwrap_or(Value::Null)
        } else {
            return Ok(None);
        };
        let output_json = serde_json::to_string(&output).map_err(|error| error.to_string())?;
        Ok(Some((proof, output_json)))
    }
}

fn explicit_response_status(value: &Value) -> Option<&str> {
    value
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/response/status").and_then(Value::as_str))
}

fn explicit_finish_reason(value: &Value) -> Option<&str> {
    value
        .get("finish_reason")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/response/finish_reason")
                .and_then(Value::as_str)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_control::V3CommittedClientSseBuilder;
    use crate::hub_v1::V3RuntimeStreamObservation;
    use crate::nodes::V3ClientBody;
    use futures_util::StreamExt;
    use routecodex_v3_agent_memory::MemorySkillHandle;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "routecodex-v3-memory-resp03-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn payload(value: serde_json::Value) -> V3Resp15ClientPayload {
        V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::Json(value),
        }
    }

    fn committed_sse(frames: &[&[u8]]) -> crate::nodes::V3CommittedClientSseStream {
        let mut builder = V3CommittedClientSseBuilder::new();
        for frame in frames {
            builder.push(frame.to_vec()).expect("test frame fits");
        }
        builder
            .mark_last_frame_as_terminal()
            .expect("test stream has a terminal frame");
        builder
            .seal_after_validated_terminal()
            .expect("test stream seals")
    }

    fn terminal_sse_frame(memory: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "response.completed",
            "response": {
                "id": "resp_sse_memory",
                "status": "completed",
                "finish_reason": "stop",
                "output": [{"type":"message","content":[{"type":"output_text","text":"done"}]}],
                "memory": memory,
            }
        }))
        .map(|data| {
            let data = String::from_utf8(data).expect("test JSON is UTF-8");
            format!("event: response.completed\ndata: {data}\n\n").into_bytes()
        })
        .expect("test frame serializes")
    }

    #[test]
    fn resp03_memory_requires_explicit_completed_stop_pair() {
        let handle = MemorySkillHandle::open(temp_root("proof")).expect("open skill");
        for value in [
            json!({"status":"completed","memory":{"entries":[]}}),
            json!({"status":"completed","stop_reason":"stop","memory":{"entries":[]}}),
            json!({"status":"in_progress","finish_reason":"stop","memory":{"entries":[]}}),
            json!({"status":"completed","finish_reason":"length","memory":{"entries":[]}}),
        ] {
            let result = observe_v3_responses_direct_memory_at_resp03(
                Some(&handle),
                &payload(value),
                "req-proof",
            );
            assert_eq!(result, V3MemoryResp03ObservationOutcome::NotEligible);
        }
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }

    #[test]
    fn resp03_memory_admits_valid_entries_only_after_canonical_terminal() {
        let handle = MemorySkillHandle::open(temp_root("admit")).expect("open skill");
        let response = payload(json!({
            "status":"completed",
            "finish_reason":"stop",
            "output_text":"parent remains unchanged",
            "memory":{"entries":[{
                "schema":"routecodex.memory.index-entry.v1",
                "operation":"add",
                "scope":"project",
                "kind":"fact",
                "title":"Resp03",
                "summary":"Only canonical terminal output is admitted.",
                "tags":[],
                "entities":[]
            }]}
        }));
        let result =
            observe_v3_responses_direct_memory_at_resp03(Some(&handle), &response, "req-admit");
        assert_eq!(
            result,
            V3MemoryResp03ObservationOutcome::Observed(V3MemoryResp03Observation {
                admitted: 1,
                deduplicated: 0,
                diagnostics: 0,
                append_errors: 0,
            })
        );
        assert_eq!(handle.pending_entries().expect("pending entries").len(), 1);
        let V3ClientBody::Json(value) = response.body else {
            panic!("test response must remain JSON")
        };
        assert_eq!(value["output_text"], "parent remains unchanged");
    }

    #[test]
    fn resp03_memory_invalid_entry_is_diagnostic_only() {
        let handle = MemorySkillHandle::open(temp_root("invalid")).expect("open skill");
        let response = payload(json!({
            "status":"completed",
            "finish_reason":"stop",
            "memory":{"entries":[{
                "schema":"routecodex.memory.index-entry.v1",
                "operation":"add",
                "scope":"project",
                "kind":"fact",
                "title":"Invalid",
                "summary":"bad",
                "tags":[],
                "entities":[],
                "unexpected":true
            }]}
        }));
        let result =
            observe_v3_responses_direct_memory_at_resp03(Some(&handle), &response, "req-invalid");
        assert_eq!(
            result,
            V3MemoryResp03ObservationOutcome::Observed(V3MemoryResp03Observation {
                admitted: 0,
                deduplicated: 0,
                diagnostics: 1,
                append_errors: 0,
            })
        );
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }

    #[test]
    fn resp03_memory_ignores_non_json_client_body() {
        let handle = MemorySkillHandle::open(temp_root("bytes")).expect("open skill");
        let response = V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::Bytes(br#"{"status":"completed","finish_reason":"stop"}"#.to_vec()),
        };
        assert_eq!(
            observe_v3_responses_direct_memory_at_resp03(Some(&handle), &response, "req-bytes"),
            V3MemoryResp03ObservationOutcome::NotEligible
        );
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }

    #[tokio::test]
    async fn resp03_sse_memory_admits_only_after_completed_stop_terminal() {
        let handle = MemorySkillHandle::open(temp_root("sse-admit")).expect("open skill");
        let memory = json!({
            "entries": [{
                "schema": "routecodex.memory.index-entry.v1",
                "operation": "add",
                "scope": "project",
                "kind": "fact",
                "title": "SSE memory",
                "summary": "A canonical Responses terminal can be observed without changing frames.",
                "tags": ["sse"],
                "entities": ["routecodex"]
            }]
        });
        let frame = terminal_sse_frame(memory);
        let expected = frame.clone();
        let mut response = V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::CommittedSse(committed_sse(&[&frame])),
        };
        assert_eq!(
            attach_v3_responses_direct_memory_sse_observer_at_resp03(
                &mut response,
                Some(&handle),
                "req-sse-admit",
                None,
            ),
            V3MemoryResp03SseObservationAttachOutcome::Attached
        );
        let V3ClientBody::CommittedSse(mut stream) = response.body else {
            panic!("expected committed SSE body");
        };
        let mut received = Vec::new();
        while let Some(frame) = stream.next().await {
            received.extend_from_slice(&frame);
        }
        assert_eq!(
            received, expected,
            "observer must preserve client frames exactly"
        );
        let entries = handle.pending_entries().expect("pending entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].draft.title, "SSE memory");
    }

    #[tokio::test]
    async fn resp03_sse_eof_or_done_without_canonical_pair_never_admits() {
        for (label, frame) in [
            (
                "eof",
                b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
            ),
            ("done", b"data: [DONE]\n\n".to_vec()),
        ] {
            let handle = MemorySkillHandle::open(temp_root(&format!("sse-{label}")))
                .expect("open skill");
            let mut response = V3Resp15ClientPayload {
                status: 200,
                headers: Default::default(),
                body: V3ClientBody::CommittedSse(committed_sse(&[&frame])),
            };
            assert_eq!(
                attach_v3_responses_direct_memory_sse_observer_at_resp03(
                    &mut response,
                    Some(&handle),
                    "req-sse-negative",
                    None,
                ),
                V3MemoryResp03SseObservationAttachOutcome::Attached
            );
            let V3ClientBody::CommittedSse(mut stream) = response.body else {
                panic!("expected committed SSE body");
            };
            while stream.next().await.is_some() {}
            assert!(handle.pending_entries().expect("pending entries").is_empty());
        }
    }

    #[tokio::test]
    async fn resp03_sse_drop_before_terminal_never_admits() {
        let handle = MemorySkillHandle::open(temp_root("sse-drop")).expect("open skill");
        let first = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
        let terminal = terminal_sse_frame(json!({
            "entries": [{
                "schema": "routecodex.memory.index-entry.v1",
                "operation": "add",
                "scope": "project",
                "kind": "fact",
                "title": "Must not admit",
                "summary": "The client dropped before the terminal frame.",
                "tags": [],
                "entities": []
            }]
        }));
        let mut response = V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::CommittedSse(committed_sse(&[first, &terminal])),
        };
        assert_eq!(
            attach_v3_responses_direct_memory_sse_observer_at_resp03(
                &mut response,
                Some(&handle),
                "req-sse-drop",
                None,
            ),
            V3MemoryResp03SseObservationAttachOutcome::Attached
        );
        let V3ClientBody::CommittedSse(mut stream) = response.body else {
            panic!("expected committed SSE body");
        };
        let _ = stream.next().await;
        drop(stream);
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }

    #[tokio::test]
    async fn resp03_sse_invalid_memory_is_diagnostic_only_and_parent_frames_survive() {
        let handle = MemorySkillHandle::open(temp_root("sse-invalid")).expect("open skill");
        let frame = terminal_sse_frame(json!({
            "entries": [{
                "schema": "routecodex.memory.index-entry.v1",
                "operation": "add",
                "scope": "project",
                "kind": "fact",
                "title": "Invalid",
                "summary": "Unknown field is diagnostic-only.",
                "tags": [],
                "entities": [],
                "unexpected": true
            }]
        }));
        let expected = frame.clone();
        let mut response = V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::CommittedSse(committed_sse(&[&frame])),
        };
        attach_v3_responses_direct_memory_sse_observer_at_resp03(
            &mut response,
            Some(&handle),
            "req-sse-invalid",
            None,
        );
        let V3ClientBody::CommittedSse(mut stream) = response.body else {
            panic!("expected committed SSE body");
        };
        let mut received = Vec::new();
        while let Some(frame) = stream.next().await {
            received.extend_from_slice(&frame);
        }
        assert_eq!(received, expected);
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }

    #[tokio::test]
    async fn resp03_sse_capture_errors_are_recorded_on_runtime_observation_side_channel() {
        let handle =
            MemorySkillHandle::open(temp_root("sse-observation-error")).expect("open skill");
        let observation = V3RuntimeStreamObservation::default();
        let frame = b"data: {not-json}\n\n";
        let mut response = V3Resp15ClientPayload {
            status: 200,
            headers: Default::default(),
            body: V3ClientBody::CommittedSse(committed_sse(&[frame])),
        };
        attach_v3_responses_direct_memory_sse_observer_at_resp03(
            &mut response,
            Some(&handle),
            "req-sse-observation-error",
            Some(&observation),
        );
        let V3ClientBody::CommittedSse(mut stream) = response.body else {
            panic!("expected committed SSE body");
        };
        while stream.next().await.is_some() {}
        let snapshot = observation.snapshot().expect("observation snapshot");
        assert!(snapshot
            .observation_error
            .as_deref()
            .is_some_and(|error| error.contains("memory_resp03_sse")));
        assert!(handle
            .pending_entries()
            .expect("pending entries")
            .is_empty());
    }
}
