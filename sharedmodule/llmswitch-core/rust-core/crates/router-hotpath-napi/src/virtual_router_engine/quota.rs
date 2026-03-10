use napi::{Env, JsFunction, JsObject, JsUnknown, Ref, ValueType};

#[derive(Debug, Clone, Default)]
pub(crate) struct QuotaViewEntry {
    pub in_pool: Option<bool>,
    pub cooldown_until: Option<i64>,
    pub blacklist_until: Option<i64>,
    pub selection_penalty: Option<i64>,
    pub last_error_at_ms: Option<i64>,
    pub consecutive_error_count: Option<i64>,
}

pub(crate) fn call_quota_view(
    env: Env,
    quota_view: &Ref<()>,
    provider_key: &str,
) -> Option<QuotaViewEntry> {
    let func: JsFunction = env.get_reference_value(quota_view).ok()?;
    let arg = env.create_string(provider_key).ok()?;
    let result = func.call(None, &[arg.into_unknown()]).ok()?;
    if is_js_null_or_undefined(&result) {
        return None;
    }
    let obj = result.coerce_to_object().ok()?;
    Some(QuotaViewEntry {
        in_pool: read_bool_prop(&obj, "inPool"),
        cooldown_until: read_i64_prop(&obj, "cooldownUntil"),
        blacklist_until: read_i64_prop(&obj, "blacklistUntil"),
        selection_penalty: read_i64_prop(&obj, "selectionPenalty"),
        last_error_at_ms: read_i64_prop(&obj, "lastErrorAtMs"),
        consecutive_error_count: read_i64_prop(&obj, "consecutiveErrorCount"),
    })
}

fn is_js_null_or_undefined(value: &JsUnknown) -> bool {
    match value.get_type() {
        Ok(ValueType::Null) | Ok(ValueType::Undefined) => true,
        _ => false,
    }
}

fn read_bool_prop(obj: &JsObject, key: &str) -> Option<bool> {
    let value: JsUnknown = obj.get_named_property(key).ok()?;
    if is_js_null_or_undefined(&value) {
        return None;
    }
    let js_bool = value.coerce_to_bool().ok()?;
    js_bool.get_value().ok()
}

fn read_i64_prop(obj: &JsObject, key: &str) -> Option<i64> {
    let value: JsUnknown = obj.get_named_property(key).ok()?;
    if is_js_null_or_undefined(&value) {
        return None;
    }
    let js_num = value.coerce_to_number().ok()?;
    let raw = js_num.get_double().ok()?;
    if !raw.is_finite() {
        return None;
    }
    Some(raw.floor() as i64)
}
