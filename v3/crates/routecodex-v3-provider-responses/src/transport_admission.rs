use crate::adaptive_concurrency::{V3AdaptiveConcurrencyController, V3AdaptiveConcurrencyLease};
use crate::transport::{
    v3_transport_13_request, V3ProviderCancellation, V3ProviderRequestHeader,
    V3Transport13ResponsesHttpRequest, V3Transport13ResponsesRequestKind,
};
use crate::wire::{V3ProviderAuthHandle, V3ResponsesStreamIntent};
use crate::V3ProviderError;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct V3PreAcquiredProviderAdmission {
    lease: Option<V3AdaptiveConcurrencyLease>,
}

impl V3PreAcquiredProviderAdmission {
    pub(crate) fn empty() -> Self {
        Self { lease: None }
    }

    pub(crate) fn set(&mut self, admission: V3AdaptiveConcurrencyLease) {
        self.release();
        self.lease = Some(admission);
    }

    pub(crate) fn take(&mut self) -> Option<V3AdaptiveConcurrencyLease> {
        self.lease.take()
    }

    pub(crate) fn release(&mut self) {
        if let Some(admission) = self.lease.take() {
            V3AdaptiveConcurrencyController::process_shared()
                .release(admission.into_permit())
                .expect("pre-acquired provider admission release must never underflow");
        }
    }
}

impl Drop for V3PreAcquiredProviderAdmission {
    fn drop(&mut self) {
        self.release();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3ProviderAdmissionError {
    ClientDisconnect,
    Timeout,
}

pub(crate) async fn acquire_provider_admission(
    controller: V3AdaptiveConcurrencyController,
    provider_key: String,
    now_ms: u64,
    timeout: Duration,
    cancellation: Option<V3ProviderCancellation>,
) -> Result<V3AdaptiveConcurrencyLease, V3ProviderAdmissionError> {
    let acquire = controller.acquire_with_clock(provider_key, || now_ms);
    match cancellation {
        Some(cancellation) => {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(V3ProviderAdmissionError::ClientDisconnect),
                result = tokio::time::timeout(timeout, acquire) =>
                    result.map_err(|_| V3ProviderAdmissionError::Timeout),
            }
        }
        None => tokio::time::timeout(timeout, acquire)
            .await
            .map_err(|_| V3ProviderAdmissionError::Timeout),
    }
}

pub(crate) async fn take_or_acquire_provider_admission(
    pre_acquired: Option<V3AdaptiveConcurrencyLease>,
    controller: V3AdaptiveConcurrencyController,
    provider_key: String,
    now_ms: u64,
    timeout: Duration,
    cancellation: Option<V3ProviderCancellation>,
) -> Result<V3AdaptiveConcurrencyLease, V3ProviderAdmissionError> {
    match pre_acquired {
        Some(lease) => Ok(lease),
        None => {
            acquire_provider_admission(controller, provider_key, now_ms, timeout, cancellation)
                .await
        }
    }
}

pub(crate) fn provider_admission_error(
    error: V3ProviderAdmissionError,
    request_id: &str,
    provider_id: &str,
    acquire_timeout_ms: u64,
) -> V3ProviderError {
    match error {
        V3ProviderAdmissionError::ClientDisconnect => V3ProviderError::ClientDisconnect {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
        },
        V3ProviderAdmissionError::Timeout => V3ProviderError::Transport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: format!(
                "provider concurrency admission timed out after {acquire_timeout_ms}ms"
            ),
        },
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_v3_transport_13_responses_http_request_from_parts_with_timeout_and_concurrency(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
    provider_headers: Vec<V3ProviderRequestHeader>,
    timeout: Option<Duration>,
    concurrency_acquire_timeout_ms: u64,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    let request_id = request_id.into();
    let provider_id = provider_id.into();
    let url = reqwest::Url::parse(url_text.as_ref()).map_err(|error| {
        V3ProviderError::InvalidBaseUrl {
            request_id: request_id.clone(),
            provider_id: provider_id.clone(),
            reason: error.to_string(),
        }
    })?;
    Ok(v3_transport_13_request(
        V3Transport13ResponsesRequestKind::Http {
            request_id,
            provider_id,
            url,
            auth,
            stream_intent,
            body,
            provider_headers,
            timeout,
            initial_concurrency_budget: 8,
            concurrency_acquire_timeout_ms,
            sse_first_frame_timeout_ms: None,
            cancellation: None,
            compatibility_profile: None,
        },
    ))
}
