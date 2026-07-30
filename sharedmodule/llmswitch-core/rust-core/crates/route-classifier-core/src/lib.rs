// feature_id: vr.route_classifier
mod active_turn;
mod route;
mod shell;
mod tools;

pub use active_turn::{extract_active_turn_signals, RouteActiveTurnSignals};
pub use route::{
    classify_route, RouteClassification, RouteClassifierInput, DEFAULT_ROUTE, ROUTE_PRIORITY,
};
pub use tools::{classify_tool_call, has_web_search_intent, RouteToolCallClassification};

#[cfg(test)]
mod tests;
