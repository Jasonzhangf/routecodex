use crate::hub_v1::v3_feature_enabled_for_server;

/// 客户端响应 id 剥离开关：开启后把返回给客户端的 Responses body 中
/// `id` 替换为空串，客户端无法用 previous_response_id 做增量续接，
/// 强制下一次请求全量发送（配合本地 continuation 关闭，避免上游对
/// previous_response_id 兼容性差异导致的 400）。
pub(crate) fn v3_strip_client_response_id_enabled_for_server(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(manifest, server_id, "strip_client_response_id", false)
}

/// 本地 continuation 保存/恢复开关：开启后 Resp04 不再保存 continuation
/// locator，Req03 也不再按 previous_response_id 恢复（客户端拿不到 id，
/// 必然全量请求；即便收到 previous_response_id 也按未命中处理）。
pub(crate) fn v3_responses_continuation_disabled_for_server(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> bool {
    v3_feature_enabled_for_server(
        manifest,
        server_id,
        "responses_continuation_disabled",
        false,
    )
}

/// 客户端响应 id 剥离唯一入口：把 Responses body 中顶层 `id`（或嵌套
/// `response.id`）替换为空串。JSON 路径与 SSE data 帧共用，返回是否改写。
pub(crate) fn strip_v3_response_id_from_json_body(body: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(object) = body.as_object_mut() {
        if object
            .get("id")
            .is_some_and(|id| !id.as_str().unwrap_or("").is_empty())
        {
            object.insert("id".to_string(), serde_json::Value::String(String::new()));
            changed = true;
        }
        if let Some(response) = object
            .get_mut("response")
            .and_then(serde_json::Value::as_object_mut)
        {
            if response
                .get("id")
                .is_some_and(|id| !id.as_str().unwrap_or("").is_empty())
            {
                response.insert("id".to_string(), serde_json::Value::String(String::new()));
                changed = true;
            }
        }
    }
    changed
}
