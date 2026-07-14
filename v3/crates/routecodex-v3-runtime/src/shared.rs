use crate::nodes::{
    V3ClientBody, V3Req04StandardizedResponses, V3Resp10ClientPayload, V3Route05SelectedTarget,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::V3ProviderResp09Raw;
use std::collections::BTreeMap;

pub(crate) fn select_default_route_target(
    manifest: &V3Config05ManifestPublished,
    _request: &V3Req04StandardizedResponses,
) -> Result<V3Route05SelectedTarget, V3Error01SourceRaised> {
    let server = manifest
        .servers
        .values()
        .find(|server| server.enabled)
        .ok_or_else(|| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Route05SelectedTarget",
                "enabled_server_missing",
                "validated manifest has no enabled server",
            )
        })?;
    let target = manifest.route_groups[&server.routing_group].pools["default"]
        .targets
        .first()
        .ok_or_else(|| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Route05SelectedTarget",
                "default_target_missing",
                "validated manifest has no default target",
            )
        })?;
    let provider_id = target.provider.clone().ok_or_else(|| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Route05SelectedTarget",
            "forwarder_target_not_implemented",
            "early Responses direct runtime cannot interpret a forwarder target",
        )
    })?;
    let provider = manifest.providers.get(&provider_id).ok_or_else(|| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Route05SelectedTarget",
            "provider_manifest_missing",
            format!("validated manifest provider {provider_id} missing"),
        )
    })?;
    Ok(V3Route05SelectedTarget {
        provider_id,
        model: target
            .model
            .clone()
            .unwrap_or_else(|| provider.default_model.clone()),
        base_url: provider.base_url.clone(),
        auth_env: provider
            .auth
            .entries
            .first()
            .and_then(|entry| entry.env.clone())
            .unwrap_or_default(),
    })
}

pub(crate) fn project_provider_raw_to_client_payload(
    raw: V3ProviderResp09Raw,
) -> Result<V3Resp10ClientPayload, V3Error01SourceRaised> {
    if raw.status >= 400 {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp09Raw",
            format!("provider_http_{}", raw.status),
            format!("provider {} returned {}", raw.provider_id, raw.status),
        ));
    }
    let content_type = raw.headers.get("content-type").cloned().ok_or_else(|| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp09Raw",
            "provider_content_type_missing",
            "provider response missing content-type",
        )
    })?;
    let body = if content_type.starts_with("text/event-stream") {
        V3ClientBody::Bytes(raw.body)
    } else if content_type.starts_with("application/json") {
        let parsed = serde_json::from_slice(&raw.body).map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::ProviderFailure,
                "V3ProviderResp09Raw",
                "provider_response_json_invalid",
                format!("provider response JSON parse failed: {error}"),
            )
        })?;
        V3ClientBody::Json(parsed)
    } else {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp09Raw",
            "provider_content_type_unsupported",
            format!("unsupported provider response content-type {content_type}"),
        ));
    };
    Ok(V3Resp10ClientPayload {
        status: raw.status,
        headers: BTreeMap::from([("content-type".to_string(), content_type)]),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_content_type_is_explicit_error() {
        let result = project_provider_raw_to_client_payload(V3ProviderResp09Raw {
            provider_id: "test".to_string(),
            status: 200,
            headers: BTreeMap::new(),
            body: br#"{"id":"resp"}"#.to_vec(),
        });
        assert!(result.is_err());
    }
}
