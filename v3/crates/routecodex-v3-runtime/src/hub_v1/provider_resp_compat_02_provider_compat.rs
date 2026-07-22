use super::{
    provider_protocol_compat_id, V3HubResponsePayload, V3ProviderCompatError,
    V3ProviderCompatProfileId, V3ProviderRespInbound01Raw,
};
use provider_compat_core::req_outbound_stage3_compat::{
    run_resp_inbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRespCompat02ProviderCompat {
    pub(crate) previous: V3ProviderRespInbound01Raw,
    pub(crate) profile: V3ProviderCompatProfileId,
}

pub fn build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(
    input: V3ProviderRespInbound01Raw,
) -> Result<ProviderRespCompat02ProviderCompat, V3ProviderCompatError> {
    let profile = match &input.compatibility_profile {
        V3ProviderCompatProfileId::Passthrough => V3ProviderCompatProfileId::Passthrough,
        profile => profile.clone(),
    };
    let mut input = input;
    let payload = apply_v3_provider_resp_compat(&input, &profile)?;
    input.payload = V3HubResponsePayload(Arc::new(payload));
    Ok(ProviderRespCompat02ProviderCompat {
        previous: input,
        profile,
    })
}

impl ProviderRespCompat02ProviderCompat {
    pub fn profile(&self) -> &V3ProviderCompatProfileId {
        &self.profile
    }

    pub(crate) fn raw(&self) -> &V3ProviderRespInbound01Raw {
        &self.previous
    }

    pub(crate) fn raw_mut(&mut self) -> &mut V3ProviderRespInbound01Raw {
        &mut self.previous
    }
}

fn apply_v3_provider_resp_compat(
    input: &V3ProviderRespInbound01Raw,
    profile: &V3ProviderCompatProfileId,
) -> Result<Value, V3ProviderCompatError> {
    run_resp_inbound_stage3_compat(ReqOutboundCompatInput {
        payload: input.payload.0.as_ref().clone(),
        adapter_context: AdapterContext {
            compatibility_profile: profile.as_optional_string(),
            provider_protocol: Some(provider_protocol_compat_id(input.provider_protocol)),
            ..Default::default()
        },
        explicit_profile: profile.as_optional_string(),
    })
    .map(|result| result.payload)
    .map_err(|reason| V3ProviderCompatError {
        stage: "response",
        profile: profile.as_str().to_string(),
        reason,
    })
}
