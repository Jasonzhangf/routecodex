use super::*;

pub(super) fn is_rate_limited(error: &V3ProviderError) -> bool {
    matches!(
        error,
        V3ProviderError::HttpStatus { response } if response.status == 429
    )
}

impl ProviderResponsesTransport {
    /// A health probe succeeds at HTTP 2xx headers; business parsing stays in send_http.
    pub async fn send_probe(
        &self,
        mut request: V3Transport13ResponsesRequest,
    ) -> Result<(), V3ProviderError> {
        if request.transport_kind() != crate::transport_handoff::V3ProviderTransportKind::Http {
            return Err(V3ProviderError::InternalTransport {
                request_id: request.request_id().into(),
                provider_id: request.provider_id().into(),
                lane: V3ProviderInternalTransportLane::Request,
                reason: "HTTP health probe requires HTTP transport".into(),
            });
        }
        let controller = V3AdaptiveConcurrencyController::process_shared();
        let provider_key = request.provider_key();
        controller
            .ensure_initial_budget(&provider_key, request.initial_concurrency_budget())
            .map_err(|reason| V3ProviderError::InternalTransport {
                request_id: request.request_id().into(),
                provider_id: request.provider_id().into(),
                lane: V3ProviderInternalTransportLane::Request,
                reason,
            })?;
        let (guard, was_probe, _) = websocket::acquire_admission_and_connection_slot(
            &self.websocket_sessions,
            &mut request,
            &self.handoff,
            None,
            controller,
            provider_key,
        )
        .await?;
        let V3Transport13ResponsesRequestKind::Http {
            request_id,
            provider_id,
            url,
            auth,
            stream_intent,
            body,
            provider_headers,
            timeout,
            sse_first_frame_timeout_ms,
            cancellation,
            ..
        } = request.kind
        else {
            unreachable!("HTTP checked before admission")
        };
        let result = async {
            let response = self
                .send_http_headers(
                    &request_id,
                    &provider_id,
                    url,
                    auth,
                    stream_intent,
                    body,
                    provider_headers,
                    timeout,
                    sse_first_frame_timeout_ms,
                    cancellation.clone(),
                )
                .await?;
            let status = response.status().as_u16();
            if response.status().is_success() {
                drop(response);
                return Ok(());
            }
            let headers = collect_response_headers(response.headers());
            let body =
                read_response_body_bytes(response, &request_id, &provider_id, cancellation).await?;
            Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id,
                    provider_id,
                    status,
                    headers,
                    body,
                    body_read_failure: None,
                }),
            })
        }
        .await;
        if was_probe && result.is_ok() {
            drop(guard.with_probe_result(V3AdaptiveConcurrencyProbeResult::Accepted));
        } else if was_probe && result.as_ref().err().is_some_and(is_rate_limited) {
            drop(guard.with_probe_result(V3AdaptiveConcurrencyProbeResult::RateLimited));
        } else {
            drop(guard);
        }
        result
    }
}
