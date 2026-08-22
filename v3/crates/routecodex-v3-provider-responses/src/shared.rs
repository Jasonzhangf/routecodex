use crate::{
    V3ProviderCancellation, V3ProviderError, V3ProviderResponseHeader, V3ProviderSseStream,
};
use bytes::Bytes;
use futures_util::{stream, Stream, StreamExt};
use reqwest::header::HeaderMap;
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
                            reason: error.to_string(),
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
