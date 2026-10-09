//! OpenCode Zen private, executable TCM tool representation and its exact inverse.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const PROFILE: &str = "chat:opencode-zen-tcm";

/// A recovery probe declares inert native capabilities. It never represents
/// client tools, executes a call, or fabricates a tool result.
pub fn apply_opencode_zen_probe_request(payload: &mut Value) {
    payload["stream"] = json!(true);
    payload["reasoning_effort"] = json!("low");
    payload
        .as_object_mut()
        .expect("standard Chat probe object")
        .remove("max_tokens");
    payload["messages"] =
        json!([{ "role": "user", "content": "Reply exactly OK. Do not call tools." }]);
    payload["tools"] = json!([
        {"type":"function","function":{"name":"bash","description":"Execute a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}}},
        {"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"],"additionalProperties":false}}}
    ]);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZenNativeTool {
    Bash,
    Read,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ZenNativeCall {
    pub tool: ZenNativeTool,
    pub arguments: Option<Value>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeZenTcmBridgeBinding {
    pub executor_wire_name: String,
    pub response_aliases: Vec<ZenNativeTool>,
}

const PREFIX: &str = "const argumentSource = ";
const BASH: &str = r#";
let args;
try {
  if (argumentSource.length !== 1) throw new Error("arguments field is missing");
  args = typeof argumentSource[0] === "string" ? JSON.parse(argumentSource[0]) : argumentSource[0];
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.command !== "string" || Object.keys(args).length !== 1) throw new Error("expected only command:string");
} catch (error) {
  throw new Error("Invalid bash arguments " + JSON.stringify(argumentSource) + ": " + String(error));
}
text(await tools.exec_command({cmd: args.command}));"#;
const READ: &str = r#";
let args;
try {
  if (argumentSource.length !== 1) throw new Error("arguments field is missing");
  args = typeof argumentSource[0] === "string" ? JSON.parse(argumentSource[0]) : argumentSource[0];
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.filePath !== "string" || Object.keys(args).length !== 1) throw new Error("expected only filePath:string");
} catch (error) {
  throw new Error("Invalid read arguments " + JSON.stringify(argumentSource) + ": " + String(error));
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
text(await tools.exec_command({cmd: "cat -- " + quote(args.filePath)}));"#;
pub const TCM_GRAMMAR: &str = r#"start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/"#;

impl ZenNativeTool {
    fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Read => "read",
        }
    }
    fn template(self) -> &'static str {
        match self {
            Self::Bash => BASH,
            Self::Read => READ,
        }
    }
    fn parameter(self) -> &'static str {
        match self {
            Self::Bash => "command",
            Self::Read => "filePath",
        }
    }
}

pub fn encode_native_call(call: &ZenNativeCall) -> String {
    let source: Vec<&Value> = call.arguments.iter().collect();
    format!(
        "{PREFIX}{}{suffix}",
        serde_json::to_string(&source).expect("JSON values serialize"),
        suffix = call.tool.template()
    )
}

pub fn decode_canonical_native_call(input: &str) -> Option<ZenNativeCall> {
    let source = input.strip_prefix(PREFIX)?;
    for tool in [ZenNativeTool::Bash, ZenNativeTool::Read] {
        let Some(literal) = source.strip_suffix(tool.template()) else {
            continue;
        };
        let Ok(mut values) = serde_json::from_str::<Vec<Value>>(literal) else {
            continue;
        };
        if values.len() > 1 {
            continue;
        }
        let call = ZenNativeCall {
            tool,
            arguments: values.pop(),
        };
        if encode_native_call(&call) == input {
            return Some(call);
        }
    }
    None
}

/// Capability is registered from the actual custom declaration and standard wire
/// projection. Executable history never supplies selection or execution authority.
pub fn compile_opencode_zen_tcm_bridge(
    client: &Value,
    provider: &Value,
) -> Option<OpencodeZenTcmBridgeBinding> {
    let mut declarations =
        crate::namespace_tools::resolve_responses_tool_declarations(client).ok()?;
    for item in client
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item["type"] == "additional_tools" {
            declarations.extend(
                item.get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
    }
    let mut candidates = Vec::new();
    for namespace in &declarations {
        if namespace["type"] != "namespace" || namespace["name"] != "functions" {
            continue;
        }
        let names = crate::namespace_tools::namespace_tool_name_map(namespace).ok()??;
        for tool in namespace
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if tool["type"] != "custom" || tool["name"] != "exec" {
                continue;
            }
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let format = &tool["format"];
            if format["type"] != "grammar"
                || format["syntax"] != "lark"
                || format
                    .get("definition")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    != Some(TCM_GRAMMAR.trim())
                || ![
                    "fresh V8 isolate as an async module",
                    "tools.exec_command",
                    "Runs raw JavaScript",
                    "text(value",
                ]
                .iter()
                .all(|part| description.contains(part))
            {
                continue;
            }
            let wire = names.get("functions.exec")?;
            let matches: Vec<_> = provider
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| entry["type"] == "function" && entry["function"]["name"] == *wire)
                .collect();
            if matches.len() == 1
                && matches[0]["function"]["parameters"]
                    == crate::namespace_tools::openai_chat_freeform_custom_tool_parameters()
            {
                candidates.push(wire.clone());
            }
        }
    }
    if candidates.len() != 1 {
        return None;
    }
    let executor_wire_name = candidates.pop()?;
    let response_aliases =
        if executor_choice_allowed(provider.get("tool_choice"), &executor_wire_name) {
            [ZenNativeTool::Bash, ZenNativeTool::Read]
                .into_iter()
                .filter(|tool| {
                    !provider
                        .get("tools")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .any(|entry| {
                            crate::namespace_tools::provider_function_tool_name(entry)
                                == Some(tool.name())
                        })
                })
                .collect()
        } else {
            Vec::new()
        };
    Some(OpencodeZenTcmBridgeBinding {
        executor_wire_name,
        response_aliases,
    })
}

fn choice_name(tool: &Value) -> Option<&str> {
    tool.get("function")
        .and_then(|function| function.get("name"))
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
}

fn executor_choice_allowed(choice: Option<&Value>, name: &str) -> bool {
    match choice {
        None | Some(Value::Null) => true,
        Some(Value::String(mode)) => matches!(mode.as_str(), "auto" | "required"),
        Some(choice) if choice["type"] == "function" => choice_name(choice) == Some(name),
        Some(choice) if choice["type"] == "allowed_tools" => choice["allowed_tools"]["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| choice_name(tool) == Some(name))),
        _ => false,
    }
}

fn declaration(tool: ZenNativeTool) -> Value {
    let parameter = tool.parameter();
    let description = match tool {
        ZenNativeTool::Bash => "Execute a shell command through the client's functions.exec tools.exec_command API. Returns the actual stdout/stderr, exit status, session and truncation receipt.",
        ZenNativeTool::Read => "Read a file with a safely quoted cat command through the client's functions.exec tools.exec_command API. Returns its actual execution receipt; no line numbering, offset/limit or image decoding is provided.",
    };
    json!({"type":"function","function":{"name":tool.name(),"description":description,"parameters":{"type":"object","properties":{parameter:{"type":"string"}},"required":[parameter],"additionalProperties":false}}})
}

pub fn apply_opencode_zen_tcm_request(payload: &mut Value, binding: &OpencodeZenTcmBridgeBinding) {
    restore_native_history(payload, binding);
    if binding.response_aliases.is_empty() {
        return;
    }
    if let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) {
        tools.extend(binding.response_aliases.iter().copied().map(declaration));
    }
    let references: Vec<_> = binding
        .response_aliases
        .iter()
        .map(|tool| json!({"type":"function","function":{"name":tool.name()}}))
        .collect();
    if let Some(choice) = payload.get_mut("tool_choice") {
        if choice["type"] == "function"
            && choice_name(choice) == Some(binding.executor_wire_name.as_str())
        {
            let mut tools = vec![choice.clone()];
            tools.extend(references);
            *choice =
                json!({"type":"allowed_tools","allowed_tools":{"mode":"required","tools":tools}});
        } else if choice["type"] == "allowed_tools" {
            if let Some(tools) = choice["allowed_tools"]["tools"].as_array_mut() {
                tools.extend(references)
            }
        }
    }
}

fn restore_native_history(payload: &mut Value, binding: &OpencodeZenTcmBridgeBinding) {
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let mut counts = BTreeMap::<String, usize>::new();
    for message in messages.iter() {
        for call in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                *counts.entry(id.to_owned()).or_default() += 1
            }
        }
    }
    let mut restored = BTreeMap::<String, &'static str>::new();
    for message in messages
        .iter_mut()
        .filter(|message| message["role"] == "assistant")
    {
        for call in message
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let id = call.get("id").and_then(Value::as_str).map(str::to_owned);
            let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) else {
                continue;
            };
            if function.get("name").and_then(Value::as_str)
                != Some(binding.executor_wire_name.as_str())
            {
                continue;
            }
            let wrapper = match function.get("arguments") {
                Some(Value::String(arguments)) => serde_json::from_str::<Value>(arguments).ok(),
                Some(arguments) => Some(arguments.clone()),
                None => None,
            };
            let Some(wrapper) = wrapper
                .as_ref()
                .and_then(Value::as_object)
                .filter(|wrapper| wrapper.len() == 1)
            else {
                continue;
            };
            let Some(native) = wrapper
                .get("input")
                .and_then(Value::as_str)
                .and_then(decode_canonical_native_call)
            else {
                continue;
            };
            function.insert("name".into(), json!(native.tool.name()));
            match native.arguments {
                Some(arguments) => {
                    function.insert("arguments".into(), arguments);
                }
                None => {
                    function.remove("arguments");
                }
            }
            if let Some(id) = id.filter(|id| counts.get(id) == Some(&1)) {
                restored.insert(id, native.tool.name());
            }
        }
    }
    for result in messages
        .iter_mut()
        .filter(|message| message["role"] == "tool")
    {
        let native = result
            .get("tool_call_id")
            .and_then(Value::as_str)
            .and_then(|id| restored.get(id))
            .copied();
        if result.get("name").and_then(Value::as_str) == Some(binding.executor_wire_name.as_str()) {
            if let Some(native) = native {
                result["name"] = json!(native)
            }
        }
    }
}

pub fn apply_opencode_zen_tcm_response(payload: &mut Value, binding: &OpencodeZenTcmBridgeBinding) {
    for choice in payload
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for call in choice
            .get_mut("message")
            .and_then(|message| message.get_mut("tool_calls"))
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(function) = call.get_mut("function").and_then(Value::as_object_mut) else {
                continue;
            };
            let Some(tool) = binding
                .response_aliases
                .iter()
                .copied()
                .find(|tool| function.get("name").and_then(Value::as_str) == Some(tool.name()))
            else {
                continue;
            };
            let native = ZenNativeCall {
                tool,
                arguments: function.get("arguments").cloned(),
            };
            function.insert("name".into(), json!(binding.executor_wire_name));
            function.insert(
                "arguments".into(),
                json!(json!({"input":encode_native_call(&native)}).to_string()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn client_and_provider() -> (Value, Value) {
        let client = json!({"tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","description":"Evaluates JavaScript in a fresh V8 isolate as an async module. tools.exec_command. Runs raw JavaScript. text(value)","format":{"type":"grammar","syntax":"lark","definition":TCM_GRAMMAR}}]}]});
        let provider = json!({"tools":[{"type":"function","function":{"name":"functions__exec","parameters":crate::namespace_tools::openai_chat_freeform_custom_tool_parameters()}}],"messages":[{"role":"user","content":"test"}],"tool_choice":"auto"});
        (client, provider)
    }
    fn binding() -> OpencodeZenTcmBridgeBinding {
        OpencodeZenTcmBridgeBinding {
            executor_wire_name: "functions__exec".into(),
            response_aliases: vec![ZenNativeTool::Bash, ZenNativeTool::Read],
        }
    }
    #[test]
    fn opencode_zen_tcm_codec_is_lossless_and_exact() {
        for tool in [ZenNativeTool::Bash, ZenNativeTool::Read] {
            for arguments in [
                None,
                Some(Value::Null),
                Some(json!("not json {")),
                Some(json!(" {\"command\":\"printf '$`\\n'\"} ")),
                Some(json!({"filePath":"-a'\n$`雪", "extra":false})),
            ] {
                let call = ZenNativeCall { tool, arguments };
                let encoded = encode_native_call(&call);
                assert_eq!(decode_canonical_native_call(&encoded), Some(call));
                assert_eq!(
                    decode_canonical_native_call(&(encoded.clone() + "\ntext('extra')")),
                    None
                );
                assert_eq!(
                    decode_canonical_native_call(&(" ".to_string() + &encoded)),
                    None
                );
            }
        }
    }
    #[test]
    fn opencode_zen_tcm_response_request_preserve_native_pair() {
        let original = json!({"id":"call_bash", "type":"function", "function":{"name":"bash", "arguments":" {\"command\":\"printf ok\"} "}});
        let mut response = json!({"choices":[{"message":{"tool_calls":[original.clone()]}}]});
        apply_opencode_zen_tcm_response(&mut response, &binding());
        let call = response["choices"][0]["message"]["tool_calls"][0].clone();
        assert_eq!(call["function"]["name"], "functions__exec");
        let mut request = json!({"tools":[], "messages":[{"role":"assistant", "tool_calls":[call]}, {"role":"tool", "tool_call_id":"call_bash", "content":"real stdout/stderr/exit receipt"}]});
        apply_opencode_zen_tcm_request(&mut request, &binding());
        assert_eq!(request["messages"][0]["tool_calls"][0], original);
        assert_eq!(
            request["messages"][1],
            json!({"role":"tool", "tool_call_id":"call_bash", "content":"real stdout/stderr/exit receipt"})
        );
    }
    #[test]
    fn opencode_zen_tcm_binding_requires_actual_contract_and_preserves_collisions() {
        let (mut client, mut provider) = client_and_provider();
        let bound = compile_opencode_zen_tcm_bridge(&client, &provider).unwrap();
        assert_eq!(bound, binding());
        provider["tools"]
            .as_array_mut()
            .unwrap()
            .push(declaration(ZenNativeTool::Bash));
        let bound = compile_opencode_zen_tcm_bridge(&client, &provider).unwrap();
        assert_eq!(bound.response_aliases, vec![ZenNativeTool::Read]);
        let mut response = json!({"choices":[{"message":{"tool_calls":[{"id":"native","function":{"name":"bash","arguments":"{}"}},{"id":"bridge","function":{"name":"read","arguments":null}}]}}]});
        apply_opencode_zen_tcm_response(&mut response, &bound);
        assert_eq!(
            response["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "bash"
        );
        assert_eq!(
            response["choices"][0]["message"]["tool_calls"][1]["function"]["name"],
            "functions__exec"
        );
        client["tools"][0]["tools"][0]["format"]["definition"] = json!("start: 'restricted'");
        assert!(compile_opencode_zen_tcm_bridge(&client, &provider).is_none());
        assert!(compile_opencode_zen_tcm_bridge(&json!({}), &provider).is_none());
    }
    #[test]
    fn opencode_zen_tcm_choice_restrictions_do_not_disable_history_inverse() {
        let (client, mut provider) = client_and_provider();
        provider["tool_choice"] = json!("none");
        let bound = compile_opencode_zen_tcm_bridge(&client, &provider).unwrap();
        assert!(bound.response_aliases.is_empty());
        let script = encode_native_call(&ZenNativeCall {
            tool: ZenNativeTool::Read,
            arguments: Some(json!("{\"filePath\":\"x\"}")),
        });
        provider["messages"] = json!([{"role":"assistant","tool_calls":[{"id":"read_id","function":{"name":"functions__exec","arguments":json!({"input":script}).to_string()}}]},{"role":"tool","tool_call_id":"read_id","content":"actual denied receipt"}]);
        apply_opencode_zen_tcm_request(&mut provider, &bound);
        assert_eq!(provider["tools"].as_array().unwrap().len(), 1);
        assert_eq!(provider["tool_choice"], "none");
        assert_eq!(
            provider["messages"][0]["tool_calls"][0]["function"]["name"],
            "read"
        );
        assert_eq!(provider["messages"][1]["content"], "actual denied receipt");
        provider["tool_choice"] = json!({"type":"function","function":{"name":"other"}});
        assert!(compile_opencode_zen_tcm_bridge(&client, &provider)
            .unwrap()
            .response_aliases
            .is_empty());
        provider["tool_choice"] = json!({"type":"function","function":{"name":"functions__exec"}});
        let bound = compile_opencode_zen_tcm_bridge(&client, &provider).unwrap();
        apply_opencode_zen_tcm_request(&mut provider, &bound);
        assert_eq!(provider["tool_choice"]["allowed_tools"]["mode"], "required");
        assert_eq!(
            provider["tool_choice"]["allowed_tools"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }
}
