//! Independent client SSE transport module.
//!
//! Declared skeleton: `V3DirectSseAccept01ClientChannel` (client SSE channel and
//! transport-only keepalive) -> `V3DirectSseAccept02RuntimeWorker` (the runtime
//! buffers one complete provider attempt) -> `V3DirectSseAccept03ProjectedClientFrame`
//! (only the runtime-projected client frame crosses into the client transport).
//!
//! Transport rules:
//!
//! - The channel and its keepalive are transport-only. No provider payload byte
//!   reaches the client before the runtime outcome exists, and establishing the
//!   channel is not a semantic client commit.
//! - The module never classifies provider or client business events and never
//!   reparses JSON to infer provider or control state. It reads only the HTTP
//!   status and content type of the already-projected runtime outcome.
//! - A committed channel carries the projected client payload: an SSE payload
//!   streams through unchanged, and a successful non-SSE payload is carried by
//!   the SSE transport framing of the committed bytes. The keepalive has exactly
//!   one owner at a time: this channel owns it while the runtime outcome is
//!   pending, and the drained SSE body owns it afterwards.
//! - An outcome with no successful client payload closes the client transport
//!   without projecting a provider status, error payload, or fabricated success.
//!   The real cause stays in the typed Error chain and in the console record.
use crate::V3LiveSnapClientWireCaptureSlot;
use axum::body::{Body, BodyDataStream};
use axum::http::{header, StatusCode};
use axum::response::Response;
use futures_util::Stream;
use routecodex_v3_sse::{
    build_v3_sse_transport_in_02_from_fields,
    build_v3_sse_transport_in_03_from_v3_sse_transport_in_02,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03,
    build_v3_sse_transport_out_04_keepalive_comment, SseField,
};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The transport-only keepalive comment carried by the committed client channel.
const V3_CLIENT_SSE_KEEPALIVE_COMMENT: &str = " keepalive";

/// Recording hook for a client that disconnects while the runtime outcome is pending.
///
/// The transport owns the disconnect fact: only it sees the committed channel
/// drop. The recorder that turns that fact into a typed terminal row is injected
/// by the request owner, which holds the request identity and the console
/// ingress. The transport never builds the ledger row itself.
pub(crate) type V3ClientDisconnectRecorder = Box<dyn FnOnce() + Send>;

/// Shared slot that lets the still-running request install its recorder after it
/// allocates the request identity. The transport keeps its own clone, so the
/// recorder survives the runtime task abort that the disconnect triggers.
#[derive(Clone, Default)]
pub(crate) struct V3ClientDisconnectSlot {
    state: Arc<Mutex<V3ClientDisconnectState>>,
}

#[derive(Default)]
struct V3ClientDisconnectState {
    disconnected: bool,
    consumed: bool,
    recorder: Option<V3ClientDisconnectRecorder>,
}

impl V3ClientDisconnectSlot {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn set(&self, recorder: V3ClientDisconnectRecorder) {
        let run_now = self.state.lock().ok().and_then(|mut state| {
            if state.consumed {
                None
            } else if state.disconnected {
                state.consumed = true;
                Some(recorder)
            } else {
                state.recorder = Some(recorder);
                None
            }
        });
        if let Some(recorder) = run_now {
            recorder();
        }
    }

    #[cfg(test)]
    fn take(&self) -> Option<V3ClientDisconnectRecorder> {
        self.state.lock().ok().and_then(|mut state| {
            let recorder = state.recorder.take();
            if recorder.is_some() {
                state.consumed = true;
            }
            recorder
        })
    }

    fn record_disconnect(&self) {
        let recorder = self.state.lock().ok().and_then(|mut state| {
            state.disconnected = true;
            if state.consumed {
                None
            } else if let Some(recorder) = state.recorder.take() {
                state.consumed = true;
                Some(recorder)
            } else {
                None
            }
        });
        if let Some(recorder) = recorder {
            recorder();
        }
    }
}

/// Accept the client SSE channel while the runtime worker still buffers the
/// provider attempt.
///
/// Two events race during this stage: the runtime outcome and one keepalive
/// window.
///
/// - The outcome wins: the outcome is returned unchanged, so a client that never
///   needed the channel keeps the exact runtime status, headers, and body.
/// - The keepalive window expires first: the channel is committed and the
///   deferred runtime outcome is spliced into it.
pub(crate) async fn accept_v3_client_sse_transport(
    runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>>,
    finalize_runtime_outcome: Box<dyn FnOnce(Response<Body>) -> Response<Body> + Send>,
    keepalive_interval: Duration,
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
    client_disconnect_slot: Option<V3ClientDisconnectSlot>,
) -> Response<Body> {
    let mut runtime_outcome = runtime_outcome;

    enum V3ClientSseAcceptRace {
        Outcome(Response<Body>),
        KeepaliveDeadline,
    }

    let raced = match tokio::time::timeout(keepalive_interval, &mut runtime_outcome).await {
        Ok(outcome) => V3ClientSseAcceptRace::Outcome(outcome),
        Err(_) => V3ClientSseAcceptRace::KeepaliveDeadline,
    };

    match raced {
        V3ClientSseAcceptRace::Outcome(outcome) => finalize_runtime_outcome(outcome),
        V3ClientSseAcceptRace::KeepaliveDeadline => {
            let (outcome_sender, outcome) = oneshot::channel();
            let outcome_task = tokio::spawn(async move {
                let outcome = runtime_outcome.await;
                let _ = outcome_sender.send(finalize_runtime_outcome(outcome));
            });
            commit_v3_client_sse_channel(
                outcome,
                Some(outcome_task),
                keepalive_interval,
                client_wire_capture,
                client_disconnect_slot,
            )
        }
    }
}

/// Commit the client SSE channel for a pending, deferred, or already-resolved
/// runtime outcome.
///
/// `outcome_task` owns the runtime work. The committed body aborts that task when
/// the client transport goes away, so a client disconnect still cancels the
/// in-flight runtime request.
fn commit_v3_client_sse_channel(
    outcome: oneshot::Receiver<Response<Body>>,
    outcome_task: Option<JoinHandle<()>>,
    keepalive_interval: Duration,
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
    client_disconnect_slot: Option<V3ClientDisconnectSlot>,
) -> Response<Body> {
    let mut interval = tokio::time::interval_at(
        tokio::time::Instant::now() + keepalive_interval,
        keepalive_interval,
    );
    // A stalled client must not build a keepalive backlog: the next comment is
    // scheduled from the completed tick, not from the missed deadline.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let stream = V3ClientSseChannelStream {
        outcome,
        outcome_task,
        client_wire_capture: client_wire_capture.clone(),
        client_disconnect_slot,
        interval,
        keepalive_chunk: build_v3_sse_transport_out_04_keepalive_comment(
            V3_CLIENT_SSE_KEEPALIVE_COMMENT,
        )
        .into_bytes(),
        flush_yield: false,
        state: V3ClientSseChannelState::AwaitOutcome {
            keepalive_sent: false,
        },
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("V3 committed client SSE channel response");
    if let Some(client_wire_capture) = client_wire_capture {
        response.extensions_mut().insert(client_wire_capture);
    }
    response
}

enum V3ClientSseChannelState {
    AwaitOutcome {
        keepalive_sent: bool,
    },
    /// The projected client frame is already an SSE body: it owns the transport
    /// framing and the keepalive from this point on.
    Drain(Pin<Box<BodyDataStream>>),
    /// The projected client frame is a successful non-SSE payload: the committed
    /// bytes are carried by SSE transport framing.
    FrameCommittedPayload {
        stream: Pin<Box<BodyDataStream>>,
        payload: Vec<u8>,
    },
    Finished,
}

/// What the committed channel does with an already-projected runtime outcome.
enum V3ClientSseChannelDisposition {
    Drain,
    FrameCommittedPayload,
    Close(io::Error),
}

struct V3ClientSseChannelStream {
    outcome: oneshot::Receiver<Response<Body>>,
    outcome_task: Option<JoinHandle<()>>,
    /// Hands the client-response sample recorder from the runtime outcome to the
    /// transport boundary wrapper that owns the final client wire.
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
    /// Owns the recorder that writes the committed-then-cancelled terminal row.
    client_disconnect_slot: Option<V3ClientDisconnectSlot>,
    interval: tokio::time::Interval,
    keepalive_chunk: Vec<u8>,
    /// Set when a chunk was just handed to the client transport. The next poll
    /// yields `Pending` once so the HTTP writer flushes that chunk before the
    /// channel can advance to another chunk or a terminal event.
    flush_yield: bool,
    state: V3ClientSseChannelState,
}

impl V3ClientSseChannelStream {
    fn keepalive(&self) -> Result<Vec<u8>, io::Error> {
        Ok(self.keepalive_chunk.clone())
    }

    /// A committed SSE channel carries a successful client payload. An SSE payload
    /// streams through; a successful non-SSE payload is carried by SSE transport
    /// framing of the committed bytes. Every other outcome keeps its explicit
    /// transport failure instead of a silent clean end, and the connection record
    /// keeps the runtime status for diagnosis.
    fn committed_channel_disposition(response: &Response<Body>) -> V3ClientSseChannelDisposition {
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !response.status().is_success() {
            return V3ClientSseChannelDisposition::Close(io::Error::other(format!(
                "committed client SSE channel cannot carry runtime outcome status {} content-type {content_type:?}; the client transport closes without an error frame",
                response.status().as_u16()
            )));
        }
        if content_type.starts_with("text/event-stream") {
            V3ClientSseChannelDisposition::Drain
        } else {
            V3ClientSseChannelDisposition::FrameCommittedPayload
        }
    }
}

/// Carry committed non-SSE payload bytes as one SSE `data:` frame.
///
/// This is transport framing only: the module never parses the payload. Each
/// payload line becomes its own `data:` field so the frame stays well formed for
/// any committed bytes, and non-UTF-8 bytes follow the transport contract of
/// U+FFFD substitution instead of breaking the frame.
fn build_v3_client_sse_data_frame(payload: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(payload);
    let mut fields = Vec::new();
    for line in text.split('\n') {
        fields.push(SseField::Named {
            name: "data".to_string(),
            value: line.strip_suffix('\r').unwrap_or(line).to_string(),
        });
    }
    if fields.is_empty() {
        fields.push(SseField::Named {
            name: "data".to_string(),
            value: String::new(),
        });
    }
    match build_v3_sse_transport_in_02_from_fields(fields)
        .and_then(build_v3_sse_transport_in_03_from_v3_sse_transport_in_02)
    {
        Ok(frame) => build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame).into_bytes(),
        Err(_) => Vec::new(),
    }
}

impl Stream for V3ClientSseChannelStream {
    type Item = Result<Vec<u8>, io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            // The HTTP writer flushes a response body chunk only when the body
            // stream reports `Pending`. A chunk followed immediately by another
            // chunk or by the terminal event in the same wake would sit in a
            // buffer that never reaches the socket, so the client observes a
            // silent disconnect. Yield once per emitted chunk, with the waker
            // armed, so the chunk is flushed before the channel advances.
            if this.flush_yield {
                this.flush_yield = false;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            match &mut this.state {
                V3ClientSseChannelState::AwaitOutcome { keepalive_sent } => {
                    if !*keepalive_sent {
                        *keepalive_sent = true;
                        return Poll::Ready(Some(this.keepalive()));
                    }
                    if this.interval.poll_tick(cx).is_ready() {
                        this.flush_yield = true;
                        return Poll::Ready(Some(this.keepalive()));
                    }
                    match Pin::new(&mut this.outcome).poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(mut response)) => {
                            this.outcome_task = None;
                            // The client-response sample recorder travels on the
                            // runtime outcome, but this channel owns the response
                            // head the client actually sees. Adopt the recorder
                            // here so the transport boundary records the final
                            // wire.
                            if let Some(capture_slot) = this.client_wire_capture.as_ref() {
                                capture_slot.adopt_from_response(&mut response);
                            }
                            let disposition =
                                V3ClientSseChannelStream::committed_channel_disposition(&response);
                            match disposition {
                                V3ClientSseChannelDisposition::Close(error) => {
                                    this.state = V3ClientSseChannelState::Finished;
                                    return Poll::Ready(Some(Err(error)));
                                }
                                V3ClientSseChannelDisposition::Drain => {
                                    this.state = V3ClientSseChannelState::Drain(Box::pin(
                                        response.into_body().into_data_stream(),
                                    ));
                                }
                                V3ClientSseChannelDisposition::FrameCommittedPayload => {
                                    this.state = V3ClientSseChannelState::FrameCommittedPayload {
                                        stream: Box::pin(response.into_body().into_data_stream()),
                                        payload: Vec::new(),
                                    };
                                }
                            }
                        }
                        Poll::Ready(Err(_)) => {
                            this.state = V3ClientSseChannelState::Finished;
                            return Poll::Ready(Some(Err(io::Error::other(
                                "committed client SSE channel lost the runtime outcome channel; the client transport closes without an error frame",
                            ))));
                        }
                    }
                }
                V3ClientSseChannelState::Drain(stream) => {
                    // The drained SSE body owns the transport framing and the
                    // keepalive, so the channel must not emit a second keepalive
                    // stream on the same client connection.
                    match stream.as_mut().poll_next(cx) {
                        Poll::Ready(Some(Ok(bytes))) => {
                            this.flush_yield = true;
                            return Poll::Ready(Some(Ok(bytes.to_vec())));
                        }
                        Poll::Ready(Some(Err(error))) => {
                            this.state = V3ClientSseChannelState::Finished;
                            return Poll::Ready(Some(Err(io::Error::other(error))));
                        }
                        Poll::Ready(None) => {
                            this.state = V3ClientSseChannelState::Finished;
                            return Poll::Ready(None);
                        }
                        Poll::Pending => return Poll::Pending,
                    }
                }
                V3ClientSseChannelState::FrameCommittedPayload { stream, payload } => {
                    match stream.as_mut().poll_next(cx) {
                        Poll::Ready(Some(Ok(bytes))) => {
                            payload.extend_from_slice(&bytes);
                        }
                        Poll::Ready(Some(Err(error))) => {
                            this.state = V3ClientSseChannelState::Finished;
                            return Poll::Ready(Some(Err(io::Error::other(error))));
                        }
                        Poll::Ready(None) => {
                            let frame = build_v3_client_sse_data_frame(&std::mem::take(payload));
                            this.state = V3ClientSseChannelState::Finished;
                            this.flush_yield = true;
                            return Poll::Ready(Some(Ok(frame)));
                        }
                        Poll::Pending => {
                            // The committed payload body is still arriving; the
                            // channel stays transport-live while it does.
                            if this.interval.poll_tick(cx).is_ready() {
                                this.flush_yield = true;
                                return Poll::Ready(Some(this.keepalive()));
                            }
                            return Poll::Pending;
                        }
                    }
                }
                V3ClientSseChannelState::Finished => return Poll::Ready(None),
            }
        }
    }
}

impl Drop for V3ClientSseChannelStream {
    fn drop(&mut self) {
        // A client that goes away while the runtime outcome is still pending
        // never reaches runtime closeout, even before its first business frame:
        // the abort below drops the runtime task first. Record that disconnect
        // terminal here. A resolved or already-closed outcome is left to the
        // existing finalizer so the terminal row is written exactly once.
        let outcome_still_pending = matches!(
            self.outcome.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        let record_disconnect = matches!(self.state, V3ClientSseChannelState::AwaitOutcome { .. })
            && self.outcome_task.is_some()
            && outcome_still_pending;
        if record_disconnect {
            if let Some(slot) = &self.client_disconnect_slot {
                slot.record_disconnect();
            }
        }
        if let Some(task) = self.outcome_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn json_outcome(status: u16, content_type: &'static str, body: &'static str) -> Response<Body> {
        Response::builder()
            .status(StatusCode::from_u16(status).unwrap())
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap()
    }

    fn sse_outcome(frames: Vec<&'static [u8]>, stall: Duration) -> Response<Body> {
        let body = futures_util::stream::unfold(
            (0_usize, frames, stall),
            |(index, frames, stall)| async move {
                let frame = frames.get(index)?;
                if index > 0 {
                    tokio::time::sleep(stall).await;
                }
                Some((
                    Ok::<Vec<u8>, std::convert::Infallible>(frame.to_vec()),
                    (index + 1, frames, stall),
                ))
            },
        );
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from_stream(body))
            .unwrap()
    }

    fn channel(
        outcome: oneshot::Receiver<Response<Body>>,
        task: JoinHandle<()>,
        interval: Duration,
    ) -> V3ClientSseChannelStream {
        let mut interval =
            tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        V3ClientSseChannelStream {
            outcome,
            outcome_task: Some(task),
            client_wire_capture: None,
            client_disconnect_slot: None,
            interval,
            keepalive_chunk: b": keepalive\n\n".to_vec(),
            flush_yield: false,
            state: V3ClientSseChannelState::AwaitOutcome {
                keepalive_sent: false,
            },
        }
    }

    async fn collect(stream: V3ClientSseChannelStream) -> Vec<Result<Vec<u8>, io::Error>> {
        let mut stream = Box::pin(stream);
        let mut chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            chunks.push(chunk);
        }
        chunks
    }

    fn keepalive_count(chunks: &[Result<Vec<u8>, io::Error>]) -> usize {
        chunks
            .iter()
            .filter(|chunk| {
                chunk.as_ref().map(Vec::as_slice).ok() == Some(b": keepalive\n\n".as_slice())
            })
            .count()
    }

    fn disconnect_slot(calls: &Arc<AtomicUsize>) -> V3ClientDisconnectSlot {
        let calls = Arc::clone(calls);
        let slot = V3ClientDisconnectSlot::new();
        slot.set(Box::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
        }));
        slot
    }

    #[tokio::test]
    async fn client_sse_channel_keeps_the_client_transport_live_before_the_runtime_outcome() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = sender.send(sse_outcome(vec![b"data: first\n\n"], Duration::ZERO));
        });
        let chunks = collect(channel(outcome, task, Duration::from_millis(50))).await;
        assert!(
            keepalive_count(&chunks) >= 3,
            "a pending runtime outcome must keep the transport live: {chunks:?}"
        );
        assert_eq!(
            chunks.first().and_then(|chunk| chunk.as_ref().ok()),
            Some(&b": keepalive\n\n".to_vec()),
            "the committed channel must write its first byte immediately"
        );
        assert_eq!(
            chunks.last().and_then(|chunk| chunk.as_ref().ok()),
            Some(&b"data: first\n\n".to_vec()),
            "the runtime outcome must stream through unchanged: {chunks:?}"
        );
    }

    #[tokio::test]
    async fn client_sse_channel_delegates_the_keepalive_to_the_drained_outcome_body() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(sse_outcome(
                vec![b"data: first\n\n", b": keepalive\n\n", b"data: [DONE]\n\n"],
                Duration::from_millis(150),
            ));
        });
        let chunks = collect(channel(outcome, task, Duration::from_millis(40))).await;
        // The outcome body spans more than three keepalive intervals, so a second
        // emitter on the committed channel would add extra comments. Only the one
        // comment before the outcome and the body's own comment may appear.
        assert_eq!(
            chunks.len(),
            4,
            "the drained SSE body owns the keepalive, so the channel must not add a second one: {chunks:?}"
        );
        assert_eq!(
            keepalive_count(&chunks),
            2,
            "exactly one committed keepalive before the outcome plus the body's own: {chunks:?}"
        );
        assert_eq!(
            chunks.last().and_then(|chunk| chunk.as_ref().ok()),
            Some(&b"data: [DONE]\n\n".to_vec())
        );
    }

    #[tokio::test]
    async fn client_sse_channel_carries_a_successful_non_sse_outcome_as_sse_framing() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(json_outcome(
                200,
                "application/json",
                r#"{"id":"resp_json","output_text":"ok"}"#,
            ));
        });
        let chunks = collect(channel(outcome, task, Duration::from_millis(50))).await;
        let errors: Vec<_> = chunks
            .iter()
            .filter_map(|chunk| chunk.as_ref().err())
            .collect();
        assert!(
            errors.is_empty(),
            "a successful runtime outcome must never become a client transport failure: {errors:?}"
        );
        assert_eq!(
            chunks.last().and_then(|chunk| chunk.as_ref().ok()),
            Some(&b"data: {\"id\":\"resp_json\",\"output_text\":\"ok\"}\n\n".to_vec()),
            "the committed payload must be carried by SSE transport framing: {chunks:?}"
        );
    }

    #[tokio::test]
    async fn client_sse_channel_frames_every_committed_payload_line() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(json_outcome(200, "text/plain", "first\nsecond"));
        });
        let chunks = collect(channel(outcome, task, Duration::from_millis(50))).await;
        assert_eq!(
            chunks.last().and_then(|chunk| chunk.as_ref().ok()),
            Some(&b"data: first\ndata: second\n\n".to_vec()),
            "a multi-line committed payload must stay a well formed frame: {chunks:?}"
        );
    }

    #[tokio::test]
    async fn client_sse_channel_closes_when_the_outcome_has_no_successful_client_payload() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(json_outcome(
                598,
                "application/json",
                r#"{"error":{"code":"internal"}}"#,
            ));
        });
        let chunks = collect(channel(outcome, task, Duration::from_millis(50))).await;
        let error = chunks
            .last()
            .and_then(|chunk| chunk.as_ref().err())
            .expect("a committed SSE channel cannot carry a non-successful runtime outcome");
        assert!(
            error.to_string().contains("598"),
            "the connection record must keep the runtime status: {error}"
        );
        assert_eq!(
            chunks.len(),
            2,
            "keepalive then the explicit close: {chunks:?}"
        );
    }

    #[tokio::test]
    async fn client_sse_channel_drop_aborts_the_pending_runtime_task() {
        let (sender, outcome) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = V3TestCancellationGuard(Arc::clone(&cancelled));
        let task = tokio::spawn(async move {
            let _guard = guard;
            tokio::time::sleep(Duration::from_secs(30)).await;
            let _ = sender.send(sse_outcome(vec![b"data: late\n\n"], Duration::ZERO));
        });
        drop(channel(outcome, task, Duration::from_millis(50)));
        for _ in 0..50 {
            if cancelled.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("a client disconnect must abort the pending runtime task");
    }

    #[tokio::test]
    async fn client_sse_channel_records_a_keepalive_only_disconnect_once() {
        let (_outcome_sender, outcome) = oneshot::channel();
        let task = tokio::spawn(std::future::pending::<()>());
        let mut stream = Box::pin(channel(outcome, task, Duration::from_millis(50)));
        let calls = Arc::new(AtomicUsize::new(0));
        let slot = disconnect_slot(&calls);
        stream.client_disconnect_slot = Some(slot.clone());

        assert_eq!(
            stream.next().await.expect("keepalive").expect("frame"),
            b": keepalive\n\n".to_vec(),
            "the pending channel must emit only the transport keepalive before the disconnect"
        );
        drop(stream);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a real disconnect before the first business frame must record one cancelled terminal"
        );
        assert!(
            slot.take().is_none(),
            "the disconnect recorder must be consumed exactly once"
        );
    }

    #[tokio::test]
    async fn client_disconnect_before_recorder_install_runs_it_once() {
        let (_outcome_sender, outcome) = oneshot::channel();
        let task = tokio::spawn(std::future::pending::<()>());
        let mut stream = Box::pin(channel(outcome, task, Duration::from_millis(50)));
        let calls = Arc::new(AtomicUsize::new(0));
        let slot = V3ClientDisconnectSlot::new();
        stream.client_disconnect_slot = Some(slot.clone());

        assert_eq!(
            stream.next().await.expect("keepalive").expect("frame"),
            b": keepalive\n\n".to_vec()
        );
        drop(stream);

        let first_calls = Arc::clone(&calls);
        slot.set(Box::new(move || {
            first_calls.fetch_add(1, Ordering::SeqCst);
        }));
        let second_calls = Arc::clone(&calls);
        slot.set(Box::new(move || {
            second_calls.fetch_add(100, Ordering::SeqCst);
        }));

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a disconnect observed before recorder installation must be retained and consumed once"
        );
        assert!(slot.take().is_none(), "the recorder remains single-use");
    }

    #[tokio::test]
    async fn client_sse_channel_does_not_record_a_ready_outcome_as_cancelled() {
        let (outcome_sender, outcome) = oneshot::channel();
        let task = tokio::spawn(std::future::pending::<()>());
        let mut stream = Box::pin(channel(outcome, task, Duration::from_millis(50)));
        let calls = Arc::new(AtomicUsize::new(0));
        stream.client_disconnect_slot = Some(disconnect_slot(&calls));

        outcome_sender
            .send(sse_outcome(vec![b"data: complete\n\n"], Duration::ZERO))
            .expect("ready runtime outcome");
        drop(stream);

        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a resolved runtime outcome must keep its existing finalizer and must not be reclassified as cancelled"
        );
    }

    #[tokio::test]
    async fn client_sse_transport_returns_the_runtime_outcome_unchanged_inside_one_interval() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(());
        });
        let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
            Box::pin(async move { json_outcome(200, "application/json", r#"{"ok":true}"#) });
        let response = accept_v3_client_sse_transport(
            runtime_outcome,
            Box::new(|outcome| outcome),
            Duration::from_millis(50),
            None,
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/json"),
            "a fast outcome keeps the exact runtime headers"
        );
        task.await.unwrap();
    }

    struct V3TestCancellationGuard(Arc<AtomicBool>);

    impl Drop for V3TestCancellationGuard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
}
