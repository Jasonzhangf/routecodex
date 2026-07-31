fn inject_stopless_guidance(
    payload: &mut Value,
    state: Option<&V3StoplessCenterState>,
) -> Result<(), V3HubRelayRequestError> {
    let mut remove_instructions = false;
    match payload.get_mut("instructions") {
        Some(Value::String(existing)) => {
            let cleaned = strip_legacy_stopless_instruction(existing);
            if cleaned.trim().is_empty() {
                remove_instructions = true;
            } else {
                *existing = cleaned;
            }
        }
        Some(_) | None => {
            if payload.as_object().is_none() {
                return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
                    field: "payload",
                    reason: "request payload must be an object before stopless tool injection",
                });
            }
        }
    }
    let guidance = stopless_instruction_for_state_or_base(state);
    let object =
        payload
            .as_object_mut()
            .ok_or(V3HubRelayRequestError::MalformedStoplessToolSurface {
                field: "payload",
                reason: "request payload must be an object before stopless guidance injection",
            })?;
    let existing = if remove_instructions {
        String::new()
    } else {
        object
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let next = if existing.is_empty() {
        guidance.to_string()
    } else if has_current_stopless_instruction(&existing) {
        existing
    } else {
        format!("{}\n\n{guidance}", existing.trim_end())
    };
    object.insert("instructions".to_string(), Value::String(next));
    inject_reasoning_stop_tool(payload)?;
    enforce_stopless_required_tool_choice(payload)?;
    Ok(())
}

fn has_current_stopless_instruction(existing: &str) -> bool {
    (existing.contains("当前轮推进准则") || existing.contains("当前轮继续推进准则"))
        && existing.contains("reasoningStop")
}

fn stopless_instruction_for_state_or_base(state: Option<&V3StoplessCenterState>) -> String {
    match state {
        Some(state) => format!(
            "{}\n{}",
            STOPLESS_BASE_INSTRUCTION,
            stopless_instruction_for_state(state)
        ),
        None => STOPLESS_BASE_INSTRUCTION.to_string(),
    }
}

fn stopless_instruction_for_state(state: &V3StoplessCenterState) -> &'static str {
    match state.steering() {
        V3StoplessCenterSteering::ReasoningStopNeedsEvidence => {
            "当前完成/阻塞证据不足；如果不能提供真实 evidence 和具体证据，就不要结束本轮，先执行能补证据或推进目标的工具动作。"
        }
        V3StoplessCenterSteering::Continue => {
            "上一轮明确仍需继续；本轮必须优先选择一个可执行工具动作并执行，除非已经有完成证据或真实阻塞证据。"
        }
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop => {
            if state.consecutive_stop_count() > 1 {
                "上一轮仍未给出明确完成或阻塞证据；更严格地推进，本轮必须先执行一个最小可验证工具动作，不要只写分析、计划或总结。"
            } else {
                "上一轮未给出明确完成或阻塞证据；本轮先执行一个最小可验证工具动作，不要只写分析、计划或总结。"
            }
        }
        V3StoplessCenterSteering::Blocked => {
            "当前状态指向阻塞；只有确实需要用户输入或外部条件时才报告阻塞，并提供 evidence 与 needs_user_input，然后等待下一条真实用户输入。"
        }
        V3StoplessCenterSteering::NeedContinue | V3StoplessCenterSteering::GuardTerminal => {
            "当前状态已到终态边界；不要生成新的继续提示，按已有语义输出。"
        }
    }
}

fn strip_legacy_stopless_instruction(existing: &str) -> String {
    let mut cleaned = existing.to_string();
    for marker in [
        "当前轮推进准则",
        "当前轮继续推进准则",
        "请基于已经恢复的完整上下文继续推理",
        "正常执行当前任务，不要因为 stop schema 合同",
        "上一轮 stop 响应缺少 stop schema",
        "继续完成当前目标；基于现有上下文推理并按需调用工具。停止时调用 reasoningStop",
        "继续推进当前目标；不要把 no-op 工具轮当作完成。",
        "RouteCodex stopless guideline",
        "RouteCodex stopless continuation",
        "上一轮 reasoningStop CLI no-op",
        "继续完成当前目标；如果认为已完成或阻塞，必须调用 reasoningStop",
        "如果确实阻塞，调用 reasoningStop",
        "<rcc_stop_schema>",
    ] {
        if let Some(index) = cleaned.find(marker) {
            cleaned.truncate(index);
        }
    }
    cleaned.trim_end().to_string()
}

fn inject_reasoning_stop_tool(payload: &mut Value) -> Result<(), V3HubRelayRequestError> {
    let Some(object) = payload.as_object_mut() else {
        return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
            field: "payload",
            reason: "request payload must be an object before stopless tool injection",
        });
    };
    if object.contains_key("tools") {
        let Some(tools) = object.get_mut("tools") else {
            unreachable!("contains_key checked")
        };
        inject_reasoning_stop_tool_into_array(tools, "tools")?;
        return Ok(());
    }
    if inject_reasoning_stop_tool_into_additional_tools(object.get_mut("input"))? {
        return Ok(());
    }
    object.insert(
        "tools".to_string(),
        Value::Array(vec![build_reasoning_stop_tool()]),
    );
    Ok(())
}

fn inject_reasoning_stop_tool_into_array(
    tools: &mut Value,
    field: &'static str,
) -> Result<(), V3HubRelayRequestError> {
    let Some(items) = tools.as_array_mut() else {
        return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
            field,
            reason: "tools must be an array; refusing to rebuild original tool JSON path",
        });
    };
    items.retain(|tool| !tool_name_is_stopless_internal(tool));
    items.push(build_reasoning_stop_tool());
    Ok(())
}

fn inject_reasoning_stop_tool_into_additional_tools(
    input: Option<&mut Value>,
) -> Result<bool, V3HubRelayRequestError> {
    let Some(items) = input.and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("additional_tools") {
            continue;
        }
        let Some(embedded_tools) = item.get_mut("tools") else {
            return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
                field: "input[].tools",
                reason: "additional_tools.tools must be an array; refusing to rebuild original tool JSON path",
            });
        };
        inject_reasoning_stop_tool_into_array(embedded_tools, "input[].tools")?;
        return Ok(true);
    }
    Ok(false)
}

fn enforce_stopless_required_tool_choice(
    payload: &mut Value,
) -> Result<(), V3HubRelayRequestError> {
    let Some(object) = payload.as_object_mut() else {
        return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
            field: "payload",
            reason: "request payload must be an object before stopless tool_choice enforcement",
        });
    };
    let must_require_tool = match object.get("tool_choice") {
        None | Some(Value::Null) => true,
        Some(Value::String(choice)) => {
            matches!(choice.trim(), "" | "auto" | "none" | "required")
        }
        Some(Value::Object(choice)) => matches!(
            choice.get("type").and_then(Value::as_str),
            Some("auto" | "none" | "any" | "required")
        ),
        Some(_) => false,
    };
    if must_require_tool {
        object.insert(
            "tool_choice".to_string(),
            Value::String("required".to_string()),
        );
    }
    Ok(())
}

fn build_reasoning_stop_tool() -> Value {
    json!({
        "type": "function",
        "name": "reasoningStop",
        "description": "仅在需要报告当前回合终态或无法直接调用工具推进时使用：0=完成，1=阻塞或需要用户，2=继续，仍需继续但本轮无合适工具动作。完成/阻塞必须填写 reason 和 evidence；有工具可推进时优先调用工具而不是本工具。",
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "stopreason": {
                    "type": "integer",
                    "enum": [0, 1, 2],
                    "description": "0=finished, 1=blocked, 2=continue_needed_without_immediate_tool_action"
                },
                "reason": {
                    "type": "string",
                    "description": "Required when stopreason=1; optional summary otherwise."
                },
                "evidence": {
                    "type": "string",
                    "description": "Required when stopreason=0 or stopreason=1."
                },
                "needs_user_input": {
                    "type": "boolean",
                    "description": "true only when user input is required before progress can continue."
                }
            },
            "required": ["stopreason"]
        }
    })
}
