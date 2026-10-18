use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3DirectRequestProtocol {
    Responses,
    OpenAiChat,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3DirectRequestKeyKind {
    System,
    Developer,
    Tools,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectRequestToolKey {
    pub ordinal: usize,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectRequestKeyView {
    pub protocol: V3DirectRequestProtocol,
    pub system: Vec<String>,
    pub developer: Vec<String>,
    pub tools: Vec<V3DirectRequestToolKey>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3DirectRequestToolInjection {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct V3DirectRequestKeyEdits {
    pub system_append: Option<String>,
    pub developer_append: Option<String>,
    pub tool_description_append: Option<String>,
    pub inject_tools: Vec<V3DirectRequestToolInjection>,
}

pub trait V3DirectRequestKeyHook {
    fn notify(&mut self, view: &V3DirectRequestKeyView);

    fn rewrite(
        &mut self,
        view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String>;
}

pub type V3DirectRequestKeyNotify = fn(&V3DirectRequestKeyView);
pub type V3DirectRequestKeyRewrite =
    fn(&V3DirectRequestKeyView, &mut V3DirectRequestKeyEdits) -> Result<(), String>;

#[derive(Clone, Copy)]
pub struct V3DirectRequestKeyMount {
    pub key: V3DirectRequestKeyKind,
    pub notify: V3DirectRequestKeyNotify,
    pub rewrite: V3DirectRequestKeyRewrite,
}

#[derive(Clone, Copy)]
pub struct V3DirectRequestKeyHookCatalog {
    pub mounts: [V3DirectRequestKeyMount; 3],
}

impl V3DirectRequestKeyHookCatalog {
    pub const fn new(
        system: V3DirectRequestKeyMount,
        developer: V3DirectRequestKeyMount,
        tools: V3DirectRequestKeyMount,
    ) -> Self {
        Self {
            mounts: [system, developer, tools],
        }
    }
}

impl V3DirectRequestKeyHook for V3DirectRequestKeyHookCatalog {
    fn notify(&mut self, view: &V3DirectRequestKeyView) {
        for mount in self.mounts {
            let _key = mount.key;
            (mount.notify)(view);
        }
    }

    fn rewrite(
        &mut self,
        view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        for mount in self.mounts {
            let mut mount_edits = V3DirectRequestKeyEdits::default();
            (mount.rewrite)(view, &mut mount_edits)?;
            merge_v3_direct_request_key_mount_edits(mount.key, mount_edits, edits)?;
        }
        Ok(())
    }
}

fn merge_v3_direct_request_key_mount_edits(
    key: V3DirectRequestKeyKind,
    source: V3DirectRequestKeyEdits,
    target: &mut V3DirectRequestKeyEdits,
) -> Result<(), String> {
    let has_developer = source.developer_append.is_some();
    let has_tools = source.tool_description_append.is_some() || !source.inject_tools.is_empty();
    match key {
        V3DirectRequestKeyKind::System => {
            if has_developer || has_tools {
                return Err("system request key hook attempted to edit a non-system key".to_owned());
            }
            target.system_append = source.system_append;
        }
        V3DirectRequestKeyKind::Developer => {
            if source.system_append.is_some() || has_tools {
                return Err(
                    "developer request key hook attempted to edit a non-developer key".to_owned(),
                );
            }
            target.developer_append = source.developer_append;
        }
        V3DirectRequestKeyKind::Tools => {
            if source.system_append.is_some() || has_developer {
                return Err("tools request key hook attempted to edit a non-tools key".to_owned());
            }
            target.tool_description_append = source.tool_description_append;
            target.inject_tools = source.inject_tools;
        }
    }
    Ok(())
}

fn noop_v3_direct_request_key_notify(_view: &V3DirectRequestKeyView) {}

fn noop_v3_direct_request_key_rewrite(
    _view: &V3DirectRequestKeyView,
    _edits: &mut V3DirectRequestKeyEdits,
) -> Result<(), String> {
    Ok(())
}

pub const fn default_v3_direct_request_key_hook_catalog() -> V3DirectRequestKeyHookCatalog {
    V3DirectRequestKeyHookCatalog::new(
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::System,
            notify: noop_v3_direct_request_key_notify,
            rewrite: noop_v3_direct_request_key_rewrite,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Developer,
            notify: noop_v3_direct_request_key_notify,
            rewrite: noop_v3_direct_request_key_rewrite,
        },
        V3DirectRequestKeyMount {
            key: V3DirectRequestKeyKind::Tools,
            notify: noop_v3_direct_request_key_notify,
            rewrite: noop_v3_direct_request_key_rewrite,
        },
    )
}

pub fn apply_v3_direct_request_key_hook(
    mut body: Value,
    protocol: V3DirectRequestProtocol,
    hook: &mut impl V3DirectRequestKeyHook,
) -> Result<Value, String> {
    let view = parse_v3_direct_request_key_view(&body, protocol)?;
    hook.notify(&view);
    let mut edits = V3DirectRequestKeyEdits::default();
    hook.rewrite(&view, &mut edits)?;
    apply_v3_direct_request_key_edits(&mut body, &view, edits)?;
    Ok(body)
}

pub(crate) fn parse_v3_direct_request_key_view(
    body: &Value,
    protocol: V3DirectRequestProtocol,
) -> Result<V3DirectRequestKeyView, String> {
    let object = body
        .as_object()
        .ok_or_else(|| "direct request key hook body must be an object".to_owned())?;
    let mut system = Vec::new();
    let mut developer = Vec::new();
    let mut tools = Vec::new();
    match protocol {
        V3DirectRequestProtocol::Responses => {
            if let Some(instructions) = object.get("instructions") {
                if let Some(text) = instructions.as_str() {
                    system.push(text.to_owned());
                }
            }
            if let Some(input) = object.get("input").and_then(Value::as_array) {
                for item in input {
                    let role = item.get("role").and_then(Value::as_str);
                    let text = extract_v3_direct_prompt_text(item);
                    match (role, text) {
                        (Some("system"), Some(text)) => system.push(text),
                        (Some("developer"), Some(text)) => developer.push(text),
                        _ => {}
                    }
                }
            }
            collect_v3_direct_response_tools(object.get("tools"), &mut tools);
        }
        V3DirectRequestProtocol::OpenAiChat => {
            if let Some(messages) = object.get("messages").and_then(Value::as_array) {
                for item in messages {
                    let text = extract_v3_direct_prompt_text(item);
                    match (item.get("role").and_then(Value::as_str), text) {
                        (Some("system"), Some(text)) => system.push(text),
                        (Some("developer"), Some(text)) => developer.push(text),
                        _ => {}
                    }
                }
            }
            collect_v3_direct_chat_tools(object.get("tools"), &mut tools);
        }
        V3DirectRequestProtocol::Anthropic => {
            collect_v3_direct_anthropic_system(object.get("system"), &mut system);
            if let Some(messages) = object.get("messages").and_then(Value::as_array) {
                for item in messages {
                    if item.get("role").and_then(Value::as_str) == Some("developer") {
                        if let Some(text) = extract_v3_direct_prompt_text(item) {
                            developer.push(text);
                        }
                    }
                }
            }
            collect_v3_direct_anthropic_tools(object.get("tools"), &mut tools);
        }
        V3DirectRequestProtocol::Gemini => {
            collect_v3_direct_gemini_system(object.get("systemInstruction"), &mut system);
            collect_v3_direct_gemini_tools(object.get("tools"), &mut tools);
        }
    }
    Ok(V3DirectRequestKeyView {
        protocol,
        system,
        developer,
        tools,
    })
}

fn extract_v3_direct_prompt_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    let parts = value
        .get("content")
        .or_else(|| value.get("text"))
        .and_then(Value::as_array)?;
    let mut text = String::new();
    for part in parts {
        let fragment = part
            .get("text")
            .or_else(|| part.get("input_text"))
            .and_then(Value::as_str);
        if let Some(fragment) = fragment {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(fragment);
        }
    }
    (!text.is_empty()).then_some(text)
}

fn collect_v3_direct_response_tools(
    tools_value: Option<&Value>,
    output: &mut Vec<V3DirectRequestToolKey>,
) {
    let Some(tools) = tools_value.and_then(Value::as_array) else {
        return;
    };
    for (ordinal, tool) in tools.iter().enumerate() {
        output.push(V3DirectRequestToolKey {
            ordinal,
            name: tool.get("name").and_then(Value::as_str).map(str::to_owned),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
}

fn collect_v3_direct_chat_tools(
    tools_value: Option<&Value>,
    output: &mut Vec<V3DirectRequestToolKey>,
) {
    let Some(tools) = tools_value.and_then(Value::as_array) else {
        return;
    };
    for (ordinal, tool) in tools.iter().enumerate() {
        output.push(V3DirectRequestToolKey {
            ordinal,
            name: tool
                .pointer("/function/name")
                .and_then(Value::as_str)
                .map(str::to_owned),
            description: tool
                .pointer("/function/description")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
}

fn collect_v3_direct_anthropic_system(value: Option<&Value>, output: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) => output.push(text.clone()),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    output.push(text.to_owned());
                }
            }
        }
        _ => {}
    }
}

fn collect_v3_direct_anthropic_tools(
    tools_value: Option<&Value>,
    output: &mut Vec<V3DirectRequestToolKey>,
) {
    let Some(tools) = tools_value.and_then(Value::as_array) else {
        return;
    };
    for (ordinal, tool) in tools.iter().enumerate() {
        output.push(V3DirectRequestToolKey {
            ordinal,
            name: tool.get("name").and_then(Value::as_str).map(str::to_owned),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
}

fn collect_v3_direct_gemini_system(value: Option<&Value>, output: &mut Vec<String>) {
    let Some(parts) = value
        .and_then(|instruction| instruction.get("parts"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            output.push(text.to_owned());
        }
    }
}

fn collect_v3_direct_gemini_tools(
    tools_value: Option<&Value>,
    output: &mut Vec<V3DirectRequestToolKey>,
) {
    let Some(tools) = tools_value.and_then(Value::as_array) else {
        return;
    };
    for tool in tools {
        let Some(declarations) = tool.get("functionDeclarations").and_then(Value::as_array) else {
            continue;
        };
        for declaration in declarations {
            output.push(V3DirectRequestToolKey {
                ordinal: output.len(),
                name: declaration
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                description: declaration
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
    }
}

fn apply_v3_direct_request_key_edits(
    body: &mut Value,
    view: &V3DirectRequestKeyView,
    edits: V3DirectRequestKeyEdits,
) -> Result<(), String> {
    if let Some(append) = edits.system_append.as_deref() {
        append_v3_direct_prompt_key(body, view.protocol, "system", append)?;
    }
    if let Some(append) = edits.developer_append.as_deref() {
        append_v3_direct_prompt_key(body, view.protocol, "developer", append)?;
    }
    if let Some(append) = edits.tool_description_append.as_deref() {
        append_v3_direct_tool_descriptions(body, view.protocol, append)?;
    }
    for injection in edits.inject_tools {
        inject_v3_direct_tool(body, view.protocol, injection)?;
    }
    Ok(())
}

fn append_v3_direct_prompt_key(
    body: &mut Value,
    protocol: V3DirectRequestProtocol,
    role: &str,
    append: &str,
) -> Result<(), String> {
    match protocol {
        V3DirectRequestProtocol::Responses => {
            if role == "system" {
                append_v3_direct_string_field(body, "instructions", append);
            } else {
                append_v3_direct_role_item(body, "input", role, append);
            }
        }
        V3DirectRequestProtocol::OpenAiChat => {
            append_v3_direct_role_item(body, "messages", role, append)
        }
        V3DirectRequestProtocol::Anthropic => {
            if role == "developer" {
                append_v3_direct_role_item(body, "messages", role, append);
            } else {
                append_v3_direct_anthropic_system(body, append)?;
            }
        }
        V3DirectRequestProtocol::Gemini => match role {
            "system" => append_v3_direct_gemini_system(body, append)?,
            "developer" => {
                return Err(
                    "Gemini Direct request key hooks do not support the developer role".to_owned(),
                )
            }
            _ => return Err(format!("unsupported Gemini request key role: {role}")),
        },
    }
    Ok(())
}

fn append_v3_direct_string_field(body: &mut Value, field: &str, append: &str) {
    let object = body
        .as_object_mut()
        .expect("validated direct request object");
    match object.get_mut(field) {
        Some(Value::String(text)) if !text.is_empty() => {
            text.push_str("\n\n");
            text.push_str(append);
        }
        _ => {
            object.insert(field.to_owned(), Value::String(append.to_owned()));
        }
    }
}

fn append_v3_direct_role_item(body: &mut Value, field: &str, role: &str, append: &str) {
    let object = body
        .as_object_mut()
        .expect("validated direct request object");
    let items = object
        .entry(field.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .expect("direct prompt collection must be an array");
    if let Some(item) = items
        .iter_mut()
        .find(|item| item.get("role").and_then(Value::as_str) == Some(role))
    {
        append_v3_direct_content(item, append);
    } else {
        items.insert(0, serde_json::json!({"role": role, "content": append}));
    }
}

fn append_v3_direct_content(item: &mut Value, append: &str) {
    let object = item.as_object_mut().expect("prompt item must be an object");
    match object.get_mut("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            text.push_str("\n\n");
            text.push_str(append);
        }
        _ => {
            object.insert("content".to_owned(), Value::String(append.to_owned()));
        }
    }
}

fn append_v3_direct_anthropic_system(body: &mut Value, append: &str) -> Result<(), String> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| "direct Anthropic request must be an object".to_owned())?;
    match object.get_mut("system") {
        Some(Value::String(text)) => {
            text.push_str("\n\n");
            text.push_str(append);
        }
        Some(Value::Array(blocks)) => blocks.push(serde_json::json!({"type":"text","text":append})),
        _ => {
            object.insert("system".to_owned(), Value::String(append.to_owned()));
        }
    }
    Ok(())
}

fn append_v3_direct_gemini_system(body: &mut Value, append: &str) -> Result<(), String> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| "direct Gemini request must be an object".to_owned())?;
    let instruction = object
        .entry("systemInstruction".to_owned())
        .or_insert_with(|| serde_json::json!({"parts":[]}));
    let instruction = instruction
        .as_object_mut()
        .ok_or_else(|| "Gemini systemInstruction must be an object".to_owned())?;
    let parts = instruction
        .entry("parts".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Gemini systemInstruction.parts must be an array".to_owned())?;
    parts.push(serde_json::json!({"text":append}));
    Ok(())
}

fn append_v3_direct_tool_descriptions(
    body: &mut Value,
    protocol: V3DirectRequestProtocol,
    append: &str,
) -> Result<(), String> {
    let tools = body
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "direct tool key rewrite requires a tools array".to_owned())?;
    if protocol == V3DirectRequestProtocol::Gemini {
        for tool in tools {
            let Some(declarations) = tool
                .get_mut("functionDeclarations")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for declaration in declarations {
                if let Some(Value::String(description)) = declaration.get_mut("description") {
                    description.push_str("\n\n");
                    description.push_str(append);
                }
            }
        }
    } else {
        for tool in tools {
            let description = match protocol {
                V3DirectRequestProtocol::OpenAiChat => tool.pointer_mut("/function/description"),
                _ => tool.get_mut("description"),
            };
            if let Some(Value::String(description)) = description {
                description.push_str("\n\n");
                description.push_str(append);
            }
        }
    }
    Ok(())
}

fn inject_v3_direct_tool(
    body: &mut Value,
    protocol: V3DirectRequestProtocol,
    injection: V3DirectRequestToolInjection,
) -> Result<(), String> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| "direct request key hook body must be an object".to_owned())?;
    let tools = object
        .entry("tools".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "direct tool key injection requires a tools array".to_owned())?;
    let description = injection.description.unwrap_or_default();
    let tool = match protocol {
        V3DirectRequestProtocol::Responses => serde_json::json!({
            "type":"function",
            "name":injection.name,
            "description":description,
            "parameters":injection.parameters
        }),
        V3DirectRequestProtocol::OpenAiChat => serde_json::json!({
            "type":"function",
            "function":{"name":injection.name,"description":description,"parameters":injection.parameters}
        }),
        V3DirectRequestProtocol::Anthropic => serde_json::json!({
            "name":injection.name,
            "description":description,
            "input_schema":injection.parameters
        }),
        V3DirectRequestProtocol::Gemini => serde_json::json!({
            "name":injection.name,
            "description":description,
            "parameters":injection.parameters
        }),
    };
    if protocol == V3DirectRequestProtocol::Gemini {
        if let Some(declarations) = tools.iter_mut().find_map(|tool| {
            tool.get_mut("functionDeclarations")
                .and_then(Value::as_array_mut)
        }) {
            declarations.push(tool);
        } else {
            tools.push(serde_json::json!({"functionDeclarations":[tool]}));
        }
    } else {
        tools.push(tool);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_mount(
        _view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        edits.system_append = Some("system mount".to_owned());
        Ok(())
    }

    fn developer_mount(
        _view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        edits.developer_append = Some("developer mount".to_owned());
        Ok(())
    }

    fn tools_mount(
        _view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        edits.tool_description_append = Some("tools mount".to_owned());
        Ok(())
    }

    fn tool_injection_mount(
        _view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        edits.inject_tools.push(V3DirectRequestToolInjection {
            name: "injected".to_owned(),
            description: Some("injected tool".to_owned()),
            parameters: serde_json::json!({"type":"object"}),
        });
        Ok(())
    }

    fn illegal_system_mount(
        _view: &V3DirectRequestKeyView,
        edits: &mut V3DirectRequestKeyEdits,
    ) -> Result<(), String> {
        edits.tool_description_append = Some("illegal".to_owned());
        Ok(())
    }

    struct AppendHook;

    impl V3DirectRequestKeyHook for AppendHook {
        fn notify(&mut self, _view: &V3DirectRequestKeyView) {}

        fn rewrite(
            &mut self,
            _view: &V3DirectRequestKeyView,
            edits: &mut V3DirectRequestKeyEdits,
        ) -> Result<(), String> {
            edits.system_append = Some("system addition".to_owned());
            edits.developer_append = Some("developer addition".to_owned());
            edits.tool_description_append = Some("tool addition".to_owned());
            edits.inject_tools.push(V3DirectRequestToolInjection {
                name: "extra".to_owned(),
                description: Some("extra tool".to_owned()),
                parameters: serde_json::json!({"type":"object"}),
            });
            Ok(())
        }
    }

    struct GeminiAppendHook;

    impl V3DirectRequestKeyHook for GeminiAppendHook {
        fn notify(&mut self, _view: &V3DirectRequestKeyView) {}

        fn rewrite(
            &mut self,
            _view: &V3DirectRequestKeyView,
            edits: &mut V3DirectRequestKeyEdits,
        ) -> Result<(), String> {
            edits.system_append = Some("system addition".to_owned());
            edits.tool_description_append = Some("tool addition".to_owned());
            edits.inject_tools.push(V3DirectRequestToolInjection {
                name: "extra".to_owned(),
                description: Some("extra tool".to_owned()),
                parameters: serde_json::json!({"type":"object"}),
            });
            Ok(())
        }
    }

    struct GeminiDeveloperHook;

    impl V3DirectRequestKeyHook for GeminiDeveloperHook {
        fn notify(&mut self, _view: &V3DirectRequestKeyView) {}

        fn rewrite(
            &mut self,
            _view: &V3DirectRequestKeyView,
            edits: &mut V3DirectRequestKeyEdits,
        ) -> Result<(), String> {
            edits.developer_append = Some("developer addition".to_owned());
            Ok(())
        }
    }

    #[test]
    fn direct_key_hook_rewrites_chat_system_developer_and_tools() {
        let body = serde_json::json!({
            "messages":[
                {"role":"system","content":"base system"},
                {"role":"developer","content":"base developer"}
            ],
            "tools":[{"type":"function","function":{"name":"old","description":"old tool"}}]
        });
        let output = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::OpenAiChat,
            &mut AppendHook,
        )
        .unwrap();
        assert!(output["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("system addition"));
        assert!(output["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("developer addition"));
        assert!(output["tools"][0]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("tool addition"));
        assert_eq!(output["tools"][1]["function"]["name"], "extra");
    }

    #[test]
    fn direct_key_view_is_protocol_specific_without_rebuilding_control_state() {
        let body = serde_json::json!({
            "instructions":"system",
            "input":[{"role":"developer","content":[{"type":"input_text","text":"developer"}]}],
            "tools":[{"type":"function","name":"lookup","description":"lookup"}]
        });
        let view =
            parse_v3_direct_request_key_view(&body, V3DirectRequestProtocol::Responses).unwrap();
        assert_eq!(view.system, vec!["system"]);
        assert_eq!(view.developer, vec!["developer"]);
        assert_eq!(view.tools[0].name.as_deref(), Some("lookup"));
    }

    #[test]
    fn anthropic_key_edits_keep_developer_separate_from_system() {
        let body = serde_json::json!({
            "system": "base system",
            "messages": [{"role":"user","content":"hello"}],
            "tools": [{"name":"lookup","description":"lookup","input_schema":{"type":"object"}}]
        });
        let output = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::Anthropic,
            &mut AppendHook,
        )
        .unwrap();
        assert!(output["system"]
            .as_str()
            .unwrap()
            .contains("system addition"));
        assert_eq!(output["messages"][0]["role"], "developer");
        assert!(output["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("developer addition"));
        assert!(output["tools"][0]["description"]
            .as_str()
            .unwrap()
            .contains("tool addition"));
        assert_eq!(output["tools"][1]["name"], "extra");
    }

    #[test]
    fn gemini_key_view_reads_native_system_and_function_declarations() {
        let body = serde_json::json!({
            "systemInstruction": {
                "parts": [
                    {"text": "base system", "opaquePart": true},
                    {"text": "second system"}
                ],
                "opaqueSystem": "keep"
            },
            "contents": [{
                "role": "user",
                "parts": [{"text": "hello"}],
                "opaqueContent": "keep"
            }],
            "tools": [
                {"googleSearch": {}, "opaqueHosted": "keep"},
                {
                    "functionDeclarations": [
                        {
                            "name": "lookup",
                            "description": "lookup tool",
                            "parameters": {"type": "object"},
                            "opaqueDeclaration": "keep"
                        },
                        {"name": "other", "parameters": {"type": "object"}}
                    ],
                    "opaqueTool": "keep"
                }
            ],
            "unknownTop": "keep"
        });
        let view =
            parse_v3_direct_request_key_view(&body, V3DirectRequestProtocol::Gemini).unwrap();
        assert_eq!(view.protocol, V3DirectRequestProtocol::Gemini);
        assert_eq!(view.system, vec!["base system", "second system"]);
        assert!(view.developer.is_empty());
        assert_eq!(view.tools.len(), 2);
        assert_eq!(view.tools[0].ordinal, 0);
        assert_eq!(view.tools[0].name.as_deref(), Some("lookup"));
        assert_eq!(view.tools[0].description.as_deref(), Some("lookup tool"));
        assert_eq!(view.tools[1].ordinal, 1);
        assert_eq!(view.tools[1].name.as_deref(), Some("other"));
    }

    #[test]
    fn gemini_default_noop_hooks_preserve_native_request_exactly() {
        let body = serde_json::json!({
            "systemInstruction": {
                "parts": [{"text": "base system", "opaquePart": true}],
                "opaqueSystem": "keep"
            },
            "contents": [{
                "role": "user",
                "parts": [{"text": "hello", "opaquePart": true}],
                "opaqueContent": "keep"
            }],
            "tools": [{
                "googleSearch": {},
                "opaqueHosted": "keep"
            }],
            "generationConfig": {"temperature": 0.2, "opaqueConfig": true},
            "unknownTop": "keep"
        });
        let mut catalog = default_v3_direct_request_key_hook_catalog();
        let output = apply_v3_direct_request_key_hook(
            body.clone(),
            V3DirectRequestProtocol::Gemini,
            &mut catalog,
        )
        .unwrap();
        assert_eq!(output, body);
    }

    #[test]
    fn gemini_key_edits_preserve_contents_unknown_fields_and_hosted_tools() {
        let body = serde_json::json!({
            "systemInstruction": {
                "parts": [
                    {"text": "base system", "opaquePart": true},
                    {"text": "second system"}
                ],
                "opaqueSystem": "keep"
            },
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": "hello", "opaquePart": true},
                    {"inlineData": {"mimeType": "text/plain", "data": "aGVsbG8="}}
                ],
                "opaqueContent": "keep"
            }],
            "tools": [
                {"googleSearch": {}, "opaqueHosted": "keep"},
                {
                    "functionDeclarations": [
                        {
                            "name": "lookup",
                            "description": "base tool",
                            "parameters": {"type": "object"},
                            "opaqueDeclaration": "keep"
                        },
                        {
                            "name": "other",
                            "parameters": {"type": "object"},
                            "opaqueDeclaration": "keep other"
                        }
                    ],
                    "opaqueTool": "keep"
                }
            ],
            "generationConfig": {"temperature": 0.2, "opaqueConfig": true},
            "unknownTop": "keep"
        });
        let original_contents = body["contents"].clone();
        let original_hosted_tool = body["tools"][0].clone();
        let output = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::Gemini,
            &mut GeminiAppendHook,
        )
        .unwrap();

        assert_eq!(output["contents"], original_contents);
        assert_eq!(output["tools"][0], original_hosted_tool);
        assert_eq!(output["systemInstruction"]["opaqueSystem"], "keep");
        assert_eq!(
            output["systemInstruction"]["parts"][0],
            serde_json::json!({"text": "base system", "opaquePart": true})
        );
        assert_eq!(
            output["systemInstruction"]["parts"][1],
            serde_json::json!({"text": "second system"})
        );
        assert_eq!(
            output["systemInstruction"]["parts"][2],
            serde_json::json!({"text": "system addition"})
        );
        assert_eq!(output["tools"][1]["opaqueTool"], "keep");
        let declarations = output["tools"][1]["functionDeclarations"]
            .as_array()
            .unwrap();
        assert_eq!(declarations[0]["opaqueDeclaration"], "keep");
        assert_eq!(declarations[0]["description"], "base tool\n\ntool addition");
        assert_eq!(declarations[1]["opaqueDeclaration"], "keep other");
        assert!(declarations[1].get("description").is_none());
        assert_eq!(declarations[2]["name"], "extra");
        assert_eq!(declarations[2]["description"], "extra tool");
        assert_eq!(
            declarations[2]["parameters"],
            serde_json::json!({"type":"object"})
        );
        assert_eq!(output["generationConfig"]["opaqueConfig"], true);
        assert_eq!(output["unknownTop"], "keep");
    }

    #[test]
    fn gemini_developer_edit_fails_without_inventing_a_native_role() {
        let body = serde_json::json!({
            "contents": [{"role":"user","parts":[{"text":"hello"}]}]
        });
        let error = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::Gemini,
            &mut GeminiDeveloperHook,
        )
        .expect_err("Gemini has no developer role");
        assert!(error.contains("Gemini"));
        assert!(error.contains("developer"));
    }

    #[test]
    fn gemini_key_catalog_dispatches_system_and_tools_mounts() {
        let body = serde_json::json!({
            "systemInstruction": {"parts": [{"text": "base system"}]},
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
            "tools": [{
                "googleSearch": {},
                "functionDeclarations": [{
                    "name": "lookup",
                    "description": "base tool",
                    "parameters": {"type": "object"}
                }]
            }]
        });
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: system_mount,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: tools_mount,
            },
        );
        let output =
            apply_v3_direct_request_key_hook(body, V3DirectRequestProtocol::Gemini, &mut catalog)
                .unwrap();
        assert_eq!(
            output["systemInstruction"]["parts"][1],
            serde_json::json!({"text": "system mount"})
        );
        assert_eq!(
            output["tools"][0]["functionDeclarations"][0]["description"],
            "base tool\n\ntools mount"
        );
        assert_eq!(output["tools"][0]["googleSearch"], serde_json::json!({}));
    }

    #[test]
    fn gemini_tool_edits_ignore_hosted_only_tools_without_creating_a_declarations_container() {
        let body = serde_json::json!({
            "contents": [{"role":"user","parts":[{"text":"hello"}]}],
            "tools": [{"googleSearch": {}, "opaqueHosted": "keep"}]
        });
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: tools_mount,
            },
        );
        let output =
            apply_v3_direct_request_key_hook(body, V3DirectRequestProtocol::Gemini, &mut catalog)
                .expect("hosted tools have no function declarations to edit");
        assert_eq!(
            output["tools"],
            serde_json::json!([{"googleSearch": {}, "opaqueHosted": "keep"}])
        );
        assert_eq!(output["contents"][0]["parts"][0]["text"], "hello");
    }

    #[test]
    fn gemini_tool_injection_creates_function_declarations_after_hosted_tools() {
        let body = serde_json::json!({
            "contents": [{"role":"user","parts":[{"text":"hello"}]}],
            "tools": [{"googleSearch": {}, "opaqueHosted": "keep"}]
        });
        let original_contents = body["contents"].clone();
        let original_hosted_tool = body["tools"][0].clone();
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: tool_injection_mount,
            },
        );
        let output =
            apply_v3_direct_request_key_hook(body, V3DirectRequestProtocol::Gemini, &mut catalog)
                .expect("Gemini tool injection must not require an existing declaration container");

        assert_eq!(output["contents"], original_contents);
        assert_eq!(output["tools"][0], original_hosted_tool);
        assert_eq!(
            output["tools"][1],
            serde_json::json!({
                "functionDeclarations": [{
                    "name": "injected",
                    "description": "injected tool",
                    "parameters": {"type":"object"}
                }]
            })
        );
    }

    #[test]
    fn direct_key_mounts_apply_protocol_shaped_edits_for_every_supported_direct_protocol() {
        let cases = [
            (
                V3DirectRequestProtocol::Responses,
                serde_json::json!({
                    "instructions":"base system",
                    "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
                    "tools":[{"type":"function","name":"lookup","description":"base tool","parameters":{"type":"object"}}]
                }),
            ),
            (
                V3DirectRequestProtocol::OpenAiChat,
                serde_json::json!({
                    "messages":[{"role":"user","content":"hello"}],
                    "tools":[{"type":"function","function":{"name":"lookup","description":"base tool","parameters":{"type":"object"}}}]
                }),
            ),
            (
                V3DirectRequestProtocol::Anthropic,
                serde_json::json!({
                    "messages":[{"role":"user","content":"hello"}],
                    "tools":[{"name":"lookup","description":"base tool","input_schema":{"type":"object"}}]
                }),
            ),
        ];

        for (protocol, body) in cases {
            let output = apply_v3_direct_request_key_hook(body, protocol, &mut AppendHook)
                .expect("each Direct protocol must consume the same typed key mounts");
            assert!(output.to_string().contains("system addition"));
            assert!(output.to_string().contains("developer addition"));
            assert!(output.to_string().contains("tool addition"));
            assert!(output.to_string().contains("\"extra\""));
            assert!(output.get("metadata").is_none());
            assert!(output.get("route").is_none());
            assert!(output.get("continuation").is_none());
        }
    }

    #[test]
    fn key_catalog_dispatches_system_developer_and_tools_mounts_independently() {
        let body = serde_json::json!({
            "messages":[{"role":"system","content":"s"}],
            "tools":[{"type":"function","function":{"name":"t","description":"d"}}]
        });
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: system_mount,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: developer_mount,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: tools_mount,
            },
        );
        let output = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::OpenAiChat,
            &mut catalog,
        )
        .unwrap();
        let messages = output["messages"].as_array().unwrap();
        assert!(messages.iter().any(|message| {
            message["role"] == "system"
                && message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("system mount"))
        }));
        assert!(messages
            .iter()
            .any(|message| message["role"] == "developer"));
        assert!(output["tools"][0]["function"]["description"]
            .as_str()
            .unwrap()
            .contains("tools mount"));
    }

    #[test]
    fn key_catalog_rejects_cross_key_edits_at_the_owner_boundary() {
        let body = serde_json::json!({
            "messages":[{"role":"system","content":"s"}],
            "tools":[{"type":"function","function":{"name":"t","description":"d"}}]
        });
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: illegal_system_mount,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
        );
        let error = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::OpenAiChat,
            &mut catalog,
        )
        .expect_err("cross-key edits must fail at the catalog owner");
        assert!(error.contains("non-system key"));
    }

    #[test]
    fn tool_key_injection_mount_creates_an_absent_tools_array() {
        fn inject_tool(
            _view: &V3DirectRequestKeyView,
            edits: &mut V3DirectRequestKeyEdits,
        ) -> Result<(), String> {
            edits.inject_tools.push(V3DirectRequestToolInjection {
                name: "lookup".to_owned(),
                description: Some("lookup injected by the Direct mount".to_owned()),
                parameters: serde_json::json!({"type":"object"}),
            });
            Ok(())
        }

        let body = serde_json::json!({"messages":[{"role":"user","content":"hello"}]});
        let mut catalog = V3DirectRequestKeyHookCatalog::new(
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::System,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Developer,
                notify: noop_v3_direct_request_key_notify,
                rewrite: noop_v3_direct_request_key_rewrite,
            },
            V3DirectRequestKeyMount {
                key: V3DirectRequestKeyKind::Tools,
                notify: noop_v3_direct_request_key_notify,
                rewrite: inject_tool,
            },
        );
        let output = apply_v3_direct_request_key_hook(
            body,
            V3DirectRequestProtocol::OpenAiChat,
            &mut catalog,
        )
        .unwrap();
        assert_eq!(output["tools"][0]["function"]["name"], "lookup");
    }
}
