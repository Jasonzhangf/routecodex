mod request;
mod response;

pub(crate) use request::{apply_responses_c4m_request_compat, apply_responses_crs_request_compat};
pub(crate) use response::{
    convert_responses_output_to_choices, detect_responses_c4m_rate_limit,
    ensure_response_request_id_fallback,
};
