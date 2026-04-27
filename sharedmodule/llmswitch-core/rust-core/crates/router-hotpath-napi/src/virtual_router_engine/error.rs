use serde_json::{json, Value};

pub(crate) const VIRTUAL_ROUTER_ERROR_PREFIX: &str = "VIRTUAL_ROUTER_ERROR:";

fn normalize_virtual_router_error_message(message: impl AsRef<str>) -> String {
    let message = message.as_ref();
    let trimmed = message.trim();
    if trimmed.is_empty() {
        "Virtual router error".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn format_virtual_router_error(code: &str, message: impl AsRef<str>) -> String {
    let body = normalize_virtual_router_error_message(message);
    format!("{}{}:{}", VIRTUAL_ROUTER_ERROR_PREFIX, code, body)
}

pub(crate) fn format_virtual_router_error_with_details(
    code: &str,
    message: impl AsRef<str>,
    details: &Value,
) -> String {
    let body = normalize_virtual_router_error_message(message);
    let payload = json!({
        "message": body,
        "details": details
    });
    format!("{}{}:{}", VIRTUAL_ROUTER_ERROR_PREFIX, code, payload)
}
