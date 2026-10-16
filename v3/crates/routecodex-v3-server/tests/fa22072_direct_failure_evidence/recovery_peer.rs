//! Test-owned loopback peer, socket framing and business-wire helpers for the
//! fa22072 Direct/Relay recovery cases (P4-P7).
//!
//! This is the peer/socket half of `recovery_fixture`; the config, request and
//! HTTP-client helpers stay in the parent. No live provider, production config
//! or production API is touched.
use super::*;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Clone)]
pub(crate) enum PeerReply {
    /// Real provider JSON/SSE business result (200).
    Business {
        text: &'static str,
        wire: &'static str,
    },
    /// Fixed upstream HTTP error status with a JSON body.
    HttpError { status: u16, body: Value },
}

/// A running loopback peer. `arrived`/`release` are only populated for a held
/// peer: the first accepted request signals `arrived` and blocks until
/// `release` is sent, so a later module can create an exact artifact path
/// before the provider is released.
pub(crate) struct Peer {
    pub captures: Arc<Mutex<Vec<Capture>>>,
    pub arrived: Option<oneshot::Receiver<Capture>>,
    pub release: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Peer {
    pub(crate) async fn captured(&self) -> Vec<Capture> {
        self.captures.lock().await.clone()
    }

    pub(crate) async fn abort(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

pub(crate) fn spawn_peer(
    listener: TcpListener,
    label: &'static str,
    reply: PeerReply,
    held: bool,
    order: OrderLog,
) -> Peer {
    let captures = Arc::new(Mutex::new(Vec::new()));
    let (arrived_tx, arrived_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let task_captures = captures.clone();
    let task = tokio::spawn(async move {
        let mut arrived_tx = Some(arrived_tx);
        let mut release_rx = Some(release_rx);
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let Some(capture) = read_request(&mut socket).await else {
                continue;
            };
            task_captures.lock().await.push(capture.clone());
            order.lock().await.push(label.to_string());
            if let (Some(tx), Some(rx)) = (arrived_tx.take(), release_rx.take()) {
                let _ = tx.send(capture.clone());
                let _ = rx.await;
            }
            match &reply {
                PeerReply::HttpError { status, body } => {
                    write_http_error(&mut socket, *status, body).await
                }
                PeerReply::Business { text, wire } => {
                    write_business(&mut socket, &capture, text, wire).await
                }
            }
        }
    });
    Peer {
        captures,
        arrived: held.then_some(arrived_rx),
        release: held.then_some(release_tx),
        task,
    }
}

pub(crate) fn peer_listener() -> (TcpListener, u16) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an owned loopback peer");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    (TcpListener::from_std(listener).unwrap(), port)
}

fn status_reason(status: u16) -> &'static str {
    match status {
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

async fn write_http_error(socket: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        status_reason(status),
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn write_business(socket: &mut TcpStream, capture: &Capture, text: &str, wire: &str) {
    let (content_type, body) = business_wire(
        capture.path.ends_with("/responses"),
        capture.body["stream"] == true,
        text,
        wire,
    );
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

fn business_wire(responses: bool, stream: bool, text: &str, wire: &str) -> (&'static str, String) {
    if responses {
        let response = json!({
            "id": "resp-owned-recovery", "object": "response", "status": "completed", "model": wire,
            "output": [{"id": "msg-owned-recovery", "type": "message", "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
        });
        if stream {
            (
                "text/event-stream",
                format!(
                    "data: {}\n\ndata: {}\n\ndata: {}\n\n",
                    json!({"type": "response.created", "response": {"id": "resp-owned-recovery",
                        "status": "in_progress", "model": wire, "output": []}}),
                    json!({"type": "response.output_text.delta", "response_id": "resp-owned-recovery",
                        "output_index": 0, "content_index": 0, "item_id": "msg-owned-recovery",
                        "delta": text}),
                    json!({"type": "response.completed", "response": response})
                ),
            )
        } else {
            ("application/json", response.to_string())
        }
    } else {
        let chat = json!({
            "id": "chatcmpl-owned-recovery", "object": "chat.completion", "model": wire,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
        });
        if stream {
            (
                "text/event-stream",
                format!(
                    "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"id": "chatcmpl-owned-recovery", "object": "chat.completion.chunk",
                        "model": wire, "choices": [{"index": 0,
                            "delta": {"role": "assistant", "content": text}, "finish_reason": null}]}),
                    json!({"id": "chatcmpl-owned-recovery", "object": "chat.completion.chunk",
                        "model": wire, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})
                ),
            )
        } else {
            ("application/json", chat.to_string())
        }
    }
}
