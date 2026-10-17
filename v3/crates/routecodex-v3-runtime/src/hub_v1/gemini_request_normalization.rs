//! Gemini 客户端请求 -> canonical Chat 无损归一化。
//!
//! ReqInbound02 的 Gemini 分支调用本模块唯一的 public builder。standard
//! outbound projector（OpenAI Chat / Responses / Anthropic）与 T1 的 Gemini
//! projector 都直接消费其输出，因此不再需要 Gemini->X 成对 converter。
//!
//! 归一化原则：
//! - 已登记语义（role、part 类型、tool_choice、generation 标量、thinkingConfig）
//!   经 `protocol_tables` 的既有 gemini 行查询后映射到 canonical Chat。
//! - 只有实际映射成功的 source key 才从 residual 中移除。未映射的 native 字段、
//!   part siblings 与嵌套结构按 `content_index`/`part_index`/`nested_part_index`
//!   显式关联，保存在 message 级 `routecodex_chat_extension.gemini_native_fields`
//!   的有序 records 中。
//! - 缺失的 native id 保持缺失：不生成 id、filename 或 signature，不把未知
//!   part/MIME 合成为文本或媒体，也不把 no-id functionResponse 改写为 user 角色。

use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Map, Value};

const V3_GEMINI_PROTOCOL: &str = "gemini";
const GEMINI_NATIVE_FIELDS_KEY: &str = "gemini_native_fields";

/// 把 Gemini 客户端请求归一化为 canonical Chat payload（`messages` + 已登记标量）。
pub fn build_v3_chat_canonical_request_from_gemini_payload(
    payload: &Value,
) -> Result<Value, String> {
    let root = payload.as_object().ok_or_else(|| {
        "Gemini request payload must be an object before Chat canonicalization".to_string()
    })?;
    let contents = root
        .get("contents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Gemini request contents must be an array before Chat canonicalization".to_string()
        })?;

    let mut messages: Vec<Value> = Vec::new();
    if let Some(system_instruction) = root.get("systemInstruction") {
        if let (Some(content), Some(parts)) = (
            system_instruction.as_object(),
            system_instruction.get("parts").and_then(Value::as_array),
        ) {
            append_gemini_content_turn(&mut messages, 0, content, "system", parts)?;
        } else if let Some(text) = gemini_system_instruction_text(system_instruction)? {
            messages.push(json!({"role":"system","content":text}));
        }
    }
    for (content_index, content) in contents.iter().enumerate() {
        let content = content.as_object().ok_or_else(|| {
            "Gemini content must be an object before Chat canonicalization".to_string()
        })?;
        let raw_role = content
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let hub_role = gemini_chat_role(raw_role)?;
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "Gemini content parts must be an array before Chat canonicalization".to_string()
            })?;
        append_gemini_content_turn(&mut messages, content_index, content, hub_role, parts)?;
    }
    if messages.is_empty() {
        return Err("Gemini Chat canonicalization produced no messages".to_string());
    }

    let mut request = Map::new();
    let mut root_residual = root.clone();
    root_residual.remove("contents");
    if let Some(instruction) = root_residual
        .get_mut("systemInstruction")
        .and_then(Value::as_object_mut)
    {
        instruction.remove("parts");
        if instruction.is_empty() {
            root_residual.remove("systemInstruction");
        }
    } else {
        root_residual.remove("systemInstruction");
    }
    root_residual.remove("tools");
    root_residual.remove("toolConfig");
    root_residual.remove("generationConfig");
    root_residual.remove("model");
    for key in [
        "temperature",
        "top_p",
        "top_k",
        "max_completion_tokens",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "logprobs",
        "top_logprobs",
        "seed",
        "reasoning_include_thoughts",
        "reasoning_budget_tokens",
        "reasoning_thinking_mode",
        "reasoning_effort",
        "tool_choice",
    ] {
        root_residual.remove(key);
    }
    if let Some(model) = root.get("model") {
        request.insert("model".to_string(), model.clone());
    }
    request.insert("messages".to_string(), Value::Array(messages));
    let (tools, tool_declarations) = build_gemini_canonical_tools_with_bindings(root.get("tools"))?;
    if let Some(tools) = tools {
        request.insert("tools".to_string(), tools);
    }
    let tool_config = build_gemini_canonical_tool_choice_with_bindings(root.get("toolConfig"))?;
    if let Some(tool_choice) = tool_config.choice {
        request.insert("tool_choice".to_string(), tool_choice);
    }
    apply_gemini_generation_config(root.get("generationConfig"), &mut request)?;
    let mut request_fields = root_residual;
    let generation_mapped = [
        "temperature",
        "top_p",
        "top_k",
        "max_completion_tokens",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "logprobs",
        "top_logprobs",
        "seed",
        "reasoning_include_thoughts",
        "reasoning_budget_tokens",
        "reasoning_thinking_mode",
        "reasoning_effort",
    ];
    if let Some(tools_declaration_fields) = tool_declarations {
        request_fields.insert("tools".to_string(), tools_declaration_fields);
    }
    if let Some(tool_config) = tool_config.residual {
        request_fields.insert("toolConfig".to_string(), tool_config);
    }
    if request.contains_key("generation")
        || generation_mapped
            .iter()
            .any(|key| request.contains_key(*key))
    {
        request_fields.insert(
            "generationConfig".to_string(),
            request
                .get("generation")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
    }
    if !request_fields.is_empty() {
        request.insert(
            "routecodex_chat_extension".to_string(),
            json!({GEMINI_NATIVE_FIELDS_KEY: [{
                "kind": "request",
                "fields": Value::Object(request_fields),
            }]}),
        );
    }
    Ok(Value::Object(request))
}

/// 查 role_map 的 gemini 列，得到 canonical hub role。表是映射真源。
fn gemini_chat_role(raw_role: &str) -> Result<&'static str, String> {
    let role = if raw_role.is_empty() {
        "user"
    } else {
        raw_role
    };
    table_map_value(
        V3TableKind::Role,
        V3_GEMINI_PROTOCOL,
        role,
        V3TableDirection::Inbound,
    )
    .map_err(|error| format!("Gemini role_map lookup failed: {error}"))?
    .ok_or_else(|| format!("Gemini content role '{raw_role}' has no registered inbound Chat role"))
}

/// 查 part_type_map 的 gemini 列，得到已登记 part 类型的 hub 值。未登记的
/// Gemini 字段返回 None，由相邻 container 逻辑按 residual 保留。
fn gemini_registered_part_hub(field: &str) -> Result<Option<&'static str>, String> {
    table_map_value(
        V3TableKind::PartType,
        V3_GEMINI_PROTOCOL,
        field,
        V3TableDirection::Inbound,
    )
    .map_err(|error| format!("Gemini part_type_map lookup failed: {error}"))
}

/// 构造一个 native source-association record：显式记录 source 结构位置、本轮已实现
/// 的固定 binding、被 normalization 抹掉的容器 presence，以及未映射字段。
fn native_record(
    content_index: usize,
    part_index: Option<usize>,
    nested_part_index: Option<usize>,
    bindings: Vec<Value>,
    containers: Vec<Value>,
    fields: Map<String, Value>,
) -> Value {
    let mut record = Map::new();
    record.insert("content_index".to_string(), json!(content_index));
    if let Some(part_index) = part_index {
        record.insert("part_index".to_string(), json!(part_index));
    }
    if let Some(nested_part_index) = nested_part_index {
        record.insert("nested_part_index".to_string(), json!(nested_part_index));
    }
    record.insert("bindings".to_string(), Value::Array(bindings));
    record.insert("containers".to_string(), Value::Array(containers));
    record.insert("fields".to_string(), Value::Object(fields));
    Value::Object(record)
}

/// 一条固定映射 binding：source 路径 -> 承载该 record 的 canonical 对象内的路径。
/// encoding 只用本轮实现的 `identity`/`json_text` 与既有媒体逆向表示。
fn native_binding(source_path: &[&str], canonical_path: &[&str], encoding: &str) -> Value {
    json!({
        "source_path": source_path,
        "canonical_path": canonical_path,
        "encoding": encoding,
    })
}

/// content 容器的 record：记录 content 层 source coordinates、role presence 与
/// 未映射 content siblings；容器 record 不伪造 part_index。
fn native_container_record(
    content_index: usize,
    role_present: bool,
    fields: Map<String, Value>,
) -> Value {
    json!({
        "content_index": content_index,
        "role_present": role_present,
        "fields": Value::Object(fields),
    })
}

/// content 层未映射 siblings（role/parts 之外的原生字段）。
fn gemini_content_siblings(content: &Map<String, Value>) -> Map<String, Value> {
    let mut residual = content.clone();
    residual.remove("role");
    residual.remove("parts");
    residual
}

/// 从 part 的深拷贝中移除一条已成功映射的嵌套路径，并清理变空的对象。
fn remove_nested_path(object: &mut Map<String, Value>, path: &[&str]) {
    if path.is_empty() {
        return;
    }
    if path.len() == 1 {
        object.remove(path[0]);
        return;
    }
    let Some(child) = object.get_mut(path[0]).and_then(Value::as_object_mut) else {
        return;
    };
    remove_nested_path(child, &path[1..]);
    if child.is_empty() {
        object.remove(path[0]);
    }
}

/// residual = 原 part 去掉所有已成功映射的路径。未映射字段与 siblings 原样保留。
fn residual_part(part: &Map<String, Value>, mapped_paths: &[&[&str]]) -> Map<String, Value> {
    let mut residual = part.clone();
    for path in mapped_paths {
        remove_nested_path(&mut residual, path);
    }
    residual
}

/// 把有序 native residual records 挂到 message 的 `routecodex_chat_extension`。
fn attach_native_records(message: &mut Map<String, Value>, records: Vec<Value>) {
    if records.is_empty() {
        return;
    }
    let mut extension = Map::new();
    extension.insert(GEMINI_NATIVE_FIELDS_KEY.to_string(), Value::Array(records));
    message.insert(
        "routecodex_chat_extension".to_string(),
        Value::Object(extension),
    );
}

/// 把单条 source-association record 挂到它所关联的 canonical 对象上（content
/// part 或 tool_call）。已有 extension 字段被保留，不覆盖。
fn attach_native_record(object: &mut Value, record: Value) {
    let Some(row) = object.as_object_mut() else {
        return;
    };
    let extension = row
        .entry("routecodex_chat_extension".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(extension) = extension.as_object_mut() else {
        return;
    };
    let fields = extension
        .entry(GEMINI_NATIVE_FIELDS_KEY.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(records) = fields.as_array_mut() {
        records.push(record);
    }
}

fn append_gemini_content_turn(
    messages: &mut Vec<Value>,
    content_index: usize,
    content: &Map<String, Value>,
    hub_role: &'static str,
    parts: &[Value],
) -> Result<(), String> {
    let role_present = content.contains_key("role");
    let mut content_parts: Vec<Value> = Vec::new();
    let mut content_records: Vec<Value> = Vec::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_messages: Vec<Value> = Vec::new();
    for (part_index, part) in parts.iter().enumerate() {
        let part = part.as_object().ok_or_else(|| {
            "Gemini content part must be an object before Chat canonicalization".to_string()
        })?;
        if let Some(function_call) = part.get("functionCall") {
            let function_call = function_call
                .as_object()
                .ok_or_else(|| "Gemini functionCall must be an object".to_string())?;
            tool_calls.push(build_gemini_tool_call(
                part,
                function_call,
                content_index,
                part_index,
            )?);
            continue;
        }
        if let Some(function_response) = part.get("functionResponse") {
            let function_response = function_response
                .as_object()
                .ok_or_else(|| "Gemini functionResponse must be an object".to_string())?;
            tool_messages.push(build_gemini_function_response_message(
                content_index,
                part_index,
                part,
                function_response,
            )?);
            continue;
        }
        let (canonical, records) = gemini_content_part(content_index, part_index, None, part)?;
        content_parts.extend(canonical);
        content_records.extend(records);
    }
    let has_tool_calls = !tool_calls.is_empty();
    let has_content_parts = !content_parts.is_empty();
    let has_content_records = !content_records.is_empty();
    let content_value = if content_parts.is_empty() {
        Value::String(String::new())
    } else {
        Value::Array(content_parts)
    };
    if hub_role == "assistant" {
        if has_tool_calls || has_content_parts || has_content_records {
            let mut message = Map::new();
            message.insert("role".to_string(), Value::String("assistant".to_string()));
            message.insert("content".to_string(), content_value);
            if has_tool_calls {
                message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let mut records = vec![native_container_record(
                content_index,
                role_present,
                gemini_content_siblings(content),
            )];
            records.extend(content_records);
            attach_native_records(&mut message, records);
            messages.push(Value::Object(message));
        }
    } else if has_content_parts || has_content_records {
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String(hub_role.to_string()));
        message.insert("content".to_string(), content_value);
        let mut records = vec![native_container_record(
            content_index,
            role_present,
            gemini_content_siblings(content),
        )];
        records.extend(content_records);
        attach_native_records(&mut message, records);
        messages.push(Value::Object(message));
    }
    for message in &mut tool_messages {
        attach_native_record(
            message,
            native_container_record(
                content_index,
                role_present,
                gemini_content_siblings(content),
            ),
        );
    }
    messages.extend(tool_messages);
    Ok(())
}

fn gemini_function_response_id(function_response: &Map<String, Value>) -> Option<&str> {
    function_response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// 把单个 Gemini part 转成 0..n 个 canonical Chat content part，并返回未映射
/// 字段的 residual。已登记 text/inlineData 经 part_type_map 确认后投影；MIME
/// 决定媒体分支（image/* -> image_url，application/pdf inlineData -> File
/// file_data，非图片 fileData -> File file_url extension）。其余原生 part/MIME
/// 不产生 canonical part，整段按 residual 保留，不做 missing-registration 拒绝。
///
/// 每个成功映射的 part 都得到一个挂在该 canonical 对象上的 source-association
/// record（即使 `fields:{}`）；只有 opaque-only part 的 record 留在 message 级。
/// `nested_part_index` 仅用于 `functionResponse.parts[]`。
fn gemini_content_part(
    content_index: usize,
    part_index: usize,
    nested_part_index: Option<usize>,
    part: &Map<String, Value>,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    if let Some(text) = part.get("text") {
        if gemini_registered_part_hub("text")?.is_some() {
            let text = text
                .as_str()
                .ok_or_else(|| "Gemini text part must be a string".to_string())?;
            let residual = residual_part(part, &[&["text"]]);
            let mut canonical = json!({"type":"text","text":text});
            attach_native_record(
                &mut canonical,
                native_record(
                    content_index,
                    Some(part_index),
                    nested_part_index,
                    vec![native_binding(&["text"], &["text"], "identity")],
                    Vec::new(),
                    residual,
                ),
            );
            return Ok((vec![canonical], Vec::new()));
        }
    }
    if let Some(inline_data) = part.get("inlineData") {
        let inline_data = inline_data
            .as_object()
            .ok_or_else(|| "Gemini inlineData must be an object".to_string())?;
        if gemini_registered_part_hub("inlineData")?.is_some() {
            if let Some(media) = gemini_inline_data_as_image_url(inline_data) {
                let residual = residual_part(
                    part,
                    &[&["inlineData", "mimeType"], &["inlineData", "data"]],
                );
                let mut canonical = media;
                attach_native_record(
                    &mut canonical,
                    native_record(
                        content_index,
                        Some(part_index),
                        nested_part_index,
                        vec![
                            native_binding(
                                &["inlineData", "mimeType"],
                                &["image_url", "url"],
                                "inline_data_uri",
                            ),
                            native_binding(
                                &["inlineData", "data"],
                                &["image_url", "url"],
                                "inline_data_uri",
                            ),
                        ],
                        Vec::new(),
                        residual,
                    ),
                );
                return Ok((vec![canonical], Vec::new()));
            }
            if let Some(file) = gemini_inline_data_as_file(inline_data) {
                let residual = residual_part(
                    part,
                    &[&["inlineData", "mimeType"], &["inlineData", "data"]],
                );
                let mut canonical = file;
                attach_native_record(
                    &mut canonical,
                    native_record(
                        content_index,
                        Some(part_index),
                        nested_part_index,
                        vec![
                            native_binding(
                                &["inlineData", "mimeType"],
                                &["file", "file_data"],
                                "file_data_uri",
                            ),
                            native_binding(
                                &["inlineData", "data"],
                                &["file", "file_data"],
                                "file_data_uri",
                            ),
                        ],
                        Vec::new(),
                        residual,
                    ),
                );
                return Ok((vec![canonical], Vec::new()));
            }
        }
        return Ok((
            Vec::new(),
            vec![gemini_opaque_part_record(
                content_index,
                part_index,
                nested_part_index,
                part,
            )],
        ));
    }
    if let Some(file_data) = part.get("fileData") {
        let file_data = file_data
            .as_object()
            .ok_or_else(|| "Gemini fileData must be an object".to_string())?;
        if let Some(media) = gemini_file_data_as_image_url(file_data) {
            let residual =
                residual_part(part, &[&["fileData", "mimeType"], &["fileData", "fileUri"]]);
            let mut canonical = media;
            attach_native_record(
                &mut canonical,
                native_record(
                    content_index,
                    Some(part_index),
                    nested_part_index,
                    vec![
                        native_binding(
                            &["fileData", "mimeType"],
                            &["image_url", "url"],
                            "file_uri",
                        ),
                        native_binding(&["fileData", "fileUri"], &["image_url", "url"], "file_uri"),
                    ],
                    Vec::new(),
                    residual,
                ),
            );
            return Ok((vec![canonical], Vec::new()));
        }
        if let Some(file) = gemini_file_data_as_file(file_data) {
            let residual = residual_part(part, &[&["fileData", "fileUri"]]);
            let mut canonical = file;
            attach_native_record(
                &mut canonical,
                native_record(
                    content_index,
                    Some(part_index),
                    nested_part_index,
                    vec![native_binding(
                        &["fileData", "fileUri"],
                        &["file", "file_url"],
                        "file_uri",
                    )],
                    Vec::new(),
                    residual,
                ),
            );
            return Ok((vec![canonical], Vec::new()));
        }
        return Ok((
            Vec::new(),
            vec![gemini_opaque_part_record(
                content_index,
                part_index,
                nested_part_index,
                part,
            )],
        ));
    }
    Ok((
        Vec::new(),
        vec![gemini_opaque_part_record(
            content_index,
            part_index,
            nested_part_index,
            part,
        )],
    ))
}

/// opaque-only part：不产生 canonical 对象，整段保留在所属 message 的同一 family。
fn gemini_opaque_part_record(
    content_index: usize,
    part_index: usize,
    nested_part_index: Option<usize>,
    part: &Map<String, Value>,
) -> Value {
    native_record(
        content_index,
        Some(part_index),
        nested_part_index,
        Vec::new(),
        Vec::new(),
        part.clone(),
    )
}

fn gemini_inline_data_as_image_url(inline_data: &Map<String, Value>) -> Option<Value> {
    let mime_type = inline_data.get("mimeType").and_then(Value::as_str)?;
    let data = inline_data.get("data").and_then(Value::as_str)?;
    if !mime_type.starts_with("image/") {
        return None;
    }
    Some(json!({
        "type":"image_url",
        "image_url":{"url":format!("data:{mime_type};base64,{data}")}
    }))
}

fn gemini_file_data_as_image_url(file_data: &Map<String, Value>) -> Option<Value> {
    let mime_type = file_data.get("mimeType").and_then(Value::as_str)?;
    let file_uri = file_data.get("fileUri").and_then(Value::as_str)?;
    if !mime_type.starts_with("image/") || file_uri.is_empty() {
        return None;
    }
    Some(json!({"type":"image_url","image_url":{"url":file_uri}}))
}

/// inlineData 的非图片文件按已确认 MIME 生成 canonical Chat File part。只对带
/// 非空 base64 data 的 `application/pdf` 使用该表示；其它 MIME 未登记，整段按
/// residual 保留，不合成文本、不伪造媒体。
fn gemini_inline_data_as_file(inline_data: &Map<String, Value>) -> Option<Value> {
    let mime_type = inline_data.get("mimeType").and_then(Value::as_str)?;
    let data = inline_data.get("data").and_then(Value::as_str)?;
    if mime_type != "application/pdf" || data.is_empty() {
        return None;
    }
    Some(json!({
        "type":"file",
        "file":{"file_data":format!("data:{mime_type};base64,{data}")}
    }))
}

/// fileData 的非图片 URI 文件保留为 canonical Chat File `file_url` extension
/// （已登记 `content.file_uri` 语义）。MIME 与 siblings 由 residual 保留，不把
/// source URI 误投成 image，也不把该 extension 当标准 Chat File 发出。
fn gemini_file_data_as_file(file_data: &Map<String, Value>) -> Option<Value> {
    let file_uri = file_data.get("fileUri").and_then(Value::as_str)?;
    let mime_type = file_data.get("mimeType").and_then(Value::as_str);
    if file_uri.is_empty() || mime_type.is_some_and(|mime| mime.starts_with("image/")) {
        return None;
    }
    Some(json!({
        "type":"file",
        "file":{"file_url":file_uri}
    }))
}

/// Gemini functionCall -> canonical Chat assistant tool_call。显式 id 原样保留；
/// 无 id 时不制造 id。args 一律用完整 JSON 文本编码，native string/number/object/
/// array/null 都保持值类型；缺少 args 时不产生 arguments，也不产生 args binding。
fn build_gemini_tool_call(
    part: &Map<String, Value>,
    function_call: &Map<String, Value>,
    content_index: usize,
    part_index: usize,
) -> Result<Value, String> {
    let name = function_call
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            "Gemini functionCall.name is required before Chat canonicalization".to_string()
        })?;
    let mut bindings = vec![native_binding(
        &["functionCall", "name"],
        &["function", "name"],
        "identity",
    )];
    let arguments = function_call.get("args").map(|args| {
        serde_json::to_string(args).expect("functionCall args must serialize to JSON text")
    });
    if arguments.is_some() {
        bindings.push(native_binding(
            &["functionCall", "args"],
            &["function", "arguments"],
            "json_text",
        ));
    }
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(arguments) = arguments {
        function.insert("arguments".to_string(), Value::String(arguments));
    }
    let mut tool_call = Map::new();
    if let Some(id) = function_call
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        tool_call.insert("id".to_string(), Value::String(id.to_string()));
        bindings.push(native_binding(&["functionCall", "id"], &["id"], "identity"));
    }
    tool_call.insert("type".to_string(), Value::String("function".to_string()));
    tool_call.insert("function".to_string(), Value::Object(function));
    let residual = residual_part(
        part,
        &[
            &["functionCall", "id"],
            &["functionCall", "name"],
            &["functionCall", "args"],
        ],
    );
    let mut tool_call = Value::Object(tool_call);
    attach_native_record(
        &mut tool_call,
        native_record(
            content_index,
            Some(part_index),
            None,
            bindings,
            Vec::new(),
            residual,
        ),
    );
    Ok(tool_call)
}

/// functionResponse.response（完整结果）与 functionResponse.parts（多模态附件）
/// 有序投影为 canonical content。response 用完整 JSON 文本编码；nested parts
/// 各自保留 native 顺序与 source association；缺少 id 时不生成 id。
fn build_gemini_function_response_message(
    content_index: usize,
    part_index: usize,
    part: &Map<String, Value>,
    function_response: &Map<String, Value>,
) -> Result<Value, String> {
    let mut parts: Vec<Value> = Vec::new();
    let mut records: Vec<Value> = Vec::new();
    let mut containers: Vec<Value> = Vec::new();
    if let Some(response) = function_response.get("response") {
        let text = serde_json::to_string(response)
            .expect("functionResponse.response must serialize to JSON text");
        parts.push(json!({"type":"text","text":text}));
    }
    if let Some(nested) = function_response.get("parts").and_then(Value::as_array) {
        if nested.is_empty() {
            containers.push(json!({
                "source_path": ["functionResponse", "parts"],
                "empty": true
            }));
        }
        for (nested_index, nested_part) in nested.iter().enumerate() {
            let nested_part = nested_part.as_object().ok_or_else(|| {
                "Gemini functionResponse.parts item must be an object".to_string()
            })?;
            let (canonical, mut opaque_records) =
                gemini_content_part(content_index, part_index, Some(nested_index), nested_part)?;
            parts.extend(canonical);
            records.append(&mut opaque_records);
        }
    }
    let content = gemini_tool_content_value(parts);
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("tool".to_string()));
    let mut bindings = Vec::new();
    if let Some(id) = gemini_function_response_id(function_response) {
        message.insert("tool_call_id".to_string(), Value::String(id.to_string()));
        bindings.push(native_binding(
            &["functionResponse", "id"],
            &["tool_call_id"],
            "identity",
        ));
    }
    if function_response.get("response").is_some() {
        let canonical_path = if matches!(content, Value::String(_)) {
            vec!["content"]
        } else {
            vec!["content", "0", "text"]
        };
        bindings.push(native_binding(
            &["functionResponse", "response"],
            &canonical_path,
            "json_text",
        ));
    }
    message.insert("content".to_string(), content);
    let mut mapped_paths: Vec<&[&str]> = vec![
        &["functionResponse", "response"],
        &["functionResponse", "parts"],
    ];
    if gemini_function_response_id(function_response).is_some() {
        mapped_paths.push(&["functionResponse", "id"]);
    }
    let residual = residual_part(part, &mapped_paths);
    let mut message_records = vec![native_record(
        content_index,
        Some(part_index),
        None,
        bindings,
        containers,
        residual,
    )];
    message_records.append(&mut records);
    attach_native_records(&mut message, message_records);
    Ok(Value::Object(message))
}

/// tool content 只有一个文本 part 时保持 Chat 常见字符串形状；有多个 part
/// 时保留数组，避免 response 与 nested text/media 的边界被再次合并。
fn gemini_tool_content_value(parts: Vec<Value>) -> Value {
    if parts.len() == 1 {
        if let Some(text) = parts[0].get("text").and_then(Value::as_str) {
            return Value::String(text.to_string());
        }
    }
    if parts.is_empty() {
        return Value::String(String::new());
    }
    Value::Array(parts)
}

fn gemini_system_instruction_text(system_instruction: &Value) -> Result<Option<String>, String> {
    let system_instruction = system_instruction
        .as_object()
        .ok_or_else(|| "Gemini systemInstruction must be an object".to_string())?;
    let Some(parts) = system_instruction.get("parts").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut segments = Vec::new();
    for part in parts {
        let part = part
            .as_object()
            .ok_or_else(|| "Gemini systemInstruction.parts item must be an object".to_string())?;
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                segments.push(text.to_string());
            }
        }
    }
    if segments.is_empty() {
        Ok(None)
    } else {
        Ok(Some(segments.join("")))
    }
}

/// Gemini tools[].functionDeclarations[] -> canonical Chat tools。完整 schema 与
/// 其它声明字段原样保留；`parametersJsonSchema` 别名按 Chat `parameters` 承载。
fn build_gemini_canonical_tools_with_bindings(
    tools: Option<&Value>,
) -> Result<(Option<Value>, Option<Value>), String> {
    let Some(tools) = tools else {
        return Ok((None, None));
    };
    let tools = tools
        .as_array()
        .ok_or_else(|| "Gemini tools must be an array".to_string())?;
    let mut canonical = Vec::new();
    let mut declaration_fields = Vec::new();
    for (tool_index, tool) in tools.iter().enumerate() {
        let tool = tool
            .as_object()
            .ok_or_else(|| "Gemini tools item must be an object".to_string())?;
        let Some(declarations) = tool.get("functionDeclarations") else {
            // 非 functionDeclaration 的 Gemini 工具（如 googleSearch）没有 Chat
            // 等价，原样保留为 opaque 声明。
            let canonical_index = canonical.len();
            canonical.push(Value::Object(tool.clone()));
            declaration_fields.push(json!({
                "tool_index": tool_index,
                "canonical_index": canonical_index,
                "tool_fields": tool,
                "fields": tool,
            }));
            continue;
        };
        let declarations = declarations
            .as_array()
            .ok_or_else(|| "Gemini functionDeclarations must be an array".to_string())?;
        for (declaration_index, declaration) in declarations.iter().enumerate() {
            let declaration = declaration
                .as_object()
                .ok_or_else(|| "Gemini functionDeclaration must be an object".to_string())?;
            let mut function = declaration.clone();
            let parameters_json_schema = function.remove("parametersJsonSchema");
            if let Some(schema) = parameters_json_schema.clone() {
                function.entry("parameters".to_string()).or_insert(schema);
            }
            let mut residual = function.clone();
            residual.remove("name");
            residual.remove("description");
            residual.remove("parameters");
            let mut bindings = vec![native_binding(&["name"], &["function", "name"], "identity")];
            if function.contains_key("description") {
                bindings.push(native_binding(
                    &["description"],
                    &["function", "description"],
                    "identity",
                ));
            }
            if function.contains_key("parameters") {
                let source_path = if parameters_json_schema.is_some() {
                    &["parametersJsonSchema"][..]
                } else {
                    &["parameters"][..]
                };
                bindings.push(native_binding(
                    source_path,
                    &["function", "parameters"],
                    "identity",
                ));
            }
            let canonical_index = canonical.len();
            declaration_fields.push(json!({
                "tool_index": tool_index,
                "declaration_index": declaration_index,
                "canonical_index": canonical_index,
                "tool_fields": tool,
                "bindings": bindings,
                "fields": residual,
                "parameters_json_schema_present": parameters_json_schema.is_some(),
            }));
            canonical.push(json!({"type":"function","function":Value::Object(function)}));
        }
    }
    let declaration_fields = if declaration_fields.is_empty() {
        None
    } else {
        Some(Value::Array(declaration_fields))
    };
    if canonical.is_empty() {
        Ok((None, declaration_fields))
    } else {
        Ok((Some(Value::Array(canonical)), declaration_fields))
    }
}

/// Gemini toolConfig.functionCallingConfig.mode -> canonical tool_choice。mode 经
/// tool_choice_map 的 gemini 列归一化；allowedFunctionNames 保持 residual。
struct GeminiToolConfigProjection {
    choice: Option<Value>,
    residual: Option<Value>,
}

fn build_gemini_canonical_tool_choice_with_bindings(
    tool_config: Option<&Value>,
) -> Result<GeminiToolConfigProjection, String> {
    let Some(tool_config) = tool_config else {
        return Ok(GeminiToolConfigProjection {
            choice: None,
            residual: None,
        });
    };
    let tool_config = tool_config
        .as_object()
        .ok_or_else(|| "Gemini toolConfig must be an object".to_string())?;
    let Some(function_calling_config) = tool_config
        .get("functionCallingConfig")
        .and_then(Value::as_object)
    else {
        return Ok(GeminiToolConfigProjection {
            choice: None,
            residual: Some(Value::Object(tool_config.clone())),
        });
    };
    let mut choice: Option<Value> = None;
    if let Some(mode) = function_calling_config
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| !mode.is_empty())
    {
        let hub = table_map_value(
            V3TableKind::ToolChoice,
            V3_GEMINI_PROTOCOL,
            mode,
            V3TableDirection::Inbound,
        )
        .map_err(|error| format!("Gemini tool_choice_map lookup failed: {error}"))?
        .ok_or_else(|| {
            format!("Gemini toolConfig mode '{mode}' has no registered Chat tool_choice")
        })?;
        choice = Some(Value::String(hub.to_string()));
    }
    let mut residual = tool_config.clone();
    if let Some(function_calling_config_residual) = residual
        .get_mut("functionCallingConfig")
        .and_then(Value::as_object_mut)
    {
        if choice.is_some() {
            function_calling_config_residual.remove("mode");
        }
        if function_calling_config_residual.is_empty() {
            residual.remove("functionCallingConfig");
        }
    }
    Ok(GeminiToolConfigProjection {
        choice,
        residual: (!residual.is_empty()).then_some(Value::Object(residual)),
    })
}

/// generationConfig 归一化：已映射标量写入 canonical；只有实际映射成功的
/// key（含 thinkingConfig 子字段）从 residual 中移除，其余成员原样保留到已登记
/// 的 `request.generation` 扩展，避免 inbound 归一化悄悄丢弃非标量语义。
fn apply_gemini_generation_config(
    generation_config: Option<&Value>,
    request: &mut Map<String, Value>,
) -> Result<(), String> {
    let Some(generation_config) = generation_config else {
        return Ok(());
    };
    let generation_config = generation_config
        .as_object()
        .ok_or_else(|| "Gemini generationConfig must be an object".to_string())?;
    for (source, destination) in [
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("topK", "top_k"),
        ("maxOutputTokens", "max_completion_tokens"),
        ("stopSequences", "stop"),
        ("frequencyPenalty", "frequency_penalty"),
        ("presencePenalty", "presence_penalty"),
        ("responseLogprobs", "logprobs"),
        ("logprobs", "top_logprobs"),
        ("seed", "seed"),
    ] {
        if let Some(value) = generation_config.get(source) {
            request.insert(destination.to_string(), value.clone());
        }
    }
    let mut extension = generation_config.clone();
    for source in [
        "temperature",
        "topP",
        "topK",
        "maxOutputTokens",
        "stopSequences",
        "frequencyPenalty",
        "presencePenalty",
        "responseLogprobs",
        "logprobs",
        "seed",
    ] {
        extension.remove(source);
    }
    if let Some(thinking_config) = extension
        .get_mut("thinkingConfig")
        .and_then(Value::as_object_mut)
    {
        thinking_config.remove("includeThoughts");
        thinking_config.remove("thinkingBudget");
        thinking_config.remove("thinkingLevel");
        if thinking_config.is_empty() {
            extension.remove("thinkingConfig");
        }
    }
    if !extension.is_empty() {
        request.insert("generation".to_string(), Value::Object(extension));
    }
    if let Some(thinking_config) = generation_config
        .get("thinkingConfig")
        .and_then(Value::as_object)
    {
        if let Some(include) = thinking_config.get("includeThoughts") {
            request.insert("reasoning_include_thoughts".to_string(), include.clone());
        }
        if let Some(budget) = thinking_config.get("thinkingBudget") {
            request.insert("reasoning_budget_tokens".to_string(), budget.clone());
            // Gemini thinkingBudget=0 explicitly disables thinking; other values
            // retain the existing enabled mapping for the canonical consumer.
            let mode = if budget.as_i64() == Some(0) {
                "disabled"
            } else {
                "enabled"
            };
            request.insert(
                "reasoning_thinking_mode".to_string(),
                Value::String(mode.to_string()),
            );
        }
        // thinkingLevel 是 Gemini 的 reasoning 档位，canonical 语义是
        // `reasoning_effort`（既有三个 standard builder 的真实 consumer）；
        // Gemini 侧为大写枚举，canonical reasoning_effort 为小写字符串。
        if let Some(level) = thinking_config.get("thinkingLevel") {
            if let Some(level) = level.as_str().filter(|level| !level.trim().is_empty()) {
                request.insert(
                    "reasoning_effort".to_string(),
                    Value::String(level.trim().to_ascii_lowercase()),
                );
            }
        }
    }
    Ok(())
}
