#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct V3RouteTurnObservation {
    pub is_compaction: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3RouteCondition {
    CurrentCompaction,
}

impl V3RouteCondition {
    fn matches(&self, observation: &V3RouteTurnObservation) -> bool {
        match self {
            Self::CurrentCompaction => observation.is_compaction,
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

// Route policy matches only the current turn. Historical turn statistics are
// not an input: pool selection stays a pure function of the current request.
pub fn evaluate_v3_route_policies(
    policies: &[V3RoutePolicy],
    observation: V3RouteTurnObservation,
) -> Result<Option<V3RoutePolicyAction>, V3RoutePolicyEvaluationError> {
    let mut matched = policies
        .iter()
        .filter(|policy| policy.condition.matches(&observation))
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

    #[test]
    fn compaction_condition_selects_compact_pool() {
        let action = evaluate_v3_route_policies(
            &[V3RoutePolicy {
                id: "compact-purpose".into(),
                precedence: 10,
                condition: V3RouteCondition::CurrentCompaction,
                route_pool: "compact".into(),
            }],
            V3RouteTurnObservation {
                is_compaction: true,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(action.route_pool, "compact");
        assert_eq!(action.policy_id, "compact-purpose");
    }

    #[test]
    fn non_compaction_turn_matches_no_policy() {
        assert!(evaluate_v3_route_policies(
            &[V3RoutePolicy {
                id: "compact-purpose".into(),
                precedence: 10,
                condition: V3RouteCondition::CurrentCompaction,
                route_pool: "compact".into(),
            }],
            V3RouteTurnObservation::default(),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn ambiguous_precedence_is_rejected() {
        let policies = [
            V3RoutePolicy {
                id: "a".into(),
                precedence: 10,
                condition: V3RouteCondition::CurrentCompaction,
                route_pool: "compact".into(),
            },
            V3RoutePolicy {
                id: "b".into(),
                precedence: 10,
                condition: V3RouteCondition::CurrentCompaction,
                route_pool: "compact".into(),
            },
        ];
        assert_eq!(
            evaluate_v3_route_policies(
                &policies,
                V3RouteTurnObservation {
                    is_compaction: true
                },
            ),
            Err(V3RoutePolicyEvaluationError::AmbiguousPrecedence {
                policy_ids: vec!["a".into(), "b".into()],
            })
        );
    }
}
