use super::AdapterContext;
use crate::shared_json_utils::read_trimmed_string;

mod markup;
mod request;
mod response;
mod usage;

pub(crate) use request::apply_deepseek_web_request_compat;
pub(crate) use response::apply_deepseek_web_response_compat;
