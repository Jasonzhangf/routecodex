use crate::{
    V3ProviderCancellation, V3ProviderError, V3ProviderResponseHeader, V3ProviderSseStream,
};
use bytes::Bytes;
use futures_util::{stream, Stream, StreamExt};
use reqwest::header::HeaderMap;
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
    buffer: Vec<u8>,
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
        buffer: Vec::new(),
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
                if state.buffer.is_empty() {
                    return None;
                }
                state.buffer.clear();
                return Some((
                    Err(V3ProviderError::MalformedSse {
                        request_id: state.request_id.clone(),
                        provider_id: state.provider_id.clone(),
                        reason: "stream ended before the final event delimiter".to_string(),
                    }),
                    state,
                ));
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
                Some(Ok(chunk)) => {
                    state.buffer.extend_from_slice(&chunk);
                    while let Some(end) = event_end(&state.buffer) {
                        let event = state.buffer.drain(..end).collect::<Vec<_>>();
                        if let Err(reason) = validate_sse_event(&event) {
                            state.ended = true;
                            state.buffer.clear();
                            return Some((
                                Err(V3ProviderError::MalformedSse {
                                    request_id: state.request_id.clone(),
                                    provider_id: state.provider_id.clone(),
                                    reason,
                                }),
                                state,
                            ));
                        }
                        state.ready.push_back(event);
                    }
                }
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

fn event_end(buffer: &[u8]) -> Option<usize> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|i| i + 2);
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|i| i + 4);
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(end), None) | (None, Some(end)) => Some(end),
        (None, None) => None,
    }
}

fn validate_sse_event(event: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(event).map_err(|error| error.to_string())?;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty()
            || line.starts_with(':')
            || matches_sse_field_line(line, "data")
            || matches_sse_field_line(line, "event")
            || matches_sse_field_line(line, "id")
            || matches_sse_field_line(line, "retry")
        {
            continue;
        }
        return Err(format!("unsupported SSE field line {line:?}"));
    }
    Ok(())
}

fn matches_sse_field_line(line: &str, field: &str) -> bool {
    line == field
        || line
            .strip_prefix(field)
            .is_some_and(|tail| tail.starts_with(':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sse_validation_preserves_chunked_events_and_rejects_unterminated_tail() {
        let source = stream::iter([
            Ok(Bytes::from_static(b"data: one\n")),
            Ok(Bytes::from_static(b"\ndata: two\n\n")),
        ]);
        let mut validated = validated_sse_stream(source, "req".into(), "provider".into(), None);
        assert_eq!(validated.next().await.unwrap().unwrap(), b"data: one\n\n");
        assert_eq!(validated.next().await.unwrap().unwrap(), b"data: two\n\n");
        assert!(validated.next().await.is_none());

        let source = stream::iter([Ok(Bytes::from_static(b"data: incomplete\n"))]);
        let mut invalid = validated_sse_stream(source, "req".into(), "provider".into(), None);
        assert!(matches!(
            invalid.next().await.unwrap().unwrap_err(),
            V3ProviderError::MalformedSse { .. }
        ));
    }
}
