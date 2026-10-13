use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const PROFILE: &str = "responses:custom-tool-function";
const WIRE_PREFIX: &str = "routecodex_custom__";
const WIRE_HASH_HEX_LEN: usize = 16;
const MAX_PROVIDER_FUNCTION_NAME_LEN: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomToolFunctionBinding {
    name_to_wire: BTreeMap<String, String>,
    wire_to_name: BTreeMap<String, String>,
}

impl CustomToolFunctionBinding {
    pub fn is_empty(&self) -> bool {
        self.name_to_wire.is_empty()
    }

    /// The provider wire function name bound to a custom tool `name`.
    pub fn wire_name_for(&self, name: &str) -> Option<&str> {
        self.name_to_wire.get(name).map(String::as_str)
    }

    fn original_name(&self, wire_name: &str) -> Option<&str> {
        self.wire_to_name.get(wire_name).map(String::as_str)
    }
}

pub fn compile_custom_tool_function_binding(payload: &Value) -> CustomToolFunctionBinding {
    let mut ordinary_function_names = BTreeSet::new();
    let mut custom_tool_names = Vec::new();
    let mut seen_custom_tool_names = BTreeSet::new();

    if let Some(tools) = payload.get("tools").and_then(Value::as_array) {
        for tool in tools {
            let Some(tool_obj) = tool.as_object() else {
                continue;
            };
            let Some(name) = tool_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            match tool_obj.get("type").and_then(Value::as_str) {
                Some("function") => {
                    ordinary_function_names.insert(name.to_string());
                }
                Some("custom") if seen_custom_tool_names.insert(name.to_string()) => {
                    custom_tool_names.push(name.to_string());
                }
                _ => {}
            }
        }
    }

    if let Some(input) = payload.get("input").and_then(Value::as_array) {
        for item in input {
            if item.get("type").and_then(Value::as_str) != Some("custom_tool_call") {
                continue;
            }
            let Some(name) = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            if seen_custom_tool_names.insert(name.to_string()) {
                custom_tool_names.push(name.to_string());
            }
        }
    }

    let mut binding = CustomToolFunctionBinding::default();
    for name in custom_tool_names {
        let wire = select_wire_name(&name, &ordinary_function_names, &binding.wire_to_name);
        binding.name_to_wire.insert(name.clone(), wire.clone());
        binding.wire_to_name.insert(wire, name);
    }
    binding
}

/// Responses gateways that reject `custom_tool_call` history but accept the
/// equivalent function-call shape.
///
/// The wire name carries the custom-tool identity. This keeps request and
/// response mapping symmetric without adding request-scoped state to the
/// provider protocol.
#[derive(Debug, Default)]
pub struct SseState {
    binding: CustomToolFunctionBinding,
    mapped_items: BTreeSet<String>,
    argument_buffers: BTreeMap<String, String>,
    emitted_inputs: BTreeMap<String, String>,
}

impl SseState {
    pub fn new(binding: CustomToolFunctionBinding) -> Self {
        Self {
            binding,
            ..Default::default()
        }
    }
}

pub(crate) fn apply_request_compat(payload: Value) -> Result<Value, String> {
    let binding = compile_custom_tool_function_binding(&payload);
    apply_request_compat_with_binding(payload, &binding)
}

pub(crate) fn apply_request_compat_with_binding(
    payload: Value,
    binding: &CustomToolFunctionBinding,
) -> Result<Value, String> {
    let mut root = payload.as_object().cloned().ok_or_else(|| {
        format!("MalformedPayload profile={PROFILE} reason=request_object_required")
    })?;
    let mut custom_tool_names = BTreeSet::new();
    if let Some(tools) = root.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut() {
            let Some(tool_obj) = tool.as_object_mut() else {
                continue;
            };
            if tool_obj.get("type").and_then(Value::as_str) != Some("custom") {
                continue;
            }
            let Some(name) = tool_obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let wire = binding
                .wire_name_for(name)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| wire_name(name));
            let mut function = Map::new();
            function.insert("type".to_string(), Value::String("function".to_string()));
            function.insert("name".to_string(), Value::String(wire));
            if let Some(description) = tool_obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                function.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            function.insert(
                "parameters".to_string(),
                json!({
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": name}
                    },
                    "required": ["input"]
                }),
            );
            custom_tool_names.insert(name.to_string());
            *tool = Value::Object(function);
        }
    }
    if !custom_tool_names.is_empty() {
        if let Some(choice) = root.get_mut("tool_choice") {
            map_request_tool_choice(choice, &custom_tool_names, binding);
        }
    }
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        for item in input.iter_mut() {
            let Some(item_obj) = item.as_object_mut() else {
                continue;
            };
            match item_obj.get("type").and_then(Value::as_str) {
                Some("custom_tool_call") => {
                    let Some(name) = item_obj
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(ToOwned::to_owned)
                    else {
                        continue;
                    };
                    let Some(raw_input) = item_obj.get("input").cloned() else {
                        continue;
                    };
                    let arguments = serde_json::to_string(&json!({"input": raw_input}))
                        .map_err(|error| {
                            format!(
                                "MalformedPayload profile={PROFILE} reason=custom_input_serialize error={error}"
                            )
                        })?;
                    item_obj.insert(
                        "type".to_string(),
                        Value::String("function_call".to_string()),
                    );
                    let wire = binding
                        .wire_name_for(&name)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| wire_name(&name));
                    item_obj.insert("name".to_string(), Value::String(wire));
                    item_obj.insert("arguments".to_string(), Value::String(arguments));
                    item_obj.remove("input");
                }
                Some("custom_tool_call_output") => {
                    item_obj.insert(
                        "type".to_string(),
                        Value::String("function_call_output".to_string()),
                    );
                }
                _ => {}
            }
        }
    }
    Ok(Value::Object(root))
}

pub(crate) fn apply_response_compat(payload: Value, binding: &CustomToolFunctionBinding) -> Value {
    if binding.is_empty() {
        return payload;
    }
    let Some(mut root) = payload.as_object().cloned() else {
        return payload;
    };
    if let Some(output) = root.get_mut("output").and_then(Value::as_array_mut) {
        for item in output {
            map_response_item(item, binding);
        }
    }
    Value::Object(root)
}

pub fn apply_sse_event_compat(event: &mut Value, state: &mut SseState) {
    let Some(object) = event.as_object_mut() else {
        return;
    };
    let event_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    match event_type.as_deref() {
        Some("response.output_item.added" | "response.output_item.done") => {
            let Some(item) = object.get_mut("item") else {
                return;
            };
            if !map_response_item(item, &state.binding) {
                return;
            }
            if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                state.mapped_items.insert(item_id.to_string());
            }
        }
        Some("response.function_call_arguments.delta") => {
            let Some(item_id) = object
                .get("item_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
            else {
                return;
            };
            if !state.mapped_items.contains(&item_id) {
                return;
            }
            let delta = object
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut buffer = state.argument_buffers.remove(&item_id).unwrap_or_default();
            buffer.push_str(delta);
            // While the buffered arguments are still incomplete, or when the
            // parsed input adds nothing new, the event must still leave as a
            // custom-tool delta. Returning early here would leak the provider's
            // function-call wire event to the client.
            let projected = match unwrap_custom_tool_input(&buffer) {
                Some(input) => {
                    let emitted = state.emitted_inputs.entry(item_id.clone()).or_default();
                    if input.starts_with(emitted.as_str()) {
                        let suffix = input[emitted.len()..].to_string();
                        emitted.push_str(&suffix);
                        suffix
                    } else {
                        String::new()
                    }
                }
                None => String::new(),
            };
            state.argument_buffers.insert(item_id, buffer);
            object.insert(
                "type".to_string(),
                Value::String("response.custom_tool_call_input.delta".to_string()),
            );
            object.insert("delta".to_string(), Value::String(projected));
        }
        Some("response.function_call_arguments.done") => {
            let Some(item_id) = object.get("item_id").and_then(Value::as_str) else {
                return;
            };
            if !state.mapped_items.contains(item_id) {
                return;
            }
            let arguments = object
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let input = project_custom_tool_input(arguments);
            object.insert(
                "type".to_string(),
                Value::String("response.custom_tool_call_input.done".to_string()),
            );
            object.insert("input".to_string(), Value::String(input));
            object.remove("arguments");
        }
        Some("response.completed" | "response.incomplete" | "response.failed") => {
            let Some(output) = object
                .get_mut("response")
                .and_then(Value::as_object_mut)
                .and_then(|response| response.get_mut("output"))
                .and_then(Value::as_array_mut)
            else {
                return;
            };
            for item in output {
                map_response_item(item, &state.binding);
            }
        }
        _ => {}
    }
}

fn map_response_item(item: &mut Value, binding: &CustomToolFunctionBinding) -> bool {
    let Some(item_obj) = item.as_object_mut() else {
        return false;
    };
    if item_obj.get("type").and_then(Value::as_str) != Some("function_call") {
        return false;
    }
    let Some(wire_name) = item_obj
        .get("name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return false;
    };
    let Some(original_name) = binding.original_name(&wire_name) else {
        return false;
    };
    let input = match item_obj.get("arguments") {
        Some(Value::String(text)) => project_custom_tool_input(text),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    item_obj.insert(
        "type".to_string(),
        Value::String("custom_tool_call".to_string()),
    );
    item_obj.insert("name".to_string(), Value::String(original_name.to_string()));
    item_obj.insert("input".to_string(), Value::String(input));
    item_obj.remove("arguments");
    true
}

fn unwrap_custom_tool_input(arguments: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(arguments).ok()?;
    match value.get("input")? {
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// Project provider `function_call.arguments` into the client's custom tool
/// input. When the wire payload cannot be unwrapped, keep the original text so
/// real provider content reaches the client instead of an empty placeholder.
fn project_custom_tool_input(arguments: &str) -> String {
    unwrap_custom_tool_input(arguments).unwrap_or_else(|| arguments.to_string())
}

/// A named Responses `tool_choice` that selects a custom tool must follow the
/// declaration onto the function wire name. Otherwise the provider sees a
/// choice for a tool it was never offered.
fn map_request_tool_choice(
    choice: &mut Value,
    custom_tool_names: &BTreeSet<String>,
    binding: &CustomToolFunctionBinding,
) {
    let Some(object) = choice.as_object_mut() else {
        return;
    };
    if object.get("type").and_then(Value::as_str) == Some("allowed_tools") {
        map_allowed_tools_tool_choice(object, custom_tool_names, binding);
        return;
    }
    let declared_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let top_level_name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned);
    let nested_name = object
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned);
    let Some(name) = top_level_name.clone().or_else(|| nested_name.clone()) else {
        return;
    };
    let targets_custom = match declared_type.as_deref() {
        Some("custom") => true,
        Some("function") => custom_tool_names.contains(&name),
        _ => false,
    };
    if !targets_custom {
        return;
    }
    let wire = binding
        .wire_name_for(&name)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| wire_name(&name));
    object.insert("type".to_string(), Value::String("function".to_string()));
    if top_level_name.is_some() {
        object.insert("name".to_string(), Value::String(wire.clone()));
    }
    if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
        function.insert("name".to_string(), Value::String(wire));
    }
}

/// A Responses `allowed_tools` choice carries its `mode` and reference list
/// directly on the `tool_choice` object (OpenAI `ToolChoiceAllowed`), not under
/// an `allowed_tools` child. Each reference that selects a custom tool must
/// follow its declaration onto the provider wire function name; ordinary
/// references and the `mode` field stay untouched.
fn map_allowed_tools_tool_choice(
    object: &mut Map<String, Value>,
    custom_tool_names: &BTreeSet<String>,
    binding: &CustomToolFunctionBinding,
) {
    let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let Some(tool_obj) = tool.as_object_mut() else {
            continue;
        };
        let Some(name) = tool_obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let targets_custom = tool_obj
            .get("type")
            .and_then(Value::as_str)
            .map(|tool_type| tool_type == "custom" || custom_tool_names.contains(&name))
            .unwrap_or(false);
        if !targets_custom {
            continue;
        }
        let wire = binding
            .wire_name_for(&name)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| wire_name(&name));
        tool_obj.insert("type".to_string(), Value::String("function".to_string()));
        tool_obj.insert("name".to_string(), Value::String(wire));
    }
}

fn wire_name(name: &str) -> String {
    // Hex-encode the original name so the inverse is derived from the wire
    // name itself instead of guessed from a bare prefix. An ordinary function
    // whose name merely starts with `routecodex_custom__` does not decode and
    // stays a function call.
    let mut wire = String::with_capacity(WIRE_PREFIX.len() + name.len() * 2);
    wire.push_str(WIRE_PREFIX);
    for byte in name.as_bytes() {
        use std::fmt::Write;
        let _ = write!(wire, "{byte:02x}");
    }
    wire
}

fn select_wire_name(
    name: &str,
    ordinary_function_names: &BTreeSet<String>,
    used_wire_names: &BTreeMap<String, String>,
) -> String {
    let reversible = wire_name(name);
    if reversible.len() <= MAX_PROVIDER_FUNCTION_NAME_LEN
        && !ordinary_function_names.contains(&reversible)
        && !used_wire_names.contains_key(&reversible)
    {
        return reversible;
    }

    let mut salt = 0_u64;
    loop {
        let mut hasher = Sha256::new();
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(salt.to_be_bytes());
        let digest = hasher.finalize();
        let mut hash = String::with_capacity(WIRE_HASH_HEX_LEN);
        for byte in digest.iter().take(WIRE_HASH_HEX_LEN / 2) {
            use std::fmt::Write;
            let _ = write!(hash, "{byte:02x}");
        }
        let candidate = format!("{WIRE_PREFIX}{hash}");
        if candidate.len() <= MAX_PROVIDER_FUNCTION_NAME_LEN
            && !ordinary_function_names.contains(&candidate)
            && !used_wire_names.contains_key(&candidate)
        {
            return candidate;
        }
        salt = salt.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(name: &str) -> String {
        wire_name(name)
    }

    fn binding_for(name: &str) -> CustomToolFunctionBinding {
        let mut binding = CustomToolFunctionBinding::default();
        let wire = wire(name);
        binding.name_to_wire.insert(name.to_string(), wire.clone());
        binding.wire_to_name.insert(wire, name.to_string());
        binding
    }

    #[test]
    fn request_maps_all_custom_tools_and_history_to_function_shape() {
        let mapped = apply_request_compat(json!({
            "model": "kimi-k3",
            "tools": [
                {"type": "custom", "name": "apply_patch", "description": "patch"},
                {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
            ],
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ]
        }))
        .unwrap();

        assert_eq!(mapped["tools"][0]["type"], "function");
        assert_eq!(mapped["tools"][0]["name"], wire("apply_patch"));
        assert_eq!(mapped["tools"][1]["type"], "function");
        assert_eq!(mapped["input"][1]["type"], "function_call");
        assert_eq!(mapped["input"][1]["name"], wire("apply_patch"));
        assert_eq!(
            mapped["input"][1]["arguments"],
            "{\"input\":\"*** Begin Patch\"}"
        );
        assert!(mapped["input"][1].get("input").is_none());
        assert_eq!(mapped["input"][2]["type"], "function_call_output");
        assert_eq!(mapped["input"][2]["call_id"], "call_1");
    }

    #[test]
    fn response_maps_only_prefixed_function_calls_back_to_custom() {
        let mapped = apply_response_compat(
            json!({
                "output": [
                    {"type": "function_call", "call_id": "call_1", "name": wire("apply_patch"), "arguments": "{\"input\":\"*** Begin Patch\"}"},
                    {"type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                ]
            }),
            &binding_for("apply_patch"),
        );

        assert_eq!(mapped["output"][0]["type"], "custom_tool_call");
        assert_eq!(mapped["output"][0]["name"], "apply_patch");
        assert_eq!(mapped["output"][0]["input"], "*** Begin Patch");
        assert!(mapped["output"][0].get("arguments").is_none());
        assert_eq!(mapped["output"][1]["type"], "function_call");
        assert_eq!(mapped["output"][1]["name"], "exec_command");
    }

    #[test]
    fn request_keeps_plain_function_that_shares_reserved_prefix() {
        let mapped = apply_request_compat(json!({
            "tools": [
                {"type": "custom", "name": "apply_patch"},
                {"type": "function", "name": "routecodex_custom__apply_patch", "parameters": {"type": "object"}}
            ]
        }))
        .unwrap();

        assert_eq!(mapped["tools"][0]["name"], wire("apply_patch"));
        assert_eq!(mapped["tools"][1]["name"], "routecodex_custom__apply_patch");
    }

    #[test]
    fn response_keeps_ordinary_function_that_shares_reserved_prefix() {
        let mapped = apply_response_compat(
            json!({
                "output": [
                    {"type": "function_call", "call_id": "call_1", "name": wire("apply_patch"), "arguments": "{\"input\":\"patch\"}"},
                    {"type": "function_call", "call_id": "call_2", "name": "routecodex_custom__apply_patch", "arguments": "{\"cmd\":\"pwd\"}"}
                ]
            }),
            &binding_for("apply_patch"),
        );

        assert_eq!(mapped["output"][0]["type"], "custom_tool_call");
        assert_eq!(mapped["output"][0]["name"], "apply_patch");
        assert_eq!(mapped["output"][1]["type"], "function_call");
        assert_eq!(
            mapped["output"][1]["name"],
            "routecodex_custom__apply_patch"
        );
        assert_eq!(mapped["output"][1]["arguments"], "{\"cmd\":\"pwd\"}");
    }

    #[test]
    fn request_avoids_an_ordinary_function_that_equals_the_reversible_wire_name() {
        let request = json!({
            "tools": [
                {"type": "custom", "name": "apply_patch"},
                {"type": "function", "name": wire("apply_patch"), "parameters": {"type": "object"}}
            ]
        });
        let binding = compile_custom_tool_function_binding(&request);
        let mapped = apply_request_compat_with_binding(request, &binding).unwrap();

        let custom_wire = mapped["tools"][0]["name"].as_str().unwrap();
        assert_ne!(custom_wire, wire("apply_patch"));
        assert!(custom_wire.len() <= MAX_PROVIDER_FUNCTION_NAME_LEN);
        assert_eq!(mapped["tools"][1]["name"], wire("apply_patch"));

        let response = apply_response_compat(
            json!({
                "output": [
                    {"type": "function_call", "call_id": "call_1", "name": custom_wire, "arguments": "{\"input\":\"patch\"}"},
                    {"type": "function_call", "call_id": "call_2", "name": wire("apply_patch"), "arguments": "{\"cmd\":\"pwd\"}"}
                ]
            }),
            &binding,
        );
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["name"], "apply_patch");
        assert_eq!(response["output"][1]["type"], "function_call");
        assert_eq!(response["output"][1]["name"], wire("apply_patch"));
    }

    #[test]
    fn tool_choice_follows_a_custom_tool_onto_its_collision_wire_name() {
        let request = json!({
            "tools": [
                {"type": "custom", "name": "apply_patch"},
                {"type": "function", "name": wire("apply_patch"), "parameters": {"type": "object"}}
            ],
            "tool_choice": {"type": "custom", "name": "apply_patch"}
        });
        let binding = compile_custom_tool_function_binding(&request);
        let custom_wire = binding
            .wire_name_for("apply_patch")
            .expect("custom tool must be bound")
            .to_string();
        assert_ne!(custom_wire, wire("apply_patch"));

        let mapped = apply_request_compat_with_binding(request, &binding).unwrap();
        assert_eq!(mapped["tool_choice"]["type"], "function");
        assert_eq!(mapped["tool_choice"]["name"], custom_wire);
        assert_eq!(
            mapped["tools"][1]["name"],
            wire("apply_patch"),
            "the ordinary function must keep the reversible name that collided with the custom tool"
        );
    }

    #[test]
    fn allowed_tools_choice_references_follow_custom_and_ordinary_wire_names() {
        let request = json!({
            "tools": [
                {"type": "custom", "name": "apply_patch"},
                {"type": "function", "name": wire("apply_patch"), "parameters": {"type": "object"}}
            ],
            "tool_choice": {
                "type": "allowed_tools",
                "mode": "required",
                "tools": [
                    {"type": "custom", "name": "apply_patch"},
                    {"type": "function", "name": wire("apply_patch")}
                ]
            }
        });
        let binding = compile_custom_tool_function_binding(&request);
        let custom_wire = binding
            .wire_name_for("apply_patch")
            .expect("custom tool must be bound")
            .to_string();
        assert_ne!(custom_wire, wire("apply_patch"));

        let mapped = apply_request_compat_with_binding(request, &binding).unwrap();
        assert_eq!(mapped["tool_choice"]["type"], "allowed_tools");
        assert_eq!(mapped["tool_choice"]["mode"], "required");
        assert_eq!(mapped["tool_choice"]["tools"][0]["type"], "function");
        assert_eq!(mapped["tool_choice"]["tools"][0]["name"], custom_wire);
        assert_eq!(mapped["tool_choice"]["tools"][1]["type"], "function");
        assert_eq!(
            mapped["tool_choice"]["tools"][1]["name"],
            wire("apply_patch"),
            "an ordinary allowed-tools reference must keep its own wire name"
        );
    }

    #[test]
    fn long_custom_name_uses_a_short_wire_name_and_roundtrips() {
        let long_name = "custom_tool_name_that_is_twenty_four";
        let request = json!({
            "tools": [{"type": "custom", "name": long_name}]
        });
        let binding = compile_custom_tool_function_binding(&request);
        let mapped = apply_request_compat_with_binding(request, &binding).unwrap();
        let custom_wire = mapped["tools"][0]["name"].as_str().unwrap();

        assert!(custom_wire.len() <= MAX_PROVIDER_FUNCTION_NAME_LEN);
        assert_ne!(custom_wire, wire(long_name));

        let response = apply_response_compat(
            json!({
                "output": [{
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": custom_wire,
                    "arguments": "{\"input\":\"patch\"}"
                }]
            }),
            &binding,
        );
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["name"], long_name);
        assert_eq!(response["output"][0]["input"], "patch");
    }

    #[test]
    fn request_maps_named_custom_tool_choice_to_function_wire_name() {
        for choice in [
            json!({"type": "custom", "name": "apply_patch"}),
            json!({"type": "function", "name": "apply_patch"}),
            json!({"type": "function", "function": {"name": "apply_patch"}}),
        ] {
            let mapped = apply_request_compat(json!({
                "tools": [{"type": "custom", "name": "apply_patch"}],
                "tool_choice": choice
            }))
            .unwrap();
            let choice = &mapped["tool_choice"];
            assert_eq!(choice["type"], "function", "choice={choice}");
            let name = choice
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| choice["function"]["name"].as_str());
            assert_eq!(name, Some(wire("apply_patch").as_str()), "choice={choice}");
        }

        let untouched = apply_request_compat(json!({
            "tools": [{"type": "custom", "name": "apply_patch"}],
            "tool_choice": {"type": "function", "name": "exec_command"}
        }))
        .unwrap();
        assert_eq!(untouched["tool_choice"]["name"], "exec_command");
    }

    #[test]
    fn response_preserves_unwrappable_arguments_instead_of_empty_input() {
        let mapped = apply_response_compat(
            json!({
                "output": [
                    {"type": "function_call", "call_id": "call_1", "name": wire("apply_patch"), "arguments": "not-json"},
                    {"type": "function_call", "call_id": "call_2", "name": wire("apply_patch"), "arguments": "{\"input\":42}"}
                ]
            }),
            &binding_for("apply_patch"),
        );

        assert_eq!(mapped["output"][0]["type"], "custom_tool_call");
        assert_eq!(mapped["output"][0]["input"], "not-json");
        assert_eq!(mapped["output"][1]["type"], "custom_tool_call");
        assert_eq!(mapped["output"][1]["input"], "42");
    }

    #[test]
    fn sse_empty_delta_never_leaks_function_call_arguments_event() {
        let mut state = SseState::new(binding_for("apply_patch"));
        let mut added = json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": wire("apply_patch"),
                "arguments": ""
            }
        });
        apply_sse_event_compat(&mut added, &mut state);

        let mut delta = json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "{\"input\":\"*** Begin Patch\"}"
        });
        apply_sse_event_compat(&mut delta, &mut state);
        assert_eq!(delta["type"], "response.custom_tool_call_input.delta");
        assert_eq!(delta["delta"], "*** Begin Patch");

        // The buffered arguments already equal the emitted input, so this
        // delta projects to an empty custom delta. It must still be rewritten.
        let mut redundant = json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": ""
        });
        apply_sse_event_compat(&mut redundant, &mut state);
        assert_eq!(redundant["type"], "response.custom_tool_call_input.delta");
        assert_eq!(redundant["delta"], "");
    }

    #[test]
    fn sse_maps_incomplete_response_output_items() {
        let mut state = SseState::new(binding_for("apply_patch"));
        let mut incomplete = json!({
            "type": "response.incomplete",
            "response": {
                "output": [{
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": wire("apply_patch"),
                    "arguments": "{\"input\":\"*** Begin Patch\"}"
                }]
            }
        });
        apply_sse_event_compat(&mut incomplete, &mut state);
        assert_eq!(
            incomplete["response"]["output"][0]["type"],
            "custom_tool_call"
        );
        assert_eq!(
            incomplete["response"]["output"][0]["input"],
            "*** Begin Patch"
        );
        assert!(incomplete["response"]["output"][0]
            .get("arguments")
            .is_none());
    }

    #[test]
    fn sse_done_preserves_unwrappable_arguments() {
        let mut state = SseState::new(binding_for("apply_patch"));
        let mut added = json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": wire("apply_patch"),
                "arguments": ""
            }
        });
        apply_sse_event_compat(&mut added, &mut state);

        let mut done = json!({
            "type": "response.function_call_arguments.done",
            "item_id": "fc_1",
            "arguments": "not-json"
        });
        apply_sse_event_compat(&mut done, &mut state);
        assert_eq!(done["type"], "response.custom_tool_call_input.done");
        assert_eq!(done["input"], "not-json");
        assert!(done.get("arguments").is_none());
    }

    #[test]
    fn sse_maps_added_delta_done_and_completed_events() {
        let mut state = SseState::new(binding_for("apply_patch"));
        let mut added = json!({
            "type": "response.output_item.added",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": wire("apply_patch"),
                "arguments": ""
            }
        });
        apply_sse_event_compat(&mut added, &mut state);
        assert_eq!(added["item"]["type"], "custom_tool_call");
        assert_eq!(added["item"]["name"], "apply_patch");
        assert_eq!(added["item"]["input"], "");

        let mut delta = json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "{\"input\":\"*** Begin "
        });
        apply_sse_event_compat(&mut delta, &mut state);
        assert_eq!(delta["type"], "response.custom_tool_call_input.delta");
        assert_eq!(delta["delta"], "");

        let mut delta = json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "Patch\"}"
        });
        apply_sse_event_compat(&mut delta, &mut state);
        assert_eq!(delta["type"], "response.custom_tool_call_input.delta");
        assert_eq!(delta["delta"], "*** Begin Patch");

        let mut done = json!({
            "type": "response.function_call_arguments.done",
            "item_id": "fc_1",
            "arguments": "{\"input\":\"*** Begin Patch\"}"
        });
        apply_sse_event_compat(&mut done, &mut state);
        assert_eq!(done["type"], "response.custom_tool_call_input.done");
        assert_eq!(done["input"], "*** Begin Patch");
        assert!(done.get("arguments").is_none());

        let mut completed = json!({
            "type": "response.completed",
            "response": {
                "output": [{
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": wire("apply_patch"),
                    "arguments": "{\"input\":\"*** Begin Patch\"}"
                }]
            }
        });
        apply_sse_event_compat(&mut completed, &mut state);
        assert_eq!(
            completed["response"]["output"][0]["type"],
            "custom_tool_call"
        );
        assert_eq!(
            completed["response"]["output"][0]["input"],
            "*** Begin Patch"
        );
    }
}
