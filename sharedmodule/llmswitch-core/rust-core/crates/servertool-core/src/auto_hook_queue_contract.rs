use serde::{Deserialize, Serialize};

// feature_id: hub.servertool_auto_hook_queue_progress

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookQueueProgressInput {
    pub queue_order: Vec<String>,
    pub current_queue: String,
    pub result_present: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoHookQueueProgressPlan {
    pub action: AutoHookQueueProgressAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_queue: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AutoHookQueueProgressAction {
    ReturnResult,
    ContinueNextQueue,
    ReturnNull,
}

pub fn plan_auto_hook_queue_progress(
    input: AutoHookQueueProgressInput,
) -> AutoHookQueueProgressPlan {
    if input.result_present {
        return AutoHookQueueProgressPlan {
            action: AutoHookQueueProgressAction::ReturnResult,
            next_queue: None,
        };
    }

    let normalized_order: Vec<String> = input
        .queue_order
        .into_iter()
        .map(|queue| queue.trim().to_string())
        .filter(|queue| !queue.is_empty())
        .collect();
    let current = input.current_queue.trim();

    if let Some(index) = normalized_order.iter().position(|queue| queue == current) {
        if let Some(next_queue) = normalized_order.get(index + 1) {
            return AutoHookQueueProgressPlan {
                action: AutoHookQueueProgressAction::ContinueNextQueue,
                next_queue: Some(next_queue.clone()),
            };
        }
    }

    AutoHookQueueProgressPlan {
        action: AutoHookQueueProgressAction::ReturnNull,
        next_queue: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_auto_hook_queue_progress, AutoHookQueueProgressAction, AutoHookQueueProgressInput,
    };

    #[test]
    fn returns_result_immediately_when_queue_materializes() {
        let plan = plan_auto_hook_queue_progress(AutoHookQueueProgressInput {
            queue_order: vec!["A_optional".to_string(), "B_mandatory".to_string()],
            current_queue: "A_optional".to_string(),
            result_present: true,
        });
        assert_eq!(plan.action, AutoHookQueueProgressAction::ReturnResult);
        assert_eq!(plan.next_queue, None);
    }

    #[test]
    fn advances_to_next_queue_when_current_queue_misses() {
        let plan = plan_auto_hook_queue_progress(AutoHookQueueProgressInput {
            queue_order: vec!["A_optional".to_string(), "B_mandatory".to_string()],
            current_queue: "A_optional".to_string(),
            result_present: false,
        });
        assert_eq!(plan.action, AutoHookQueueProgressAction::ContinueNextQueue);
        assert_eq!(plan.next_queue.as_deref(), Some("B_mandatory"));
    }

    #[test]
    fn returns_null_when_final_queue_misses_or_queue_unknown() {
        let final_miss = plan_auto_hook_queue_progress(AutoHookQueueProgressInput {
            queue_order: vec!["A_optional".to_string(), "B_mandatory".to_string()],
            current_queue: "B_mandatory".to_string(),
            result_present: false,
        });
        assert_eq!(final_miss.action, AutoHookQueueProgressAction::ReturnNull);
        assert_eq!(final_miss.next_queue, None);

        let unknown = plan_auto_hook_queue_progress(AutoHookQueueProgressInput {
            queue_order: vec!["A_optional".to_string(), "B_mandatory".to_string()],
            current_queue: "unknown".to_string(),
            result_present: false,
        });
        assert_eq!(unknown.action, AutoHookQueueProgressAction::ReturnNull);
        assert_eq!(unknown.next_queue, None);
    }
}
