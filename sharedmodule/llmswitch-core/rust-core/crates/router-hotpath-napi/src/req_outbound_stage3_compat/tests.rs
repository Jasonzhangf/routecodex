use super::*;
use serde_json::json;
use std::sync::{Mutex, MutexGuard, OnceLock};

static SIGNATURE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn signature_cache_test_guard() -> MutexGuard<'static, ()> {
    SIGNATURE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("signature cache test lock poisoned")
}

mod adapter_context;
mod core;
mod req_profiles;
mod resp_profiles;

#[test]
fn system_tool_guidance_is_native_owned_and_apply_patch_free() {
    let raw = build_system_tool_guidance_json().expect("system guidance json");
    let guidance: String = serde_json::from_str(&raw).expect("system guidance string");

    assert!(guidance.contains("Tool usage guidance"));
    assert!(guidance.contains("assistant.tool_calls[].function.{name,arguments}"));
    assert!(guidance.contains("function.arguments must be a single JSON string"));
    assert!(!guidance.contains("apply_patch"));
    assert!(!guidance.contains("Failed to find expected lines"));
    assert!(!guidance.contains("GNU line-number ranges"));
}

#[test]
fn tool_guidance_augmentation_is_native_owned_and_apply_patch_free() {
    let openai_raw = augment_openai_tools_json(
        json!([
            {
                "type": "function",
                "function": {
                    "name": "shell",
                    "description": "Run shell command",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "array", "items": { "type": "string" } }
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "apply_patch",
                    "description": "Edit files by patch",
                    "parameters": { "type": "object", "properties": {} }
                }
            }
        ])
        .to_string(),
    )
    .expect("openai tools json");
    let openai: Value = serde_json::from_str(&openai_raw).expect("openai tools");
    let shell = openai[0]["function"]["description"]
        .as_str()
        .expect("shell description");
    assert!(shell.contains("[Codex Shell Guidance]"));
    assert!(shell.contains("bash -lc"));
    assert!(!shell.contains("apply_patch"));
    assert!(openai[0]["function"]["parameters"]["properties"]["command"]["oneOf"].is_array());
    assert_eq!(
        openai[1]["function"]["description"].as_str(),
        Some("Edit files by patch")
    );
    assert!(openai[1]["function"]["parameters"]["properties"]["patch"].is_null());

    let anthropic_raw = augment_anthropic_tools_json(
        json!([
            { "name": "exec_command", "description": "Run shell", "input_schema": {} },
            { "name": "update_plan", "description": "Plan", "input_schema": {} }
        ])
        .to_string(),
    )
    .expect("anthropic tools json");
    let anthropic: Value = serde_json::from_str(&anthropic_raw).expect("anthropic tools");
    assert!(anthropic[0]["description"]
        .as_str()
        .expect("exec description")
        .contains("[Codex ExecCommand Guidance]"));
    assert_eq!(
        anthropic[0]["input_schema"]["type"].as_str(),
        Some("object")
    );
    assert!(anthropic[1]["description"]
        .as_str()
        .expect("plan description")
        .contains("[Codex Plan Guidance]"));
}
