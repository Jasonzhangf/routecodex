use crate::raw_response::V3ProviderResp09Raw;
use crate::wire::V3Provider07ResponsesWirePayload;
use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq)]
pub struct V3Transport08ResponsesHttpRequest {
    pub provider_id: String,
    pub url: String,
    pub auth_env: String,
    pub body: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum V3ProviderError {
    #[error("provider auth env {0} missing")]
    MissingAuthEnv(String),
    #[error("provider transport failed: {0}")]
    Transport(String),
}

pub fn build_v3_transport_08_responses_http_request_from_v3_provider_07(
    wire: V3Provider07ResponsesWirePayload,
) -> V3Transport08ResponsesHttpRequest {
    V3Transport08ResponsesHttpRequest {
        provider_id: wire.provider_id,
        url: format!("{}/responses", wire.base_url.trim_end_matches('/')),
        auth_env: wire.auth_env,
        body: wire.body,
    }
}

#[async_trait]
pub trait ResponsesTransport: Send + Sync {
    async fn send(
        &self,
        request: V3Transport08ResponsesHttpRequest,
    ) -> Result<V3ProviderResp09Raw, V3ProviderError>;
}

#[derive(Debug, Clone, Default)]
pub struct ReqwestResponsesTransport {
    client: reqwest::Client,
}

#[async_trait]
impl ResponsesTransport for ReqwestResponsesTransport {
    async fn send(
        &self,
        request: V3Transport08ResponsesHttpRequest,
    ) -> Result<V3ProviderResp09Raw, V3ProviderError> {
        let token = std::env::var(&request.auth_env)
            .map_err(|_| V3ProviderError::MissingAuthEnv(request.auth_env.clone()))?;
        let response = self
            .client
            .post(&request.url)
            .bearer_auth(token)
            .json(&request.body)
            .send()
            .await
            .map_err(|error| V3ProviderError::Transport(error.to_string()))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let body = response
            .bytes()
            .await
            .map_err(|error| V3ProviderError::Transport(error.to_string()))?
            .to_vec();
        Ok(V3ProviderResp09Raw {
            provider_id: request.provider_id,
            status,
            headers,
            body,
        })
    }
}
