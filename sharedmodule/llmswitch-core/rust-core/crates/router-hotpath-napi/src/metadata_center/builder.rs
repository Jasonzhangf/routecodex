//! Build a MetadataCenter from the serde_json::Value snapshot.

use crate::metadata_center::types::MetadataCenter;
use serde_json::Value;

/// Construct a MetadataCenter from the `metadataCenterSnapshot` Value.
///
/// If the snapshot is null/missing/empty, returns a default (empty) center.
/// This is the single ingress point -- only `executeRequestStagePipeline`
/// should construct the center, never individual Rust blocks.
pub(crate) fn build_metadata_center_from_snapshot(snapshot: &Value) -> MetadataCenter {
    if snapshot.is_null() {
        return MetadataCenter::default();
    }
    serde_json::from_value(snapshot.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_empty_center_from_null() {
        let center = build_metadata_center_from_snapshot(&Value::Null);
        assert_eq!(center, MetadataCenter::default());
    }

    #[test]
    fn builds_center_from_full_snapshot() {
        let snapshot = json!({
            "requestTruth": {
                "requestId": "req-1",
                "sessionId": "sess-1"
            },
            "continuationContext": {
                "continuationOwner": "direct"
            },
            "runtimeControl": {
                "routeHint": "thinking",
                "retryProviderKey": "provider.gpt-5.5",
                "stopMessage": {
                    "enabled": true,
                    "excludeDirect": true
                },
                "stopless": {
                    "active": true,
                    "triggerHint": "budget_exhausted",
                    "repeatCount": 2,
                    "maxRepeats": 3,
                    "continuationPrompt": "continue",
                    "schemaFeedback": { "reasonCode": "stop_schema_missing" }
                },
                "serverToolLoopState": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 2,
                    "maxRepeats": 3
                },
                "stopMessageState": {
                    "stopMessageText": "continue",
                    "stopMessageUsed": 2,
                    "stopMessageMaxRepeats": 3,
                    "stopMessageStageMode": "on"
                },
                "stopMessageCompareContext": {
                    "decision": "trigger",
                    "reason": "stop_schema_missing",
                    "used": 2,
                    "remaining": 1
                }
            }
        });
        let center = build_metadata_center_from_snapshot(&snapshot);
        assert_eq!(center.request_truth.request_id.as_deref(), Some("req-1"));
        assert_eq!(center.request_truth.session_id.as_deref(), Some("sess-1"));
        assert_eq!(
            center.runtime_control.route_hint.as_deref(),
            Some("thinking")
        );
        assert_eq!(
            center.runtime_control.retry_provider_key.as_deref(),
            Some("provider.gpt-5.5")
        );
        assert_eq!(center.runtime_control.stop_message.enabled, Some(true));
        assert_eq!(
            center.runtime_control.stop_message.exclude_direct,
            Some(true)
        );
        assert_eq!(center.runtime_control.stopless.active, Some(true));
        assert_eq!(
            center.runtime_control.stopless.trigger_hint.as_deref(),
            Some("budget_exhausted")
        );
        assert_eq!(center.runtime_control.stopless.repeat_count, Some(2));
        assert_eq!(center.runtime_control.stopless.max_repeats, Some(3));
        assert_eq!(
            center
                .runtime_control
                .server_tool_loop_state
                .flow_id
                .as_deref(),
            Some("stop_message_flow")
        );
        assert_eq!(
            center.runtime_control.stop_message_state.stop_message_used,
            Some(2)
        );
        assert_eq!(
            center
                .runtime_control
                .stop_message_compare_context
                .reason
                .as_deref(),
            Some("stop_schema_missing")
        );
        assert_eq!(
            center.continuation_context.continuation_owner.as_deref(),
            Some("direct")
        );
    }

    #[test]
    fn builds_center_from_partial_snapshot() {
        let snapshot = json!({
            "runtimeControl": {
                "routeHint": "tools"
            }
        });
        let center = build_metadata_center_from_snapshot(&snapshot);
        assert_eq!(center.runtime_control.route_hint.as_deref(), Some("tools"));
        assert!(center.request_truth.request_id.is_none());
        assert!(center.runtime_control.retry_provider_key.is_none());
    }

    #[test]
    fn builds_default_center_from_empty_object() {
        let center = build_metadata_center_from_snapshot(&json!({}));
        assert_eq!(center, MetadataCenter::default());
    }
}
