use crate::{
    V3ProviderCancellation, V3ProviderError, V3ProviderResponseHeader, V3ProviderSseStream,
};
use bytes::Bytes;
use futures_util::{stream, Stream, StreamExt};
use reqwest::header::HeaderMap;
use routecodex_v3_error::V3_PROVIDER_RESPONSE_HEADER_TIMEOUT_REASON_PREFIX;
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk,
    build_v3_sse_transport_out_04_from_v3_sse_transport_in_03, SseIncrementalDecoder,
    SseTransportError, SseTransportLimits,
};
use std::collections::VecDeque;
use std::pin::Pin;

pub(crate) fn collect_response_headers(headers: &HeaderMap) -> Vec<V3ProviderResponseHeader> {
    headers
        .iter()
        .map(|(name, value)| V3ProviderResponseHeader {
            name: name.as_str().to_string(),
            value: value.as_bytes().to_vec(),
        })
        .collect()
}

pub(crate) fn content_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
}

/// provider transport 失败的唯一原因格式化入口。
///
/// `reqwest::Error` 的顶层 Display 只有 `error sending request for url (...)`，
/// 真实原因（上游超时、连接重置、DNS、TLS）在 `source()` 链里。502 必须能区分
/// “上游在 120s 内没回包”和“连接建立失败”，否则 provider transport 错误不可
/// 诊断，也无法据实判定 health/cooldown。这里把整条 source 链追加到原因文本。
///
/// 分类边界（本函数只格式化原因，不改分类）：`send()` 失败发生在任何上游响应
/// 之前，不存在可保留的上游 status，因此归 `V3ProviderError::Transport`；已经
/// 拿到非 2xx 响应后读 error body 失败，则由 transport owner 归
/// `V3ProviderError::HttpStatus` 并保留真实 status，不经过这里（见
/// `transport/tests.rs::transport_http_status_preserves_real_code_on_body_decode_failure`）。
pub(crate) fn format_v3_provider_transport_error(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !cause_text.is_empty() && !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

pub(crate) async fn send_http_await(
    request_id: String,
    provider_id: String,
    send: impl std::future::Future<Output = Result<reqwest::Response, reqwest::Error>> + Send,
    cancellation: Option<V3ProviderCancellation>,
    header_timeout_ms: Option<u64>,
) -> Result<reqwest::Response, V3ProviderError> {
    match header_timeout_ms {
        Some(header_timeout_ms) if header_timeout_ms > 0 => tokio::time::timeout(
            std::time::Duration::from_millis(header_timeout_ms),
            send_http_await_inner(request_id.clone(), provider_id.clone(), send, cancellation),
        )
        .await
        .map_err(|_| V3ProviderError::Transport {
            request_id,
            provider_id,
            reason: format!(
                "{V3_PROVIDER_RESPONSE_HEADER_TIMEOUT_REASON_PREFIX} ({header_timeout_ms}ms)"
            ),
        })?,
        _ => send_http_await_inner(request_id, provider_id, send, cancellation).await,
    }
}

async fn send_http_await_inner(
    request_id: String,
    provider_id: String,
    send: impl std::future::Future<Output = Result<reqwest::Response, reqwest::Error>> + Send,
    cancellation: Option<V3ProviderCancellation>,
) -> Result<reqwest::Response, V3ProviderError> {
    match cancellation {
        Some(cancellation) => tokio::select! {
            _ = cancellation.cancelled() => Err(V3ProviderError::ClientDisconnect { request_id, provider_id }),
            response = send => response.map_err(|error| V3ProviderError::Transport {
                request_id,
                provider_id,
                reason: format_v3_provider_transport_error(&error),
            }),
        },
        None => send.await.map_err(|error| V3ProviderError::Transport {
            request_id,
            provider_id,
            reason: format_v3_provider_transport_error(&error),
        }),
    }
}

struct SseState {
    source: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    decoder: SseIncrementalDecoder,
    ready: VecDeque<Vec<u8>>,
    ended: bool,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
}

pub(crate) fn validated_sse_stream(
    source: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
) -> V3ProviderSseStream {
    let state = SseState {
        source: Box::pin(source),
        decoder: SseIncrementalDecoder::new(SseTransportLimits::default()),
        ready: VecDeque::new(),
        ended: false,
        request_id,
        provider_id,
        cancellation,
    };
    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if let Some(event) = state.ready.pop_front() {
                return Some((Ok(event), state));
            }
            if state.ended {
                let decoder = std::mem::replace(
                    &mut state.decoder,
                    SseIncrementalDecoder::new(SseTransportLimits::default()),
                );
                return match decoder.finish_with_trailing_frame() {
                    Ok(None) => None,
                    Ok(Some(frame)) => {
                        state.ready.push_back(
                            build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame)
                                .into_bytes(),
                        );
                        Some((Ok(state.ready.pop_front().expect("trailing frame")), state))
                    }
                    Err(error) => Some((
                        Err(map_sse_transport_error(
                            error,
                            &state.request_id,
                            &state.provider_id,
                        )),
                        state,
                    )),
                };
            }

            let next = match state.cancellation.clone() {
                Some(cancellation) => {
                    tokio::select! {
                        _ = cancellation.cancelled() => {
                            state.ended = true;
                            return Some((
                                Err(V3ProviderError::ClientDisconnect {
                                    request_id: state.request_id.clone(),
                                    provider_id: state.provider_id.clone(),
                                }),
                                state,
                            ));
                        }
                        next = state.source.next() => next,
                    }
                }
                None => state.source.next().await,
            };

            match next {
                Some(Ok(chunk)) => match state
                    .decoder
                    .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
                {
                    Ok(frames) => {
                        for frame in frames {
                            state.ready.push_back(
                                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame)
                                    .into_bytes(),
                            );
                        }
                    }
                    Err(error) => {
                        state.ended = true;
                        return Some((
                            Err(map_sse_transport_error(
                                error,
                                &state.request_id,
                                &state.provider_id,
                            )),
                            state,
                        ));
                    }
                },
                Some(Err(error)) => {
                    state.ended = true;
                    return Some((
                        Err(V3ProviderError::ResponseBody {
                            request_id: state.request_id.clone(),
                            provider_id: state.provider_id.clone(),
                            reason: format_v3_provider_transport_error(&error),
                        }),
                        state,
                    ));
                }
                None => state.ended = true,
            }
        }
    }))
}

fn map_sse_transport_error(
    error: SseTransportError,
    request_id: &str,
    provider_id: &str,
) -> V3ProviderError {
    match error {
        SseTransportError::Aborted => V3ProviderError::ClientDisconnect {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
        },
        SseTransportError::UpstreamRead { message } => V3ProviderError::ResponseBody {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: message,
        },
        other => V3ProviderError::MalformedSse {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: other.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn silent_tcp_upstream() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test upstream must bind");
        let addr = listener.local_addr().expect("test upstream address");
        tokio::spawn(async move {
            // 接受连接但永不回包：复现“上游超时”这一类 502。
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        addr
    }

    fn closed_local_addr() -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("ephemeral address");
        drop(listener);
        addr
    }

    #[test]
    fn transport_failure_reason_appends_real_cause_beyond_reqwest_display() {
        let addr = closed_local_addr();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let error = runtime.block_on(async move {
            reqwest::Client::new()
                .get(format!("http://{addr}/v1/responses"))
                .send()
                .await
                .expect_err("closed port must fail to connect")
        });
        let top_level = error.to_string();
        let formatted = format_v3_provider_transport_error(&error);
        assert!(
            top_level.contains("error sending request"),
            "unexpected reqwest display: {top_level}"
        );
        assert!(
            formatted.starts_with(&top_level) && formatted.len() > top_level.len(),
            "transport reason must keep the top-level message and append the cause chain: {formatted}"
        );
    }

    #[tokio::test]
    async fn transport_timeout_reason_exposes_upstream_timeout_cause() {
        let addr = silent_tcp_upstream().await;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(300))
            .build()
            .expect("client");
        let request = client.get(format!("http://{addr}/v1/responses"));
        let error = request
            .send()
            .await
            .expect_err("silent upstream must time out");
        let top_level = error.to_string();
        let formatted = format_v3_provider_transport_error(&error);
        assert!(
            !top_level.contains("timed out"),
            "precondition: reqwest Display alone hides the timeout cause: {top_level}"
        );
        assert!(
            formatted.contains("timed out"),
            "timeout cause must be exposed in the provider transport reason: {formatted}"
        );
    }

    #[tokio::test]
    async fn send_http_await_projects_the_cause_chain_into_the_transport_error() {
        let addr = closed_local_addr();
        let client = reqwest::Client::new();
        let url = format!("http://{addr}/v1/responses");
        let baseline = client
            .get(&url)
            .send()
            .await
            .expect_err("closed port must fail")
            .to_string();
        let request = client.get(&url);
        let error = send_http_await(
            "req-transport-cause".to_string(),
            "provider-transport-cause".to_string(),
            request.send(),
            None,
            None,
        )
        .await
        .expect_err("closed port must fail");
        let V3ProviderError::Transport { reason, .. } = error else {
            panic!("connect failure must map to V3ProviderError::Transport: {error:?}");
        };
        assert!(
            reason.starts_with(&baseline) && reason.len() > baseline.len(),
            "transport reason must carry the cause chain, not only the reqwest Display: {reason}"
        );
    }

    #[tokio::test]
    async fn sse_validation_preserves_chunked_events_and_flushes_unterminated_tail() {
        let source = stream::iter([
            Ok(Bytes::from_static(b"data: one\n")),
            Ok(Bytes::from_static(b"\ndata: two\n\n")),
        ]);
        let mut validated = validated_sse_stream(source, "req".into(), "provider".into(), None);
        assert_eq!(validated.next().await.unwrap().unwrap(), b"data: one\n\n");
        assert_eq!(validated.next().await.unwrap().unwrap(), b"data: two\n\n");
        assert!(validated.next().await.is_none());

        let source = stream::iter([Ok(Bytes::from_static(b"data: terminal"))]);
        let mut trailing = validated_sse_stream(source, "req".into(), "provider".into(), None);
        assert_eq!(
            trailing.next().await.unwrap().unwrap(),
            b"data: terminal\n\n"
        );
        assert!(trailing.next().await.is_none());
    }

    #[tokio::test]
    async fn sse_validation_preserves_utf8_unknown_field_and_done_as_opaque_data() {
        let source = stream::iter([
            Ok(Bytes::from_static("event: custom\r\ndata: 你".as_bytes())),
            Ok(Bytes::from_static(
                "好\r\nx-extra: yes\r\n\r\ndata: [DONE]\n\n".as_bytes(),
            )),
        ]);
        let mut validated = validated_sse_stream(source, "req".into(), "provider".into(), None);
        assert_eq!(
            validated.next().await.unwrap().unwrap(),
            "event: custom\ndata: 你好\nx-extra: yes\n\n".as_bytes()
        );
        assert_eq!(
            validated.next().await.unwrap().unwrap(),
            b"data: [DONE]\n\n"
        );
        assert!(validated.next().await.is_none());
    }
}
