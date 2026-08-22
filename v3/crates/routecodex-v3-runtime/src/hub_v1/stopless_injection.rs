//! Stopless 请求侧注入合同（Req04 激活路径）。
//!
//! 唯一 owner：`hub.servertool_stopless_cli_continuation`。
//! 注入只在同轮 `schema_guidance_active` 时发生（由调用方 `govern_v3_servertool_request_at_req04`
//! 判定）；未激活（缺 scope/request_id）不注入。thinking 模式（`reasoning_effort` 非 none）
//! 下部分 provider（如 deepseek-v4-flash）拒绝 `tool_choice=required`
//! （400: Thinking mode does not support this tool_choice）。续接请求已经带有
//! function_call_output 时也不生成 required，保留客户端原值。

use crate::hub_v1::V3HubRelayRequestError;
use serde_json::{json, Value};

/// provider-facing 当前轮推进准则。必须对模型透明：不暴露 no-op/CLI/client
/// bridge/finish_reason=stop/预算/guard/连续次数；响应侧
/// `strip_current_stopless_instruction_echo` 以 `\n\n当前轮推进准则` 为边界
/// 剥离回显，因此注入必须使用同一 header 追加在 instructions/system 尾部。
const STOPLESS_PROVIDER_GUIDANCE: &str = "当前轮推进准则：基于已恢复的完整上下文继续推进当前任务。先复核目标、已有结论与未完成事项；需要事实或执行时继续调用可用工具；只有在任务真实完成或真实阻塞且具备证据时，才调用 reasoningStop 工具并填写 stopreason（0=已完成，1=已阻塞，2=需要继续）与 evidence；既未完成也未阻塞时继续工作，不要提前停下。";
const STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER: &str = "\n\n当前轮推进准则：基于已恢复的完整上下文继续推进当前任务。先复核目标、已有结论与未完成事项；需要事实或执行时继续调用可用工具；只有在任务真实完成或真实阻塞且具备证据时，才调用 reasoningStop 工具并填写 stopreason（0=已完成，1=已阻塞，2=需要继续）与 evidence；既未完成也未阻塞时继续工作，不要提前停下。";

pub(crate) fn stopless_provider_guidance() -> &'static str {
    STOPLESS_PROVIDER_GUIDANCE
}

/// Req04 激活路径向当前轮 provider request 注入 stopless 合同：
/// 完整推进准则 + exactly-one `reasoningStop` tool；仅初始轮且非 thinking
/// 模式才生成 `tool_choice=required`。
/// 已含准则（重复进入或历史残留）时幂等跳过；原指令/工具原样保留。
pub(crate) fn inject_v3_stopless_provider_contract(
    payload: &mut Value,
    current_payload_start: usize,
) -> Result<(), V3HubRelayRequestError> {
    if payload.get("input").is_some() {
        // Responses 的合法 input 形状包括数组与字符串标量（"text"），
        // 两者都必须注入 stopless 合同，禁止静默跳过。
        inject_v3_stopless_responses_contract(payload);
    } else if payload.get("messages").and_then(Value::as_array).is_some() {
        inject_v3_stopless_chat_contract(payload, current_payload_start);
    }
    Ok(())
}

fn message_content_contains_stopless_guidance(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => text.contains("当前轮推进准则"),
        Some(Value::Array(parts)) => parts.iter().any(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("当前轮推进准则"))
        }),
        _ => false,
    }
}

fn v3_stopless_reasoning_stop_tool() -> Value {
    json!({
        "type": "function",
        "name": "reasoningStop",
        "description": "报告当前任务状态。仅在任务真实完成(stopreason=0)、真实阻塞(stopreason=1)或需要继续(stopreason=2)时调用；必须提供 evidence。",
        "parameters": {
            "type": "object",
            "properties": {
                "stopreason": {
                    "type": "integer",
                    "enum": [0, 1, 2],
                    "description": "0=已完成，1=已阻塞，2=需要继续"
                },
                "reason": {
                    "type": "string",
                    "description": "完成或阻塞的原因"
                },
                "evidence": {
                    "type": "string",
                    "description": "支撑结论的证据"
                }
            },
            "required": ["stopreason"]
        }
    })
}

fn inject_v3_stopless_responses_contract(payload: &mut Value) {
    let thinking = payload_is_thinking_mode(payload);
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let has_guidance = object
        .get("instructions")
        .and_then(Value::as_str)
        .is_some_and(|text| text.contains("当前轮推进准则"));
    if !has_guidance {
        match object.get_mut("instructions") {
            Some(Value::String(text)) => {
                text.push_str(STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER);
            }
            _ => {
                object.insert(
                    "instructions".to_string(),
                    Value::String(STOPLESS_PROVIDER_GUIDANCE.to_string()),
                );
            }
        }
    }
    let continuation = object
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|input| {
            input.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call_output" | "tool_call_output")
                )
            })
        });
    inject_v3_stopless_tools_and_choice(object, thinking, continuation);
}

fn inject_v3_stopless_chat_contract(payload: &mut Value, current_payload_start: usize) {
    let thinking = payload_is_thinking_mode(payload);
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if let Some(messages) = object.get_mut("messages").and_then(Value::as_array_mut) {
        let current_has_guidance = messages
            .get(current_payload_start..)
            .unwrap_or_default()
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
            .any(|message| message_content_contains_stopless_guidance(message.get("content")));
        if current_has_guidance {
            // The current turn already carries the provider guidance. Historical
            // system messages are intentionally ignored here.
        } else if let Some(system) = messages
            .get_mut(current_payload_start..)
            .and_then(|current| {
                current
                    .iter_mut()
                    .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
            })
        {
            match system.get_mut("content") {
                Some(Value::String(text)) => {
                    text.push_str(STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER);
                }
                Some(parts @ Value::Array(_)) => {
                    if let Some(parts) = parts.as_array_mut() {
                        parts.push(json!({
                            "type": "text",
                            "text": STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER
                        }));
                    }
                }
                _ => {
                    if let Some(system) = system.as_object_mut() {
                        system.insert(
                            "content".to_string(),
                            Value::String(STOPLESS_PROVIDER_GUIDANCE.to_string()),
                        );
                    }
                }
            }
        } else {
            // 当前轮无 system 消息：把准则插到当前轮起始边界（不修改历史前缀）。
            let mut insert_at = current_payload_start.min(messages.len());
            while messages
                .get(insert_at)
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("tool")
            {
                insert_at += 1;
            }
            messages.insert(
                insert_at,
                json!({"role": "system", "content": STOPLESS_PROVIDER_GUIDANCE}),
            );
        }
    }
    inject_v3_stopless_tools_and_choice(object, thinking, false);
}

fn inject_v3_stopless_tools_and_choice(
    object: &mut serde_json::Map<String, Value>,
    thinking: bool,
    continuation: bool,
) {
    match object.get_mut("tools") {
        Some(Value::Array(tools)) => {
            // Stopless 合同要求 exactly-one reasoningStop 工具：客户端已声明
            // 多个时去重保留第一个，禁止向 provider 下发歧义控制工具 schema。
            let mut kept_first = false;
            tools.retain(|tool| {
                if tool_is_reasoning_stop(tool) {
                    if kept_first {
                        return false;
                    }
                    kept_first = true;
                    true
                } else {
                    true
                }
            });
            if !kept_first {
                tools.push(v3_stopless_reasoning_stop_tool());
            }
        }
        _ => {
            object.insert(
                "tools".to_string(),
                Value::Array(vec![v3_stopless_reasoning_stop_tool()]),
            );
        }
    }
    // thinking 模式（reasoning_effort 非 none）或续接轮下部分 provider
    // （如 deepseek-v4-flash）拒绝 tool_choice=required（400: Thinking mode does
    // not support this tool_choice）。此时保留客户端原值（auto/none），不提升。
    if thinking || continuation {
        let needs_auto = matches!(
            object.get("tool_choice"),
            Some(choice) if choice.as_str() == Some("none")
                || choice.get("type").and_then(Value::as_str) == Some("none")
        );
        if needs_auto {
            object.insert("tool_choice".to_string(), Value::String("auto".to_string()));
        }
        return;
    } else {
        let needs_promote = match object.get("tool_choice") {
            None => true,
            Some(choice) => {
                let as_str = choice.as_str();
                let as_type = choice.get("type").and_then(Value::as_str);
                !(as_str == Some("required") || as_type == Some("required"))
            }
        };
        if needs_promote {
            object.insert(
                "tool_choice".to_string(),
                Value::String("required".to_string()),
            );
        }
    }
}

/// 协议通用 thinking 模式判定：`reasoning_effort`（openai_chat 顶层）或
/// `reasoning.effort`（Responses 嵌套）存在且非空、非 "none"。这是协议属性，
/// 不是 provider 特例。
pub(crate) fn payload_is_thinking_mode(payload: &Value) -> bool {
    let effort = payload
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/reasoning/effort").and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or_default();
    !effort.is_empty() && !effort.eq_ignore_ascii_case("none")
}

pub(crate) fn tool_is_reasoning_stop(tool: &Value) -> bool {
    tool.get("name").and_then(Value::as_str) == Some("reasoningStop")
        || tool.pointer("/function/name").and_then(Value::as_str) == Some("reasoningStop")
}

/// Relay→Direct handoff 边界：撤销当前轮 relay 注入的 stopless 合约
/// （推进准则、reasoningStop tool、tool_choice 提升），使 handoff payload
/// 回到"未注入"语义，由 Direct 侧按自身配置决定是否注入。
///
/// 只操作当前轮注入的精确文本/声明（尾部精确匹配或 exactly-one 声明），
/// 历史与无关内容原样保留；tool_choice 恢复为原始客户端请求值。
pub(crate) fn strip_v3_stopless_contract_for_relay_direct_handoff(
    payload: &mut Value,
    original_tool_choice: Option<&Value>,
) {
    if let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) {
        messages.retain_mut(|message| {
            message.get("role").and_then(Value::as_str) != Some("system")
                || !strip_v3_injected_guidance_from_system(message)
        });
    }
    if let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| !tool_is_reasoning_stop(tool));
    }
    if payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        if let Some(object) = payload.as_object_mut() {
            object.remove("tools");
        }
    }
    match original_tool_choice {
        Some(choice) => {
            if let Some(object) = payload.as_object_mut() {
                object.insert("tool_choice".to_string(), choice.clone());
            }
        }
        None => {
            if let Some(object) = payload.as_object_mut() {
                object.remove("tool_choice");
            }
        }
    }
}

/// 返回 true 表示整条 system 消息是 relay 注入新建的（应移除该消息）。
fn strip_v3_injected_guidance_from_system(message: &mut Value) -> bool {
    let Some(content) = message.get("content") else {
        return false;
    };
    match content {
        Value::String(text) if text == STOPLESS_PROVIDER_GUIDANCE => true,
        Value::String(_) => {
            if let Some(Value::String(text)) = message.get_mut("content") {
                if let Some(prefix) = text.strip_suffix(STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER) {
                    *text = prefix.to_string();
                }
            }
            false
        }
        Value::Array(_) => {
            let only_injected = content.as_array().is_some_and(|parts| {
                parts.len() == 1 && part_is_injected_stopless_guidance(&parts[0])
            });
            if only_injected {
                return true;
            }
            if let Some(Value::Array(parts)) = message.get_mut("content") {
                if let Some(last) = parts.last_mut() {
                    if part_is_injected_stopless_guidance(last) {
                        parts.pop();
                    }
                }
            }
            false
        }
        _ => false,
    }
}

fn part_is_injected_stopless_guidance(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("text")
        && part
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| {
                text == STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER || text == STOPLESS_PROVIDER_GUIDANCE
            })
}

#[cfg(test)]
mod stopless_injection_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_guidance_inserts_at_current_turn_boundary_not_history_prefix() {
        let mut payload = json!({
            "model": "test",
            "messages": [
                {"role": "user", "content": "historical turn"},
                {"role": "assistant", "content": "historical reply"},
                {"role": "user", "content": "current turn"}
            ]
        });
        inject_v3_stopless_chat_contract(&mut payload, 2);
        let messages = payload["messages"].as_array().unwrap();
        assert_eq!(
            messages[0]["role"], "user",
            "historical prefix must not be mutated by stopless guidance injection"
        );
        assert_eq!(messages[0]["content"], "historical turn");
        assert_eq!(
            messages[2]["role"], "system",
            "guidance must be inserted at the current-turn boundary (index 2)"
        );
        assert!(messages[2]["content"]
            .as_str()
            .unwrap()
            .contains("当前轮推进准则"));
        assert_eq!(messages[3]["role"], "user");
        assert_eq!(messages[3]["content"], "current turn");
    }
    #[test]
    fn responses_string_input_still_injects_stopless_contract() {
        let mut payload = json!({
            "model": "test",
            "input": "hello world",
            "tools": [{"type": "function", "name": "other_tool"}]
        });
        inject_v3_stopless_provider_contract(&mut payload, 0).expect("inject");
        assert!(
            payload["instructions"]
                .as_str()
                .unwrap()
                .contains("当前轮推进准则"),
            "string Responses input must receive stopless guidance"
        );
        assert!(payload["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(tool_is_reasoning_stop));
    }

    #[test]
    fn responses_continuation_does_not_generate_required_tool_choice() {
        let mut payload = json!({
            "model": "deepseek-v4-flash",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_stopless",
                "output": ""
            }]
        });

        inject_v3_stopless_provider_contract(&mut payload, 0).expect("inject");

        assert_eq!(payload.get("tool_choice"), None);
        assert!(payload["tools"]
            .as_array()
            .is_some_and(|tools| { tools.iter().any(tool_is_reasoning_stop) }));
    }

    #[test]
    fn duplicate_reasoning_stop_tools_are_deduped_to_exactly_one() {
        let mut payload = json!({
            "model": "test",
            "input": "run",
            "tools": [
                {"type": "function", "name": "reasoningStop", "parameters": {"type": "object"}},
                {"type": "function", "name": "reasoningStop", "parameters": {"type": "object"}},
                {"type": "function", "name": "other_tool"}
            ]
        });
        inject_v3_stopless_provider_contract(&mut payload, 0).expect("inject");
        let stop_count = payload["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool_is_reasoning_stop(tool))
            .count();
        assert_eq!(
            stop_count, 1,
            "exactly-one reasoningStop contract must hold"
        );
        assert_eq!(
            payload["tools"].as_array().unwrap().len(),
            2,
            "other tools must be preserved"
        );
    }

    #[test]
    fn strip_relay_handoff_removes_injected_contract_and_restores_tool_choice() {
        // system content 为注入新建的整条准则（字符串形态）。
        let mut payload = json!({
            "model": "m",
            "messages": [
                {"role": "system", "content": STOPLESS_PROVIDER_GUIDANCE},
                {"role": "user", "content": "hi"}
            ],
            "tools": [v3_stopless_reasoning_stop_tool(), json!({"type":"function","name":"exec","parameters":{"type":"object"}})],
            "tool_choice": "required"
        });
        strip_v3_stopless_contract_for_relay_direct_handoff(&mut payload, Some(&json!("none")));
        let messages = payload["messages"].as_array().unwrap();
        assert!(
            messages
                .iter()
                .all(|m| m.get("role").and_then(Value::as_str) != Some("system")),
            "injected system guidance message must be removed: {payload}"
        );
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(
            payload["tool_choice"], "none",
            "original tool_choice restored"
        );
        let tools = payload["tools"].as_array().unwrap();
        assert!(
            tools.iter().all(|t| !tool_is_reasoning_stop(t)),
            "reasoningStop tool must be stripped: {payload}"
        );
        assert_eq!(tools.len(), 1, "ordinary tool preserved");

        // 追加形态：system content 尾部追加注入段，剥离只截掉尾部。
        let mut appended = json!({
            "model": "m",
            "messages": [
                {"role": "system", "content": format!("base{}", STOPLESS_PROVIDER_GUIDANCE_WITH_HEADER)},
                {"role": "user", "content": "hi"}
            ],
            "tools": [v3_stopless_reasoning_stop_tool()],
            "tool_choice": "required"
        });
        strip_v3_stopless_contract_for_relay_direct_handoff(&mut appended, None);
        assert_eq!(
            appended["messages"][0]["content"], "base",
            "tail-injected guidance must be truncated"
        );
        assert!(
            appended.get("tools").is_none(),
            "empty tools after strip must remove the field"
        );
        assert!(
            appended.get("tool_choice").is_none(),
            "missing original tool_choice must remove the field"
        );
    }
}
