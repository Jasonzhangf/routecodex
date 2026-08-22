use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct V3RouteTurnObservation {
    pub new_user_input: bool,
    pub is_compaction: bool,
    pub search_pool_hit: bool,
    pub tool_execution_error: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct V3RouteHistoryFacts {
    pub observed_turns: usize,
    pub search_pool_turns: usize,
    pub tool_execution_error_turns: usize,
}

impl V3RouteHistoryFacts {
    pub fn search_pool_turn_ratio_at_least(self, numerator: usize, denominator: usize) -> bool {
        denominator > 0
            && self.observed_turns > 0
            && self.search_pool_turns.saturating_mul(denominator)
                >= self.observed_turns.saturating_mul(numerator)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3RouteHistoryWindow {
    capacity: usize,
    turns: VecDeque<V3RouteTurnObservation>,
}

impl V3RouteHistoryWindow {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            turns: VecDeque::with_capacity(capacity),
        }
    }

    pub fn record_turn(&mut self, observation: V3RouteTurnObservation) {
        if observation.new_user_input {
            self.turns.clear();
        }
        if self.capacity == 0 {
            return;
        }
        if self.turns.len() == self.capacity {
            self.turns.pop_front();
        }
        self.turns.push_back(observation);
    }

    pub fn facts(&self, window_turns: usize) -> V3RouteHistoryFacts {
        let start = self.turns.len().saturating_sub(window_turns);
        self.turns
            .iter()
            .skip(start)
            .fold(V3RouteHistoryFacts::default(), |mut facts, turn| {
                facts.observed_turns += 1;
                facts.search_pool_turns += usize::from(turn.search_pool_hit);
                facts.tool_execution_error_turns += usize::from(turn.tool_execution_error);
                facts
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3RouteCondition {
    CurrentCompaction,
    SearchPoolTurnRatioAtLeast {
        window_turns: usize,
        numerator: usize,
        denominator: usize,
    },
    ToolExecutionErrorTurnsAtLeast {
        window_turns: usize,
        count: usize,
    },
}

impl V3RouteCondition {
    fn matches(&self, observation: V3RouteTurnObservation, history: &V3RouteHistoryWindow) -> bool {
        match self {
            Self::CurrentCompaction => observation.is_compaction,
            Self::SearchPoolTurnRatioAtLeast {
                window_turns,
                numerator,
                denominator,
            } => history
                .facts(*window_turns)
                .search_pool_turn_ratio_at_least(*numerator, *denominator),
            Self::ToolExecutionErrorTurnsAtLeast {
                window_turns,
                count,
            } => history.facts(*window_turns).tool_execution_error_turns >= *count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePolicy {
    pub id: String,
    pub precedence: i32,
    pub condition: V3RouteCondition,
    pub route_pool: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePolicyAction {
    pub policy_id: String,
    pub route_pool: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3RoutePolicyEvaluationError {
    AmbiguousPrecedence { policy_ids: Vec<String> },
    EmptyRoutePool { policy_id: String },
}

pub fn evaluate_v3_route_policies(
    policies: &[V3RoutePolicy],
    observation: V3RouteTurnObservation,
    history: &V3RouteHistoryWindow,
) -> Result<Option<V3RoutePolicyAction>, V3RoutePolicyEvaluationError> {
    let mut matched = policies
        .iter()
        .filter(|policy| policy.condition.matches(observation, history))
        .collect::<Vec<_>>();
    matched.sort_by_key(|policy| policy.precedence);
    let Some(first) = matched.first() else {
        return Ok(None);
    };
    let same_precedence = matched
        .iter()
        .take_while(|policy| policy.precedence == first.precedence)
        .collect::<Vec<_>>();
    if same_precedence.len() > 1 {
        return Err(V3RoutePolicyEvaluationError::AmbiguousPrecedence {
            policy_ids: same_precedence
                .iter()
                .map(|policy| policy.id.clone())
                .collect(),
        });
    }
    if first.route_pool.trim().is_empty() {
        return Err(V3RoutePolicyEvaluationError::EmptyRoutePool {
            policy_id: first.id.clone(),
        });
    }
    Ok(Some(V3RoutePolicyAction {
        policy_id: first.id.clone(),
        route_pool: first.route_pool.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search_turn(new_user_input: bool) -> V3RouteTurnObservation {
        V3RouteTurnObservation {
            new_user_input,
            search_pool_hit: true,
            ..Default::default()
        }
    }

    #[test]
    fn history_includes_current_turn_and_hits_eight_of_ten_boundary() {
        let mut history = V3RouteHistoryWindow::new(10);
        for index in 0..7 {
            history.record_turn(search_turn(index == 0));
        }
        history.record_turn(V3RouteTurnObservation::default());
        history.record_turn(search_turn(false));
        let facts = history.facts(10);
        assert_eq!(facts.observed_turns, 9);
        assert_eq!(facts.search_pool_turns, 8);
        assert!(facts.search_pool_turn_ratio_at_least(4, 5));
        history.record_turn(V3RouteTurnObservation::default());
        history.record_turn(V3RouteTurnObservation::default());
        assert!(!history.facts(10).search_pool_turn_ratio_at_least(4, 5));
    }

    #[test]
    fn new_user_input_resets_previous_task_statistics() {
        let mut history = V3RouteHistoryWindow::new(10);
        history.record_turn(search_turn(true));
        history.record_turn(search_turn(false));
        history.record_turn(V3RouteTurnObservation {
            new_user_input: true,
            ..Default::default()
        });
        let facts = history.facts(10);
        assert_eq!(facts.observed_turns, 1);
        assert_eq!(facts.search_pool_turns, 0);
    }

    #[test]
    fn one_turn_with_multiple_tool_errors_is_one_error_turn() {
        let mut history = V3RouteHistoryWindow::new(5);
        history.record_turn(V3RouteTurnObservation {
            new_user_input: true,
            tool_execution_error: true,
            ..Default::default()
        });
        assert_eq!(history.facts(5).tool_execution_error_turns, 1);
    }

    #[test]
    fn three_error_turns_in_five_trigger_thinking_pool() {
        let mut history = V3RouteHistoryWindow::new(5);
        for index in 0..5 {
            history.record_turn(V3RouteTurnObservation {
                new_user_input: index == 0,
                tool_execution_error: index < 3,
                ..Default::default()
            });
        }
        let action = evaluate_v3_route_policies(
            &[V3RoutePolicy {
                id: "recent-errors".into(),
                precedence: 30,
                condition: V3RouteCondition::ToolExecutionErrorTurnsAtLeast {
                    window_turns: 5,
                    count: 3,
                },
                route_pool: "thinking".into(),
            }],
            V3RouteTurnObservation::default(),
            &history,
        )
        .unwrap()
        .unwrap();
        assert_eq!(action.route_pool, "thinking");
    }

    #[test]
    fn policy_precedence_selects_pool_without_provider_model() {
        let mut history = V3RouteHistoryWindow::new(10);
        history.record_turn(search_turn(true));
        let policy = V3RoutePolicy {
            id: "search-density".into(),
            precedence: 30,
            condition: V3RouteCondition::SearchPoolTurnRatioAtLeast {
                window_turns: 10,
                numerator: 4,
                denominator: 5,
            },
            route_pool: "thinking".into(),
        };
        let action = evaluate_v3_route_policies(&[policy], search_turn(false), &history)
            .unwrap()
            .unwrap();
        assert_eq!(action.route_pool, "thinking");
        assert_eq!(action.policy_id, "search-density");
    }

    #[test]
    fn compact_condition_is_independent_route_pool() {
        let history = V3RouteHistoryWindow::new(10);
        let action = evaluate_v3_route_policies(
            &[V3RoutePolicy {
                id: "compact-purpose".into(),
                precedence: 10,
                condition: V3RouteCondition::CurrentCompaction,
                route_pool: "compact".into(),
            }],
            V3RouteTurnObservation {
                is_compaction: true,
                ..Default::default()
            },
            &history,
        )
        .unwrap()
        .unwrap();
        assert_eq!(action.route_pool, "compact");
    }
}
