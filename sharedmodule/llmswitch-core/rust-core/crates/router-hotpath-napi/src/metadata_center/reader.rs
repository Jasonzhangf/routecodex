use crate::metadata_center::types::MetadataCenter;

pub(crate) trait MetadataCenterReader {
    fn stop_message_enabled(&self) -> Option<bool>;
    fn stop_message_exclude_direct(&self) -> Option<bool>;
    fn retry_provider_key(&self) -> Option<&str>;
    fn route_hint(&self) -> Option<&str>;
    fn server_tool_followup(&self) -> Option<bool>;
    fn server_tool_followup_source(&self) -> Option<&str>;
    fn stopless_repeat_count(&self) -> Option<u32>;
    fn stopless_max_repeats(&self) -> Option<u32>;
    fn server_tool_loop_repeat_count(&self) -> Option<u32>;
    fn stop_message_used(&self) -> Option<u32>;
    fn provider_key(&self) -> Option<&str>;
    fn assigned_model_id(&self) -> Option<&str>;
    fn response_finish_reason(&self) -> Option<&str>;
    fn closeout_finalized(&self) -> Option<bool>;
    fn debug_snapshot_id(&self) -> Option<&str>;
}

impl MetadataCenterReader for MetadataCenter {
    fn stop_message_enabled(&self) -> Option<bool> {
        self.runtime_control
            .stop_message_enabled
            .or(self.runtime_control.stop_message.enabled)
    }

    fn stop_message_exclude_direct(&self) -> Option<bool> {
        self.runtime_control
            .stop_message_exclude_direct
            .or(self.runtime_control.stop_message.exclude_direct)
    }

    fn retry_provider_key(&self) -> Option<&str> {
        self.runtime_control.retry_provider_key.as_deref()
    }

    fn route_hint(&self) -> Option<&str> {
        self.runtime_control.route_hint.as_deref()
    }

    fn server_tool_followup(&self) -> Option<bool> {
        self.runtime_control.server_tool_followup
    }

    fn server_tool_followup_source(&self) -> Option<&str> {
        self.runtime_control.server_tool_followup_source.as_deref()
    }

    fn stopless_repeat_count(&self) -> Option<u32> {
        self.runtime_control.stopless.repeat_count
    }

    fn stopless_max_repeats(&self) -> Option<u32> {
        self.runtime_control.stopless.max_repeats
    }

    fn server_tool_loop_repeat_count(&self) -> Option<u32> {
        self.runtime_control.server_tool_loop_state.repeat_count
    }

    fn stop_message_used(&self) -> Option<u32> {
        self.runtime_control.stop_message_state.stop_message_used
    }

    fn provider_key(&self) -> Option<&str> {
        self.provider_observation.provider_key.as_deref()
    }

    fn assigned_model_id(&self) -> Option<&str> {
        self.provider_observation.assigned_model_id.as_deref()
    }

    fn response_finish_reason(&self) -> Option<&str> {
        self.response_observation.finish_reason.as_deref()
    }

    fn closeout_finalized(&self) -> Option<bool> {
        self.closeout_status.finalized
    }

    fn debug_snapshot_id(&self) -> Option<&str> {
        self.debug_snapshot.snapshot_id.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::MetadataCenterReader;
    use crate::metadata_center::builder::build_metadata_center_from_snapshot;
    use serde_json::json;

    #[test]
    fn reads_stop_message_controls_from_snapshot_center() {
        let center = build_metadata_center_from_snapshot(&json!({
            "runtimeControl": {
                "stopMessageEnabled": true,
                "stopMessageExcludeDirect": false
            }
        }));

        assert_eq!(center.stop_message_enabled(), Some(true));
        assert_eq!(center.stop_message_exclude_direct(), Some(false));
    }

    #[test]
    fn reads_legacy_nested_stop_message_controls_from_snapshot_center() {
        let center = build_metadata_center_from_snapshot(&json!({
            "runtimeControl": {
                "stopMessage": {
                    "enabled": true,
                    "excludeDirect": false
                }
            }
        }));

        assert_eq!(center.stop_message_enabled(), Some(true));
        assert_eq!(center.stop_message_exclude_direct(), Some(false));
    }

    #[test]
    fn reads_stopless_canonical_and_migration_controls_from_snapshot_center() {
        let center = build_metadata_center_from_snapshot(&json!({
            "runtimeControl": {
                "stopless": {
                    "active": true,
                    "repeatCount": 2,
                    "maxRepeats": 3,
                    "schemaFeedback": { "reasonCode": "stop_schema_missing" }
                },
                "serverToolLoopState": {
                    "flowId": "stop_message_flow",
                    "repeatCount": 2,
                    "maxRepeats": 3
                },
                "stopMessageState": {
                    "stopMessageUsed": 2,
                    "stopMessageMaxRepeats": 3
                }
            }
        }));

        assert_eq!(center.stopless_repeat_count(), Some(2));
        assert_eq!(center.stopless_max_repeats(), Some(3));
        assert_eq!(center.server_tool_loop_repeat_count(), Some(2));
        assert_eq!(center.stop_message_used(), Some(2));
    }

    #[test]
    fn reads_provider_response_closeout_and_debug_families_from_snapshot_center() {
        let center = build_metadata_center_from_snapshot(&json!({
            "providerObservation": {
                "providerKey": "provider.key.model",
                "assignedModelId": "gpt-5.5-assigned"
            },
            "responseObservation": {
                "finishReason": "tool_calls",
                "protocolKind": "openai-chat"
            },
            "closeoutStatus": {
                "finalized": true,
                "released": false
            },
            "debugSnapshot": {
                "snapshotId": "debug-1",
                "hubStageTop": [
                    { "stage": "req_chatprocess", "totalMs": 12.5, "count": 1 }
                ]
            }
        }));

        assert_eq!(center.provider_key(), Some("provider.key.model"));
        assert_eq!(center.assigned_model_id(), Some("gpt-5.5-assigned"));
        assert_eq!(center.response_finish_reason(), Some("tool_calls"));
        assert_eq!(center.closeout_finalized(), Some(true));
        assert_eq!(center.debug_snapshot_id(), Some("debug-1"));
        assert_eq!(
            center
                .debug_snapshot
                .hub_stage_top
                .as_ref()
                .and_then(|rows| rows.first())
                .map(|row| row.stage.as_str()),
            Some("req_chatprocess")
        );
    }
}
