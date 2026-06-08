use crate::shared_json_utils::read_trimmed_string;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const RCC_TOOL_RESULT_GUIDANCE: &str = "Tool results below are execution feedback for the next reasoning step. Use them to decide the next action instead of explaining the result itself.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccProjectionInput {
    #[serde(default)]
    semantic_conversation: Vec<Value>,
    #[serde(default)]
    rcc_text_tools: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccToolResultContextOutput {
    context: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccMarkerContractOutput {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfCascadePromptInput {
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    semantic_conversation: Vec<Value>,
    #[serde(default)]
    rcc_text_tools: Vec<Value>,
    #[serde(default)]
    rcc_guidance: String,
    #[serde(default)]
    rcc_pending_reminder: String,
    #[serde(default)]
    max_history_bytes: usize,
    #[serde(default)]
    windsurf_native_tool_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfCascadePromptOutput {
    prompt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccToolGuidanceOutput {
    guidance: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccPendingReminderInput {
    #[serde(default)]
    semantic_conversation: Vec<Value>,
    #[serde(default)]
    rcc_text_tools: Vec<Value>,
    #[serde(default)]
    windsurf_native_tool_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccPendingReminderOutput {
    reminder: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccHarvestInput {
    #[serde(default)]
    text: String,
    #[serde(default)]
    rcc_text_tools: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccHarvestOutput {
    text: String,
    tool_calls: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<WindsurfRccHarvestError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfNativeToolSignatureInput {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfNativeToolSignatureOutput {
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfCompletedNativePairingInput {
    #[serde(default)]
    raw_call: Value,
    #[serde(default)]
    completed_call_ids: Vec<String>,
    #[serde(default)]
    completed_signatures: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfCompletedNativePairingOutput {
    action: String,
    reason: String,
    strategy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfNativeAdditionalStepPayloadsInput {
    #[serde(default)]
    semantic_conversation: Vec<Value>,
    #[serde(default)]
    native_tool_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfNativeAdditionalStepPayloadsOutput {
    steps: Vec<WindsurfNativeAdditionalStepPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfNativeAdditionalStepPayload {
    kind: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeAssistantTurnInput {
    #[serde(default)]
    candidate: Value,
    #[serde(default)]
    rcc_text_tools: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeAssistantTurnOutput {
    assistant: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeToolResultTurnInput {
    #[serde(default)]
    message: Value,
    #[serde(default)]
    matched_calls: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeToolResultTurnOutput {
    tool_result: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeSemanticRoundtripInput {
    #[serde(default)]
    messages: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfParseCascadeSemanticRoundtripOutput {
    semantic_conversation: Vec<Value>,
}

fn build_native_additional_step_payloads(
    input: WindsurfNativeAdditionalStepPayloadsInput,
) -> WindsurfNativeAdditionalStepPayloadsOutput {
    let allowed_names: HashSet<String> = input
        .native_tool_names
        .iter()
        .map(|name| lookup_name(name))
        .collect();
    let allowed_kinds: HashSet<String> = input
        .native_tool_names
        .iter()
        .filter_map(|name| native_tool_kind(name).map(|kind| kind.to_string()))
        .collect();
    let allow_all_mappable = allowed_names.is_empty() && allowed_kinds.is_empty();
    let mut result_by_call_id: HashMap<String, String> = HashMap::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id")).unwrap_or_default();
        if call_id.is_empty() {
            continue;
        }
        let output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .to_string();
        result_by_call_id.insert(call_id, output);
    }
    let mut steps = Vec::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "assistant" {
            continue;
        }
        let Some(tool_calls) = row.get("tool_calls").and_then(|entry| entry.as_array()) else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(call_row) = tool_call.as_object() else {
                continue;
            };
            let raw_name = read_trimmed_string(call_row.get("name")).unwrap_or_default();
            if raw_name.is_empty() {
                continue;
            }
            let normalized_name = lookup_name(&raw_name);
            let Some(arguments) = call_row
                .get("arguments")
                .and_then(|entry| entry.as_object())
            else {
                continue;
            };
            let Some((kind, mut payload)) = project_native_payload(&raw_name, arguments) else {
                continue;
            };
            if !allow_all_mappable
                && !allowed_names.contains(&normalized_name)
                && !allowed_kinds.contains(&kind)
            {
                continue;
            }
            let call_id = read_trimmed_string(call_row.get("call_id")).unwrap_or_default();
            if let Some(observation) = result_by_call_id.get(&call_id) {
                apply_native_observation(&kind, &mut payload, observation);
            }
            steps.push(WindsurfNativeAdditionalStepPayload { kind, payload });
        }
    }
    WindsurfNativeAdditionalStepPayloadsOutput { steps }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindsurfRccHarvestError {
    message: String,
    code: String,
    status: u16,
    retryable: bool,
}

fn lookup_name(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

fn build_native_tool_signature(kind: &str, payload: &Value) -> String {
    let normalized_kind = lookup_name(kind);
    if normalized_kind == "run_command" {
        let command_line = payload
            .get("command_line")
            .or_else(|| payload.get("command"))
            .or_else(|| payload.get("cmd"))
            .or_else(|| payload.get("proposed_command_line"))
            .and_then(|entry| entry.as_str())
            .unwrap_or("");
        let cwd = payload
            .get("cwd")
            .or_else(|| payload.get("workdir"))
            .and_then(|entry| entry.as_str())
            .unwrap_or("");
        return format!(
            "{}:{}",
            normalized_kind,
            stable_stringify(&json!({ "command_line": command_line, "cwd": cwd }))
        );
    }
    format!("{}:{}", normalized_kind, stable_stringify(payload))
}

fn build_file_uri(value: &str) -> String {
    let path = value.trim();
    if path.is_empty() || path.to_ascii_lowercase().starts_with("file://") {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("file://{}", path)
    } else {
        path.to_string()
    }
}

fn read_arg_string(args: &Map<String, Value>, names: &[&str]) -> String {
    for name in names {
        if let Some(value) = args.get(*name) {
            if let Some(text) = value.as_str() {
                return text.to_string();
            }
            if !value.is_null() {
                return value.to_string();
            }
        }
    }
    String::new()
}

fn read_arg_positive_number(args: &Map<String, Value>, names: &[&str]) -> Option<u64> {
    for name in names {
        if let Some(value) = args.get(*name) {
            if let Some(number) = value.as_u64() {
                if number > 0 {
                    return Some(number);
                }
            }
            if let Some(number) = value.as_f64() {
                if number.is_finite() && number > 0.0 {
                    return Some(number.floor() as u64);
                }
            }
        }
    }
    None
}

fn read_arg_bool(args: &Map<String, Value>, name: &str) -> Option<bool> {
    args.get(name).and_then(|entry| entry.as_bool())
}

fn native_tool_kind(name: &str) -> Option<&'static str> {
    match lookup_name(name).as_str() {
        "read_file" | "read" | "view_file" => Some("view_file"),
        "exec_command" | "run_command" | "bash" | "shell" | "shell_command" => Some("run_command"),
        "list_dir" | "list_directory" => Some("list_directory"),
        "find" | "glob" => Some("find"),
        "grep" | "grep_search" | "grep_search_v2" => Some("grep_search_v2"),
        "write" => Some("write_to_file"),
        "write_to_file" => Some("write_to_file"),
        "websearch" | "toolsearch" | "web_search" => Some("search_web"),
        "webfetch" | "read_url_content" => Some("read_url_content"),
        _ => None,
    }
}

fn project_native_payload(name: &str, args: &Map<String, Value>) -> Option<(String, Value)> {
    let kind = native_tool_kind(name)?.to_string();
    let mut payload = Map::new();
    match kind.as_str() {
        "view_file" => {
            payload.insert(
                "absolute_path_uri".to_string(),
                Value::String(build_file_uri(&read_arg_string(
                    args,
                    &["filePath", "file_path", "path"],
                ))),
            );
            if let Some(offset) = read_arg_positive_number(args, &["offset"]) {
                payload.insert("offset".to_string(), json!(offset));
            }
            if let Some(limit) = read_arg_positive_number(args, &["limit"]) {
                payload.insert("limit".to_string(), json!(limit));
            }
        }
        "run_command" => {
            payload.insert(
                "command_line".to_string(),
                Value::String(read_arg_string(
                    args,
                    &[
                        "cmd",
                        "command",
                        "command_line",
                        "proposed_command_line",
                        "input",
                        "shell_command",
                    ],
                )),
            );
            let workdir = read_arg_string(args, &["workdir", "cwd"]);
            if !workdir.is_empty() {
                payload.insert("cwd".to_string(), Value::String(workdir));
            }
            payload.insert("blocking".to_string(), Value::Bool(true));
        }
        "list_directory" => {
            payload.insert(
                "directory_path_uri".to_string(),
                Value::String(build_file_uri(&read_arg_string(
                    args,
                    &["path", "directory_path", "cwd", "filePath"],
                ))),
            );
            if let Some(recursive) = read_arg_bool(args, "recursive") {
                payload.insert("recursive".to_string(), Value::Bool(recursive));
            }
        }
        "find" => {
            payload.insert(
                "pattern".to_string(),
                Value::String(read_arg_string(args, &["pattern"])),
            );
            let path = read_arg_string(args, &["path"]);
            if !path.is_empty() {
                payload.insert("search_directory".to_string(), Value::String(path));
            }
        }
        "grep_search_v2" => {
            payload.insert(
                "pattern".to_string(),
                Value::String(read_arg_string(args, &["pattern"])),
            );
            let path = read_arg_string(args, &["path"]);
            if !path.is_empty() {
                payload.insert("path".to_string(), Value::String(path));
            }
            let glob = read_arg_string(args, &["glob"]);
            if !glob.is_empty() {
                payload.insert("glob".to_string(), Value::String(glob));
            }
            if let Some(case_insensitive) = read_arg_bool(args, "-i") {
                payload.insert(
                    "case_insensitive".to_string(),
                    Value::Bool(case_insensitive),
                );
            }
        }
        "write_to_file" => {
            payload.insert(
                "target_file_uri".to_string(),
                Value::String(build_file_uri(&read_arg_string(
                    args,
                    &["target_file_uri", "file_path", "filePath", "path"],
                ))),
            );
            let content = args.get("code_content").or_else(|| args.get("content"));
            let code_content = match content {
                Some(Value::Array(items)) => Value::Array(
                    items
                        .iter()
                        .map(|entry| {
                            Value::String(
                                entry
                                    .as_str()
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| entry.to_string()),
                            )
                        })
                        .collect(),
                ),
                Some(Value::String(text)) => Value::Array(vec![Value::String(text.clone())]),
                Some(other) => Value::Array(vec![Value::String(other.to_string())]),
                None => Value::Array(vec![Value::String(String::new())]),
            };
            payload.insert("code_content".to_string(), code_content);
        }
        "search_web" => {
            payload.insert(
                "query".to_string(),
                Value::String(read_arg_string(args, &["query", "q"])),
            );
            if let Some(Value::Array(domains)) = args.get("domains") {
                if let Some(first) = domains.first().and_then(|entry| entry.as_str()) {
                    payload.insert("domain".to_string(), Value::String(first.to_string()));
                }
            } else {
                let domain = read_arg_string(args, &["domain"]);
                if !domain.is_empty() {
                    payload.insert("domain".to_string(), Value::String(domain));
                }
            }
        }
        "read_url_content" => {
            payload.insert(
                "url".to_string(),
                Value::String(read_arg_string(args, &["url", "uri", "link"])),
            );
        }
        _ => return None,
    }
    Some((kind, Value::Object(payload)))
}

fn apply_native_observation(kind: &str, payload: &mut Value, observation: &str) {
    let Some(row) = payload.as_object_mut() else {
        return;
    };
    match kind {
        "view_file" => {
            row.insert(
                "content".to_string(),
                Value::String(observation.to_string()),
            );
        }
        "run_command" => {
            row.insert(
                "full_output".to_string(),
                Value::String(observation.to_string()),
            );
            row.insert("stdout".to_string(), Value::String(observation.to_string()));
            row.insert("exit_code".to_string(), json!(0));
        }
        "list_directory" => {
            row.insert(
                "children".to_string(),
                Value::Array(
                    observation
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(|line| Value::String(line.to_string()))
                        .collect(),
                ),
            );
        }
        "find" | "grep_search_v2" => {
            row.insert(
                "raw_output".to_string(),
                Value::String(observation.to_string()),
            );
        }
        "search_web" | "read_url_content" => {
            row.insert(
                "summary".to_string(),
                Value::String(observation.to_string()),
            );
        }
        _ => {}
    }
}

fn escape_rcc_cdata(value: &str) -> String {
    value.replace("]]>", "]]]]><![CDATA[>")
}

fn escape_history_tag(value: &str, tag: &str) -> String {
    value
        .replace(&format!("<{}>", tag), &format!("&lt;{}&gt;", tag))
        .replace(&format!("</{}>", tag), &format!("&lt;/{}&gt;", tag))
}

fn read_tool_name(tool: &Value) -> Option<String> {
    let row = tool.as_object()?;
    if let Some(function) = row.get("function").and_then(|entry| entry.as_object()) {
        let name = read_trimmed_string(function.get("name")).unwrap_or_default();
        if !name.is_empty() {
            return Some(name);
        }
    }
    let name = read_trimmed_string(row.get("name")).unwrap_or_default();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn read_tool_function(tool: &Value) -> Option<&serde_json::Map<String, Value>> {
    let row = tool.as_object()?;
    row.get("function")
        .and_then(|entry| entry.as_object())
        .or(Some(row))
}

fn read_tool_parameter_schema<'a>(
    tool: &'a Value,
    param_name: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    let function = read_tool_function(tool)?;
    function
        .get("parameters")
        .and_then(|entry| entry.as_object())
        .and_then(|params| params.get("properties"))
        .and_then(|entry| entry.as_object())
        .and_then(|props| props.get(param_name))
        .and_then(|entry| entry.as_object())
}

fn read_json_schema_types(schema: Option<&serde_json::Map<String, Value>>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(schema) = schema else {
        return out;
    };
    match schema.get("type") {
        Some(Value::String(raw)) => {
            let value = raw.trim().to_ascii_lowercase();
            if !value.is_empty() && !out.contains(&value) {
                out.push(value);
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let Some(raw) = item.as_str() else {
                    continue;
                };
                let value = raw.trim().to_ascii_lowercase();
                if !value.is_empty() && !out.contains(&value) {
                    out.push(value);
                }
            }
        }
        _ => {}
    }
    out
}

fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                            stable_stringify(value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn hash_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = format!("{:x}", digest);
    hex.chars().take(16).collect()
}

fn harvest_error(message: impl Into<String>, code: &str) -> WindsurfRccHarvestOutput {
    WindsurfRccHarvestOutput {
        text: String::new(),
        tool_calls: Vec::new(),
        error: Some(WindsurfRccHarvestError {
            message: message.into(),
            code: code.to_string(),
            status: 502,
            retryable: false,
        }),
    }
}

fn parse_rcc_parameter_value(
    tool: Option<&Value>,
    param_name: &str,
    raw_value: &str,
) -> Result<Value, WindsurfRccHarvestOutput> {
    let types = read_json_schema_types(
        tool.and_then(|entry| read_tool_parameter_schema(entry, param_name)),
    );
    let expects_json = ["array", "object", "boolean", "number", "integer", "null"]
        .iter()
        .any(|expected| types.iter().any(|entry| entry == expected));
    if !expects_json || types.iter().any(|entry| entry == "string") {
        return Ok(Value::String(raw_value.to_string()));
    }
    let first_pass: Value = serde_json::from_str(raw_value).map_err(|_| {
        harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected JSON {}",
                param_name,
                types.join("|")
            ),
            "WINDSURF_RCC_MALFORMED",
        )
    })?;
    let parsed = match first_pass {
        Value::String(inner)
            if ["array", "object", "boolean", "number", "integer", "null"]
                .iter()
                .any(|expected| types.iter().any(|entry| entry == expected)) =>
        {
            match serde_json::from_str::<Value>(inner.trim()) {
                Ok(decoded) => decoded,
                Err(_) => Value::String(inner),
            }
        }
        other => other,
    };
    if types.iter().any(|entry| entry == "array") && !parsed.is_array() {
        return Err(harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected array",
                param_name
            ),
            "WINDSURF_RCC_MALFORMED",
        ));
    }
    if types.iter().any(|entry| entry == "object") && !parsed.is_object() {
        return Err(harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected object",
                param_name
            ),
            "WINDSURF_RCC_MALFORMED",
        ));
    }
    if types
        .iter()
        .any(|entry| entry == "number" || entry == "integer")
        && !parsed.is_number()
    {
        return Err(harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected number",
                param_name
            ),
            "WINDSURF_RCC_MALFORMED",
        ));
    }
    if types.iter().any(|entry| entry == "integer") && !parsed.as_i64().is_some() {
        return Err(harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected integer",
                param_name
            ),
            "WINDSURF_RCC_MALFORMED",
        ));
    }
    if types.iter().any(|entry| entry == "boolean") && !parsed.is_boolean() {
        return Err(harvest_error(
            format!(
                "[windsurf] malformed RCC parameter {}: expected boolean",
                param_name
            ),
            "WINDSURF_RCC_MALFORMED",
        ));
    }
    Ok(parsed)
}

fn find_rcc_tool_definition<'a>(tools: &'a [Value], name: &str) -> Option<&'a Value> {
    let lookup = lookup_name(name);
    tools.iter().find(|tool| {
        read_tool_name(tool)
            .map(|candidate| lookup_name(&candidate) == lookup)
            .unwrap_or(false)
    })
}

fn harvest_rcc_tool_calls(input: WindsurfRccHarvestInput) -> WindsurfRccHarvestOutput {
    let raw = input.text;
    if !raw.contains("<|RCC|tool_calls>") {
        return WindsurfRccHarvestOutput {
            text: raw,
            tool_calls: Vec::new(),
            error: None,
        };
    }
    if input.rcc_text_tools.is_empty() {
        return harvest_error(
            "[windsurf] tool call emitted but no matching tool declarations were available",
            "WINDSURF_RCC_UNDECLARED_TOOL",
        );
    }
    let root_re = Regex::new(r#"(?s)<\|RCC\|tool_calls>\s*([\s\S]*?)\s*</\|RCC\|tool_calls>"#)
        .expect("valid rcc root regex");
    let invoke_re =
        Regex::new(r#"(?s)<\|RCC\|invoke\s+name="([^"]+)">\s*([\s\S]*?)\s*</\|RCC\|invoke>"#)
            .expect("valid rcc invoke regex");
    let param_re =
        Regex::new(r#"(?s)<\|RCC\|parameter\s+name="([^"]+)">\s*([\s\S]*?)\s*</\|RCC\|parameter>"#)
            .expect("valid rcc parameter regex");
    let cdata_re = Regex::new(r#"(?s)^<!\[CDATA\[([\s\S]*?)\]\]>$"#).expect("valid cdata regex");
    let allowed = windsurf_tool_name_set(&input.rcc_text_tools);
    let mut tool_calls = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_signatures = HashSet::new();
    let mut saw_root = false;
    let mut cleaned = raw.clone();
    for root in root_re.captures_iter(&raw) {
        saw_root = true;
        let full = root.get(0).map(|entry| entry.as_str()).unwrap_or("");
        let inner = root.get(1).map(|entry| entry.as_str()).unwrap_or("");
        let mut saw_invoke = false;
        for invoke in invoke_re.captures_iter(inner) {
            saw_invoke = true;
            let name = invoke
                .get(1)
                .map(|entry| entry.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !allowed.contains(&name) && !allowed.contains(&lookup_name(&name)) {
                return harvest_error(
                    format!("[windsurf] RCC undeclared tool: {}", name),
                    "WINDSURF_RCC_UNDECLARED_TOOL",
                );
            }
            let tool_definition = find_rcc_tool_definition(&input.rcc_text_tools, &name);
            let body = invoke.get(2).map(|entry| entry.as_str()).unwrap_or("");
            let mut params = Map::new();
            let mut saw_param = false;
            for param in param_re.captures_iter(body) {
                saw_param = true;
                let param_name = param
                    .get(1)
                    .map(|entry| entry.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let mut value = param
                    .get(2)
                    .map(|entry| entry.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(cdata) = cdata_re.captures(&value) {
                    value = cdata
                        .get(1)
                        .map(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_string();
                }
                let parsed = match parse_rcc_parameter_value(tool_definition, &param_name, &value) {
                    Ok(value) => value,
                    Err(error) => return error,
                };
                params.insert(param_name, parsed);
            }
            if !saw_param {
                return harvest_error(
                    "[windsurf] malformed RCC tool call: missing parameter",
                    "WINDSURF_RCC_MALFORMED",
                );
            }
            let args_json = stable_stringify(&Value::Object(params));
            let signature = format!("{}:{}", name, args_json);
            let id = format!("call_{}", hash_id(&signature));
            if seen_ids.contains(&id) || seen_signatures.contains(&signature) {
                continue;
            }
            seen_ids.insert(id.clone());
            seen_signatures.insert(signature);
            tool_calls.push(json!({"id": id, "type": "function", "function": {"name": name, "arguments": args_json}}));
        }
        if !saw_invoke {
            return harvest_error(
                "[windsurf] malformed RCC tool call: missing invoke",
                "WINDSURF_RCC_MALFORMED",
            );
        }
        cleaned = cleaned.replace(full, "");
    }
    if !saw_root {
        return harvest_error(
            "[windsurf] malformed RCC tool call wrapper",
            "WINDSURF_RCC_MALFORMED",
        );
    }
    WindsurfRccHarvestOutput {
        text: cleaned.trim().to_string(),
        tool_calls,
        error: None,
    }
}

fn describe_rcc_parameter_schema(tool: &Value, param_name: &str) -> String {
    let types = read_json_schema_types(read_tool_parameter_schema(tool, param_name));
    if types.is_empty() {
        "string".to_string()
    } else {
        types.join("|")
    }
}

fn read_tool_properties<'a>(tool: &'a Value) -> Vec<(&'a String, &'a Value)> {
    let Some(function) = read_tool_function(tool) else {
        return Vec::new();
    };
    let Some(props) = function
        .get("parameters")
        .and_then(|entry| entry.as_object())
        .and_then(|params| params.get("properties"))
        .and_then(|entry| entry.as_object())
    else {
        return Vec::new();
    };
    props.iter().collect()
}

fn build_rcc_tool_call_example_lines(tool: &Value) -> Vec<String> {
    let first_name = read_tool_name(tool).unwrap_or_default();
    let props = read_tool_properties(tool);
    let prop_names: Vec<String> = props.iter().map(|(name, _)| (*name).clone()).collect();
    let required: Vec<String> = read_tool_function(tool)
        .and_then(|function| function.get("parameters"))
        .and_then(|entry| entry.as_object())
        .and_then(|params| params.get("required"))
        .and_then(|entry| entry.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|name| prop_names.iter().any(|prop| prop == name))
                .map(|name| name.to_string())
                .collect()
        })
        .unwrap_or_default();
    let example_params = if required.is_empty() {
        vec![prop_names
            .first()
            .cloned()
            .unwrap_or_else(|| "input".to_string())]
    } else {
        required
    };

    let mut lines = vec![
        "<|RCC|tool_calls>".to_string(),
        format!("<|RCC|invoke name=\"{}\">", first_name),
    ];
    for param_name in example_params {
        let types = read_json_schema_types(read_tool_parameter_schema(tool, &param_name));
        let value = if types.iter().any(|entry| entry == "array") {
            "[{\"step\":\"do the work\",\"status\":\"in_progress\"}]"
        } else if types.iter().any(|entry| entry == "object") {
            "{\"key\":\"value\"}"
        } else if types.iter().any(|entry| entry == "boolean") {
            "true"
        } else if types
            .iter()
            .any(|entry| entry == "number" || entry == "integer")
        {
            "1"
        } else {
            "value"
        };
        lines.push(format!(
            "<|RCC|parameter name=\"{}\"><![CDATA[{}]]></|RCC|parameter>",
            param_name, value
        ));
    }
    lines.push("</|RCC|invoke>".to_string());
    lines.push("</|RCC|tool_calls>".to_string());
    lines
}

fn build_rcc_tool_guidance(tools: &[Value]) -> String {
    let valid_tools: Vec<&Value> = tools
        .iter()
        .filter(|tool| read_tool_name(tool).is_some())
        .collect();
    if valid_tools.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "Text tool calling format (STRICT)".to_string(),
        "If this turn requires a tool, output the RCC tool-call block immediately and no visible thinking, plan, headings, markdown, or prose.".to_string(),
        "Do not output '# Plan', 'Planning tool usage', 'Considering tool usage', or similar planning text before a required tool call.".to_string(),
        "Available text tool names for this turn:".to_string(),
    ];
    for tool in &valid_tools {
        let name = read_tool_name(tool).unwrap_or_default();
        lines.push(format!("- {}", name));
        let props = read_tool_properties(tool);
        if !props.is_empty() {
            let parameter_list = props
                .iter()
                .map(|(param_name, _)| {
                    format!(
                        "{}:{}",
                        param_name,
                        describe_rcc_parameter_schema(tool, param_name)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("  parameters: {}", parameter_list));
        }
        if lookup_name(&name) == "apply_patch" {
            lines.push("  apply_patch contract: filePath must be workspace-relative, not absolute; patch must be a strict line-edit patch.".to_string());
            lines.push("  create/append lines start with `+ `; updates use exact current target lines as `- ` entries followed by replacement `+ ` entries.".to_string());
            lines.push("  For file edits, call apply_patch directly.".to_string());
            lines.push("  Do not use shell_command, exec_command, python, cat, tee, heredoc, or sed-style command writing for file editing.".to_string());
            lines.push(
                "  After tool results arrive, use that execution feedback to continue reasoning."
                    .to_string(),
            );
        }
    }
    let first = valid_tools[0];
    lines.push(
        "When a tool is required, output only this tool-call block and no prose:".to_string(),
    );
    lines.extend(build_rcc_tool_call_example_lines(first));
    lines.push("For array/object/boolean/number parameters, put a valid JSON literal inside CDATA. For string parameters, put the exact string inside CDATA. Include every required parameter exactly once.".to_string());
    lines.push("Do not use markdown fences, narrative tool intent, JSON-only payloads, invented tool names, or alternate tool-call formats.".to_string());
    lines.join("\n")
}

fn build_pending_tool_reminder(input: WindsurfRccPendingReminderInput) -> String {
    if input.rcc_text_tools.is_empty() {
        return String::new();
    }
    let declared: Vec<String> = input
        .rcc_text_tools
        .iter()
        .filter_map(read_tool_name)
        .collect();
    if declared.is_empty() {
        return String::new();
    }
    let mut called = HashSet::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "assistant" {
            continue;
        }
        let Some(tool_calls) = row.get("tool_calls").and_then(|entry| entry.as_array()) else {
            continue;
        };
        for call in tool_calls {
            let Some(call_row) = call.as_object() else {
                continue;
            };
            let name = read_trimmed_string(call_row.get("name")).unwrap_or_default();
            if !name.is_empty() {
                called.insert(lookup_name(&name));
            }
        }
    }
    let pending: Vec<String> = declared
        .into_iter()
        .filter(|name| !called.contains(&lookup_name(name)))
        .collect();
    if pending.is_empty() {
        return String::new();
    }
    let native_names: HashSet<String> = input
        .windsurf_native_tool_names
        .iter()
        .map(|name| lookup_name(name))
        .collect();
    let has_completed_native_step = input.semantic_conversation.iter().any(|turn| {
        let Some(row) = turn.as_object() else {
            return false;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            return false;
        }
        let name = lookup_name(&read_trimmed_string(row.get("name")).unwrap_or_default());
        !name.is_empty() && native_names.contains(&name)
    });
    if !has_completed_native_step {
        return String::new();
    }
    let pending_lookup: HashSet<String> = pending.iter().map(|name| lookup_name(name)).collect();
    let pending_tool = input.rcc_text_tools.iter().find(|tool| {
        read_tool_name(tool)
            .map(|name| pending_lookup.contains(&lookup_name(&name)))
            .unwrap_or(false)
    });
    let mut lines = vec![
        format!(
            "Available remaining text tool names: {}.",
            pending.join(", ")
        ),
        "If the user request requires one of them, output the tool-call block now and no prose."
            .to_string(),
    ];
    if let Some(tool) = pending_tool {
        lines.extend(build_rcc_tool_call_example_lines(tool));
    }
    lines.join("\n")
}

fn windsurf_tool_name_set(tools: &[Value]) -> HashSet<String> {
    let mut out = HashSet::new();
    for tool in tools {
        if let Some(name) = read_tool_name(tool) {
            out.insert(name.clone());
            out.insert(lookup_name(&name));
        }
    }
    out
}

fn is_marker_line(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(rest) = trimmed
        .strip_prefix("BEGIN_")
        .or_else(|| trimmed.strip_prefix("MIDDLE_"))
        .or_else(|| trimmed.strip_prefix("END_"))
    else {
        return false;
    };
    !rest.is_empty()
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' || ch == '-')
}

fn push_unique_marker(out: &mut Vec<String>, marker: &str) {
    if !out.iter().any(|entry| entry == marker) {
        out.push(marker.to_string());
    }
}

fn collect_markers_from_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if is_marker_line(trimmed) {
            push_unique_marker(&mut out, trimmed);
        }
    }
    out
}

fn collect_markers_from_inline_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in
        text.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' || ch == '-'))
    {
        if is_marker_line(token) {
            push_unique_marker(&mut out, token);
        }
    }
    out
}

fn normalize_apply_patch_tool_result_output(raw: &str) -> String {
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return text;
    }
    if trimmed.starts_with("APPLY_PATCH_ERROR:") {
        return trimmed.to_string();
    }
    if let Ok(Value::Object(row)) = serde_json::from_str::<Value>(trimmed) {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if row.get("ok").and_then(Value::as_bool) == Some(true)
            || status == "APPLY_PATCH_APPLIED"
            || status == "APPLY_PATCH_RESULT"
        {
            let mut parts = Vec::new();
            if !status.is_empty() {
                parts.push(format!("status={}", status));
            }
            if let Some(file_path) = row
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("filePath={}", file_path));
            }
            if let Some(message) = row
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("message={}", message));
            }
            return if parts.is_empty() {
                "APPLY_PATCH_RESULT".to_string()
            } else {
                parts.join("\n")
            };
        }
        if row.get("ok").and_then(Value::as_bool) == Some(false)
            || status == "APPLY_PATCH_FAILED"
            || status == "APPLY_PATCH_ERROR"
        {
            let mut parts = vec!["APPLY_PATCH_ERROR".to_string()];
            if !status.is_empty() {
                parts.push(format!("status={}", status));
            }
            if let Some(message) = row
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(format!("message={}", message));
            }
            return parts.join("\n");
        }
    }
    let lowered = trimmed.to_ascii_lowercase();
    if matches!(
        lowered.as_str(),
        "done" | "done!" | "patch applied" | "apply_patch applied"
    ) {
        return trimmed.to_string();
    }
    if lowered.contains("verification failed")
        || lowered.contains("invalid patch")
        || lowered.contains("missing")
        || lowered.contains("failed")
        || lowered.contains("error")
    {
        return trimmed.to_string();
    }
    text
}

fn build_name_by_call_id(
    input: &WindsurfRccProjectionInput,
    allowed: &HashSet<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "assistant" {
            continue;
        }
        let Some(tool_calls) = row.get("tool_calls").and_then(|entry| entry.as_array()) else {
            continue;
        };
        for call in tool_calls {
            let Some(call_row) = call.as_object() else {
                continue;
            };
            let call_id = read_trimmed_string(call_row.get("call_id")).unwrap_or_default();
            let name = read_trimmed_string(call_row.get("name")).unwrap_or_default();
            if call_id.is_empty() || name.is_empty() {
                continue;
            }
            if allowed.contains(&name) || allowed.contains(&lookup_name(&name)) {
                out.insert(call_id, name);
            }
        }
    }
    out
}

fn build_context(input: WindsurfRccProjectionInput) -> String {
    if input.rcc_text_tools.is_empty() {
        return String::new();
    }
    let allowed = windsurf_tool_name_set(&input.rcc_text_tools);
    let name_by_id = build_name_by_call_id(&input, &allowed);
    let mut blocks = Vec::new();
    let mut marker_lines = Vec::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id")).unwrap_or_default();
        let raw_output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .to_string();
        let explicit_name = read_trimmed_string(row.get("name")).unwrap_or_default();
        let name = name_by_id.get(&call_id).cloned().unwrap_or(explicit_name);
        if name.is_empty() || (!allowed.contains(&name) && !allowed.contains(&lookup_name(&name))) {
            continue;
        }
        for marker in collect_markers_from_text(&raw_output) {
            push_unique_marker(&mut marker_lines, marker.as_str());
        }
        let output = if lookup_name(&name) == "apply_patch" {
            normalize_apply_patch_tool_result_output(&raw_output)
        } else {
            raw_output
        };
        blocks.push(format_rcc_tool_result_block(&call_id, &name, &output));
    }
    if blocks.is_empty() {
        return String::new();
    }
    let mut parts = vec![RCC_TOOL_RESULT_GUIDANCE.to_string()];
    parts.extend(blocks);
    if !marker_lines.is_empty() {
        parts.push(format!("Markers: {}.", marker_lines.join(", ")));
    }
    parts.join("\n\n")
}

fn build_completed_rcc_tool_call_reminder(input: &WindsurfRccProjectionInput) -> String {
    if input.rcc_text_tools.is_empty() {
        return String::new();
    }
    let allowed = windsurf_tool_name_set(&input.rcc_text_tools);
    let name_by_id = build_name_by_call_id(input, &allowed);
    if name_by_id.is_empty() {
        return String::new();
    }
    let mut completed = Vec::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id")).unwrap_or_default();
        if call_id.is_empty() {
            continue;
        }
        let explicit_name = read_trimmed_string(row.get("name")).unwrap_or_default();
        let name = name_by_id.get(&call_id).cloned().unwrap_or(explicit_name);
        if name.is_empty() || (!allowed.contains(&name) && !allowed.contains(&lookup_name(&name))) {
            continue;
        }
        completed.push(format!("{} ({})", call_id, name));
    }
    if completed.is_empty() {
        return String::new();
    }
    format!(
        "Completed RCC text tool calls already have results: {}. Do not repeat an identical completed tool call; continue from the result unless the user asks to run it again.",
        completed.join(", ")
    )
}

fn format_rcc_tool_result_block(call_id: &str, name: &str, output: &str) -> String {
    format!(
        "<|RCC|tool_result id=\"{}\" name=\"{}\">\n<![CDATA[\n{}\n]]>\n</|RCC|tool_result>",
        call_id,
        name,
        escape_rcc_cdata(output)
    )
}

fn content_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let row = item.as_object()?;
                row.get("text")
                    .and_then(|entry| entry.as_str())
                    .map(|text| text.to_string())
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => other.as_str().unwrap_or("").to_string(),
        None => String::new(),
    }
}

fn compact_system_prompt_for_cascade(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= 8_000 {
        return trimmed.to_string();
    }
    format!(
        "{}\n\n[system prompt truncated for Windsurf Cascade]",
        &trimmed[..8_000]
    )
}

fn is_windsurf_rcc_text_tool_result(turn: &Value, native_tool_names: &HashSet<String>) -> bool {
    let Some(row) = turn.as_object() else {
        return false;
    };
    if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
        return false;
    }
    let raw_name = read_trimmed_string(row.get("name")).unwrap_or_default();
    let canonical_name = lookup_name(&raw_name);
    !raw_name.is_empty()
        && !native_tool_names.contains(&raw_name)
        && !canonical_name.is_empty()
        && !native_tool_names.contains(&canonical_name)
}

fn build_cascade_history_turn_text(
    turn: &Value,
    rcc_allowed_tool_names: &HashSet<String>,
    rcc_name_by_call_id: &HashMap<String, String>,
) -> String {
    let Some(row) = turn.as_object() else {
        return String::new();
    };
    let turn_type = read_trimmed_string(row.get("type")).unwrap_or_default();
    if turn_type == "assistant" {
        let text = row
            .get("text")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .to_string();
        let mut parts = Vec::new();
        if !text.trim().is_empty() {
            parts.push(text);
        }
        if let Some(tool_calls) = row.get("tool_calls").and_then(|entry| entry.as_array()) {
            let mut invoke_blocks = Vec::new();
            for call in tool_calls {
                let Some(call_row) = call.as_object() else {
                    continue;
                };
                let call_id = read_trimmed_string(call_row.get("call_id")).unwrap_or_default();
                let name = read_trimmed_string(call_row.get("name")).unwrap_or_default();
                if call_id.is_empty() || name.is_empty() {
                    continue;
                }
                if !rcc_allowed_tool_names.contains(&name)
                    && !rcc_allowed_tool_names.contains(&lookup_name(&name))
                {
                    continue;
                }
                let arguments = call_row
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                invoke_blocks.push(format!(
                    "<|RCC|invoke id=\"{}\" name=\"{}\">\n<|RCC|arguments><![CDATA[{}]]></|RCC|arguments>\n</|RCC|invoke>",
                    call_id,
                    name,
                    escape_rcc_cdata(&stable_stringify(&arguments))
                ));
            }
            if !invoke_blocks.is_empty() {
                parts.push(format!(
                    "<|RCC|tool_calls>\n{}\n</|RCC|tool_calls>",
                    invoke_blocks.join("\n")
                ));
            }
        }
        return parts.join("\n\n");
    }
    if turn_type == "function_call_output" {
        let call_id = read_trimmed_string(row.get("call_id")).unwrap_or_default();
        if call_id.is_empty() {
            return String::new();
        }
        let explicit_name = read_trimmed_string(row.get("name")).unwrap_or_default();
        let name = rcc_name_by_call_id
            .get(&call_id)
            .cloned()
            .unwrap_or(explicit_name);
        if name.is_empty()
            || (!rcc_allowed_tool_names.contains(&name)
                && !rcc_allowed_tool_names.contains(&lookup_name(&name)))
        {
            return String::new();
        }
        let raw_output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("");
        let output = if lookup_name(&name) == "apply_patch" {
            normalize_apply_patch_tool_result_output(raw_output)
        } else {
            raw_output.to_string()
        };
        return format_rcc_tool_result_block(&call_id, &name, &output);
    }
    row.get("text")
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .to_string()
}

fn find_first_non_empty_user_text(semantic_conversation: &[Value]) -> Option<String> {
    for turn in semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "user" {
            continue;
        }
        let text = row
            .get("text")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    None
}

fn find_latest_non_empty_user_index(semantic_conversation: &[Value]) -> Option<usize> {
    for (index, turn) in semantic_conversation.iter().enumerate().rev() {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "user" {
            continue;
        }
        let text = row
            .get("text")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if !text.is_empty() {
            return Some(index);
        }
    }
    None
}

fn extract_native_feedback_after_latest_user(
    semantic_conversation: &[Value],
    latest_user_index: Option<usize>,
    native_tool_names: &HashSet<String>,
) -> Vec<String> {
    let start = latest_user_index.map(|index| index + 1).unwrap_or(0);
    let mut feedback = Vec::new();
    for turn in semantic_conversation.iter().skip(start) {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            continue;
        }
        if row.get("source").and_then(|entry| entry.as_str()) == Some("bridge_tool_history") {
            continue;
        }
        if is_windsurf_rcc_text_tool_result(turn, native_tool_names) {
            continue;
        }
        let output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if !output.is_empty() {
            feedback.push(output.to_string());
        }
    }
    feedback
}

fn extract_recent_native_feedback_before_latest_user(
    semantic_conversation: &[Value],
    latest_user_index: Option<usize>,
    native_tool_names: &HashSet<String>,
) -> Vec<String> {
    let Some(mut index) = latest_user_index else {
        return Vec::new();
    };
    let mut feedback = Vec::new();
    while index > 0 {
        index -= 1;
        let Some(row) = semantic_conversation[index].as_object() else {
            continue;
        };
        let turn_type = read_trimmed_string(row.get("type")).unwrap_or_default();
        if turn_type == "user" {
            break;
        }
        if turn_type != "function_call_output" {
            continue;
        }
        if row.get("source").and_then(|entry| entry.as_str()) == Some("bridge_tool_history") {
            continue;
        }
        if is_windsurf_rcc_text_tool_result(&semantic_conversation[index], native_tool_names) {
            continue;
        }
        let output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if !output.is_empty() {
            feedback.insert(0, output.to_string());
        }
    }
    feedback
}

fn has_substantive_assistant_text_after_latest_user(
    semantic_conversation: &[Value],
    latest_user_index: Option<usize>,
) -> bool {
    let start = latest_user_index.map(|index| index + 1).unwrap_or(0);
    for turn in semantic_conversation.iter().skip(start) {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "assistant" {
            continue;
        }
        let text = row
            .get("text")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if !text.is_empty() {
            return true;
        }
    }
    false
}

fn extract_latest_cascade_user_text(
    semantic_conversation: &[Value],
    variable_tail_parts: &[String],
    native_tool_names: &HashSet<String>,
) -> Result<String, String> {
    let normalized_tail_parts: Vec<String> = variable_tail_parts
        .iter()
        .filter_map(|part| {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect();
    let mut latest_user_index: Option<usize> = None;
    let mut latest_user_text = String::new();
    for (index, turn) in semantic_conversation.iter().enumerate().rev() {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "user" {
            continue;
        }
        let text = row
            .get("text")
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        latest_user_index = Some(index);
        latest_user_text = text.to_string();
        break;
    }
    let has_later_turns_after_latest_user = latest_user_index
        .map(|index| index + 1 < semantic_conversation.len())
        .unwrap_or(false);
    let trailing_feedback = extract_native_feedback_after_latest_user(
        semantic_conversation,
        latest_user_index,
        native_tool_names,
    );
    let has_substantive_assistant_after_latest_user =
        has_substantive_assistant_text_after_latest_user(semantic_conversation, latest_user_index);
    let mut base_parts = Vec::new();
    if !latest_user_text.is_empty() {
        base_parts.push(latest_user_text);
        if !has_substantive_assistant_after_latest_user || !normalized_tail_parts.is_empty() {
            base_parts.extend(trailing_feedback);
        }
        if !has_later_turns_after_latest_user {
            base_parts.extend(extract_recent_native_feedback_before_latest_user(
                semantic_conversation,
                latest_user_index,
                native_tool_names,
            ));
        }
    } else {
        base_parts.extend(trailing_feedback);
    }
    if !base_parts.is_empty() {
        base_parts.extend(normalized_tail_parts);
        return Ok(base_parts.join("\n\n"));
    }
    Err("[windsurf] cascade semantic conversation missing terminal user text".to_string())
}

fn build_cascade_prompt(input: WindsurfCascadePromptInput) -> Result<String, String> {
    let system_text = input
        .messages
        .iter()
        .filter_map(|message| {
            let row = message.as_object()?;
            if read_trimmed_string(row.get("role"))
                .unwrap_or_default()
                .to_ascii_lowercase()
                != "system"
            {
                return None;
            }
            Some(content_to_string(row.get("content")))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let sys_text = compact_system_prompt_for_cascade(&system_text);
    let rcc_allowed_tool_names = windsurf_tool_name_set(&input.rcc_text_tools);
    let rcc_name_by_call_id = build_name_by_call_id(
        &WindsurfRccProjectionInput {
            semantic_conversation: input.semantic_conversation.clone(),
            rcc_text_tools: input.rcc_text_tools.clone(),
        },
        &rcc_allowed_tool_names,
    );
    let mut prefix_parts: Vec<String> = [sys_text]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect();
    if !input.rcc_guidance.trim().is_empty() {
        prefix_parts.push(input.rcc_guidance.clone());
    }
    let completed_rcc_tool_call_reminder =
        build_completed_rcc_tool_call_reminder(&WindsurfRccProjectionInput {
            semantic_conversation: input.semantic_conversation.clone(),
            rcc_text_tools: input.rcc_text_tools.clone(),
        });
    if !completed_rcc_tool_call_reminder.trim().is_empty() {
        prefix_parts.push(completed_rcc_tool_call_reminder);
    }
    let native_tool_names: HashSet<String> = input
        .windsurf_native_tool_names
        .iter()
        .map(|name| lookup_name(name))
        .collect();
    let latest_user_index = find_latest_non_empty_user_index(&input.semantic_conversation);
    let latest_tail_text =
        extract_latest_cascade_user_text(&input.semantic_conversation, &[], &native_tool_names)?;
    let convo: Vec<Value> = input
        .semantic_conversation
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| {
            let row = turn.as_object()?;
            let turn_type = read_trimmed_string(row.get("type")).unwrap_or_default();
            if !matches!(
                turn_type.as_str(),
                "user" | "assistant" | "function_call_output"
            ) {
                return None;
            }
            if turn_type == "function_call_output"
                && latest_user_index
                    .map(|latest| index > latest)
                    .unwrap_or(false)
                && !is_windsurf_rcc_text_tool_result(turn, &native_tool_names)
            {
                return None;
            }
            let mut next = turn.clone();
            if turn_type == "user" && Some(index) == latest_user_index {
                if let Some(next_row) = next.as_object_mut() {
                    next_row.insert("text".to_string(), Value::String(latest_tail_text.clone()));
                }
            }
            Some(next)
        })
        .collect();
    let convo: Vec<Value> = convo
        .iter()
        .filter(|turn| {
            let Some(row) = turn.as_object() else {
                return false;
            };
            matches!(
                read_trimmed_string(row.get("type"))
                    .unwrap_or_default()
                    .as_str(),
                "user" | "assistant" | "function_call_output"
            )
        })
        .cloned()
        .collect();
    if convo.is_empty() {
        return Err("[windsurf] cascade semantic conversation missing turns".to_string());
    }
    let mut lines: Vec<String> = Vec::new();
    for turn in &convo {
        let turn_text =
            build_cascade_history_turn_text(turn, &rcc_allowed_tool_names, &rcc_name_by_call_id);
        if turn_text.trim().is_empty() {
            continue;
        }
        let turn_type = read_trimmed_string(turn.as_object().and_then(|row| row.get("type")))
            .unwrap_or_default();
        let tag = if turn_type == "user" {
            "human"
        } else {
            "assistant"
        };
        let line = format!(
            "<{}>\n{}\n</{}>",
            tag,
            escape_history_tag(&turn_text, tag),
            tag
        );
        lines.push(line);
    }
    let text = format!(
        "The following is a multi-turn conversation. You MUST remember and use all information from prior turns.\n\n{}",
        lines.join("\n\n")
    );
    Ok(if prefix_parts.is_empty() {
        text
    } else {
        format!("{}\n\n{}", prefix_parts.join("\n\n"), text)
    })
}

fn marker_contract(input: WindsurfRccProjectionInput) -> WindsurfRccMarkerContractOutput {
    if input.rcc_text_tools.is_empty() {
        return WindsurfRccMarkerContractOutput {
            ok: true,
            missing: None,
        };
    }
    let allowed = windsurf_tool_name_set(&input.rcc_text_tools);
    let name_by_id = build_name_by_call_id(&input, &allowed);
    if name_by_id.is_empty() {
        return WindsurfRccMarkerContractOutput {
            ok: true,
            missing: None,
        };
    }
    let latest_user_text = input
        .semantic_conversation
        .iter()
        .rev()
        .find_map(|turn| {
            let row = turn.as_object()?;
            if read_trimmed_string(row.get("type")).unwrap_or_default() != "user" {
                return None;
            }
            Some(
                row.get("text")
                    .and_then(|entry| entry.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        })
        .unwrap_or_default();
    let required_markers = collect_markers_from_inline_text(&latest_user_text);
    if required_markers.is_empty() {
        return WindsurfRccMarkerContractOutput {
            ok: true,
            missing: None,
        };
    }
    let mut observed_markers = Vec::new();
    for turn in &input.semantic_conversation {
        let Some(row) = turn.as_object() else {
            continue;
        };
        if read_trimmed_string(row.get("type")).unwrap_or_default() != "function_call_output" {
            continue;
        }
        let call_id = read_trimmed_string(row.get("call_id")).unwrap_or_default();
        if !name_by_id.contains_key(&call_id) {
            continue;
        }
        let output = row
            .get("output")
            .and_then(|entry| entry.as_str())
            .unwrap_or("");
        for marker in collect_markers_from_text(output) {
            push_unique_marker(&mut observed_markers, marker.as_str());
        }
    }
    let missing: Vec<String> = required_markers
        .into_iter()
        .filter(|marker| !observed_markers.iter().any(|observed| observed == marker))
        .collect();
    if missing.is_empty() {
        WindsurfRccMarkerContractOutput {
            ok: true,
            missing: None,
        }
    } else {
        WindsurfRccMarkerContractOutput {
            ok: false,
            missing: Some(missing),
        }
    }
}

fn read_tool_call_arguments_map(raw_args: &Value) -> Result<Map<String, Value>, String> {
    if let Some(text) = raw_args.as_str() {
        let parsed = serde_json::from_str::<Value>(text).map_err(|_| {
            "[windsurf] assistant tool call arguments must be valid json object".to_string()
        })?;
        return parsed.as_object().cloned().ok_or_else(|| {
            "[windsurf] assistant tool call arguments must be valid json object".to_string()
        });
    }
    raw_args.as_object().cloned().ok_or_else(|| {
        "[windsurf] assistant tool call arguments must be valid json object".to_string()
    })
}

fn parse_cascade_assistant_turn_impl(
    input: WindsurfParseCascadeAssistantTurnInput,
) -> Result<Value, String> {
    let candidate = input.candidate.as_object().cloned().unwrap_or_default();
    let raw_content = candidate
        .get("content")
        .and_then(|entry| entry.as_array())
        .cloned()
        .unwrap_or_default();
    let raw_top_level_tool_calls = candidate
        .get("tool_calls")
        .and_then(|entry| entry.as_array())
        .cloned()
        .unwrap_or_default();
    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut seen_tool_call_ids = HashSet::new();

    if let Some(reasoning) = candidate
        .get("reasoning_content")
        .and_then(|entry| entry.as_str())
    {
        if !reasoning.is_empty() {
            reasoning_parts.push(reasoning.to_string());
        }
    }
    if let Some(content) = candidate.get("content").and_then(|entry| entry.as_str()) {
        if !content.is_empty() {
            text_parts.push(content.to_string());
        }
    }

    for entry in raw_top_level_tool_calls {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let fn_row = row
            .get("function")
            .and_then(|entry| entry.as_object())
            .cloned()
            .unwrap_or_default();
        let call_id = {
            let primary = read_trimmed_string(row.get("id")).unwrap_or_default();
            if primary.is_empty() {
                read_trimmed_string(row.get("call_id")).unwrap_or_default()
            } else {
                primary
            }
        };
        let name = {
            let primary = read_trimmed_string(fn_row.get("name")).unwrap_or_default();
            if primary.is_empty() {
                read_trimmed_string(row.get("name")).unwrap_or_default()
            } else {
                primary
            }
        };
        let raw_args = fn_row
            .get("arguments")
            .cloned()
            .or_else(|| row.get("arguments").cloned())
            .or_else(|| {
                row.get("input")
                    .and_then(|entry| entry.as_str())
                    .map(|text| json!({"input": text}))
            })
            .or_else(|| row.get("input").cloned())
            .unwrap_or(Value::Null);
        let parsed_args = read_tool_call_arguments_map(&raw_args)?;
        if name.is_empty() {
            return Err("[windsurf] assistant tool call missing name".to_string());
        }
        if call_id.is_empty() {
            return Err("[windsurf] assistant tool call missing call_id".to_string());
        }
        if seen_tool_call_ids.contains(&call_id) {
            return Err(
                "[windsurf] duplicate assistant tool call id in assistant candidate".to_string(),
            );
        }
        seen_tool_call_ids.insert(call_id.clone());
        tool_calls.push(json!({
            "id": call_id,
            "type": "function",
            "function": { "name": name, "arguments": stable_stringify(&Value::Object(parsed_args)) }
        }));
    }

    let has_top_level_tool_calls = !tool_calls.is_empty();
    for item in raw_content {
        let Some(block) = item.as_object() else {
            continue;
        };
        let type_name = read_trimmed_string(block.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if type_name == "text" || type_name == "output_text" {
            let text = read_trimmed_string(block.get("text")).unwrap_or_default();
            if !text.is_empty() {
                text_parts.push(text);
            }
            continue;
        }
        if type_name == "function_call_output"
            || type_name == "custom_tool_call_output"
            || type_name == "tool_result"
        {
            return Err(
                "[windsurf] assistant candidate mixed content with embedded tool result block"
                    .to_string(),
            );
        }
        if type_name != "tool_call"
            && type_name != "function_call"
            && type_name != "custom_tool_call"
        {
            continue;
        }
        if has_top_level_tool_calls {
            return Err(
                "[windsurf] assistant response mixed top-level tool_calls with content tool call"
                    .to_string(),
            );
        }
        let call_id = {
            let primary = read_trimmed_string(block.get("call_id")).unwrap_or_default();
            if primary.is_empty() {
                read_trimmed_string(block.get("id")).unwrap_or_default()
            } else {
                primary
            }
        };
        let name = read_trimmed_string(block.get("name")).unwrap_or_default();
        if name.is_empty() {
            return Err("[windsurf] assistant tool call missing name".to_string());
        }
        if call_id.is_empty() {
            return Err("[windsurf] assistant tool call missing call_id".to_string());
        }
        let parsed_args = if type_name == "custom_tool_call" {
            if let Some(text) = block.get("input").and_then(|entry| entry.as_str()) {
                let mut out = Map::new();
                out.insert("input".to_string(), Value::String(text.to_string()));
                out
            } else {
                block
                    .get("input")
                    .and_then(|entry| entry.as_object())
                    .cloned()
                    .unwrap_or_default()
            }
        } else if type_name == "function_call"
            && block
                .get("arguments")
                .and_then(|entry| entry.as_str())
                .is_some()
        {
            read_tool_call_arguments_map(block.get("arguments").unwrap())?
        } else {
            block
                .get("arguments")
                .and_then(|entry| entry.as_object())
                .cloned()
                .ok_or_else(|| {
                    "[windsurf] assistant tool call arguments must be object".to_string()
                })?
        };
        if seen_tool_call_ids.contains(&call_id) {
            return Err(
                "[windsurf] duplicate assistant tool call id in assistant candidate".to_string(),
            );
        }
        seen_tool_call_ids.insert(call_id.clone());
        tool_calls.push(json!({
            "id": call_id,
            "type": "function",
            "function": { "name": name, "arguments": stable_stringify(&Value::Object(parsed_args)) }
        }));
    }

    let mut raw_text = text_parts.join("");
    if Regex::new(r"</?\s*(?:tool_call|function_call)\b")
        .expect("valid legacy tool regex")
        .is_match(&raw_text)
    {
        return Err(
            "[windsurf] legacy tool_call text protocol is not allowed in cascade assistant content"
                .to_string(),
        );
    }
    let rcc_harvest = harvest_rcc_tool_calls(WindsurfRccHarvestInput {
        text: raw_text.clone(),
        rcc_text_tools: input.rcc_text_tools,
    });
    if let Some(error) = rcc_harvest.error {
        return Err(error.message);
    }
    if !rcc_harvest.tool_calls.is_empty() {
        if !tool_calls.is_empty() {
            return Err(
                "[windsurf] native trajectory tool call conflicts with RCC text tool call"
                    .to_string(),
            );
        }
        tool_calls.extend(rcc_harvest.tool_calls);
        raw_text = rcc_harvest.text;
    }
    let reasoning_content = reasoning_parts.join("");
    if raw_text.is_empty() && tool_calls.is_empty() && reasoning_content.is_empty() {
        return Err("[windsurf] empty assistant completion".to_string());
    }
    let mut assistant = Map::new();
    assistant.insert("role".to_string(), Value::String("assistant".to_string()));
    assistant.insert("content".to_string(), Value::String(raw_text));
    if !reasoning_content.is_empty() {
        assistant.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    if !tool_calls.is_empty() {
        assistant.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    Ok(Value::Object(assistant))
}

fn normalize_tool_result_content_value(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if content.is_null() {
        return String::new();
    }
    if let Some(items) = content.as_array() {
        let mut parts: Vec<String> = Vec::new();
        let mut saw_structured_block = false;
        for item in items {
            let Some(block) = item.as_object() else {
                continue;
            };
            let type_name = read_trimmed_string(block.get("type"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if type_name == "text" || type_name == "output_text" {
                saw_structured_block = true;
                let text = read_trimmed_string(block.get("text")).unwrap_or_default();
                if !text.is_empty() {
                    parts.push(text);
                }
                continue;
            }
            if type_name == "function_call_output"
                || type_name == "tool_result"
                || type_name == "custom_tool_call_output"
                || type_name == "tool_message"
            {
                saw_structured_block = true;
                let nested =
                    if let Some(text) = block.get("output").and_then(|entry| entry.as_str()) {
                        text.to_string()
                    } else if block.get("output").is_none()
                        || block.get("output").is_some_and(|entry| entry.is_null())
                    {
                        if let Some(text) = block.get("content").and_then(|entry| entry.as_str()) {
                            text.to_string()
                        } else if block.get("content").is_none()
                            || block.get("content").is_some_and(|entry| entry.is_null())
                        {
                            String::new()
                        } else {
                            serde_json::to_string(block.get("content").unwrap()).unwrap_or_default()
                        }
                    } else {
                        serde_json::to_string(block.get("output").unwrap()).unwrap_or_default()
                    };
                if !nested.is_empty() {
                    parts.push(nested);
                }
            }
        }
        if saw_structured_block {
            return parts.join("");
        }
    }
    serde_json::to_string(content).unwrap_or_default()
}

fn extract_nested_tool_result_call_id_value(content: &Value) -> String {
    let Some(items) = content.as_array() else {
        return String::new();
    };
    for item in items {
        let Some(block) = item.as_object() else {
            continue;
        };
        for key in ["tool_call_id", "call_id", "tool_use_id", "id"] {
            let value = read_trimmed_string(block.get(key)).unwrap_or_default();
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn parse_cascade_tool_result_turn_impl(
    input: WindsurfParseCascadeToolResultTurnInput,
) -> Result<Value, String> {
    let msg = input.message.as_object().cloned().unwrap_or_default();
    let call_id = {
        let primary = read_trimmed_string(msg.get("tool_call_id")).unwrap_or_default();
        if !primary.is_empty() {
            primary
        } else {
            let secondary = read_trimmed_string(msg.get("id")).unwrap_or_default();
            if !secondary.is_empty() {
                secondary
            } else {
                extract_nested_tool_result_call_id_value(msg.get("content").unwrap_or(&Value::Null))
            }
        }
    };
    let name = read_trimmed_string(msg.get("name")).unwrap_or_default();
    let output = normalize_tool_result_content_value(msg.get("content").unwrap_or(&Value::Null));
    let matched_calls = input.matched_calls.as_object().cloned().unwrap_or_default();
    let matched_name = matched_calls
        .get(&call_id)
        .and_then(|entry| entry.as_object())
        .and_then(|row| row.get("name"))
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .to_string();
    if call_id.is_empty() || matched_name.is_empty() {
        return Err(
            "[windsurf] orphan tool_result without matching assistant tool call".to_string(),
        );
    }
    let annotated_output = if matched_name == "Read"
        && !output.is_empty()
        && !Regex::new(r"^\s*\d+\t")
            .expect("valid line regex")
            .is_match(&output)
        && ((Regex::new(r"(?i)(?:file )?(?:content )?(?:unchanged|cached)")
            .expect("valid cached regex")
            .is_match(&output)
            && output.len() < 2000)
            || output.to_ascii_lowercase().contains("truncated")
            || output.contains("截断")
            || output.contains("丢失"))
    {
        format!("{output}\n\n[WindsurfAPI note: This Read result does not prove the full file body is available in the current conversation. If the task depends on full file contents, use Read with offset/limit or another content-bearing tool result before returning PASS.]")
    } else {
        output
    };
    Ok(json!({
        "type": "function_call_output",
        "call_id": call_id,
        "name": if name.is_empty() { matched_name } else { name },
        "output": annotated_output,
    }))
}

fn normalize_semantic_text_content_value(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(items) = content.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in items {
        let Some(block) = item.as_object() else {
            continue;
        };
        let type_name = read_trimmed_string(block.get("type"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if type_name == "input_text" || type_name == "output_text" || type_name == "text" {
            let text = read_trimmed_string(block.get("text")).unwrap_or_default();
            if !text.is_empty() {
                parts.push(text);
            }
        }
    }
    parts.join("")
}

fn parse_cascade_semantic_roundtrip_impl(
    input: WindsurfParseCascadeSemanticRoundtripInput,
) -> Result<Vec<Value>, String> {
    let mut out: Vec<Value> = Vec::new();
    let mut matched_calls: Map<String, Value> = Map::new();
    let mut completed_tool_call_ids: HashSet<String> = HashSet::new();
    for item in input.messages {
        let Some(msg) = item.as_object() else {
            continue;
        };
        let role = read_trimmed_string(msg.get("role"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if role == "user" {
            out.push(json!({"type":"user","text": normalize_semantic_text_content_value(msg.get("content").unwrap_or(&Value::Null))}));
            continue;
        }
        if role == "assistant" {
            let text = msg
                .get("content")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_string();
            let candidate = json!({
                "content": msg.get("content").cloned().unwrap_or(Value::String(text)),
                "tool_calls": msg.get("tool_calls").cloned().unwrap_or(Value::Array(Vec::new())),
                "reasoning_content": msg.get("reasoning_content").cloned().unwrap_or(Value::String(String::new()))
            });
            let parsed =
                parse_cascade_assistant_turn_impl(WindsurfParseCascadeAssistantTurnInput {
                    candidate,
                    rcc_text_tools: Vec::new(),
                })?;
            let parsed_obj = parsed.as_object().cloned().unwrap_or_default();
            let content_text = parsed_obj
                .get("content")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_string();
            let tool_calls = parsed_obj
                .get("tool_calls")
                .and_then(|entry| entry.as_array())
                .cloned()
                .unwrap_or_default();
            let mut semantic_tool_calls = Vec::new();
            for call in tool_calls {
                let Some(row) = call.as_object() else {
                    continue;
                };
                let fn_row = row
                    .get("function")
                    .and_then(|entry| entry.as_object())
                    .cloned()
                    .unwrap_or_default();
                let call_id = read_trimmed_string(row.get("id")).unwrap_or_default();
                let name = read_trimmed_string(fn_row.get("name")).unwrap_or_default();
                let arguments_json =
                    read_trimmed_string(fn_row.get("arguments")).unwrap_or_default();
                let arguments = serde_json::from_str::<Value>(&arguments_json)
                    .unwrap_or_else(|_| Value::Object(Map::new()));
                semantic_tool_calls
                    .push(json!({"call_id": call_id, "name": name, "arguments": arguments}));
                matched_calls.insert(call_id, json!({"name": name}));
            }
            let mut assistant = Map::new();
            assistant.insert("type".to_string(), Value::String("assistant".to_string()));
            assistant.insert("text".to_string(), Value::String(content_text));
            if !semantic_tool_calls.is_empty() {
                assistant.insert("tool_calls".to_string(), Value::Array(semantic_tool_calls));
            }
            out.push(Value::Object(assistant));
            continue;
        }
        if role == "tool" {
            let parsed =
                parse_cascade_tool_result_turn_impl(WindsurfParseCascadeToolResultTurnInput {
                    message: Value::Object(msg.clone()),
                    matched_calls: Value::Object(matched_calls.clone()),
                })?;
            let call_id = parsed
                .get("call_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_string();
            if completed_tool_call_ids.contains(&call_id) {
                return Err("[windsurf] duplicate tool_result for completed tool call".to_string());
            }
            out.push(parsed);
            completed_tool_call_ids.insert(call_id);
        }
    }
    Ok(out)
}

#[napi]
pub fn build_windsurf_rcc_tool_result_context_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfRccProjectionInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = WindsurfRccToolResultContextOutput {
        context: build_context(input),
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn assert_windsurf_rcc_tool_result_marker_contract_json(
    input_json: String,
) -> NapiResult<String> {
    let input: WindsurfRccProjectionInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = marker_contract(input);
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn build_windsurf_cascade_prompt_text_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfCascadePromptInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let prompt = build_cascade_prompt(input).map_err(napi::Error::from_reason)?;
    let output = WindsurfCascadePromptOutput { prompt };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn build_windsurf_rcc_tool_guidance_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfRccProjectionInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = WindsurfRccToolGuidanceOutput {
        guidance: build_rcc_tool_guidance(&input.rcc_text_tools),
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn build_windsurf_rcc_pending_tool_reminder_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfRccPendingReminderInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = WindsurfRccPendingReminderOutput {
        reminder: build_pending_tool_reminder(input),
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn harvest_windsurf_rcc_tool_calls_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfRccHarvestInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = harvest_rcc_tool_calls(input);
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn build_windsurf_native_tool_signature_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfNativeToolSignatureInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = WindsurfNativeToolSignatureOutput {
        signature: build_native_tool_signature(&input.kind, &input.payload),
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn decide_windsurf_completed_native_tool_call_pairing_json(
    input_json: String,
) -> NapiResult<String> {
    let input: WindsurfCompletedNativePairingInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let strategy = "completed_native_tool_result_pairing".to_string();
    let raw_call = input.raw_call.as_object();
    let result = raw_call
        .and_then(|row| row.get("result"))
        .and_then(|entry| entry.as_str())
        .unwrap_or("");
    if !result.is_empty() {
        let output = WindsurfCompletedNativePairingOutput {
            action: "skip_completed_native_tool_call".to_string(),
            reason: "inline_result_present".to_string(),
            strategy,
        };
        return serde_json::to_string(&output)
            .map_err(|error| napi::Error::from_reason(error.to_string()));
    }
    let raw_id = raw_call
        .and_then(|row| row.get("id"))
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let completed_ids: HashSet<String> = input.completed_call_ids.into_iter().collect();
    if !raw_id.is_empty() && completed_ids.contains(&raw_id) {
        let output = WindsurfCompletedNativePairingOutput {
            action: "skip_completed_native_tool_call".to_string(),
            reason: "call_id_already_completed".to_string(),
            strategy,
        };
        return serde_json::to_string(&output)
            .map_err(|error| napi::Error::from_reason(error.to_string()));
    }
    let raw_name = raw_call
        .and_then(|row| row.get("name"))
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw_name.is_empty() {
        let output = WindsurfCompletedNativePairingOutput {
            action: "emit_tool_call".to_string(),
            reason: "not_completed_native_tool_call".to_string(),
            strategy,
        };
        return serde_json::to_string(&output)
            .map_err(|error| napi::Error::from_reason(error.to_string()));
    }
    let raw_args_json = raw_call
        .and_then(|row| row.get("argumentsJson"))
        .and_then(|entry| entry.as_str())
        .unwrap_or("{}");
    if let Ok(parsed_args) = serde_json::from_str::<Value>(raw_args_json) {
        if parsed_args.is_object() {
            let signature = build_native_tool_signature(&raw_name, &parsed_args);
            let completed_signatures: HashSet<String> =
                input.completed_signatures.into_iter().collect();
            if completed_signatures.contains(&signature) {
                let output = WindsurfCompletedNativePairingOutput {
                    action: "skip_completed_native_tool_call".to_string(),
                    reason: "signature_already_completed".to_string(),
                    strategy,
                };
                return serde_json::to_string(&output)
                    .map_err(|error| napi::Error::from_reason(error.to_string()));
            }
        }
    }
    let output = WindsurfCompletedNativePairingOutput {
        action: "emit_tool_call".to_string(),
        reason: "not_completed_native_tool_call".to_string(),
        strategy,
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn build_windsurf_native_additional_step_payloads_json(
    input_json: String,
) -> NapiResult<String> {
    let input: WindsurfNativeAdditionalStepPayloadsInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let output = build_native_additional_step_payloads(input);
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "parseCascadeAssistantTurnJson")]
pub fn parse_cascade_assistant_turn_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfParseCascadeAssistantTurnInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let assistant = parse_cascade_assistant_turn_impl(input).map_err(napi::Error::from_reason)?;
    let output = WindsurfParseCascadeAssistantTurnOutput { assistant };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "parseCascadeToolResultTurnJson")]
pub fn parse_cascade_tool_result_turn_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfParseCascadeToolResultTurnInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let tool_result =
        parse_cascade_tool_result_turn_impl(input).map_err(napi::Error::from_reason)?;
    let output = WindsurfParseCascadeToolResultTurnOutput { tool_result };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi(js_name = "parseCascadeSemanticRoundtripJson")]
pub fn parse_cascade_semantic_roundtrip_json(input_json: String) -> NapiResult<String> {
    let input: WindsurfParseCascadeSemanticRoundtripInput = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let semantic_conversation =
        parse_cascade_semantic_roundtrip_impl(input).map_err(napi::Error::from_reason)?;
    let output = WindsurfParseCascadeSemanticRoundtripOutput {
        semantic_conversation,
    };
    serde_json::to_string(&output).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    #[test]
    fn builds_rcc_tool_result_context_with_markers() {
        let input = WindsurfRccProjectionInput {
            semantic_conversation: vec![
                json!({"type":"assistant","tool_calls":[{"call_id":"call_patch","name":"apply_patch"}]}),
                json!({"type":"function_call_output","call_id":"call_patch","output":"BEGIN_X\nbody\nEND_X"}),
            ],
            rcc_text_tools: vec![json!({"type":"function","function":{"name":"apply_patch"}})],
        };
        let context = build_context(input);
        assert!(context.contains(RCC_TOOL_RESULT_GUIDANCE));
        assert!(context.contains("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">"));
        assert!(context.contains("Markers: BEGIN_X, END_X."));
    }

    #[test]
    fn apply_patch_guidance_prefers_direct_apply_patch_over_shell_writes() {
        let guidance = build_rcc_tool_guidance(&[json!({
            "type": "function",
            "function": {
                "name": "apply_patch",
                "description": "patch files",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filePath": { "type": "string" },
                        "patch": { "type": "string" }
                    },
                    "required": ["filePath", "patch"]
                }
            }
        })]);

        assert!(guidance.contains("For file edits, call apply_patch directly."));
        assert!(guidance.contains("Do not use shell_command, exec_command, python, cat, tee, heredoc, or sed-style command writing for file editing."));
        assert!(guidance.contains(
            "After tool results arrive, use that execution feedback to continue reasoning."
        ));
    }

    #[test]
    fn marker_contract_reports_missing_marker() {
        let input = WindsurfRccProjectionInput {
            semantic_conversation: vec![
                json!({"type":"assistant","tool_calls":[{"call_id":"call_patch","name":"apply_patch"}]}),
                json!({"type":"function_call_output","call_id":"call_patch","output":"BEGIN_X\nEND_X"}),
                json!({"type":"user","text":"include BEGIN_X, MIDDLE_X, END_X"}),
            ],
            rcc_text_tools: vec![json!({"function":{"name":"apply_patch"}})],
        };
        let result = marker_contract(input);
        assert!(!result.ok);
        assert_eq!(result.missing, Some(vec!["MIDDLE_X".to_string()]));
    }

    #[test]
    fn builds_native_additional_step_payloads_with_observation() {
        let output = build_native_additional_step_payloads(
            WindsurfNativeAdditionalStepPayloadsInput {
                semantic_conversation: vec![
                    json!({"type":"assistant","tool_calls":[{"call_id":"native:run_command:1","name":"shell_command","arguments":{"command":"pwd","workdir":"/tmp/ws"}}]}),
                    json!({"type":"function_call_output","call_id":"native:run_command:1","output":"/tmp/ws\n"}),
                ],
                native_tool_names: vec!["shell_command".to_string()],
            },
        );
        assert_eq!(output.steps.len(), 1);
        assert_eq!(output.steps[0].kind, "run_command");
        assert_eq!(
            output.steps[0].payload,
            json!({
                "command_line": "pwd",
                "cwd": "/tmp/ws",
                "blocking": true,
                "full_output": "/tmp/ws\n",
                "stdout": "/tmp/ws\n",
                "exit_code": 0
            })
        );
    }

    #[test]
    fn build_cascade_prompt_keeps_latest_true_user_task_for_previous_response_resume_shape() {
        let prompt = build_cascade_prompt(WindsurfCascadePromptInput {
            messages: vec![
                json!({"role":"user","content":"Use exec_command to run pwd. Do not answer directly. Call the tool."}),
                json!({"role":"assistant","content":"## Running command\n\nI’ll run `pwd` in the current workspace now."}),
                json!({"role":"assistant","content":"","tool_calls":[{"id":"native:run_command:3","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}]}),
                json!({"role":"tool","tool_call_id":"native:run_command:3","content":"/Users/fanzhang/Documents/github/routecodex\n"}),
            ],
            semantic_conversation: vec![
                json!({"type":"user","text":"Use exec_command to run pwd. Do not answer directly. Call the tool."}),
                json!({"type":"assistant","text":"## Running command\n\nI’ll run `pwd` in the current workspace now."}),
                json!({"type":"assistant","text":"","tool_calls":[{"call_id":"native:run_command:3","name":"exec_command","arguments":{"cmd":"pwd"}}]}),
                json!({"type":"function_call_output","call_id":"native:run_command:3","name":"exec_command","output":"/Users/fanzhang/Documents/github/routecodex"}),
            ],
            rcc_text_tools: vec![],
            rcc_guidance: String::new(),
            rcc_pending_reminder: String::new(),
            max_history_bytes: 100_000,
            windsurf_native_tool_names: vec!["exec_command".to_string()],
        }).expect("prompt");

        let latest_human = prompt
            .split("<human>\n")
            .last()
            .and_then(|segment| segment.split("\n</human>").next())
            .map(|segment| segment.to_string())
            .expect("latest human");

        assert_eq!(
            latest_human.trim(),
            "Use exec_command to run pwd. Do not answer directly. Call the tool."
        );
        assert!(prompt.contains("<human>\nUse exec_command to run pwd. Do not answer directly. Call the tool.\n</human>"));
        assert!(prompt.contains("<assistant>\n## Running command\n\nI’ll run `pwd` in the current workspace now.\n</assistant>"));
        assert!(!prompt.contains("<human>\n/Users/fanzhang/Documents/github/routecodex\n</human>"));
    }

    #[test]
    fn build_cascade_prompt_appends_native_tool_result_after_latest_user_for_submit_continuation() {
        let prompt = build_cascade_prompt(WindsurfCascadePromptInput {
            messages: vec![
                json!({"role":"user","content":"Use the shell_command tool to run exactly: pwd."}),
                json!({"role":"assistant","content":"","tool_calls":[{"id":"native:run_command:3","type":"function","function":{"name":"run_command","arguments":"{\"command_line\":\"pwd\",\"cwd\":\"/Users/fanzhang/Documents/github/routecodex\"}"}}]}),
                json!({"role":"tool","tool_call_id":"native:run_command:3","content":"/Users/fanzhang/Documents/github/routecodex\n"}),
            ],
            semantic_conversation: vec![
                json!({"type":"user","text":"Use the shell_command tool to run exactly: pwd."}),
                json!({"type":"assistant","text":"","tool_calls":[{"call_id":"native:run_command:3","name":"run_command","arguments":{"command_line":"pwd","cwd":"/Users/fanzhang/Documents/github/routecodex"}}]}),
                json!({"type":"function_call_output","call_id":"native:run_command:3","name":"run_command","output":"/Users/fanzhang/Documents/github/routecodex\n"}),
            ],
            rcc_text_tools: vec![],
            rcc_guidance: String::new(),
            rcc_pending_reminder: String::new(),
            max_history_bytes: 100_000,
            windsurf_native_tool_names: vec!["run_command".to_string()],
        }).expect("prompt");

        let latest_human = prompt
            .split("<human>\n")
            .last()
            .and_then(|segment| segment.split("\n</human>").next())
            .map(|segment| segment.to_string())
            .expect("latest human");

        assert!(latest_human.contains("Use the shell_command tool to run exactly: pwd."));
        assert!(latest_human.contains("/Users/fanzhang/Documents/github/routecodex"));
    }

    #[test]
    fn build_cascade_prompt_preserves_rcc_tool_call_and_result_in_history() {
        let prompt = build_cascade_prompt(WindsurfCascadePromptInput {
            messages: vec![],
            semantic_conversation: vec![
                json!({"type":"user","text":"Patch the file."}),
                json!({"type":"assistant","text":"","tool_calls":[{"call_id":"call_patch","name":"apply_patch","arguments":{"filePath":"src/a.ts","patch":"+ value"}}]}),
                json!({"type":"function_call_output","call_id":"call_patch","name":"apply_patch","output":"patch applied"}),
                json!({"type":"user","text":"Continue."}),
            ],
            rcc_text_tools: vec![json!({"type":"function","function":{"name":"apply_patch"}})],
            rcc_guidance: "Text tool calling format (STRICT)".to_string(),
            rcc_pending_reminder: String::new(),
            max_history_bytes: 100_000,
            windsurf_native_tool_names: vec!["run_command".to_string()],
        }).expect("prompt");

        assert!(prompt.contains("Text tool calling format (STRICT)"));
        assert!(prompt.contains("<|RCC|tool_calls>"));
        assert!(prompt.contains("<|RCC|invoke id=\"call_patch\" name=\"apply_patch\">"));
        assert!(prompt.contains("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">"));
        assert!(prompt.contains("patch applied"));
        assert!(prompt.contains("Completed RCC text tool calls already have results: call_patch (apply_patch). Do not repeat an identical completed tool call"));
        let prefix = prompt
            .split("<human>\n")
            .next()
            .map(|segment| segment.to_string())
            .expect("prefix");
        assert!(!prefix.contains("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">"));
        assert!(!prompt
            .split("The following is a multi-turn conversation.")
            .last()
            .unwrap_or("")
            .contains("Text tool calling format (STRICT)"));
        let latest_human = prompt
            .split("<human>\n")
            .last()
            .and_then(|segment| segment.split("\n</human>").next())
            .map(|segment| segment.to_string())
            .expect("latest human");
        assert!(latest_human.contains("Continue."));
        assert!(!latest_human.contains(RCC_TOOL_RESULT_GUIDANCE));
        assert!(!latest_human.contains("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">"));
        assert!(
            prompt.find("Patch the file.").unwrap() < prompt.find("<|RCC|tool_calls>").unwrap()
        );
        assert!(
            prompt.find("<|RCC|tool_calls>").unwrap()
                < prompt
                    .find("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">")
                    .unwrap()
        );
        assert!(
            prompt
                .find("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">")
                .unwrap()
                < prompt.find("Continue.").unwrap()
        );
    }

    #[test]
    fn build_cascade_prompt_keeps_rcc_result_after_latest_user_when_native_result_is_tail() {
        let prompt = build_cascade_prompt(WindsurfCascadePromptInput {
            messages: vec![],
            semantic_conversation: vec![
                json!({"type":"user","text":"Run command, then patch."}),
                json!({"type":"assistant","text":"","tool_calls":[{"call_id":"native:run_command:3","name":"run_command","arguments":{"command_line":"pwd"}}]}),
                json!({"type":"function_call_output","call_id":"native:run_command:3","name":"run_command","output":"/repo\n"}),
                json!({"type":"function_call_output","call_id":"call_patch","name":"apply_patch","output":"patch applied"}),
            ],
            rcc_text_tools: vec![json!({"type":"function","function":{"name":"apply_patch"}})],
            rcc_guidance: String::new(),
            rcc_pending_reminder: String::new(),
            max_history_bytes: 100_000,
            windsurf_native_tool_names: vec!["run_command".to_string()],
        }).expect("prompt");

        let latest_human = prompt
            .split("<human>\n")
            .last()
            .and_then(|segment| segment.split("\n</human>").next())
            .map(|segment| segment.to_string())
            .expect("latest human");

        assert!(latest_human.contains("Run command, then patch."));
        assert!(latest_human.contains("/repo"));
        assert!(!latest_human.contains("patch applied"));
        assert!(prompt.contains("<|RCC|tool_result id=\"call_patch\" name=\"apply_patch\">"));
        assert!(prompt.contains("patch applied"));
    }

    #[test]
    fn reparses_double_encoded_json_string_for_typed_array_parameter() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "update_plan",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plan": { "type": "array", "items": { "type": "object" } }
                    },
                    "required": ["plan"]
                }
            }
        });

        let parsed = parse_rcc_parameter_value(
            Some(&tool),
            "plan",
            "\"[{\\\"step\\\":\\\"create tmp file\\\",\\\"status\\\":\\\"in_progress\\\"},{\\\"step\\\":\\\"verify tmp file\\\",\\\"status\\\":\\\"pending\\\"}]\"",
        )
        .expect("double-encoded array should parse");

        assert_eq!(
            parsed,
            json!([
                { "step": "create tmp file", "status": "in_progress" },
                { "step": "verify tmp file", "status": "pending" }
            ])
        );
    }

    #[test]
    fn shared_read_trimmed_string_deletion_gate_removed_windsurf_tool_history_projection_local_clone(
    ) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/windsurf_tool_history_projection.rs");
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {}", path.display(), error));
        let local_clone = Regex::new(
            r"(?m)^fn\s+read_trimmed_string\s*\(\s*value:\s*Option<&Value>\s*\)\s*->\s*String\s*\{",
        )
        .unwrap();
        assert!(
            !local_clone.is_match(source.as_str()),
            "local read_trimmed_string clone still present in {}",
            path.display()
        );
        assert!(
            source.contains("use crate::shared_json_utils::read_trimmed_string")
                || source.contains("shared_json_utils::read_trimmed_string"),
            "windsurf_tool_history_projection.rs must use shared read_trimmed_string truth directly"
        );
    }
}
