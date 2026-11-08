use super::*;

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
        let _ = websocket::acquire_connection_slot(
            &self.websocket_sessions,
            &mut request,
            &self.handoff,
            None,
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
        let auth_carrier = request.auth_carrier;
        let result = async {
            let response = self
                .send_http_headers(
                    &request_id,
                    &provider_id,
                    url,
                    auth,
                    auth_carrier,
                    stream_intent,
                    body,
                    provider_headers,
                    timeout,
                    sse_first_frame_timeout_ms,
                    None,
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
        result
    }
}
