mod system_prompt;
mod user_id;

pub(crate) use system_prompt::apply_anthropic_claude_code_system_prompt_compat;
pub(crate) use user_id::apply_anthropic_claude_code_user_id_json;
