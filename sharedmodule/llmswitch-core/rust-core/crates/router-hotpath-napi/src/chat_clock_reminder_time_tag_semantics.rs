use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;

fn resolve_clock_time_tag_fallback_line(fallback_line: String, default_line: String) -> String {
    let fallback = fallback_line.trim().to_string();
    if !fallback.is_empty() {
        return fallback;
    }
    default_line
}

#[napi]
pub fn resolve_clock_time_tag_fallback_line_json(
    fallback_line: String,
    default_line: String,
) -> NapiResult<String> {
    Ok(resolve_clock_time_tag_fallback_line(
        fallback_line,
        default_line,
    ))
}
