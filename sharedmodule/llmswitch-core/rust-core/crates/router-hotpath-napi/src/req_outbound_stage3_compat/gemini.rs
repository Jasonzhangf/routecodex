mod request;
mod tool_schema;

pub(crate) use request::{
    apply_gemini_request_compat, apply_gemini_web_search_request_compat_json,
};
pub(crate) use tool_schema::apply_claude_thinking_tool_schema_compat;
