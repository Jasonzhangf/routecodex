use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::json;

fn build_default_servertool_skeleton_document_value() -> serde_json::Value {
    json!({
        "version": 1,
        "servertool": {
            "enabled": true,
            "internalTools": {
                "reasoning.stop": {
                    "name": "reasoning.stop",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "reasoning.stop" },
                    "execution": { "mode": "guarded", "stripAfterExecute": true }
                },
                "clock": {
                    "name": "clock",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "clock" },
                    "execution": { "mode": "client_inject_only", "stripAfterExecute": true }
                },
                "continue_execution": {
                    "name": "continue_execution",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "continue_execution" },
                    "execution": { "mode": "client_inject_only", "stripAfterExecute": true }
                },
                "stop_message_auto": {
                    "name": "stop_message_auto",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "stop_message_auto", "phase": "default", "priority": 40 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "review": {
                    "name": "review",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "review" },
                    "execution": { "mode": "reenter", "stripAfterExecute": true }
                },
                "web_search": {
                    "name": "web_search",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "web_search" },
                    "execution": { "mode": "backend", "stripAfterExecute": true }
                },
                "recursive_detection_guard": {
                    "name": "recursive_detection_guard",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "recursive_detection_guard", "phase": "pre", "priority": 5 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "antigravity_thought_signature_bootstrap": {
                    "name": "antigravity_thought_signature_bootstrap",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "antigravity_thought_signature_bootstrap", "phase": "default", "priority": 30 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "clock_auto": {
                    "name": "clock_auto",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "clock_auto", "phase": "post", "priority": 50 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "vision_auto": {
                    "name": "vision_auto",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "vision_auto", "phase": "post", "priority": 60 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "reasoning_only_continue": {
                    "name": "reasoning_only_continue",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "reasoning_only_continue", "phase": "post", "priority": 200 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "reasoning_stop_guard": {
                    "name": "reasoning_stop_guard",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "reasoning_stop_guard", "phase": "post", "priority": 160 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "exec_command": {
                    "name": "exec_command",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "exec_command" },
                    "execution": { "mode": "guarded", "stripAfterExecute": true }
                },
                "apply_patch": {
                    "name": "apply_patch",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "apply_patch" },
                    "execution": { "mode": "guarded", "stripAfterExecute": true }
                }
            },
            "skeleton": {
                "requestPrepare": { "enabled": true },
                "internalDispatch": { "enabled": true },
                "finalizeStrip": { "enabled": true, "requireFinalizedMarker": true },
                "autoHooks": {
                    "optionalPrimaryOrder": ["clock_auto", "stop_message_auto"],
                    "mandatoryOrder": []
                },
                "pendingInjection": {
                    "messageKinds": ["assistant_tool_calls", "tool_outputs"]
                },
                "progress": {
                    "toolNameByFlowId": {
                        "continue_execution_flow": "continue_execution",
                        "reasoning_stop_flow": "reasoning.stop",
                        "reasoning_stop_guard_flow": "reasoning_stop_guard",
                        "reasoning_stop_finalize_flow": "reasoning_stop_finalize",
                        "stop_message_flow": "stop_message_auto",
                        "apply_patch_guard": "apply_patch_guard",
                        "exec_command_guard": "exec_command_guard",
                        "antigravity_thought_signature_bootstrap": "antigravity_thought_signature_bootstrap",
                        "web_search_flow": "web_search",
                        "vision_flow": "vision_auto",
                        "clock_flow": "clock",
                        "clock_hold_flow": "clock_auto",
                        "recursive_detection_guard": "recursive_detection_guard"
                    },
                    "goldHighlightFlowIds": ["continue_execution_flow"]
                },
                "followup": {
                    "genericInjectionOps": [
                        "append_assistant_message",
                        "append_tool_messages_from_tool_outputs"
                    ],
                    "nativeSupportedOps": [
                        "preserve_tools",
                        "ensure_standard_tools",
                        "replace_tools",
                        "force_tool_choice",
                        "append_assistant_message",
                        "append_tool_messages_from_tool_outputs",
                        "append_user_text",
                        "inject_system_text",
                        "drop_tool_by_name",
                        "inject_vision_summary",
                        "trim_openai_messages",
                        "compact_tool_content",
                        "append_tool_if_missing"
                    ],
                    "flowPolicy": {
                        "profilesByFlowId": {
                            "reasoning_stop_finalize_flow": {
                                "noFollowup": true
                            },
                            "apply_patch_guard": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true
                            },
                            "exec_command_guard": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true
                            },
                            "reasoning_only_continue_flow": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true
                            },
                            "reasoning_stop_guard_flow": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true,
                                "stickyProvider": true
                            },
                            "reasoning_stop_continue_flow": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true,
                                "stickyProvider": true
                            },
                            "stop_message_flow": {
                                "stickyProvider": true,
                                "seedLoopPayload": true,
                                "retryEmptyFollowupOnce": true,
                                "ignoreRequiresActionFollowup": true
                            },
                            "clock_hold_flow": {
                                "stickyProvider": true,
                                "clientInjectOnly": true,
                                "clientInjectSource": "servertool.clock"
                            },
                            "heartbeat_flow": {
                                "clientInjectOnly": true,
                                "clientInjectSource": "servertool.heartbeat"
                            },
                            "continue_execution_flow": {
                                "stickyProvider": true,
                                "contextDecorationMode": "continue_execution_summary"
                            },
                            "antigravity_thought_signature_bootstrap": {
                                "stickyProvider": true,
                                "transparentReplayRequestSuffix": ":antigravity_ts_replay"
                            },
                            "reasoning_stop_flow": {
                                "stickyProvider": true
                            },
                            "web_search_flow": {
                                "contextDecorationMode": "web_search_summary"
                            }
                        }
                    }
                }
            },
            "state": {
                "scopePriority": ["tmux", "session", "conversation"],
                "pendingInjection": {
                    "enabled": true,
                    "strictContract": true
                }
            }
        }
    })
}

#[napi]
pub fn get_default_servertool_skeleton_document_json() -> NapiResult<String> {
    let output = build_default_servertool_skeleton_document_value();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_servertool_followup_flow_profile_json(flow_id: String) -> NapiResult<String> {
    let normalized_flow_id = flow_id.trim();
    if normalized_flow_id.is_empty() {
        return Ok("null".to_string());
    }
    let output = build_default_servertool_skeleton_document_value();
    let profile = output
        .get("servertool")
        .and_then(|v| v.get("skeleton"))
        .and_then(|v| v.get("followup"))
        .and_then(|v| v.get("flowPolicy"))
        .and_then(|v| v.get("profilesByFlowId"))
        .and_then(|v| v.get(normalized_flow_id))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&profile).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_followup_runtime_json(flow_id: String) -> NapiResult<String> {
    let normalized_flow_id = flow_id.trim().to_string();
    let profile_raw = resolve_servertool_followup_flow_profile_json(normalized_flow_id.clone())?;
    let profile: serde_json::Value =
        serde_json::from_str(&profile_raw).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let profile_obj = profile.as_object();
    let runtime_plan = json!({
        "flowId": if normalized_flow_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_flow_id.clone()) },
        "outcomeMode": if profile_obj.and_then(|v| v.get("noFollowup")).and_then(|v| v.as_bool()) == Some(true) {
            "skip"
        } else if profile_obj.and_then(|v| v.get("clientInjectOnly")).and_then(|v| v.as_bool()) == Some(true) {
            "client_inject_only"
        } else {
            "reenter"
        },
        "noFollowup": profile_obj.and_then(|v| v.get("noFollowup")).and_then(|v| v.as_bool()).unwrap_or(false),
        "autoLimit": profile_obj.and_then(|v| v.get("autoLimit")).and_then(|v| v.as_bool()).unwrap_or(false),
        "flowOnlyLoopLimit": profile_obj.and_then(|v| v.get("flowOnlyLoopLimit")).and_then(|v| v.as_bool()).unwrap_or(false),
        "stickyProvider": profile_obj.and_then(|v| v.get("stickyProvider")).and_then(|v| v.as_bool()).unwrap_or(false),
        "clientInjectOnly": profile_obj.and_then(|v| v.get("clientInjectOnly")).and_then(|v| v.as_bool()).unwrap_or(false),
        "seedLoopPayload": profile_obj.and_then(|v| v.get("seedLoopPayload")).and_then(|v| v.as_bool()).unwrap_or(false),
        "retryEmptyFollowupOnce": profile_obj.and_then(|v| v.get("retryEmptyFollowupOnce")).and_then(|v| v.as_bool()).unwrap_or(false),
        "ignoreRequiresActionFollowup": profile_obj.and_then(|v| v.get("ignoreRequiresActionFollowup")).and_then(|v| v.as_bool()).unwrap_or(false),
        "clientInjectSource": profile_obj.and_then(|v| v.get("clientInjectSource")).cloned().unwrap_or(serde_json::Value::Null),
        "transparentReplayRequestSuffix": profile_obj.and_then(|v| v.get("transparentReplayRequestSuffix")).cloned().unwrap_or(serde_json::Value::Null),
        "contextDecorationMode": profile_obj.and_then(|v| v.get("contextDecorationMode")).cloned().unwrap_or(serde_json::Value::Null)
    });
    serde_json::to_string(&runtime_plan).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        get_default_servertool_skeleton_document_json, plan_servertool_followup_runtime_json,
        resolve_servertool_followup_flow_profile_json,
    };
    use serde_json::Value;

    #[test]
    fn returns_servertool_skeleton_document() {
        let raw = get_default_servertool_skeleton_document_json().expect("skeleton json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse skeleton");
        assert_eq!(parsed.get("version").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(
            parsed
                .get("servertool")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(parsed
            .get("servertool")
            .and_then(|v| v.get("internalTools"))
            .and_then(|v| v.get("reasoning.stop"))
            .is_some());
    }

    #[test]
    fn resolves_followup_flow_profile() {
        let raw = resolve_servertool_followup_flow_profile_json(
            "antigravity_thought_signature_bootstrap".to_string(),
        )
        .expect("profile json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse profile");
        assert_eq!(
            parsed.get("stickyProvider").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            parsed
                .get("transparentReplayRequestSuffix")
                .and_then(|v| v.as_str()),
            Some(":antigravity_ts_replay")
        );
    }

    #[test]
    fn resolves_followup_runtime_plan() {
        let raw = plan_servertool_followup_runtime_json("clock_hold_flow".to_string())
            .expect("runtime plan json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse runtime plan");
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("client_inject_only")
        );
        assert_eq!(
            parsed.get("clientInjectOnly").and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}
