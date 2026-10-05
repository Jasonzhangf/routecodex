//! Reversible wire representation for the explicit Goaichat Messages profile.
use crate::namespace_tools::provider_tool_wire_names_with_prefix;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GoaichatToolNameProjection {
    aliases: HashMap<String, String>,
    inverse: HashMap<String, String>,
}

impl GoaichatToolNameProjection {
    pub fn client_name<'a>(&'a self, name: &'a str) -> &'a str {
        self.inverse.get(name).map(String::as_str).unwrap_or(name)
    }
    pub fn for_request(profile: Option<&str>, protocol: &str, payload: &Value) -> Self {
        if !profile.is_some_and(|value| value.trim().eq_ignore_ascii_case("anthropic:goaichat"))
            || protocol != "anthropic-messages"
        {
            return Self::default();
        }
        let names: BTreeSet<String> = payload
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        // Goaichat rejects a pure 64-hex alias for a described forced tool.
        let aliases = provider_tool_wire_names_with_prefix(names.clone(), names, "tool_");
        let inverse = aliases
            .iter()
            .map(|(original, alias)| (alias.clone(), original.clone()))
            .collect();
        Self { aliases, inverse }
    }

    pub fn project_request(&self, payload: &mut Value) {
        for tool in payload
            .get_mut("tools")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            Self::rewrite(tool.get_mut("name"), &self.aliases);
        }
        for message in payload
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            for block in message
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    Self::rewrite(block.get_mut("name"), &self.aliases);
                }
            }
        }
        Self::rewrite(payload.pointer_mut("/tool_choice/name"), &self.aliases);
    }

    pub fn restore_response(&self, payload: &mut Value) {
        for block in payload
            .get_mut("content")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                Self::rewrite(block.get_mut("name"), &self.inverse);
            }
        }
        if payload
            .pointer("/content_block/type")
            .and_then(Value::as_str)
            == Some("tool_use")
        {
            Self::rewrite(payload.pointer_mut("/content_block/name"), &self.inverse);
        }
    }

    fn rewrite(value: Option<&mut Value>, names: &HashMap<String, String>) {
        if let Some(value) = value {
            if let Some(name) = value.as_str().and_then(|name| names.get(name)) {
                *value = Value::String(name.clone());
            }
        }
    }
}
