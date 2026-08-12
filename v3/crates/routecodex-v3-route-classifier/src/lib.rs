// feature_id: v3.route_classifier_local_owner
mod active_turn;
mod route;
mod shell;
mod tools;

pub use active_turn::{build_v3_current_turn_route_facts, V3CurrentTurnSignals};
pub use route::{
    classify_route, RouteClassification, RouteClassifierInput, V3CurrentTurnRouteFacts,
    DEFAULT_ROUTE, ROUTE_PRIORITY,
};

pub use tools::{classify_tool_call, RouteToolCallClassification};

#[cfg(test)]
mod tests;
