mod error;
#[cfg_attr(not(test), allow(dead_code))]
mod health;
pub mod raw_response;
mod shared;
pub mod transport;
pub mod wire;

pub use error::{V3ProviderError, V3ProviderHttpFailure};
pub use health::{
    V3ProviderAllAvailable, V3ProviderAvailabilityProjection, V3ProviderAvailabilityReader,
    V3ProviderAvailabilityRegistry, V3ProviderCrossSessionReviveAdmission, V3ProviderFailureRecord,
    V3ProviderHealthStore, V3ProviderSessionAvailabilityReader,
};
pub use raw_response::{
    V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderResponseBodyKind,
    V3ProviderResponseHeader, V3ProviderSseStream,
};
pub use transport::{
    build_v3_anthropic_provider_request_header,
    build_v3_transport_13_responses_http_request_from_parts,
    build_v3_transport_13_responses_http_request_from_v3_provider_12,
    build_v3_transport_13_responses_http_request_with_provider_headers_from_parts,
    build_v3_transport_13_responses_request_from_v3_provider_12,
    is_v3_anthropic_provider_request_header_name, ProviderResponsesTransport,
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderCancellation, V3ProviderRequestHeader,
    V3Transport13ResponsesHttpRequest, V3Transport13ResponsesRequest,
};
pub use wire::{
    build_v3_provider_12_responses_wire_payload, find_v3_routecodex_control_payload_key,
    V3Provider12ResponsesWirePayload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesProviderTarget, V3ResponsesStreamIntent,
};
