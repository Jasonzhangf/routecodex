pub(crate) const VIRTUAL_ROUTER_ERROR_PREFIX: &str = "VIRTUAL_ROUTER_ERROR:";

pub(crate) fn format_virtual_router_error(code: &str, message: impl AsRef<str>) -> String {
    let message = message.as_ref();
    let trimmed = message.trim();
    let body = if trimmed.is_empty() {
        "Virtual router error"
    } else {
        trimmed
    };
    format!("{}{}:{}", VIRTUAL_ROUTER_ERROR_PREFIX, code, body)
}
