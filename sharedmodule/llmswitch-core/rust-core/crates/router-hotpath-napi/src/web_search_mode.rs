// feature_id: hub.web_search_tool_governance
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebSearchExecutionMode {
    Servertool,
    DirectRoute,
    DirectBuiltin,
}

fn read_execution_mode(engine: &Map<String, Value>) -> String {
    let direct = engine
        .get("executionMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            engine
                .get("mode")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
        });
    match direct.as_deref() {
        Some("direct") => "direct".to_string(),
        _ => "servertool".to_string(),
    }
}

fn read_direct_activation(engine: &Map<String, Value>) -> String {
    let execution_mode = read_execution_mode(engine);
    let direct = engine
        .get("directActivation")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            engine
                .get("activation")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
        });
    match direct.as_deref() {
        Some("builtin") => "builtin".to_string(),
        Some("route") => "route".to_string(),
        _ if execution_mode == "direct" => "route".to_string(),
        _ => String::new(),
    }
}

pub(crate) fn resolve_web_search_execution_mode(
    engine: &Map<String, Value>,
) -> WebSearchExecutionMode {
    if read_execution_mode(engine) != "direct" {
        return WebSearchExecutionMode::Servertool;
    }
    if read_direct_activation(engine) == "builtin" {
        return WebSearchExecutionMode::DirectBuiltin;
    }
    WebSearchExecutionMode::DirectRoute
}

pub(crate) fn resolve_web_search_execution_mode_from_value(
    engine: &Value,
) -> WebSearchExecutionMode {
    let Some(row) = engine.as_object() else {
        return WebSearchExecutionMode::Servertool;
    };
    resolve_web_search_execution_mode(row)
}
