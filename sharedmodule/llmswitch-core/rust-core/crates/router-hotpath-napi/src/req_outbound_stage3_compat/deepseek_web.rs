use serde_json::Value;

use super::AdapterContext;

mod markup;
mod request;
mod response;
mod usage;

pub(crate) use request::apply_deepseek_web_request_compat;
pub(crate) use response::apply_deepseek_web_response_compat;

pub(super) fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}
