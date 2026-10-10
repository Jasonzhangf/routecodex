use super::*;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn delayed_body_upstream(sse: bool) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let n = socket.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..n]);
            if n == 0 || request.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        if sse {
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(120)).await;
            let _ = socket
                .write_all(b"data: {\"type\":\"response.completed\"}\n\n")
                .await;
        } else {
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(120)).await;
            let _ = socket.write_all(b"{}").await;
        }
    });
    (url, task)
}

fn request(url: String, intent: V3ResponsesStreamIntent) -> V3Transport13ResponsesHttpRequest {
    build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
        "req-first-word-only",
        "first-word-only-provider",
        url,
        V3ProviderAuthHandle {
            alias: "key".into(),
            secret: V3ProviderAuthSecretHandle::ApiKey("test-only".into()),
        },
        intent,
        json!({"model":"test","stream":intent == V3ResponsesStreamIntent::Sse}),
        vec![],
        Some(Duration::from_millis(40)),
        60_000,
        Some(200),
    )
    .unwrap()
}

#[tokio::test]
async fn sse_body_survives_total_and_client_idle_limits() {
    let (url, upstream) = delayed_body_upstream(true).await;
    let transport =
        ProviderResponsesTransport::with_http_read_timeout_for_test(Duration::from_millis(30));
    let raw = transport
        .send(request(url, V3ResponsesStreamIntent::Sse))
        .await
        .unwrap();
    let V3ProviderResponseBody::Sse(mut stream) = raw.into_body() else {
        panic!("expected actual provider SSE");
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk.expect("SSE progress is not governed by total or idle timeout"));
    }
    assert!(String::from_utf8(bytes)
        .unwrap()
        .contains("response.completed"));
    upstream.await.unwrap();
}

#[tokio::test]
async fn json_body_retains_request_timeout() {
    let (url, upstream) = delayed_body_upstream(false).await;
    let transport = ProviderResponsesTransport::default();
    let error = transport
        .send(request(url, V3ResponsesStreamIntent::Json))
        .await
        .unwrap_err();
    assert!(format!("{error:?}").contains("timed out"), "{error:?}");
    upstream.await.unwrap();
}
