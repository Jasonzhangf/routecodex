// feature_id: v3.route_classifier_local_owner
mod active_turn;
mod policy;
mod route;
mod shell;
mod tools;

pub use active_turn::{
    build_v3_current_turn_route_facts, build_v3_current_turn_route_facts_from_value,
    project_v3_current_turn_entries_from_value, ChatTurnEntry, ChatTurnRole, GeminiTurnEntry,
    GeminiTurnRole, ResponsesTurnEntry, ResponsesTurnKind, ResponsesTurnRole, TurnPart,
    TurnPartKind, V3CurrentTurnEntries, V3CurrentTurnSignals,
};
pub use policy::{
    evaluate_v3_route_policies, V3RouteCondition, V3RouteHistoryFacts, V3RouteHistoryWindow,
    V3RoutePolicy, V3RoutePolicyAction, V3RoutePolicyEvaluationError, V3RouteTurnObservation,
};
pub use route::{
    classify_route, RouteClassification, RouteClassifierInput, V3CurrentTurnRouteFacts,
    DEFAULT_ROUTE, ROUTE_PRIORITY,
};

pub use tools::{classify_tool_call, RouteToolCallClassification};

#[cfg(test)]
mod tests;
