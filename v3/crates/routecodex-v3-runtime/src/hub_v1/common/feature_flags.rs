use routecodex_v3_config::V3Config05ManifestPublished;

pub(crate) fn v3_stopless_center_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(manifest, server_id, "stopless_center", true)
}

pub(crate) fn v3_responses_direct_stopless_center_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_stopless_center_enabled_for_server(manifest, server_id)
        && v3_feature_enabled_for_server(
            manifest,
            server_id,
            "responses_direct_stopless_center",
            false,
        )
}

pub(crate) fn v3_feature_enabled_for_server(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    feature: &str,
    default_enabled: bool,
) -> bool {
    let global_enabled = manifest
        .features
        .get(feature)
        .copied()
        .unwrap_or(default_enabled);
    manifest
        .servers
        .get(server_id)
        .and_then(|server| server.features.get(feature).copied())
        .unwrap_or(global_enabled)
}
