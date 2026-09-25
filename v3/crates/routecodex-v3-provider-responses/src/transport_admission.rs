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
            admission
                .release()
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
    LeaseMismatch,
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
        Some(lease) if lease.provider_key() == provider_key && lease.belongs_to(&controller) => {
            Ok(lease)
        }
        Some(lease) => {
            lease
                .release()
                .expect("mismatched pre-acquired provider lease must release through its owner");
            Err(V3ProviderAdmissionError::LeaseMismatch)
        }
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
        V3ProviderAdmissionError::LeaseMismatch => V3ProviderError::InternalTransport {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            lane: crate::V3ProviderInternalTransportLane::Request,
            reason: "pre-acquired provider admission does not match the selected transport request"
                .to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{take_or_acquire_provider_admission, V3ProviderAdmissionError};
    use crate::adaptive_concurrency::V3AdaptiveConcurrencyController;
    use std::time::Duration;

    #[tokio::test]
    async fn mismatched_pre_acquired_provider_key_is_released_and_rejected() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        controller
            .ensure_initial_budget("provider-a:key", 1)
            .unwrap();
        let lease = controller
            .try_acquire_business("provider-a:key")
            .expect("provider A lease must be acquired");

        let result = take_or_acquire_provider_admission(
            Some(lease),
            controller.clone(),
            "provider-b:key".to_string(),
            0,
            Duration::from_millis(1),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(V3ProviderAdmissionError::LeaseMismatch)
        ));
        assert_eq!(controller.snapshot("provider-a:key").unwrap().in_flight, 0);
    }

    #[tokio::test]
    async fn pre_acquired_lease_from_another_controller_is_released_and_rejected() {
        let owner = V3AdaptiveConcurrencyController::new(1).unwrap();
        let transport = V3AdaptiveConcurrencyController::new(1).unwrap();
        owner.ensure_initial_budget("provider:key", 1).unwrap();
        transport.ensure_initial_budget("provider:key", 1).unwrap();
        let lease = owner
            .try_acquire_business("provider:key")
            .expect("owner controller lease must be acquired");

        let result = take_or_acquire_provider_admission(
            Some(lease),
            transport.clone(),
            "provider:key".to_string(),
            0,
            Duration::from_millis(1),
            None,
        )
        .await;

        assert!(matches!(
            result,
            Err(V3ProviderAdmissionError::LeaseMismatch)
        ));
        assert_eq!(owner.snapshot("provider:key").unwrap().in_flight, 0);
        assert_eq!(transport.snapshot("provider:key").unwrap().in_flight, 0);
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
