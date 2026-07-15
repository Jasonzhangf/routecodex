use crate::V3ProviderError;
use futures_util::{Stream, StreamExt};
use std::fmt;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderResponseHeader {
    pub name: String,
    pub value: Vec<u8>,
}

pub type V3ProviderSseStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, V3ProviderError>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderResponseBodyKind {
    Json,
    Sse,
}

pub enum V3ProviderResponseBody {
    Json(Vec<u8>),
    Sse(V3ProviderSseStream),
}

impl fmt::Debug for V3ProviderResponseBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(body) => formatter
                .debug_struct("Json")
                .field("byte_len", &body.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<raw-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3ProviderResp14Raw {
    request_id: String,
    provider_id: String,
    status: u16,
    headers: Vec<V3ProviderResponseHeader>,
    body: V3ProviderResponseBody,
}

impl V3ProviderResp14Raw {
    pub fn from_json(
        request_id: impl Into<String>,
        provider_id: impl Into<String>,
        status: u16,
        headers: Vec<V3ProviderResponseHeader>,
        body: Vec<u8>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            provider_id: provider_id.into(),
            status,
            headers,
            body: V3ProviderResponseBody::Json(body),
        }
    }

    pub fn from_sse(
        request_id: String,
        provider_id: String,
        status: u16,
        headers: Vec<V3ProviderResponseHeader>,
        body: V3ProviderSseStream,
    ) -> Self {
        Self {
            request_id,
            provider_id,
            status,
            headers,
            body: V3ProviderResponseBody::Sse(body),
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn headers(&self) -> &[V3ProviderResponseHeader] {
        &self.headers
    }

    pub fn header_text(&self, name: &str) -> Result<Option<&str>, V3ProviderError> {
        self.headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| {
                std::str::from_utf8(&header.value).map_err(|error| V3ProviderError::ResponseBody {
                    request_id: self.request_id.clone(),
                    provider_id: self.provider_id.clone(),
                    reason: format!("response header {name} is not UTF-8: {error}"),
                })
            })
            .transpose()
    }

    pub fn body_kind(&self) -> V3ProviderResponseBodyKind {
        match self.body {
            V3ProviderResponseBody::Json(_) => V3ProviderResponseBodyKind::Json,
            V3ProviderResponseBody::Sse(_) => V3ProviderResponseBodyKind::Sse,
        }
    }

    pub fn into_body(self) -> V3ProviderResponseBody {
        self.body
    }

    pub async fn into_body_bytes(self) -> Result<Vec<u8>, V3ProviderError> {
        match self.body {
            V3ProviderResponseBody::Json(body) => Ok(body),
            V3ProviderResponseBody::Sse(mut stream) => {
                let mut body = Vec::new();
                while let Some(event) = stream.next().await {
                    body.extend(event?);
                }
                Ok(body)
            }
        }
    }
}
