use routecodex_v4_server::{
    AsyncHttpHandler, AsyncHttpServer, HttpRequest, HttpResponse, ResponseStream,
};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

struct Handler;

impl AsyncHttpHandler for Handler {
    fn handle_async<'a>(
        &'a self,
        request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async move {
            HttpResponse::json(
                200,
                format!("{{\"path\":\"{}\"}}", request.path).into_bytes(),
            )
        })
    }
}

#[tokio::test]
async fn async_server_binds_and_stops_without_blocking_accept() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    assert!(server.local_address().expect("address").contains(':'));
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(Handler), stop.clone()));
    stop.cancel();
    task.await.expect("join").expect("clean stop");
}

struct OneChunk {
    sent: bool,
}

impl ResponseStream for OneChunk {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, io::Error> {
        if self.sent {
            return Ok(false);
        }
        self.sent = true;
        chunk.extend_from_slice(b"event: done\n\n");
        Ok(true)
    }
}

struct StreamingHandler;

impl AsyncHttpHandler for StreamingHandler {
    fn handle_async<'a>(
        &'a self,
        _request: HttpRequest,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>> {
        Box::pin(async {
            HttpResponse::streaming(200, "text/event-stream", Box::new(OneChunk { sent: false }))
        })
    }
}

#[tokio::test]
async fn async_server_writes_stream_with_bounded_chunked_frames() {
    let server = AsyncHttpServer::bind("127.0.0.1:0").await.expect("bind");
    let address = server.local_address().expect("address");
    let stop = CancellationToken::new();
    let task = tokio::spawn(server.run_until(Arc::new(StreamingHandler), stop.clone()));

    let mut client = TcpStream::connect(address).await.expect("connect");
    client
        .write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("request");
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.expect("response");
    let response = String::from_utf8(response).expect("UTF-8 response");
    assert!(response.contains("transfer-encoding: chunked"));
    assert!(response.contains("event: done\n\n"));
    assert!(response.ends_with("0\r\n\r\n"));

    stop.cancel();
    task.await.expect("join").expect("clean stop");
}
