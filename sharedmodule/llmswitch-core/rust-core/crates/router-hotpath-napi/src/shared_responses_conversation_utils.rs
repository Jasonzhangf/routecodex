use crate::hub_bridge_actions::utils::normalize_function_call_output_id;
use crate::shared_json_utils::{read_string_array_command, read_workdir_from_args};
use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use std::collections::HashSet;

fn is_shell_like_function_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal" | "run_command"
    )
}

fn parse_arguments_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(row)) => Some(row.clone()),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Some(Map::new());
            }
            let parsed: Value = serde_json::from_str(trimmed).ok()?;
            parsed.as_object().cloned()
        }
        _ => None,
    }
}

fn read_command_from_args_map(args: &Map<String, Value>) -> Option<String> {
    let read_value = |value: Option<&Value>| -> Option<String> {
        read_trimmed_string(value).or_else(|| read_string_array_command(value))
    };

    let direct = read_value(args.get("cmd"))
        .or_else(|| read_value(args.get("command")))
        .or_else(|| read_value(args.get("command_line")))
        .or_else(|| read_value(args.get("proposed_command_line")));
    if direct.is_some() {
        return direct;
    }

    args.get("input")
        .and_then(Value::as_object)
        .and_then(|row| read_value(row.get("cmd")).or_else(|| read_value(row.get("command"))))
        .or_else(|| {
            args.get("args").and_then(Value::as_object).and_then(|row| {
                read_value(row.get("cmd")).or_else(|| read_value(row.get("command")))
            })
        })
}

fn args_contain_direct_or_nested_key(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
    })
}

fn build_shell_like_output_arguments(
    raw_name: Option<&str>,
    args: &Map<String, Value>,
) -> Option<String> {
    let cmd = read_command_from_args_map(args)?;
    let has_cmd = args_contain_direct_or_nested_key(args, "cmd");
    let has_command = args_contain_direct_or_nested_key(args, "command")
        || args_contain_direct_or_nested_key(args, "command_line")
        || args_contain_direct_or_nested_key(args, "proposed_command_line");
    let source_is_shell_alias = raw_name
        .map(|name| {
            let lowered = name.trim().to_ascii_lowercase();
            matches!(
                lowered.as_str(),
                "shell_command" | "shell" | "bash" | "terminal"
            )
        })
        .unwrap_or(false);

    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);

    let mut normalized = Map::new();
    if emit_command {
        normalized.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        normalized.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args(args) {
        normalized.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(normalized)).ok()
}

fn pick_responses_persisted_fields(payload: &Value) -> Value {
    let Some(row) = payload.as_object() else {
        return Value::Object(Map::new());
    };
    let fields = [
        "model",
        "instructions",
        "metadata",
        "include",
        "store",
        "tool_choice",
        "parallel_tool_calls",
        "response_format",
        "temperature",
        "top_p",
        "max_output_tokens",
        "max_tokens",
        "stop",
        "user",
        "modal",
        "truncation_strategy",
        "previous_response_id",
        "reasoning",
        "attachments",
        "input_audio",
        "output_audio",
    ];
    let mut next = Map::new();
    for key in fields {
        if let Some(value) = row.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(next)
}

fn clone_responses_context_body(payload: &Value) -> Map<String, Value> {
    let mut cloned = clone_object(Some(payload));
    cloned.remove("response_id");
    cloned.remove("tool_outputs");
    cloned
}

fn normalize_responses_tool_definition(tool: &Value) -> Option<Value> {
    let row = tool.as_object()?;
    let tool_type = row
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if tool_type != "function" {
        return Some(Value::Object(row.clone()));
    }

    let function_node = row.get("function").and_then(Value::as_object);
    let name = read_trimmed_string(row.get("name"))
        .or_else(|| function_node.and_then(|node| read_trimmed_string(node.get("name"))))?;

    let mut normalized = Map::new();
    normalized.insert("type".to_string(), Value::String("function".to_string()));
    normalized.insert("name".to_string(), Value::String(name));

    let description = row
        .get("description")
        .cloned()
        .or_else(|| function_node.and_then(|node| node.get("description").cloned()));
    if let Some(description) = description {
        normalized.insert("description".to_string(), description);
    }

    let parameters = row
        .get("parameters")
        .cloned()
        .or_else(|| function_node.and_then(|node| node.get("parameters").cloned()));
    if let Some(parameters) = parameters {
        normalized.insert("parameters".to_string(), parameters);
    }

    Some(Value::Object(normalized))
}

fn normalize_responses_tool_definitions(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(normalize_responses_tool_definition)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn read_entry_tools_value(entry_obj: &Map<String, Value>) -> Value {
    if let Some(tools) = entry_obj.get("tools") {
        return tools.clone();
    }
    entry_obj
        .get("basePayload")
        .and_then(Value::as_object)
        .and_then(|row| row.get("tools"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn normalize_responses_history_item(value: Value) -> Value {
    let Some(row) = value.as_object() else {
        return value;
    };
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if item_type == "function_call" {
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(call_id) = read_bridge_function_call_id(row) {
            out.insert("call_id".to_string(), Value::String(call_id));
        }
        if let Some(name) = read_trimmed_string(row.get("name")).or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_trimmed_string(function.get("name")))
        }) {
            out.insert("name".to_string(), Value::String(name));
        }
        if let Some(arguments) = row.get("arguments").cloned().or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("arguments").cloned())
        }) {
            out.insert("arguments".to_string(), arguments);
        }
        return Value::Object(out);
    }

    if item_type == "function_call_output" {
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        );
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(call_id) = read_bridge_function_call_id(row) {
            out.insert("call_id".to_string(), Value::String(call_id));
        }
        if let Some(output) = row.get("output").cloned() {
            out.insert("output".to_string(), output);
        }
        return Value::Object(out);
    }

    value
}

fn normalize_responses_history_items(items: Vec<Value>) -> Vec<Value> {
    items
        .into_iter()
        .map(strip_meta_value)
        .map(normalize_responses_history_item)
        .collect::<Vec<_>>()
}

const STOP_HOOK_COMMAND_MARKERS: &[&str] = &[
    "routecodex hook run stop_message_auto",
    "routecodex servertool run stop_message_auto",
    "routecodex hook run reasoningStop",
    "routecodex servertool run reasoningStop",
];

fn build_responses_text_guidance_input_item(text: String) -> Value {
    serde_json::json!({
        "type": "message",
        "role": "user",
        "content": [{ "type": "input_text", "text": text }]
    })
}

fn is_shell_like_tool_name(raw_name: &str) -> bool {
    matches!(
        raw_name.trim().to_ascii_lowercase().as_str(),
        "exec_command"
            | "run_command"
            | "bash"
            | "sh"
            | "zsh"
            | "terminal"
            | "shell"
            | "write_stdin"
    )
}

fn read_exec_command_cmd(arguments: Option<&Value>) -> Option<String> {
    let raw = match arguments {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(obj)) => obj
            .get("cmd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                obj.get("command")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })?,
        _ => return None,
    };
    if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) {
        return obj
            .get("cmd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                obj.get("command")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            });
    }
    Some(raw)
}

fn parse_stopless_tool_output_payload(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(row) => Some(row.clone()),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|parsed| parsed.as_object().cloned()),
        _ => None,
    }
}

fn is_stopless_tool_output_payload(value: &Value) -> bool {
    parse_stopless_tool_output_payload(value)
        .and_then(|row| {
            read_trimmed_string(row.get("toolName"))
                .or_else(|| read_trimmed_string(row.get("tool_name")))
        })
        .is_some_and(|tool_name| tool_name == "stop_message_auto")
}

fn is_stop_hook_function_call(row: &Map<String, Value>) -> bool {
    let item_type = read_trimmed_string(row.get("type"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if item_type != "function_call" && item_type != "tool_call" {
        return false;
    }
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    if !is_shell_like_tool_name(name.as_str()) {
        return false;
    }
    let Some(cmd) = read_exec_command_cmd(row.get("arguments")) else {
        return false;
    };
    STOP_HOOK_COMMAND_MARKERS
        .iter()
        .any(|marker| cmd.contains(marker))
}

fn read_stopless_schema_feedback_text(
    row: &Map<String, Value>,
    _repeat_count: u32,
) -> Option<String> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = read_trimmed_string(feedback.get("reasonCode"))
        .or_else(|| read_trimmed_string(feedback.get("reason_code")))?;
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if missing_fields.is_empty() && reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    let joined = missing_fields.join(", ");
    match reason_code.as_str() {
        "stop_schema_missing" => Some(if joined.is_empty() {
            "如果任务已经完成，就按下面 schema 补齐收尾字段；如果任务还没完成，不要停，继续执行当前任务。".to_string()
        } else {
            format!(
                "如果任务已经完成，就按下面 schema 补齐缺失字段：{joined}；如果任务还没完成，不要停，继续执行当前任务。"
            )
        }),
        "stop_schema_reason_missing" => Some(format!("这次先把 reason 补齐：{joined}。")),
        "stop_schema_continue_next_step" => {
            if joined.is_empty() {
                Some("任务还没收尾，继续执行你给出的 next_step，并在收尾时再补全结论与证据。".to_string())
            } else {
                Some(format!("任务还没收尾，先执行 next_step；同时别忘了后面还缺：{joined}。"))
            }
        }
        "stop_schema_terminal_missing_fields" => {
            Some(format!("你已经表达想停，但收尾字段还没补齐：{joined}。"))
        }
        "stop_schema_needs_user_input_missing_next_step" => {
            Some("你表示需要用户输入，但 next_step 里还没有写出要问用户的具体问题；把问题直接写进 next_step。".to_string())
        }
        "stop_schema_next_step_missing" => {
            Some(format!("任务还没完成，但当前没有明确 next_step；缺少这些字段：{joined}。把下一步写成这轮立刻执行的最小动作。"))
        }
        "stop_schema_continue_without_next_step" => {
            Some("任务还没完成，但你没有给出明确 next_step；这轮必须补出最小下一步，或者直接给出最终收尾。".to_string())
        }
        _ => Some(format!("先补齐这些字段：{joined}。")),
    }
}

fn render_stopless_schema_guidance_text(schema_guidance: &Value) -> Option<String> {
    let guidance = schema_guidance.as_object()?;
    let schema_overview = guidance
        .get("schemaOverview")
        .or_else(|| guidance.get("schema_overview"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("stop schema 是模型在准备结束、暂停或继续时返回的收尾报告。");
    let schema_purpose = guidance
        .get("schemaPurpose")
        .or_else(|| guidance.get("schema_purpose"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("它把结论、证据、根因、排查顺序和下一步固定下来，让系统判断 finished / blocked / continue_needed。");
    let required_fields = guidance
        .get("requiredFields")
        .or_else(|| guidance.get("required_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let field_descriptions = guidance
        .get("fieldDescriptions")
        .or_else(|| guidance.get("field_descriptions"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object())
                .filter_map(|row| {
                    let field = read_trimmed_string(row.get("field"))?;
                    let meaning = read_trimmed_string(row.get("meaning"))?;
                    Some(format!("{field}：{meaning}"))
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let stopreason_values = guidance
        .get("stopreasonValues")
        .or_else(|| guidance.get("stopreason_values"))
        .and_then(Value::as_object);
    let sample = guidance
        .get("sample")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("最小可复制样本：{value}"));
    let mut lines = Vec::<String>::new();
    lines.push(format!("这是什么：{schema_overview}"));
    lines.push(format!("为什么要填：{schema_purpose}"));
    lines.push(
        "怎么理解这个 schema：它是 stop result 的结构化 JSON 约定，不是普通总结。".to_string(),
    );
    if !required_fields.is_empty() {
        lines.push(format!(
            "怎么填：按字段之间的逻辑关系填写，不是每个字段都必填；本轮缺失字段：{}。",
            required_fields.join(", ")
        ));
    }
    lines.push(
        "必填关系：stopreason 必须是数字 0/1/2；stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空；stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止；stopreason=2 必须写 next_step，下一轮只执行 next_step；needs_user_input=true 时 next_step 必须直接写要问用户的问题并停止等待。".to_string(),
    );
    if !field_descriptions.is_empty() {
        lines.push(format!(
            "字段怎么写：\n- {}",
            field_descriptions.join("\n- ")
        ));
    }
    if let Some(values) = stopreason_values {
        let finished = values.get("finished").and_then(Value::as_i64).unwrap_or(0);
        let blocked = values.get("blocked").and_then(Value::as_i64).unwrap_or(1);
        let continue_needed = values
            .get("continueNeeded")
            .or_else(|| values.get("continue_needed"))
            .and_then(Value::as_i64)
            .unwrap_or(2);
        lines.push(format!(
            "stopreason 取值：{finished}=finished，{blocked}=blocked，{continue_needed}=continue_needed。"
        ));
    }
    if let Some(sample) = sample {
        lines.push(sample);
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn read_stopless_tool_result_snapshot_text(row: &Map<String, Value>) -> Option<String> {
    let repeat_count = row
        .get("repeatCount")
        .or_else(|| row.get("repeat_count"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let max_repeats = row
        .get("maxRepeats")
        .or_else(|| row.get("max_repeats"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let schema_feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))
        .and_then(Value::as_object);
    let reason_code = schema_feedback
        .and_then(|feedback| {
            feedback
                .get("reasonCode")
                .or_else(|| feedback.get("reason_code"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let missing_fields = schema_feedback
        .and_then(|feedback| {
            feedback
                .get("missingFields")
                .or_else(|| feedback.get("missing_fields"))
        })
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    if repeat_count.is_none() && reason_code.is_none() && missing_fields.is_empty() {
        return None;
    }
    let mut segments = Vec::<String>::new();
    if let Some(repeat) = repeat_count {
        if let Some(max) = max_repeats {
            segments.push(format!("repeatCount={repeat}/{max}"));
        } else {
            segments.push(format!("repeatCount={repeat}"));
        }
    }
    if let Some(reason) = reason_code {
        segments.push(format!("reasonCode={reason}"));
    }
    if !missing_fields.is_empty() {
        segments.push(format!("missingFields={}", missing_fields.join(", ")));
    }
    Some(format!("上一轮执行结果：{}。", segments.join("；")))
}

fn build_stop_hook_guidance_text_from_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(row) = parse_stopless_tool_output_payload(&Value::String(trimmed.to_string())) {
        let tool_name = read_trimmed_string(row.get("toolName"))
            .or_else(|| read_trimmed_string(row.get("tool_name")))
            .unwrap_or_default();
        if tool_name == "stop_message_auto" {
            let mut parts = Vec::<String>::new();
            let repeat_count = row
                .get("repeatCount")
                .and_then(Value::as_u64)
                .map(|value| value as u32)
                .unwrap_or(1);
            if let Some(snapshot) = read_stopless_tool_result_snapshot_text(&row) {
                parts.push(snapshot);
            }
            if let Some(schema_feedback) = read_stopless_schema_feedback_text(&row, repeat_count) {
                parts.push(schema_feedback);
            }
            if let Some(prompt) = read_trimmed_string(row.get("continuationPrompt"))
                .or_else(|| read_trimmed_string(row.get("continuation_prompt")))
            {
                parts.push(prompt);
            }
            if let Some(schema_guidance) = row
                .get("schemaGuidance")
                .or_else(|| row.get("schema_guidance"))
                .and_then(render_stopless_schema_guidance_text)
            {
                parts.push(schema_guidance);
            } else if let Some((reason_code, missing_fields)) =
                read_stopless_schema_feedback_context(&row)
            {
                let Some(trigger_hint) = derive_stopless_trigger_hint_from_reason(&reason_code)
                else {
                    parts.push(format!(
                        "STOPLESS_CLI_RESULT_MALFORMED: schemaFeedback.reasonCode={reason_code} 没有注册的修复引导；不能伪造默认 schema guidance。请重新运行 reasoningStop 生成合法 CLI 输出。"
                    ));
                    return parts.join("\n");
                };
                let guidance = serde_json::json!({
                    "triggerHint": trigger_hint,
                    "requiredFields": missing_fields,
                    "sample": "{\"stopreason\":2,\"reason\":\"当前还在推进\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"运行下一条验证命令\",\"needs_user_input\":false}",
                    "stopreasonValues": {
                        "finished": 0,
                        "blocked": 1,
                        "continueNeeded": 2
                    }
                });
                if let Some(schema_guidance) = render_stopless_schema_guidance_text(&guidance) {
                    parts.push(schema_guidance);
                }
            } else if !is_legal_minimal_stopless_output(&row) {
                parts.push(
                    "STOPLESS_CLI_RESULT_MALFORMED: 缺少 schemaGuidance，且 schemaFeedback.reasonCode/missingFields 不完整；不能伪造默认 schema guidance。请重新运行 reasoningStop 生成合法 CLI 输出。"
                        .to_string(),
                );
            }
            if !parts.is_empty() {
                return parts.join("\n");
            }
        }
    }
    trimmed.to_string()
}

fn is_legal_minimal_stopless_output(row: &Map<String, Value>) -> bool {
    let trigger_hint = row
        .get("input")
        .or_else(|| row.get("input_json"))
        .and_then(Value::as_object)
        .and_then(|input| {
            read_trimmed_string(input.get("triggerHint"))
                .or_else(|| read_trimmed_string(input.get("trigger_hint")))
        })
        .or_else(|| read_trimmed_string(row.get("triggerHint")))
        .or_else(|| read_trimmed_string(row.get("trigger_hint")));
    matches!(
        trigger_hint.as_deref(),
        Some("no_schema" | "non_terminal_schema")
    )
}

fn read_stopless_schema_feedback_context(
    row: &Map<String, Value>,
) -> Option<(String, Vec<String>)> {
    let feedback = row
        .get("schemaFeedback")
        .or_else(|| row.get("schema_feedback"))?
        .as_object()?;
    let reason_code = read_trimmed_string(
        feedback
            .get("reasonCode")
            .or_else(|| feedback.get("reason_code")),
    )?;
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|item| read_trimmed_string(Some(item)))
        .collect::<Vec<String>>();
    if missing_fields.is_empty() && reason_code != "stop_schema_continue_next_step" {
        return None;
    }
    Some((reason_code, missing_fields))
}

fn derive_stopless_trigger_hint_from_reason(reason_code: &str) -> Option<&'static str> {
    match reason_code {
        "stop_schema_missing" => Some("no_schema"),
        "stop_schema_continue_next_step" => Some("non_terminal_schema"),
        "stop_schema_stopreason_missing_or_non_numeric"
        | "stop_schema_reason_missing"
        | "stop_schema_forcestop_reason_missing"
        | "stop_schema_terminal_missing_fields"
        | "stop_schema_needs_user_input_missing_next_step"
        | "stop_schema_next_step_missing"
        | "stop_schema_continue_without_next_step" => Some("invalid_schema"),
        _ => None,
    }
}

fn is_stopless_guidance_message(entry: &Value) -> bool {
    let Some(row) = entry.as_object() else {
        return false;
    };
    if row.get("type").and_then(Value::as_str) != Some("message") {
        return false;
    }
    if row.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(content) = row.get("content").and_then(Value::as_array) else {
        return false;
    };
    if content.len() != 1 {
        return false;
    }
    let Some(text) = content[0].get("text").and_then(Value::as_str) else {
        return false;
    };
    text.contains("上一轮执行结果：repeatCount=")
        || text.contains("按下面 schema 补齐缺失字段")
        || text.contains("收尾时至少带上这些字段")
        || text.contains("stopreason")
            && (text.contains("finished")
                || text.contains("blocked")
                || text.contains("continue_needed")
                || text.contains("收尾时至少带上这些字段"))
}

fn collapse_auto_stop_hook_pairs_in_history(items: Vec<Value>) -> Vec<Value> {
    let completed_stopless_call_ids: HashSet<String> = items
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|row| {
            let item_type = read_trimmed_string(row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !is_bridge_tool_output_item_type(item_type.as_str()) {
                return None;
            }
            let output = row.get("output")?;
            if !is_stopless_tool_output_payload(output) {
                return None;
            }
            read_bridge_function_call_id(row)
        })
        .collect();
    let latest_stopless_call_id = items
        .iter()
        .rev()
        .filter_map(Value::as_object)
        .find_map(|row| {
            let item_type = read_trimmed_string(row.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !is_bridge_tool_output_item_type(item_type.as_str()) {
                return None;
            }
            let output = row.get("output")?;
            if !is_stopless_tool_output_payload(output) {
                return None;
            }
            read_bridge_function_call_id(row)
        });
    let latest_stopless_guidance = latest_stopless_call_id.as_ref().and_then(|latest_call_id| {
        items
            .iter()
            .rev()
            .filter_map(Value::as_object)
            .find_map(|row| {
                let item_type = read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if !is_bridge_tool_output_item_type(item_type.as_str()) {
                    return None;
                }
                let call_id = read_bridge_function_call_id(row)?;
                if call_id != *latest_call_id {
                    return None;
                }
                let output = row.get("output")?;
                if !is_stopless_tool_output_payload(output) {
                    return None;
                }
                let output_text = match output {
                    Value::String(text) => text.clone(),
                    other => serde_json::to_string(other).ok()?,
                };
                Some(build_responses_text_guidance_input_item(
                    build_stop_hook_guidance_text_from_output(&output_text),
                ))
            })
    });
    let mut normalized = Vec::<Value>::with_capacity(items.len());
    let mut guidance_injected = false;
    let mut suppressed_stop_hook_call_id: Option<String> = None;
    for item in items {
        let Some(row) = item.as_object() else {
            normalized.push(item);
            continue;
        };
        if is_stopless_guidance_message(&item) {
            continue;
        }
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type == "function_call" || item_type == "tool_call" {
            let Some(call_id) = read_bridge_function_call_id(row) else {
                normalized.push(item);
                continue;
            };
            if is_stop_hook_function_call(row)
                && completed_stopless_call_ids.contains(call_id.as_str())
            {
                suppressed_stop_hook_call_id = Some(call_id);
                continue;
            }
            normalized.push(item);
            continue;
        }
        if item_type == "message"
            && row.get("role").and_then(Value::as_str) == Some("assistant")
            && suppressed_stop_hook_call_id.is_some()
        {
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            let call_id = read_bridge_function_call_id(row).unwrap_or_default();
            if is_stopless_tool_output_payload(row.get("output").unwrap_or(&Value::Null))
                && completed_stopless_call_ids.contains(call_id.as_str())
            {
                if !guidance_injected
                    && latest_stopless_call_id.as_deref() == Some(call_id.as_str())
                {
                    if let Some(guidance) = latest_stopless_guidance.clone() {
                        normalized.push(guidance);
                    }
                    guidance_injected = true;
                }
                if suppressed_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    suppressed_stop_hook_call_id = None;
                }
                continue;
            }
            if is_stopless_tool_output_payload(row.get("output").unwrap_or(&Value::Null))
                && latest_stopless_call_id.as_deref() == Some(call_id.as_str())
                && !guidance_injected
            {
                if let Some(guidance) = latest_stopless_guidance.clone() {
                    normalized.push(guidance);
                }
                guidance_injected = true;
                if suppressed_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    suppressed_stop_hook_call_id = None;
                }
                continue;
            }
        }
        normalized.push(item);
    }
    normalized
}

fn remove_auto_stop_hook_assistant_echoes_in_history(items: Vec<Value>) -> Vec<Value> {
    let mut normalized = Vec::<Value>::with_capacity(items.len());
    let mut pending_stop_hook_call_id: Option<String> = None;
    for item in items {
        let Some(row) = item.as_object() else {
            normalized.push(item);
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type == "function_call" || item_type == "tool_call" {
            pending_stop_hook_call_id = if is_stop_hook_function_call(row) {
                read_bridge_function_call_id(row)
            } else {
                None
            };
            normalized.push(item);
            continue;
        }
        if item_type == "message"
            && row.get("role").and_then(Value::as_str) == Some("assistant")
            && pending_stop_hook_call_id.is_some()
        {
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if pending_stop_hook_call_id.as_deref() == Some(call_id.as_str()) {
                    pending_stop_hook_call_id = None;
                }
            }
        }
        normalized.push(item);
    }
    normalized
}

fn normalize_message_content_part_for_request_history(part: &Value) -> Option<Value> {
    let row = part.as_object()?;
    let part_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match part_type.as_str() {
        "input_text" => Some(part.clone()),
        "output_text" | "text" | "commentary" => {
            let text = row
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            Some(serde_json::json!({
                "type": "input_text",
                "text": text,
            }))
        }
        "image_url" | "input_image" | "video_url" | "input_audio" | "file" => Some(part.clone()),
        _ => None,
    }
}

fn normalize_message_content_for_request_history(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(normalize_message_content_part_for_request_history)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_output_item_to_input(item: &Value) -> Option<Value> {
    let row = item.as_object()?;
    let item_type = row
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if item_type == "message" {
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("assistant")
            .to_string();
        let content = if row.get("content").is_some() {
            Value::Array(normalize_message_content_for_request_history(
                row.get("content"),
            ))
        } else {
            row.get("text")
                .and_then(Value::as_str)
                .map(|text| {
                    Value::Array(vec![
                        serde_json::json!({ "type": "input_text", "text": text }),
                    ])
                })
                .unwrap_or_else(|| Value::Array(Vec::new()))
        };
        return Some(serde_json::json!({
          "type": "message",
          "role": role,
          "content": content,
        }));
    }

    if item_type == "reasoning" {
        let mut out = Map::new();
        out.insert("type".to_string(), Value::String("reasoning".to_string()));
        if let Some(id) = read_trimmed_string(row.get("id")) {
            out.insert("id".to_string(), Value::String(id));
        }
        if let Some(summary) = row.get("summary").cloned() {
            out.insert("summary".to_string(), summary);
        }
        if let Some(encrypted_content) = row.get("encrypted_content").cloned() {
            out.insert("encrypted_content".to_string(), encrypted_content);
        }
        return Some(Value::Object(out));
    }

    if item_type == "function_call" {
        let raw_name = row
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                row.get("function")
                    .and_then(Value::as_object)
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
            })
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let is_shell_like = raw_name
            .as_deref()
            .map(is_shell_like_function_name)
            .unwrap_or(false);
        let raw_arguments = row.get("arguments").or_else(|| {
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|f| f.get("arguments"))
        });

        let mut normalized_shell_args: Option<Value> = None;
        if is_shell_like {
            let args = parse_arguments_record(raw_arguments)?;
            let serialized = build_shell_like_output_arguments(raw_name.as_deref(), &args)?;
            normalized_shell_args = Some(Value::String(serialized));
        }

        let call_id = row
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| row.get("id").and_then(Value::as_str));
        let function_node = row
            .get("function")
            .and_then(Value::as_object)
            .cloned()
            .or_else(|| {
                row.get("name").and_then(Value::as_str).map(|name| {
                    let mut fn_node = Map::new();
                    fn_node.insert("name".to_string(), Value::String(name.to_string()));
                    if let Some(args) = normalized_shell_args
                        .as_ref()
                        .or_else(|| row.get("arguments"))
                    {
                        fn_node.insert("arguments".to_string(), args.clone());
                    }
                    fn_node
                })
            });
        let mut out = Map::new();
        out.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            out.insert("id".to_string(), Value::String(id.to_string()));
        }
        if let Some(call_id) = call_id {
            out.insert("call_id".to_string(), Value::String(call_id.to_string()));
        }
        if let Some(name) = row.get("name").and_then(Value::as_str) {
            out.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(arguments) = normalized_shell_args
            .as_ref()
            .or_else(|| row.get("arguments"))
        {
            out.insert("arguments".to_string(), arguments.clone());
        }
        return Some(Value::Object(out));
    }

    None
}

fn normalize_required_action_tool_call_to_input(call: &Value) -> Option<Value> {
    let row = call.as_object()?;
    let call_id = read_bridge_function_call_id(row)?;
    let function = row.get("function").and_then(Value::as_object);
    let name = read_trimmed_string(row.get("name"))
        .or_else(|| function.and_then(|node| read_trimmed_string(node.get("name"))))?;
    let arguments = row
        .get("arguments")
        .cloned()
        .or_else(|| function.and_then(|node| node.get("arguments").cloned()))
        .unwrap_or_else(|| Value::String("{}".to_string()));

    let mut out = Map::new();
    out.insert(
        "type".to_string(),
        Value::String("function_call".to_string()),
    );
    if let Some(id) = read_trimmed_string(row.get("id")) {
        out.insert("id".to_string(), Value::String(id));
    } else {
        out.insert("id".to_string(), Value::String(format!("fc_{}", call_id)));
    }
    out.insert("call_id".to_string(), Value::String(call_id));
    out.insert("name".to_string(), Value::String(name));
    out.insert("arguments".to_string(), arguments);
    Some(Value::Object(out))
}

fn convert_responses_output_to_input_items(response: &Value) -> Value {
    let output = response
        .as_object()
        .and_then(|row| row.get("output"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items: Vec<Value> = Vec::new();
    for entry in output {
        if let Some(mapped) = normalize_output_item_to_input(&entry) {
            let item_type = mapped
                .as_object()
                .and_then(|row| row.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if item_type == "function_call" {
                items.push(mapped);
                continue;
            }
            items.push(mapped);
        }
    }
    if items.iter().all(|item| {
        item.as_object()
            .and_then(|row| row.get("type"))
            .and_then(Value::as_str)
            != Some("function_call")
    }) {
        if let Some(required_action) = response
            .as_object()
            .and_then(|row| row.get("required_action"))
            .and_then(Value::as_object)
        {
            if let Some(tool_calls) = required_action
                .get("submit_tool_outputs")
                .and_then(Value::as_object)
                .and_then(|submit| submit.get("tool_calls"))
                .and_then(Value::as_array)
            {
                for call in tool_calls {
                    if let Some(mapped) = normalize_required_action_tool_call_to_input(call) {
                        items.push(mapped);
                    }
                }
            }
        }
    }
    Value::Array(items)
}

fn clone_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn clone_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn clone_optional_array(value: Option<&Value>) -> Option<Vec<Value>> {
    value.and_then(Value::as_array).cloned()
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(Value::as_str)?.trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn stringify_responses_tool_output(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => {
            serde_json::to_string(other).unwrap_or_else(|_| "[object Object]".to_string())
        }
    }
}

fn responses_input_starts_with_tool_output(payload_obj: &Map<String, Value>) -> bool {
    let Some(input) = payload_obj.get("input").and_then(Value::as_array) else {
        return false;
    };
    let Some(first) = input.first().and_then(Value::as_object) else {
        return false;
    };
    first.get("type").and_then(Value::as_str) == Some("function_call_output")
}

fn normalize_responses_handler_submit_payload(
    payload_obj: &Map<String, Value>,
    response_id_from_path: Option<&str>,
) -> Result<(Option<String>, Value), String> {
    let response_id = read_trimmed_string(payload_obj.get("response_id"))
        .or_else(|| read_trimmed_string(payload_obj.get("previous_response_id")))
        .or_else(|| response_id_from_path.map(str::to_string));

    if response_id.is_some()
        && payload_obj
            .get("tool_outputs")
            .and_then(Value::as_array)
            .is_some()
    {
        let mut normalized = payload_obj.clone();
        if !normalized.contains_key("response_id") {
            if let Some(response_id) = response_id.as_ref() {
                normalized.insert(
                    "response_id".to_string(),
                    Value::String(response_id.clone()),
                );
            }
        }
        return Ok((response_id, Value::Object(normalized)));
    }

    let input = payload_obj
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut saw_function_call_output = false;
    let mut tool_outputs: Vec<Value> = Vec::new();

    for (index, item) in input.iter().enumerate() {
        let Some(row) = item.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("function_call_output") {
            continue;
        }
        saw_function_call_output = true;
        let Some(call_id) = read_trimmed_string(row.get("call_id"))
            .or_else(|| read_trimmed_string(row.get("tool_call_id")))
            .or_else(|| read_trimmed_string(row.get("id")))
        else {
            return Err(format!(
                "Responses function_call_output at input index {} is missing call_id/tool_call_id",
                index
            ));
        };
        tool_outputs.push(serde_json::json!({
            "tool_call_id": call_id,
            "output": stringify_responses_tool_output(row.get("output")),
        }));
    }

    if !saw_function_call_output {
        let mut normalized = payload_obj.clone();
        if !normalized.contains_key("response_id") {
            if let Some(response_id) = response_id.as_ref() {
                normalized.insert(
                    "response_id".to_string(),
                    Value::String(response_id.clone()),
                );
            }
        }
        return Ok((response_id, Value::Object(normalized)));
    }
    if tool_outputs.is_empty() {
        return Err(
            "Responses function_call_output resume payload produced no tool outputs".to_string(),
        );
    }
    let Some(response_id) = response_id else {
        return Err("Responses function_call_output resume payload requires response_id or previous_response_id".to_string());
    };

    let mut normalized = payload_obj.clone();
    normalized.insert(
        "response_id".to_string(),
        Value::String(response_id.clone()),
    );
    normalized.insert("tool_outputs".to_string(), Value::Array(tool_outputs));

    Ok((Some(response_id), Value::Object(normalized)))
}

fn plan_responses_handler_entry(
    payload: &Value,
    entry_endpoint: Option<&str>,
    response_id_from_path: Option<&str>,
) -> Result<Value, String> {
    let Some(payload_obj) = payload.as_object() else {
        return Ok(serde_json::json!({ "mode": "none", "payload": {} }));
    };
    let endpoint = entry_endpoint.unwrap_or("/v1/responses");
    let is_submit_endpoint = endpoint == "/v1/responses.submit_tool_outputs";
    let is_submit_payload = endpoint == "/v1/responses"
        && read_trimmed_string(payload_obj.get("response_id")).is_some()
        && payload_obj
            .get("tool_outputs")
            .and_then(Value::as_array)
            .is_some();
    let is_previous_response_tool_output = endpoint == "/v1/responses"
        && read_trimmed_string(payload_obj.get("previous_response_id")).is_some()
        && payload_obj
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|input| {
                input.iter().any(|item| {
                    item.as_object()
                        .and_then(|row| row.get("type"))
                        .and_then(Value::as_str)
                        == Some("function_call_output")
                })
            });

    if is_submit_endpoint || is_submit_payload || is_previous_response_tool_output {
        let (response_id, normalized_payload) =
            normalize_responses_handler_submit_payload(payload_obj, response_id_from_path)?;
        return Ok(serde_json::json!({
            "mode": "submit_tool_outputs",
            "responseId": response_id.map(Value::String).unwrap_or(Value::Null),
            "payload": normalized_payload,
        }));
    }

    if endpoint == "/v1/responses" && responses_input_starts_with_tool_output(payload_obj) {
        return Ok(serde_json::json!({
            "mode": "scope_materialize",
            "payload": payload,
        }));
    }

    Ok(serde_json::json!({ "mode": "none", "payload": payload }))
}

fn normalize_submitted_tool_outputs(
    tool_outputs: &[Value],
    merged_input: &[Value],
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let mut call_id_to_function_item_id: Map<String, Value> = Map::new();
    for item in merged_input {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call" {
            continue;
        }
        let id = read_trimmed_string(row.get("id"));
        let call_id = read_trimmed_string(row.get("call_id"));
        if let Some(id_value) = id.clone() {
            call_id_to_function_item_id.insert(id_value.clone(), Value::String(id_value));
        }
        if let Some(call_id_value) = call_id {
            let mapped = id.clone().unwrap_or_else(|| call_id_value.clone());
            call_id_to_function_item_id.insert(call_id_value, Value::String(mapped));
        }
    }

    let mut items: Vec<Value> = Vec::new();
    let mut submitted: Vec<Value> = Vec::new();

    for (index, entry) in tool_outputs.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };

        let raw_id = read_trimmed_string(row.get("tool_call_id"))
            .or_else(|| read_trimmed_string(row.get("call_id")))
            .or_else(|| read_trimmed_string(row.get("id")));
        let call_id = raw_id.clone();

        let mapped_item_id = call_id
            .as_ref()
            .and_then(|resolved_call_id| call_id_to_function_item_id.get(resolved_call_id))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let output_id = if let Some(mapped) = mapped_item_id {
            normalize_function_call_output_id(Some(mapped.as_str()), mapped.as_str())
        } else if let Some(resolved_call_id) = call_id.as_ref() {
            return Err(format!(
                "Responses tool output id '{}' does not match any pending function_call in previous_response_id context",
                resolved_call_id
            ));
        } else {
            return Err(format!(
                "Responses tool output at index {} is missing tool_call_id/call_id",
                index
            ));
        };

        let output_text = stringify_responses_tool_output(row.get("output"));

        let mut item = Map::new();
        item.insert(
            "type".to_string(),
            Value::String("function_call_output".to_string()),
        );
        item.insert("id".to_string(), Value::String(output_id));
        if let Some(resolved_call_id) = call_id.clone() {
            item.insert("call_id".to_string(), Value::String(resolved_call_id));
        }
        item.insert("output".to_string(), Value::String(output_text.clone()));
        items.push(Value::Object(item));

        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": raw_id.clone(),
            "outputText": output_text,
        }));
    }

    Ok((items, submitted))
}

fn prepare_responses_conversation_entry(payload: &Value, context: &Value) -> Value {
    let mut base_payload = clone_responses_context_body(payload);

    if let Some(model) = read_trimmed_string(payload.as_object().and_then(|row| row.get("model"))) {
        base_payload.insert("model".to_string(), Value::String(model));
    }
    if let Some(stream) = payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
    {
        base_payload.insert("stream".to_string(), Value::Bool(stream));
    }

    let input = collapse_auto_stop_hook_pairs_in_history(normalize_responses_history_items(
        clone_array(context.as_object().and_then(|row| row.get("input"))),
    ));
    let tools = normalize_responses_tool_definitions(
        payload
            .as_object()
            .and_then(|row| row.get("tools"))
            .or_else(|| context.as_object().and_then(|row| row.get("toolsRaw"))),
    );

    let provider_key_value = read_trimmed_string(
        context
            .as_object()
            .and_then(|row| row.get("providerKey"))
            .or_else(|| payload.as_object().and_then(|row| row.get("providerKey"))),
    )
    .map(Value::String)
    .unwrap_or(Value::Null);

    let mut entry = Map::new();
    entry.insert("basePayload".to_string(), Value::Object(base_payload));
    entry.insert("input".to_string(), Value::Array(input));
    entry.insert("providerKey".to_string(), provider_key_value);
    if !tools.is_empty()
        && !entry
            .get("basePayload")
            .and_then(Value::as_object)
            .is_some_and(|row| row.contains_key("tools"))
    {
        entry.insert("tools".to_string(), Value::Array(tools));
    }

    Value::Object(entry)
}

fn strip_meta_value(value: Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.into_iter().map(strip_meta_value).collect()),
        Value::Object(mut map) => {
            map.remove("metadata");
            map.remove("meta");
            map.remove("__meta");
            map.remove("_meta");
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(v) = map.remove(&key) {
                    map.insert(key, strip_meta_value(v));
                }
            }
            Value::Object(map)
        }
        other => other,
    }
}

fn resume_responses_conversation_payload(
    entry: &Value,
    response_id: &str,
    submit_payload: &Value,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let base_payload = clone_object(entry_obj.get("basePayload"));
    let mut payload = base_payload.clone();
    let direct_input = normalize_responses_history_items(clone_array(entry_obj.get("input")));
    let released_input_prefix =
        normalize_responses_history_items(clone_array(entry_obj.get("releasedInputPrefix")));
    let mut merged_input = if direct_input.is_empty() && !released_input_prefix.is_empty() {
        released_input_prefix
    } else {
        direct_input
    };
    let tool_outputs = clone_array(
        submit_payload
            .as_object()
            .and_then(|row| row.get("tool_outputs")),
    );

    let (normalized_items, submitted_details) =
        normalize_submitted_tool_outputs(&tool_outputs, &merged_input)?;
    merged_input.extend(normalized_items);
    let full_input = remove_auto_stop_hook_assistant_echoes_in_history(
        normalize_responses_history_items(merged_input),
    );
    payload.insert("input".to_string(), Value::Array(full_input.clone()));

    let stream = submit_payload
        .as_object()
        .and_then(|row| row.get("stream"))
        .and_then(Value::as_bool)
        .or_else(|| base_payload.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    payload.insert("stream".to_string(), Value::Bool(stream));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.to_string()),
    );

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

    if let Some(model) =
        read_trimmed_string(submit_payload.as_object().and_then(|row| row.get("model")))
    {
        payload.insert("model".to_string(), Value::String(model));
    }

    if let Some(submit_meta) = submit_payload
        .as_object()
        .and_then(|row| row.get("metadata"))
        .and_then(Value::as_object)
    {
        let mut merged_meta = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in submit_meta {
            merged_meta.insert(key.clone(), value.clone());
        }
        payload.insert("metadata".to_string(), Value::Object(merged_meta));
    }

    payload.remove("tool_outputs");
    payload.remove("response_id");

    Ok(serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "toolOutputs": tool_outputs.len(),
            "toolOutputsDetailed": submitted_details,
            "fullInputItems": full_input.len(),
            "fullInput": full_input,
            "restoredTools": read_entry_tools_value(&entry_obj),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "restored": true,
        }
    }))
}

fn canonicalize_continuation_item(value: &Value) -> Value {
    let Some(row) = value.as_object() else {
        return value.clone();
    };
    let item_type = read_trimmed_string(row.get("type"));
    let role = read_trimmed_string(row.get("role"));
    let content = if row.get("content").is_some() {
        Some(Value::Array(normalize_message_content_for_request_history(
            row.get("content"),
        )))
    } else {
        None
    };

    if role.is_some() && content.is_some() && item_type.as_deref() == Some("message") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    if role.is_some() && content.is_some() && !row.contains_key("type") {
        return serde_json::json!({
            "role": role,
            "content": content
        });
    }

    let mut normalized = row.clone();
    normalized.remove("message");
    Value::Object(normalized)
}

fn values_equal(left: &Value, right: &Value) -> bool {
    canonicalize_continuation_item(left) == canonicalize_continuation_item(right)
}

fn find_exact_prefix_delta(prefix: &[Value], incoming: &[Value]) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.len() <= prefix.len() {
        return None;
    }
    for (index, expected) in prefix.iter().enumerate() {
        let candidate = incoming.get(index)?;
        if !values_equal(expected, candidate) {
            return None;
        }
    }
    Some(incoming[prefix.len()..].to_vec())
}

fn find_prefix_delta_allowing_pending_tool_call_replay(
    prefix: &[Value],
    incoming: &[Value],
) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.is_empty() {
        return None;
    }
    let mut incoming_index = 0usize;
    for (prefix_index, expected) in prefix.iter().enumerate() {
        let candidate = incoming.get(incoming_index)?;
        if !values_equal(expected, candidate) {
            let expected_row = expected.as_object()?;
            let expected_type = expected_row
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if expected_type != "function_call" || prefix_index + 1 != prefix.len() {
                return None;
            }
            let pending_call_id = read_bridge_function_call_id(expected_row)?;
            let candidate_row = candidate.as_object()?;
            let candidate_type = candidate_row
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !is_bridge_tool_output_item_type(candidate_type.as_str()) {
                return None;
            }
            let candidate_call_id = read_bridge_function_call_id(candidate_row)?;
            if candidate_call_id != pending_call_id {
                return None;
            }
            return Some(incoming[incoming_index..].to_vec());
        }
        incoming_index += 1;
    }
    if incoming.len() <= incoming_index {
        return None;
    }
    Some(incoming[incoming_index..].to_vec())
}

fn overlap_slice_contains_bridge_tool_history(items: &[Value]) -> bool {
    items.iter().any(|entry| {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        item_type == "function_call" || is_bridge_tool_output_item_type(item_type.as_str())
    })
}

fn find_suffix_overlap_delta_with_bridge_tool_history(
    prefix: &[Value],
    incoming: &[Value],
) -> Option<Vec<Value>> {
    if prefix.is_empty() || incoming.is_empty() {
        return None;
    }
    let max_overlap = prefix.len().min(incoming.len());
    for overlap_len in (1..=max_overlap).rev() {
        let prefix_slice = &prefix[prefix.len() - overlap_len..];
        if !overlap_slice_contains_bridge_tool_history(prefix_slice) {
            continue;
        }
        if prefix_slice
            .iter()
            .zip(incoming.iter().take(overlap_len))
            .all(|(left, right)| values_equal(left, right))
        {
            return Some(incoming[overlap_len..].to_vec());
        }
    }
    None
}

fn count_common_leading_items(left: &[Value], right: &[Value]) -> usize {
    let mut count = 0usize;
    let max = left.len().min(right.len());
    while count < max {
        if !values_equal(&left[count], &right[count]) {
            break;
        }
        count += 1;
    }
    count
}

fn collect_submitted_tool_output_details(input_items: &[Value]) -> Vec<Value> {
    let mut submitted: Vec<Value> = Vec::new();
    for (index, entry) in input_items.iter().enumerate() {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id"))
            .or_else(|| read_trimmed_string(row.get("id")))
            .unwrap_or_else(|| format!("resume_tool_{}", index + 1));
        let output_text = stringify_responses_tool_output(row.get("output"));
        submitted.push(serde_json::json!({
            "callId": call_id.clone(),
            "originalId": call_id,
            "outputText": output_text,
        }));
    }
    submitted
}

fn read_bridge_function_call_id(row: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")))
}

fn is_bridge_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "function_call_output" | "tool_result" | "tool_message"
    )
}

fn collect_pending_bridge_function_call_ids(input_items: &[Value]) -> Vec<String> {
    let mut pending: Vec<String> = Vec::new();
    for entry in input_items {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type == "function_call" {
            if let Some(call_id) = read_bridge_function_call_id(row) {
                if !pending.iter().any(|existing| existing == &call_id) {
                    pending.push(call_id);
                }
            }
            continue;
        }
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            continue;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            continue;
        };
        if let Some(position) = pending.iter().position(|existing| existing == &call_id) {
            pending.remove(position);
        }
    }
    pending
}

fn collect_completed_bridge_function_call_ids(input_items: &[Value]) -> Vec<String> {
    let mut pending: Vec<String> = Vec::new();
    let mut completed: Vec<String> = Vec::new();
    for item in input_items {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(call_id) = read_bridge_function_call_id(row) else {
            continue;
        };
        if item_type == "function_call" {
            pending.push(call_id);
            continue;
        }
        if is_bridge_tool_output_item_type(item_type.as_str()) {
            if let Some(position) = pending.iter().position(|existing| existing == &call_id) {
                pending.remove(position);
                if !completed.iter().any(|existing| existing == &call_id) {
                    completed.push(call_id);
                }
            }
        }
    }
    completed
}

fn input_replays_completed_bridge_call(
    input_items: &[Value],
    completed_call_ids: &[String],
) -> bool {
    if completed_call_ids.is_empty() {
        return false;
    }
    input_items.iter().any(|item| {
        let Some(row) = item.as_object() else {
            return false;
        };
        let item_type = read_trimmed_string(row.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if item_type != "function_call" && !is_bridge_tool_output_item_type(item_type.as_str()) {
            return false;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            return false;
        };
        completed_call_ids
            .iter()
            .any(|existing| existing == &call_id)
    })
}

fn read_released_pending_tool_call_ids(entry_obj: &Map<String, Value>) -> Vec<String> {
    entry_obj
        .get("releasedPendingToolCallIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

fn read_continuation_owner(entry_obj: &Map<String, Value>) -> Option<&str> {
    match entry_obj.get("continuationOwner").and_then(Value::as_str) {
        Some("direct") => Some("direct"),
        Some("relay") => Some("relay"),
        _ => None,
    }
}

fn leading_input_consumes_pending_tool_calls(
    incoming_items: &[Value],
    pending_call_ids: &[String],
) -> bool {
    if pending_call_ids.is_empty() {
        return true;
    }
    let mut remaining = pending_call_ids.to_vec();
    for entry in incoming_items {
        let Some(row) = entry.as_object() else {
            return false;
        };
        let item_type = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if item_type == "function_call" {
            let Some(call_id) = read_bridge_function_call_id(row) else {
                return false;
            };
            if !remaining.iter().any(|existing| existing == &call_id) {
                return false;
            }
            continue;
        }
        if !is_bridge_tool_output_item_type(item_type.as_str()) {
            break;
        }
        let Some(call_id) = read_bridge_function_call_id(row) else {
            return false;
        };
        let Some(position) = remaining.iter().position(|existing| existing == &call_id) else {
            return false;
        };
        remaining.remove(position);
        if remaining.is_empty() {
            return true;
        }
    }
    remaining.is_empty()
}

fn find_delta_from_released_pending_tool_outputs(
    incoming_items: &[Value],
    pending_call_ids: &[String],
) -> Option<Vec<Value>> {
    if pending_call_ids.is_empty() {
        return Some(incoming_items.to_vec());
    }
    for start_index in 0..incoming_items.len() {
        if leading_input_consumes_pending_tool_calls(
            &incoming_items[start_index..],
            pending_call_ids,
        ) {
            return Some(incoming_items[start_index..].to_vec());
        }
    }
    None
}

fn raw_suffix_for_normalized_delta(
    raw_items: &[Value],
    normalized_items: &[Value],
    normalized_delta: &[Value],
) -> Vec<Value> {
    let start = normalized_items
        .len()
        .saturating_sub(normalized_delta.len());
    raw_items.get(start..).unwrap_or(&[]).to_vec()
}

fn restore_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let incoming_input = clone_optional_array(incoming_obj.get("input"));
    let continuation_owner = read_continuation_owner(&entry_obj);
    let released_prefix_raw = clone_array(entry_obj.get("releasedInputPrefix"));
    let released_prefix = normalize_responses_history_items(released_prefix_raw.clone());

    let Some(response_id) = last_response_id else {
        return Value::Null;
    };
    let Some(input_items_raw) = incoming_input else {
        return Value::Null;
    };
    let input_items = normalize_responses_history_items(input_items_raw.clone());
    let submitted_details = collect_submitted_tool_output_details(&input_items_raw);
    let prefix_raw = clone_array(entry_obj.get("input"));
    let prefix = normalize_responses_history_items(prefix_raw.clone());
    let incoming_previous_response_id =
        read_trimmed_string(incoming_obj.get("previous_response_id"));
    let delta_input = if prefix.is_empty() {
        let released_pending_call_ids = read_released_pending_tool_call_ids(&entry_obj);
        if !released_pending_call_ids.is_empty() {
            let Some(delta_input) = find_delta_from_released_pending_tool_outputs(
                &input_items,
                &released_pending_call_ids,
            ) else {
                return Value::Null;
            };
            raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &delta_input)
        } else {
            input_items_raw.clone()
        }
    } else if continuation_owner == Some("direct") && !released_prefix.is_empty() {
        input_items_raw.clone()
    } else {
        let Some(delta_input) = find_exact_prefix_delta(&prefix, &input_items)
            .or_else(|| find_prefix_delta_allowing_pending_tool_call_replay(&prefix, &input_items))
            .or_else(|| {
                if continuation_owner != Some("direct")
                    && incoming_previous_response_id.as_deref() == Some(response_id.as_str())
                {
                    Some(input_items.clone())
                } else {
                    None
                }
            })
        else {
            return Value::Null;
        };
        raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &delta_input)
    };

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input"
            || key == "previous_response_id"
            || key == "response_id"
            || key == "tool_outputs"
        {
            continue;
        }
        payload.insert(key, value);
    }

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));
    if continuation_owner != Some("direct") && !payload.contains_key("tools") {
        let tools = normalize_responses_tool_definitions(entry_obj.get("tools"));
        if !tools.is_empty() {
            payload.insert("tools".to_string(), Value::Array(tools));
        }
    }

    payload.insert("input".to_string(), Value::Array(delta_input.clone()));
    payload.insert(
        "previous_response_id".to_string(),
        Value::String(response_id.clone()),
    );

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": response_id,
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "deltaInputItems": delta_input.len(),
            "fullInput": input_items_raw.clone(),
            "restoredTools": read_entry_tools_value(&entry_obj),
            "toolOutputsDetailed": submitted_details,
            "restored": true,
        }
    })
}

fn materialize_responses_continuation_payload(
    entry: &Value,
    incoming_payload: &Value,
    request_id: Option<&str>,
    scope_key: Option<&str>,
) -> Value {
    let entry_obj = entry.as_object().cloned().unwrap_or_default();
    let incoming_obj = incoming_payload.as_object().cloned().unwrap_or_default();
    let incoming_input = clone_optional_array(incoming_obj.get("input"));
    let Some(input_items_raw) = incoming_input else {
        return Value::Null;
    };
    let input_items = normalize_responses_history_items(input_items_raw.clone());
    if input_items_raw.is_empty() {
        return Value::Null;
    }

    let prefix_source = if clone_array(entry_obj.get("input")).is_empty() {
        clone_array(entry_obj.get("releasedInputPrefix"))
    } else {
        clone_array(entry_obj.get("input"))
    };
    let prefix_raw = prefix_source;
    let prefix = normalize_responses_history_items(prefix_raw.clone());
    if prefix.is_empty() {
        return Value::Null;
    }
    let pending_call_ids = collect_pending_bridge_function_call_ids(&prefix);

    if find_exact_prefix_delta(&prefix, &input_items).is_some() || input_items == prefix {
        return Value::Null;
    }

    if let Some(suffix_delta) =
        find_suffix_overlap_delta_with_bridge_tool_history(&prefix, &input_items)
    {
        if suffix_delta.is_empty() {
            return Value::Null;
        }

        let suffix_delta =
            raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &suffix_delta);
        if suffix_delta.is_empty() {
            return Value::Null;
        }

        let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
        let submitted_details = collect_submitted_tool_output_details(&suffix_delta);
        let mut full_input = prefix_raw.clone();
        full_input.extend(suffix_delta.clone());

        let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
            .as_object()
            .cloned()
            .unwrap_or_default();

        for (key, value) in incoming_obj {
            if key == "input" || key == "response_id" || key == "tool_outputs" {
                continue;
            }
            if key == "previous_response_id" {
                continue;
            }
            payload.insert(key, value);
        }

        let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

        payload.insert("input".to_string(), Value::Array(full_input.clone()));
        payload.remove("previous_response_id");

        return serde_json::json!({
            "payload": Value::Object(payload),
            "meta": {
                "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
                "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
                "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
                "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
                "materialized": true,
                "materializedMode": "local_full_input",
                "incomingInputItems": input_items.len(),
                "continuationDeltaItems": suffix_delta.len(),
                "fullInputItems": full_input.len(),
                "fullInput": full_input,
                "restoredTools": read_entry_tools_value(&entry_obj),
                "toolOutputsDetailed": submitted_details,
            }
        });
    }

    let common_prefix_len = count_common_leading_items(&prefix, &input_items);
    if common_prefix_len > 0 {
        return Value::Null;
    }
    let completed_call_ids = collect_completed_bridge_function_call_ids(&prefix);
    if input_replays_completed_bridge_call(&input_items, &completed_call_ids) {
        return Value::Null;
    }
    if !pending_call_ids.is_empty()
        && !leading_input_consumes_pending_tool_calls(&input_items, &pending_call_ids)
    {
        return Value::Null;
    }

    let continuation_delta = if !pending_call_ids.is_empty() {
        find_prefix_delta_allowing_pending_tool_call_replay(&prefix, &input_items)
            .unwrap_or_else(|| input_items.clone())
    } else {
        input_items.clone()
    };
    let continuation_delta =
        raw_suffix_for_normalized_delta(&input_items_raw, &input_items, &continuation_delta);

    let last_response_id = read_trimmed_string(entry_obj.get("lastResponseId"));
    let submitted_details = collect_submitted_tool_output_details(&continuation_delta);
    let mut full_input = prefix_raw.clone();
    full_input.extend(continuation_delta.clone());

    let mut payload = pick_responses_persisted_fields(&Value::Object(incoming_obj.clone()))
        .as_object()
        .cloned()
        .unwrap_or_default();

    for (key, value) in incoming_obj {
        if key == "input" || key == "response_id" || key == "tool_outputs" {
            continue;
        }
        if key == "previous_response_id" {
            continue;
        }
        payload.insert(key, value);
    }

    let provider_key = read_trimmed_string(entry_obj.get("providerKey"));

    payload.insert("input".to_string(), Value::Array(full_input.clone()));
    payload.remove("previous_response_id");

    serde_json::json!({
        "payload": Value::Object(payload),
        "meta": {
            "restoredFromResponseId": last_response_id.map(Value::String).unwrap_or(Value::Null),
            "previousRequestId": entry_obj.get("requestId").cloned().unwrap_or(Value::Null),
            "providerKey": provider_key.map(Value::String).unwrap_or(Value::Null),
            "requestId": request_id.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "scopeKey": scope_key.map(|value| Value::String(value.to_string())).unwrap_or(Value::Null),
            "materialized": true,
            "materializedMode": "local_full_input",
            "incomingInputItems": input_items.len(),
            "continuationDeltaItems": continuation_delta.len(),
            "fullInputItems": full_input.len(),
            "fullInput": full_input,
            "restoredTools": read_entry_tools_value(&entry_obj),
            "toolOutputsDetailed": submitted_details,
        }
    })
}

#[napi_derive::napi]
pub fn pick_responses_persisted_fields_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = pick_responses_persisted_fields(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn convert_responses_output_to_input_items_json(response_json: String) -> NapiResult<String> {
    let response: Value = serde_json::from_str(&response_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = convert_responses_output_to_input_items(&response);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn prepare_responses_conversation_entry_json(
    payload_json: String,
    context_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let context: Value =
        serde_json::from_str(&context_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = prepare_responses_conversation_entry(&payload, &context);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn resume_responses_conversation_payload_json(
    entry_json: String,
    response_id: String,
    submit_payload_json: String,
    request_id: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let submit_payload: Value = serde_json::from_str(&submit_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resume_responses_conversation_payload(
        &entry,
        &response_id,
        &submit_payload,
        request_id.as_deref(),
    )
    .unwrap_or_else(|reason| {
        serde_json::json!({
            "error": {
                "type": "orphan_tool_result",
                "message": reason,
                "status": 400,
                "code": "hub_pipeline_context_capture_failed",
                "origin": "client"
            }
        })
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn restore_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = restore_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn materialize_responses_continuation_payload_json(
    entry_json: String,
    incoming_payload_json: String,
    request_id: Option<String>,
    scope_key: Option<String>,
) -> NapiResult<String> {
    let entry: Value =
        serde_json::from_str(&entry_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let incoming_payload: Value = serde_json::from_str(&incoming_payload_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = materialize_responses_continuation_payload(
        &entry,
        &incoming_payload,
        request_id.as_deref(),
        scope_key.as_deref(),
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn plan_responses_handler_entry_json(
    payload_json: String,
    entry_endpoint: Option<String>,
    response_id_from_path: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = plan_responses_handler_entry(
        &payload,
        entry_endpoint.as_deref(),
        response_id_from_path.as_deref(),
    )
    .map_err(napi::Error::from_reason)?;
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        build_stop_hook_guidance_text_from_output, convert_responses_output_to_input_items,
        materialize_responses_continuation_payload, plan_responses_handler_entry,
        prepare_responses_conversation_entry, restore_responses_continuation_payload,
        resume_responses_conversation_payload,
    };
    use serde_json::{json, Value};

    #[test]
    fn handler_entry_plan_materializes_leading_tool_output_without_ts_tool_scan() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "input": [
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("scope_materialize"));
        assert_eq!(planned["payload"]["input"][0]["call_id"], json!("call_1"));
    }

    #[test]
    fn handler_entry_plan_normalizes_previous_response_function_call_output_submit() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_prev_1",
                "input": [
                    { "type": "message", "role": "user", "content": "ignored" },
                    { "type": "function_call_output", "call_id": "call_1", "output": { "ok": true } }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("submit_tool_outputs"));
        assert_eq!(planned["responseId"], json!("resp_prev_1"));
        assert_eq!(planned["payload"]["response_id"], json!("resp_prev_1"));
        assert_eq!(
            planned["payload"]["tool_outputs"][0]["tool_call_id"],
            json!("call_1")
        );
    }

    #[test]
    fn handler_entry_plan_routes_submit_tool_outputs_to_native_submit_shape() {
        let planned = plan_responses_handler_entry(
            &json!({
                "model": "gpt-5.5",
                "response_id": "resp_submit_1",
                "tool_outputs": [
                    { "call_id": "call_submit_1", "output": "ok" }
                ]
            }),
            Some("/v1/responses"),
            None,
        )
        .unwrap();

        assert_eq!(planned["mode"], json!("submit_tool_outputs"));
        assert_eq!(planned["responseId"], json!("resp_submit_1"));
        assert_eq!(planned["payload"]["response_id"], json!("resp_submit_1"));
        assert_eq!(
            planned["payload"]["tool_outputs"][0]["call_id"],
            json!("call_submit_1")
        );
        assert!(planned["payload"].get("input").is_none());
    }

    #[test]
    fn shared_responses_conversation_prepare_and_resume_json() {
        let payload = json!({
            "model": "gpt-base",
            "stream": true,
            "metadata": { "origin": "base" },
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
            "top_p": 0.5
        });
        let context = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "type": "function_call", "id": "fc_item_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);
        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{ "call_id": "call_1", "output": { "cmd": "pwd" } }],
                "metadata": { "resume": true },
                "stream": false
            }),
            Some("req_2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("model").and_then(Value::as_str),
            Some("gpt-base")
        );
        assert_eq!(payload.get("stream").and_then(Value::as_bool), Some(false));
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_1")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let output_item = input.last().and_then(Value::as_object).unwrap();
        assert_eq!(
            output_item.get("id").and_then(Value::as_str),
            Some("fc_item_1")
        );
        assert_eq!(
            output_item.get("output").and_then(Value::as_str),
            Some("{\"cmd\":\"pwd\"}")
        );
        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta.get("toolOutputs").and_then(Value::as_u64), Some(1));
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(3));
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 3);
        assert_eq!(full_input[1]["type"], json!("function_call"));
        assert_eq!(full_input[2]["type"], json!("function_call_output"));
    }

    #[test]
    fn resume_uses_released_input_prefix_when_live_entry_input_is_already_released() {
        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_resume_released_1",
                "basePayload": {
                    "model": "gpt-5.5",
                    "store": true
                },
                "input": [],
                "releasedInputPrefix": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "continue working" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_resume_released_1",
                        "call_id": "call_resume_released_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ],
                "tools": Value::Null
            }),
            "resp_resume_released_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_resume_released_1",
                    "output": "{\"ok\":true,\"kind\":\"stop_message_auto\"}"
                }],
                "stream": true
            }),
            Some("req_resume_released_2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(input[2]["type"], json!("function_call_output"));

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta.get("fullInputItems").and_then(Value::as_u64), Some(3));
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 3);
        assert_eq!(full_input[1]["call_id"], json!("call_resume_released_1"));
        assert_eq!(full_input[2]["call_id"], json!("call_resume_released_1"));
    }

    #[test]
    fn prepare_collapses_auto_projected_stopless_pairs_into_guidance_only() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.5",
                "store": true
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "这是第三轮 stopless 恢复测试" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":1,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续往下做；先把手头能确认的结果拿回来。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":2,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。\",\"repeatCount\":3,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    }
                ]
            }),
        );

        let input = entry.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("message"));
        let serialized = serde_json::to_string(input).unwrap();
        assert!(!serialized.contains("reasoningStop"));
        assert!(!serialized.contains("stop_message_auto"));
        let guidance = input[1]["content"][0]["text"].as_str().expect("guidance");
        assert!(guidance.contains("上一轮执行结果：repeatCount=3/3。"));
        assert!(guidance.contains("继续往下做"));
        assert!(guidance.contains("stopreason"));
    }

    #[test]
    fn resume_does_not_replay_auto_projected_stopless_pairs_from_canonical_history() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.5",
                "store": true
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "这是第三轮 stopless 恢复测试" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":1,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_third_round_1",
                        "call_id": "call_third_round_1",
                        "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续往下做；先把手头能确认的结果拿回来。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_third_round_2",
                        "call_id": "call_third_round_2",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"routecodex hook run reasoningStop --input-json \\\"{\\\\\\\"flowId\\\\\\\":\\\\\\\"stop_message_flow\\\\\\\",\\\\\\\"repeatCount\\\\\\\":2,\\\\\\\"maxRepeats\\\\\\\":3}\\\"\"}"
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "继续执行中" }]
                    }
                ]
            }),
        );

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req-stopless-1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp-third-round-2",
            &json!({
                "tool_outputs": [{
                    "tool_call_id": "call_third_round_2",
                    "output": "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。\",\"repeatCount\":3,\"maxRepeats\":3,\"schemaGuidance\":{\"requiredFields\":[\"stopreason\",\"reason\",\"next_step\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
                }],
                "stream": false
            }),
            Some("req-stopless-2"),
        )
        .unwrap();

        let payload = resumed.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("message"));
        let serialized = serde_json::to_string(input).unwrap();
        assert!(!serialized.contains("call_third_round_1"));
        assert!(serialized.contains("call_third_round_2"));
        assert!(!serialized.contains("继续执行中"));
        let guidance = input
            .iter()
            .filter_map(|item| {
                item.get("content")?
                    .as_array()?
                    .first()?
                    .get("text")?
                    .as_str()
            })
            .find(|text| text.contains("上一轮执行结果"))
            .expect("guidance");
        assert!(guidance.contains("上一轮执行结果：repeatCount=2/3。"));
        assert!(guidance.contains("继续往下做"));
        assert!(guidance.contains("stopreason"));
        let current_call = input
            .iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call")
                    && item.get("call_id").and_then(Value::as_str) == Some("call_third_round_2")
            })
            .expect("current stopless shell call remains for request governance");
        assert_eq!(current_call["name"], json!("exec_command"));
        let current_output = input
            .iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some("call_third_round_2")
            })
            .expect("current stopless output remains for request governance");
        assert!(
            current_output
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("stop_message_auto"),
            "current raw CLI output must reach request governance sanitizer"
        );

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input.len(), 4);
        assert_eq!(full_input[0]["type"], json!("message"));
        assert_eq!(full_input[1]["type"], json!("message"));
        let full_input_serialized = serde_json::to_string(full_input).unwrap();
        assert!(!full_input_serialized.contains("call_third_round_1"));
        assert!(full_input_serialized.contains("call_third_round_2"));
        assert!(!full_input_serialized.contains("继续执行中"));
    }

    #[test]
    fn stopless_resume_guidance_for_first_missing_schema_round_stays_short() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"continuationPrompt\":\"继续推进当前任务。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\"],\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
        );
        assert!(text.contains(
            "上一轮执行结果：repeatCount=1；reasonCode=stop_schema_missing；missingFields=stopreason。"
        ));
        assert!(text.contains("继续推进当前任务。"));
        assert!(text.contains("如果任务已经完成，就按下面 schema 补齐缺失字段：stopreason"));
        assert!(text.contains("如果任务还没完成，不要停，继续执行当前任务"));
        assert!(text.contains("按字段之间的逻辑关系填写，不是每个字段都必填"));
        assert!(!text.contains("每个字段都要写具体内容"));
    }

    #[test]
    fn stopless_resume_guidance_for_first_invalid_schema_round_renders_feedback() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"continuationPrompt\":\"继续推进当前任务。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_next_step_missing\",\"missingFields\":[\"next_step\"]}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1；reasonCode=stop_schema_next_step_missing；missingFields=next_step。"));
        assert!(text.contains("任务还没完成，但当前没有明确 next_step"));
        assert!(text.contains("本轮缺失字段：next_step"));
    }

    #[test]
    fn stopless_resume_guidance_accepts_continue_next_step_with_empty_missing_fields() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续往下做。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_continue_next_step\",\"missingFields\":[]},\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"triggerHint\":\"non_terminal_schema\"}}"
        );
        assert!(text.contains("reasonCode=stop_schema_continue_next_step"));
        assert!(text.contains("任务还没收尾，继续执行你给出的 next_step"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "continue_next_step with empty missing fields is legal: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_accepts_minimal_no_schema_cli_output_without_malformed_warning() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"continuationPrompt\":\"继续做下一步；先把手头能确认的结果拿回来。\",\"input\":{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3,\"triggerHint\":\"no_schema\"}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续做下一步；先把手头能确认的结果拿回来。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal no_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_accepts_minimal_non_terminal_schema_cli_output() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"kind\":\"stop_message_auto\",\"tool\":\"stop_message_auto\",\"summary\":\"停止检查需要继续\",\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"routeHint\":\"thinking\",\"continuationPrompt\":\"继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。\",\"repeatCount\":1,\"maxRepeats\":3,\"sessionId\":\"stopless-live-1782780421308\",\"requestId\":\"openai-responses-XLC.key1-glm-5.2-20260630T084701341-424854-5137\",\"input\":{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1,\"triggerHint\":\"non_terminal_schema\"}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=1/3。"));
        assert!(text.contains("继续往下做；要是能收尾就直接告诉我做完了，不然就继续推进。"));
        assert!(
            !text.contains("STOPLESS_CLI_RESULT_MALFORMED"),
            "minimal non_terminal_schema CLI output is legal and must not be treated as malformed: {text}"
        );
    }

    #[test]
    fn stopless_resume_guidance_for_second_missing_schema_round_must_expand_branching() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"continuationPrompt\":\"继续推进当前任务。\",\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"schemaGuidance\":{\"requiredFields\":[\"stopreason\"],\"sample\":\"{\\\"stopreason\\\":2,\\\"reason\\\":\\\"继续执行\\\",\\\"has_evidence\\\":0,\\\"evidence\\\":\\\"\\\",\\\"next_step\\\":\\\"运行下一条验证\\\",\\\"needs_user_input\\\":false}\",\"stopreasonValues\":{\"finished\":0,\"blocked\":1,\"continueNeeded\":2}}}"
        );
        assert!(text.contains("上一轮执行结果：repeatCount=2；reasonCode=stop_schema_missing；missingFields=stopreason。"));
        assert!(text.contains("如果任务已经完成，就按下面 schema 补齐缺失字段：stopreason"));
        assert!(text.contains("如果任务还没完成，不要停，继续执行当前任务"));
        assert!(text.contains("按字段之间的逻辑关系填写，不是每个字段都必填"));
        assert!(text.contains("stopreason=0 表示完成，必须 has_evidence=1 且 evidence 非空"));
        assert!(text.contains("stopreason=1 表示阻塞，必须 reason 非空，提供 reason 即可停止"));
        assert!(text.contains("stopreason=2 必须写 next_step"));
        assert!(text.contains("needs_user_input=true 时 next_step 必须直接写要问用户的问题"));
        assert!(text.contains("最小可复制样本："));
        assert!(!text.contains("每个字段都要写具体内容"));
    }

    #[test]
    fn stopless_resume_guidance_rejects_unknown_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_unknown_future_reason\",\"missingFields\":[\"next_step\"]}}"
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("没有注册的修复引导"));
        assert!(!text.contains("triggerHint"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("本轮缺失字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn stopless_resume_guidance_rejects_incomplete_feedback_without_default_guidance() {
        let text = build_stop_hook_guidance_text_from_output(
            "{\"ok\":true,\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"repeatCount\":2,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_next_step_missing\",\"missingFields\":[]}}"
        );
        assert!(text.contains("STOPLESS_CLI_RESULT_MALFORMED"));
        assert!(text.contains("schemaFeedback.reasonCode/missingFields 不完整"));
        assert!(!text.contains("no_schema"));
        assert!(!text.contains("本轮缺失字段：stopreason, reason, has_evidence"));
    }

    #[test]
    fn prepare_persists_responses_legal_tools_and_history_items() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-base",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "description": "run command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }]
            }),
            &json!({
                "input": [
                    {
                        "type": "function_call",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "status": "in_progress",
                        "function": { "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                        "content": [{ "type": "output_text", "text": "illegal" }],
                        "role": "assistant"
                    },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "status": "completed",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "illegal" }]
                    }
                ]
            }),
        );

        assert_eq!(entry["basePayload"]["tools"][0]["type"], json!("function"));
        assert_eq!(
            entry["basePayload"]["tools"][0]["function"]["name"],
            json!("exec_command")
        );
        assert!(entry.get("tools").is_none());
        assert_eq!(entry["input"][0]["type"], json!("function_call"));
        assert_eq!(entry["input"][0]["name"], json!("exec_command"));
        assert!(entry["input"][0].get("function").is_none());
        assert!(entry["input"][0].get("content").is_none());
        assert!(entry["input"][0].get("role").is_none());
        assert!(entry["input"][0].get("status").is_none());
        assert_eq!(entry["input"][1]["type"], json!("function_call_output"));
        assert_eq!(entry["input"][1]["output"], json!("ok"));
        assert!(entry["input"][1].get("content").is_none());
        assert!(entry["input"][1].get("status").is_none());
    }

    #[test]
    fn converts_required_action_tool_calls_to_pending_function_call_items() {
        let response = json!({
            "id": "resp_required_action_1",
            "object": "response",
            "status": "requires_action",
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": {
                    "tool_calls": [{
                        "id": "call_required_action_1",
                        "type": "function",
                        "function": {
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"pwd\"}"
                        }
                    }]
                }
            }
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], json!("function_call"));
        assert_eq!(items[0]["call_id"], json!("call_required_action_1"));
        assert_eq!(items[0]["name"], json!("exec_command"));
        assert_eq!(items[0]["arguments"], json!("{\"cmd\":\"pwd\"}"));
    }

    #[test]
    fn does_not_create_pending_function_call_when_required_action_has_no_tool_calls() {
        let response = json!({
            "id": "resp_empty_required_action_1",
            "object": "response",
            "status": "requires_action",
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": { "tool_calls": [] }
            }
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(items.is_empty());
    }

    #[test]
    fn restore_never_emits_function_call_output_content_from_persisted_history() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "historical leak" }]
                    }
                ]
            }),
            &json!({
                "model": "gpt-5.5",
                "stream": true,
                "input": [
                    { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    {
                        "type": "function_call_output",
                        "id": "fc_1",
                        "call_id": "call_1",
                        "output": "ok",
                        "content": [{ "type": "output_text", "text": "historical leak" }]
                    },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], json!("message"));
        let serialized = serde_json::to_string(payload).unwrap();
        assert!(!serialized.contains("historical leak"));
    }

    #[test]
    fn convert_responses_output_to_input_items_rewrites_output_text_message_content_to_input_text()
    {
        let response = json!({
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        { "type": "output_text", "text": "world" },
                        { "type": "commentary", "text": "progress" }
                    ]
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], json!("message"));
        assert_eq!(items[0]["role"], json!("assistant"));
        assert_eq!(items[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(items[0]["content"][0]["text"], json!("world"));
        assert_eq!(items[0]["content"][1]["type"], json!("input_text"));
        assert_eq!(items[0]["content"][1]["text"], json!("progress"));
        let serialized = serde_json::to_string(&items).unwrap();
        assert!(!serialized.contains("\"output_text\""));
        assert!(!serialized.contains("\"commentary\""));
    }

    #[test]
    fn restore_matches_prefix_when_stored_input_text_and_incoming_replays_output_text() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "input_text", "text": "world" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.4",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "world" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn resume_preserves_historical_attachments_until_provider_send_completes() {
        let payload = json!({
            "model": "gpt-base",
            "stream": true,
            "tools": [{ "type": "function", "function": { "name": "view_image" } }]
        });
        let context = json!({
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        { "type": "input_image", "image_url": "data:image/png;base64,HISTORY" },
                        { "type": "input_text", "text": "look" }
                    ]
                },
                { "type": "function_call", "id": "fc_view_1", "call_id": "call_view_1", "name": "view_image", "arguments": "{\"path\":\"/tmp/current.png\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_view_1",
                    "output": "[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,CURRENT\"}]"
                }],
                "stream": true
            }),
            Some("req_2"),
        )
        .unwrap();

        let serialized = serde_json::to_string(resumed.get("payload").unwrap()).unwrap();
        assert!(serialized.contains("data:image/png;base64,HISTORY"));
        assert!(!serialized.contains("[Image omitted]"));
        assert!(serialized.contains("data:image/png;base64,CURRENT"));
    }

    #[test]
    fn resume_reads_restored_tools_from_full_base_payload_when_entry_tools_are_absent() {
        let entry = prepare_responses_conversation_entry(
            &json!({
                "model": "gpt-5.4",
                "store": false,
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "parameters": { "type": "object", "properties": {} }
                    }
                }]
            }),
            &json!({
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "继续执行" }]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_restore_tools_1",
                        "call_id": "call_restore_tools_1",
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"pwd\"}"
                    }
                ]
            }),
        );

        assert!(entry.get("tools").is_none());
        assert_eq!(
            entry["basePayload"]["tools"][0]["function"]["name"],
            json!("exec_command")
        );

        let resumed = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_restore_tools_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null)
            }),
            "resp_restore_tools_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_restore_tools_1",
                    "output": "{\"ok\":true}"
                }]
            }),
            Some("req_restore_tools_2"),
        )
        .unwrap();

        let meta = resumed.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(meta["restoredTools"][0]["type"], json!("function"));
        assert_eq!(
            meta["restoredTools"][0]["function"]["name"],
            json!("exec_command")
        );
    }

    #[test]
    fn resume_rejects_unknown_tool_output_id_before_provider_send() {
        let payload = json!({
            "model": "gpt-base",
            "tools": [{ "type": "function", "function": { "name": "exec_command" } }]
        });
        let context = json!({
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                { "type": "function_call", "id": "fc_expected", "call_id": "call_expected", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
            ]
        });
        let entry = prepare_responses_conversation_entry(&payload, &context);

        let error = resume_responses_conversation_payload(
            &json!({
                "requestId": "req_1",
                "basePayload": entry.get("basePayload").cloned().unwrap_or(Value::Null),
                "input": entry.get("input").cloned().unwrap_or(Value::Null),
                "tools": Value::Null
            }),
            "resp_1",
            &json!({
                "tool_outputs": [{
                    "call_id": "call_function_snr978zyv21w_1",
                    "output": "/Users/fanzhang/Documents/github/routecodex"
                }]
            }),
            Some("req_2"),
        )
        .expect_err("unknown tool output id must fail fast");

        assert!(error.contains("call_function_snr978zyv21w_1"));
        assert!(error.contains("does not match any pending function_call"));
    }

    #[test]
    fn restores_plain_responses_continuation_when_incoming_input_replays_exact_prefix() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "tools": [{ "type": "function", "function": { "name": "exec_command" } }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "metadata": { "session_id": "sess-1" },
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("next"));
        let meta = restored.get("meta").and_then(Value::as_object).unwrap();
        assert_eq!(
            meta.get("scopeKey").and_then(Value::as_str),
            Some("session:sess-1")
        );
    }

    #[test]
    fn restore_preserves_current_delta_without_history_normalization() {
        let current_delta = json!({
            "type": "function_call",
            "id": "fc_current",
            "call_id": "call_current",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"date\"}",
            "x_current_request_truth": "must-stay"
        });
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "input_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    current_delta.clone()
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input, &vec![current_delta.clone()]);

        let meta = restored.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input[2], current_delta);
    }

    #[test]
    fn direct_owned_scope_restore_does_not_reinject_tools() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev_direct",
                "lastResponseId": "resp_prev_direct",
                "continuationOwner": "direct",
                "providerKey": "asxs.crsa.gpt-5.4",
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "apply_patch",
                        "parameters": { "type": "object" }
                    }
                }],
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "first turn" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.4",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "first turn" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "done" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "second turn" }] }
                ]
            }),
            Some("req_now_direct"),
            Some("session:sess-direct"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        assert_eq!(
            payload.get("previous_response_id").and_then(Value::as_str),
            Some("resp_prev_direct")
        );
        assert!(payload.get("tools").is_none());
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["content"][0]["text"].as_str(), Some("second turn"));
    }

    #[test]
    fn does_not_restore_plain_continuation_when_prefix_does_not_match() {
        let restored = restore_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }
                ]
            }),
            &json!({
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "different" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(restored.is_null());
    }

    #[test]
    fn materialize_plain_continuation_only_when_incoming_is_pure_delta() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[2]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn materialize_plain_continuation_keeps_persisted_prefix_semantics_and_applies_current_delta_fields_only(
    ) {
        let entry = json!({
            "requestId": "req_prev",
            "lastResponseId": "resp_prev",
            "input": [
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] }
            ],
            "basePayload": { "model": "cached-model" }
        });
        let first_prefix_before = entry["input"][0].clone();
        let materialized = materialize_responses_continuation_payload(
            &entry,
            &json!({
                "model": "current-route-model",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            payload.get("model").and_then(Value::as_str),
            Some("current-route-model")
        );
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[0], first_prefix_before);
        assert_eq!(input[2]["content"][0]["text"].as_str(), Some("next"));
        assert_eq!(entry["basePayload"]["model"].as_str(), Some("cached-model"));
        assert_eq!(entry["input"][0], first_prefix_before);
    }

    #[test]
    fn materialize_preserves_saved_prefix_and_current_delta_without_history_normalization() {
        let saved_prefix = json!({
            "type": "function_call_output",
            "id": "fc_done",
            "call_id": "call_done",
            "output": "/tmp",
            "x_saved_store_truth": "must-stay"
        });
        let current_delta = json!({
            "type": "function_call",
            "id": "fc_current",
            "call_id": "call_current",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"date\"}",
            "x_current_request_truth": "must-stay"
        });
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_done", "call_id": "call_done", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    saved_prefix.clone()
                ]
            }),
            &json!({
                "model": "current-route-model",
                "stream": true,
                "input": [current_delta.clone()]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input[1], saved_prefix);
        assert_eq!(input[2], current_delta);

        let meta = materialized.get("meta").and_then(Value::as_object).unwrap();
        let full_input = meta.get("fullInput").and_then(Value::as_array).unwrap();
        assert_eq!(full_input[1], saved_prefix);
        assert_eq!(full_input[2], current_delta);
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_prefix_has_pending_tool_call_without_leading_output(
    ) {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn materializes_plain_continuation_when_leading_tool_output_consumes_pending_tool_call() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "run pwd" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "继续" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = materialized
            .get("payload")
            .and_then(Value::as_object)
            .unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[1]["type"].as_str(), Some("function_call"));
        assert_eq!(input[2]["type"].as_str(), Some("function_call_output"));
        assert_eq!(input[3]["content"][0]["text"].as_str(), Some("继续"));
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_incoming_partially_replays_prefix() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "tool result summary" }] }
                ]
            }),
            &json!({
                "model": "gpt-5.3-codex",
                "stream": true,
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] },
                    { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "hello" }] },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn does_not_materialize_plain_continuation_when_incoming_replays_completed_call_after_offset() {
        let materialized = materialize_responses_continuation_payload(
            &json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" }
                ],
                "basePayload": { "model": "gpt-test" }
            }),
            &json!({
                "model": "gpt-test",
                "input": [
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "old prompt" }] },
                    { "type": "function_call", "id": "fc_call_1", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}" },
                    { "type": "function_call_output", "call_id": "call_1", "output": "/tmp" },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next prompt" }] }
                ]
            }),
            Some("req_next"),
            Some("session:s1"),
        );

        assert!(materialized.is_null());
    }

    #[test]
    fn drops_invalid_shell_like_function_calls_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"cmd<arg_value>cd /repo && git status</arg_value><arg_key>command\":\"cd /repo && git status\"}"
                },
                {
                    "type": "function_call",
                    "id": "fc_good",
                    "call_id": "call_good",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_good");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["cmd"], "pwd");
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn preserves_command_only_exec_command_when_converting_output_items() {
        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_bad",
                    "call_id": "call_bad",
                    "name": "exec_command",
                    "arguments": "{\"command\":\"pwd\",\"cwd\":\"/tmp\"}"
                }
            ]
        });

        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["call_id"], "call_bad");
        let args_text = items[0]["arguments"].as_str().unwrap_or("{}");
        let args: Value = serde_json::from_str(args_text).expect("args object");
        assert_eq!(args["command"], "pwd");
        assert!(args.get("cmd").is_none());
        assert_eq!(args["workdir"], "/tmp");
    }

    #[test]
    fn preserves_reasoning_output_item_in_persisted_history() {
        let response = serde_json::json!({
            "output": [{
                "type": "reasoning",
                "id": "reasoning-1",
                "status": "completed",
                "summary": [{"type": "summary_text", "text": "thinking step 1"}],
                "content": [{"type": "reasoning_text", "text": "detailed reasoning here"}],
                "encrypted_content": "opaque-sig-abc"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-1");
        assert!(items[0].get("status").is_none());
        assert_eq!(items[0]["summary"][0]["type"], "summary_text");
        assert_eq!(items[0]["summary"][0]["text"], "thinking step 1");
        assert!(items[0].get("content").is_none());
        assert_eq!(items[0]["encrypted_content"], "opaque-sig-abc");
    }

    #[test]
    fn preserves_reasoning_output_item_before_function_call_when_persisting_history() {
        let response = serde_json::json!({
            "output": [
                {
                    "type": "reasoning",
                    "id": "reasoning-1",
                    "status": "completed",
                    "content": [{"type": "reasoning_text", "text": "Need to inspect cwd before editing."}]
                },
                {
                    "type": "function_call",
                    "id": "fc_call_1",
                    "call_id": "call_1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                }
            ]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-1");
        assert!(items[0].get("status").is_none());
        assert!(items[0].get("content").is_none());
        assert_eq!(items[1]["type"], "function_call");
    }

    #[test]
    fn restore_never_replays_reasoning_content_from_persisted_history() {
        let restored = restore_responses_continuation_payload(
            &serde_json::json!({
                "requestId": "req_prev",
                "lastResponseId": "resp_prev",
                "input": [
                    {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "summary": [{ "type": "summary_text", "text": "thinking step 1" }],
                        "content": [{ "type": "reasoning_text", "text": "historical reasoning leak" }],
                        "encrypted_content": "opaque-sig-abc"
                    }
                ]
            }),
            &serde_json::json!({
                "model": "gpt-5.4",
                "stream": true,
                "input": [
                    {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "summary": [{ "type": "summary_text", "text": "thinking step 1" }],
                        "content": [{ "type": "reasoning_text", "text": "historical reasoning leak" }],
                        "encrypted_content": "opaque-sig-abc"
                    },
                    { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "next turn" }] }
                ]
            }),
            Some("req_now"),
            Some("session:sess-1"),
        );

        let payload = restored.get("payload").and_then(Value::as_object).unwrap();
        let input = payload.get("input").and_then(Value::as_array).unwrap();
        let serialized = serde_json::to_string(payload).unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], serde_json::json!("message"));
        assert!(!serialized.contains("historical reasoning leak"));
        assert!(!serialized.contains("\"reasoning_text\""));
    }

    #[test]
    fn convert_responses_output_to_input_items_strips_response_only_status_fields() {
        let response = serde_json::json!({
            "id": "resp_status_strip_1",
            "status": "requires_action",
            "output": [{
                "type": "function_call",
                "id": "fc_status_1",
                "call_id": "call_status_1",
                "name": "exec_command",
                "status": "in_progress",
                "arguments": "{\"cmd\":\"pwd\"}"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "function_call");
        assert_eq!(items[0]["call_id"], "call_status_1");
        assert!(items[0].get("status").is_none());
    }

    #[test]
    fn preserves_encrypted_only_reasoning_output_item_in_persisted_history() {
        let response = serde_json::json!({
            "output": [{
                "type": "reasoning",
                "id": "reasoning-enc-1",
                "status": "completed",
                "encrypted_content": "encrypted-opaque-value"
            }]
        });
        let items = convert_responses_output_to_input_items(&response)
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "reasoning");
        assert_eq!(items[0]["id"], "reasoning-enc-1");
        assert!(items[0].get("status").is_none());
        assert_eq!(items[0]["encrypted_content"], "encrypted-opaque-value");
    }
}
