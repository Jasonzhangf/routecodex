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
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The transport-only keepalive comment carried by the committed client channel.
const V3_CLIENT_SSE_KEEPALIVE_COMMENT: &str = " keepalive";

/// Accept the client SSE channel while the runtime worker still buffers the
/// provider attempt.
///
/// Three events race during this stage: the runtime outcome, the first committed
/// business frame, and one keepalive window.
///
/// - The outcome wins: the outcome is returned unchanged, so a client that never
///   needed the channel keeps the exact runtime status, headers, and body.
/// - A committed frame wins: the channel is returned immediately and carries that
///   frame at its provider arrival time. The runtime keeps running in a task this
///   channel owns and aborts it on client disconnect.
/// - The keepalive window expires first: the channel is committed and the
///   deferred runtime outcome is spliced into it.
///
/// `client_frame_receiver` carries the committed first-business-frame prefix:
/// bytes the runtime handed to the client channel before the provider terminal
/// existed. The committed channel emits these bytes first, then the deferred
/// runtime outcome.
///
/// `finalize_runtime_outcome` applies the same model-entry transport projection
/// the entry handler applies on the fast path. The deferred outcome must apply it
/// here because the entry handler can no longer see the committed body. The
/// projection is idempotent, so the entry handler's later application is a no-op.
pub(crate) async fn accept_v3_client_sse_transport(
    runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>>,
    client_frame_receiver: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
    finalize_runtime_outcome: Box<dyn FnOnce(Response<Body>) -> Response<Body> + Send>,
    keepalive_interval: Duration,
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
) -> Response<Body> {
    let mut runtime_outcome = runtime_outcome;
    let mut client_frame_receiver = client_frame_receiver;

    /// Which event ended the accept stage.
    enum V3ClientSseAcceptRace {
        /// The runtime outcome resolved first.
        Outcome(Response<Body>),
        /// The runtime committed a business frame first, so the channel must
        /// carry it before the outcome exists.
        CommittedFrame(Vec<u8>),
        /// Neither the outcome nor a frame arrived inside one keepalive window.
        KeepaliveDeadline,
    }

    let raced = if let Some(receiver) = client_frame_receiver.as_mut() {
        tokio::select! {
            biased;
            frame = receiver.recv() => match frame {
                Some(frame) => V3ClientSseAcceptRace::CommittedFrame(frame),
                // The runtime dropped the sink without a committed frame, so no
                // frame can arrive later and the outcome owns the channel.
                None => match tokio::time::timeout(keepalive_interval, &mut runtime_outcome).await {
                    Ok(outcome) => V3ClientSseAcceptRace::Outcome(outcome),
                    Err(_) => V3ClientSseAcceptRace::KeepaliveDeadline,
                },
            },
            outcome = &mut runtime_outcome => V3ClientSseAcceptRace::Outcome(outcome),
            _ = tokio::time::sleep(keepalive_interval) => V3ClientSseAcceptRace::KeepaliveDeadline,
        }
    } else {
        match tokio::time::timeout(keepalive_interval, &mut runtime_outcome).await {
            Ok(outcome) => V3ClientSseAcceptRace::Outcome(outcome),
            Err(_) => V3ClientSseAcceptRace::KeepaliveDeadline,
        }
    };

    match raced {
        V3ClientSseAcceptRace::Outcome(outcome) => {
            let mut prefix_frames = Vec::new();
            if let Some(receiver) = client_frame_receiver.as_mut() {
                while let Ok(frame) = receiver.try_recv() {
                    prefix_frames.push(frame);
                }
            }
            if prefix_frames.is_empty() {
                return finalize_runtime_outcome(outcome);
            }
            // The first business frame already crossed the commit point. The
            // committed channel owns the response head and must emit that prefix
            // before the remainder, because the sealed outcome body skips the
            // frames the runtime already flushed.
            let (outcome_sender, deferred_outcome) = oneshot::channel();
            let _ = outcome_sender.send(finalize_runtime_outcome(outcome));
            commit_v3_client_sse_channel(
                deferred_outcome,
                None,
                client_frame_receiver,
                prefix_frames,
                keepalive_interval,
                client_wire_capture,
            )
        }
        V3ClientSseAcceptRace::CommittedFrame(frame) => {
            // The runtime committed a business frame before its outcome existed.
            // Return the channel now so the frame reaches the client at its
            // provider arrival time; the runtime keeps running in a task this
            // channel owns and aborts on client disconnect.
            let mut prefix_frames = vec![frame];
            if let Some(receiver) = client_frame_receiver.as_mut() {
                while let Ok(frame) = receiver.try_recv() {
                    prefix_frames.push(frame);
                }
            }
            let (outcome_sender, deferred_outcome) = oneshot::channel();
            let outcome_task = tokio::spawn(async move {
                let outcome = runtime_outcome.await;
                let _ = outcome_sender.send(finalize_runtime_outcome(outcome));
            });
            commit_v3_client_sse_channel(
                deferred_outcome,
                Some(outcome_task),
                client_frame_receiver,
                prefix_frames,
                keepalive_interval,
                client_wire_capture,
            )
        }
        V3ClientSseAcceptRace::KeepaliveDeadline => {
            let (outcome_sender, outcome) = oneshot::channel();
            let outcome_task = tokio::spawn(async move {
                let outcome = runtime_outcome.await;
                let _ = outcome_sender.send(finalize_runtime_outcome(outcome));
            });
            commit_v3_client_sse_channel(
                outcome,
                Some(outcome_task),
                client_frame_receiver,
                Vec::new(),
                keepalive_interval,
                client_wire_capture,
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
    client_frame_receiver: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
    prefix_frames: Vec<Vec<u8>>,
    keepalive_interval: Duration,
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
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
        client_frame_receiver,
        client_frame_prefix: prefix_frames.into(),
        client_frame_emitted: false,
        client_wire_capture: client_wire_capture.clone(),
        interval,
        keepalive_chunk: build_v3_sse_transport_out_04_keepalive_comment(
            V3_CLIENT_SSE_KEEPALIVE_COMMENT,
        )
        .into_bytes(),
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
    /// Frames the runtime committed before the provider terminal existed. They
    /// are the exact client bytes for the prefix; the drained outcome body skips
    /// them, so the channel emits them first and never duplicates one.
    client_frame_receiver: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
    /// Committed frames that arrived before the channel was committed.
    client_frame_prefix: std::collections::VecDeque<Vec<u8>>,
    /// Set as soon as one committed frame reached the client. From that point the
    /// transport never emits another keepalive and never projects an error.
    client_frame_emitted: bool,
    /// Hands the client-response sample recorder from the runtime outcome to the
    /// transport boundary wrapper that owns the final client wire.
    client_wire_capture: Option<V3LiveSnapClientWireCaptureSlot>,
    interval: tokio::time::Interval,
    keepalive_chunk: Vec<u8>,
    state: V3ClientSseChannelState,
}

impl V3ClientSseChannelStream {
    fn keepalive(&self) -> Result<Vec<u8>, io::Error> {
        Ok(self.keepalive_chunk.clone())
    }

    /// Poll the next committed client frame.
    ///
    /// `Closed` means the runtime dropped the sink: no frame can arrive later.
    fn poll_client_frame(&mut self, cx: &mut Context<'_>) -> Poll<Option<Vec<u8>>> {
        if let Some(frame) = self.client_frame_prefix.pop_front() {
            self.client_frame_emitted = true;
            return Poll::Ready(Some(frame));
        }
        let Some(receiver) = self.client_frame_receiver.as_mut() else {
            return Poll::Ready(None);
        };
        match receiver.poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                self.client_frame_emitted = true;
                Poll::Ready(Some(frame))
            }
            Poll::Ready(None) => {
                self.client_frame_receiver = None;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
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
            // Poll the committed client prefix before the state machine: a
            // committed frame must reach the client even while the runtime
            // outcome is pending, and the method borrow must not overlap the
            // state match.
            if matches!(this.state, V3ClientSseChannelState::AwaitOutcome { .. }) {
                if let Poll::Ready(Some(frame)) = this.poll_client_frame(cx) {
                    return Poll::Ready(Some(Ok(frame)));
                }
            }
            match &mut this.state {
                V3ClientSseChannelState::AwaitOutcome { keepalive_sent } => {
                    // A committed frame is business payload, not transport
                    // liveness: the keepalive has no owner once one was emitted.
                    if !this.client_frame_emitted {
                        if !*keepalive_sent {
                            *keepalive_sent = true;
                            return Poll::Ready(Some(this.keepalive()));
                        }
                        if this.interval.poll_tick(cx).is_ready() {
                            return Poll::Ready(Some(this.keepalive()));
                        }
                    }
                    let committed_already = this.client_frame_emitted;
                    match Pin::new(&mut this.outcome).poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Ok(mut response)) => {
                            this.outcome_task = None;
                            // The client-response sample recorder travels on the
                            // runtime outcome, but this channel owns the response
                            // head the client actually sees. Adopt the recorder
                            // here so the transport boundary records the final
                            // wire, including the committed prefix frames.
                            if let Some(capture_slot) = this.client_wire_capture.as_ref() {
                                capture_slot.adopt_from_response(&mut response);
                            }
                            let disposition =
                                V3ClientSseChannelStream::committed_channel_disposition(&response);
                            if committed_already {
                                // The client already holds committed business
                                // bytes. Only the continuing committed SSE body
                                // may follow; any other outcome is a silent
                                // transport close without an error frame.
                                match disposition {
                                    V3ClientSseChannelDisposition::Drain => {
                                        this.state = V3ClientSseChannelState::Drain(Box::pin(
                                            response.into_body().into_data_stream(),
                                        ));
                                    }
                                    V3ClientSseChannelDisposition::Close(_)
                                    | V3ClientSseChannelDisposition::FrameCommittedPayload => {
                                        this.state = V3ClientSseChannelState::Finished;
                                        return Poll::Ready(None);
                                    }
                                }
                                continue;
                            }
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
                            if committed_already {
                                return Poll::Ready(None);
                            }
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
                            return Poll::Ready(Some(Ok(bytes.to_vec())))
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
                            return Poll::Ready(Some(Ok(frame)));
                        }
                        Poll::Pending => {
                            // The committed payload body is still arriving; the
                            // channel stays transport-live while it does.
                            if this.interval.poll_tick(cx).is_ready() {
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
        if let Some(task) = self.outcome_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::sync::atomic::{AtomicBool, Ordering};
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
            client_frame_receiver: None,
            client_frame_prefix: std::collections::VecDeque::new(),
            client_frame_emitted: false,
            client_wire_capture: None,
            interval,
            keepalive_chunk: b": keepalive\n\n".to_vec(),
            state: V3ClientSseChannelState::AwaitOutcome {
                keepalive_sent: false,
            },
        }
    }

    fn channel_with_client_frames(
        outcome: oneshot::Receiver<Response<Body>>,
        task: JoinHandle<()>,
        client_frame_receiver: Option<tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>>,
        interval: Duration,
    ) -> V3ClientSseChannelStream {
        let mut stream = channel(outcome, task, interval);
        stream.client_frame_receiver = client_frame_receiver;
        stream
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
    async fn client_sse_transport_returns_the_runtime_outcome_unchanged_inside_one_interval() {
        let (sender, outcome) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sender.send(());
        });
        let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
            Box::pin(async move { json_outcome(200, "application/json", r#"{"ok":true}"#) });
        let response = accept_v3_client_sse_transport(
            runtime_outcome,
            None,
            Box::new(|outcome| outcome),
            Duration::from_millis(50),
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

    #[tokio::test]
    async fn client_sse_first_frame_channel_emits_the_committed_frame_before_the_runtime_outcome() {
        let (outcome_sender, outcome) = oneshot::channel();
        let (frame_sender, frames) = tokio::sync::mpsc::unbounded_channel();
        let mut stream = Box::pin(channel_with_client_frames(
            outcome,
            tokio::spawn(async {}),
            Some(frames),
            Duration::from_millis(50),
        ));
        frame_sender
            .send(b"data: first\n\n".to_vec())
            .expect("committed frame channel");
        let first = stream.next().await.expect("first frame").expect("frame");
        assert_eq!(
            first, b"data: first\n\n",
            "the committed business frame reaches the client before the runtime outcome"
        );
        // The committed prefix already crossed the client boundary. A lost
        // runtime outcome is a silent transport close, not an error frame.
        drop(outcome_sender);
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn client_sse_first_frame_channel_closes_silently_after_a_committed_frame_on_failure() {
        let (outcome_sender, outcome) = oneshot::channel();
        let (frame_sender, frames) = tokio::sync::mpsc::unbounded_channel();
        let mut stream = Box::pin(channel_with_client_frames(
            outcome,
            tokio::spawn(async {}),
            Some(frames),
            Duration::from_millis(50),
        ));
        frame_sender
            .send(b"data: committed\n\n".to_vec())
            .expect("committed frame channel");
        assert_eq!(
            stream.next().await.expect("first frame").expect("frame"),
            b"data: committed\n\n"
        );
        let mut failed = Response::builder()
            .status(StatusCode::from_u16(507).expect("status"))
            .body(Body::empty())
            .expect("response");
        failed.headers_mut().insert(
            header::CONTENT_TYPE,
            "application/json".parse().expect("content type"),
        );
        outcome_sender.send(failed).expect("runtime outcome");
        assert!(
            stream.next().await.is_none(),
            "a post-commit failure ends the channel without an error frame"
        );
    }

    #[tokio::test]
    async fn client_sse_first_frame_channel_returns_a_committed_prefix_before_the_fast_outcome() {
        let (frame_sender, frames) = tokio::sync::mpsc::unbounded_channel();
        frame_sender
            .send(b"data: prefix\n\n".to_vec())
            .expect("committed frame channel");
        let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
            Box::pin(async move { sse_outcome(vec![b"data: rest\n\n"], Duration::ZERO) });
        let response = accept_v3_client_sse_transport(
            runtime_outcome,
            Some(frames),
            Box::new(|outcome| outcome),
            Duration::from_millis(50),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        let first = stream.next().await.expect("prefix chunk").expect("prefix");
        assert_eq!(
            &first[..],
            b"data: prefix\n\n",
            "the committed prefix is not lost when the outcome is already ready"
        );
        let second = stream.next().await.expect("remainder chunk").expect("rest");
        assert_eq!(&second[..], b"data: rest\n\n");
    }

    #[tokio::test]
    async fn client_sse_first_frame_channel_returns_the_frame_before_a_slow_outcome() {
        let (frame_sender, frames) = tokio::sync::mpsc::unbounded_channel();
        frame_sender
            .send(b"data: prefix\n\n".to_vec())
            .expect("committed frame channel");
        let runtime_outcome: Pin<Box<dyn Future<Output = Response<Body>> + Send>> =
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(40)).await;
                sse_outcome(vec![b"data: rest\n\n"], Duration::ZERO)
            });
        let response = accept_v3_client_sse_transport(
            runtime_outcome,
            Some(frames),
            Box::new(|outcome| outcome),
            Duration::from_millis(500),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body().into_data_stream();
        let first = stream.next().await.expect("prefix chunk").expect("prefix");
        assert_eq!(
            &first[..],
            b"data: prefix\n\n",
            "the committed frame crosses the client channel before a slower runtime outcome"
        );
        let second = stream.next().await.expect("remainder chunk").expect("rest");
        assert_eq!(&second[..], b"data: rest\n\n");
    }
}
