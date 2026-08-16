use serde::{Deserialize, Serialize};
use serde_json::Value;

const AUTO_PAYLOAD_HASH: &str = "__servertool_auto__";
const STOP_MESSAGE_FLOW_ID: &str = "stop_message_flow";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolLoopStateSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    pub payload_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_pair_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_pair_repeat_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_pair_warned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolLoopStateDecisionInput {
    pub flow_only_loop_limit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolLoopStatePlanInput {
    pub flow_id: Option<String>,
    pub decision: Option<ServertoolLoopStateDecisionInput>,
    pub previous_loop_state: Option<Value>,
    pub payload_hash: Option<String>,
    pub stop_pair_hash: Option<String>,
    pub now_ms: i64,
}

pub fn read_servertool_loop_state(runtime_metadata: &Value) -> Option<ServertoolLoopStateSnapshot> {
    let raw = runtime_metadata.get("serverToolLoopState")?;
    normalize_loop_state_record(raw)
}

pub fn plan_servertool_loop_state(
    input: ServertoolLoopStatePlanInput,
) -> Option<ServertoolLoopStateSnapshot> {
    let flow_id = input.flow_id.filter(|value| !value.is_empty());
    let flow_only_loop_limit = input
        .decision
        .as_ref()
        .and_then(|decision| decision.flow_only_loop_limit)
        .unwrap_or(false);
    let track_payload = flow_id
        .as_deref()
        .map(|value| {
            !value.trim().is_empty() && value != STOP_MESSAGE_FLOW_ID && !flow_only_loop_limit
        })
        .unwrap_or(false);
    let payload_hash = if track_payload {
        normalize_non_empty_string(input.payload_hash.as_deref())?
    } else {
        AUTO_PAYLOAD_HASH.to_string()
    };
    let previous = input
        .previous_loop_state
        .as_ref()
        .and_then(normalize_loop_state_record);
    let same_flow = previous
        .as_ref()
        .map(|state| state.flow_id == flow_id)
        .unwrap_or(false);
    let same_payload = !track_payload
        || previous
            .as_ref()
            .map(|state| state.payload_hash == payload_hash)
            .unwrap_or(false);
    let previous_repeat_count = previous
        .as_ref()
        .and_then(|state| state.repeat_count)
        .unwrap_or(0);
    let repeat_count = if same_flow && same_payload {
        previous_repeat_count + 1
    } else {
        1
    };
    let started_at_ms = if same_flow {
        previous
            .as_ref()
            .and_then(|state| state.started_at_ms)
            .unwrap_or_else(|| normalize_non_negative_i64(input.now_ms))
    } else {
        normalize_non_negative_i64(input.now_ms)
    };

    let mut next = ServertoolLoopStateSnapshot {
        flow_id,
        payload_hash,
        repeat_count: Some(repeat_count),
        started_at_ms: Some(started_at_ms),
        stop_pair_hash: None,
        stop_pair_repeat_count: None,
        stop_pair_warned: None,
    };

    if next.flow_id.as_deref() == Some(STOP_MESSAGE_FLOW_ID) {
        if let Some(pair_hash) = normalize_non_empty_string(input.stop_pair_hash.as_deref()) {
            let previous_pair_hash = if same_flow {
                previous
                    .as_ref()
                    .and_then(|state| state.stop_pair_hash.clone())
            } else {
                None
            };
            let previous_pair_count = if same_flow {
                previous
                    .as_ref()
                    .and_then(|state| state.stop_pair_repeat_count)
                    .unwrap_or(0)
            } else {
                0
            };
            let same_pair = previous_pair_hash.as_deref() == Some(pair_hash.as_str());
            next.stop_pair_hash = Some(pair_hash);
            next.stop_pair_repeat_count = Some(if same_pair {
                previous_pair_count + 1
            } else {
                1
            });
            next.stop_pair_warned = Some(if same_pair {
                previous
                    .as_ref()
                    .and_then(|state| state.stop_pair_warned)
                    .unwrap_or(false)
            } else {
                false
            });
        }
    }

    Some(next)
}

fn normalize_loop_state_record(value: &Value) -> Option<ServertoolLoopStateSnapshot> {
    let record = value.as_object()?;
    let payload_hash =
        normalize_non_empty_string(record.get("payloadHash").and_then(Value::as_str))?;
    Some(ServertoolLoopStateSnapshot {
        flow_id: normalize_non_empty_string(record.get("flowId").and_then(Value::as_str)),
        payload_hash,
        repeat_count: normalize_json_non_negative_i64(record.get("repeatCount")),
        started_at_ms: normalize_json_non_negative_i64(record.get("startedAtMs")),
        stop_pair_hash: normalize_non_empty_string(
            record.get("stopPairHash").and_then(Value::as_str),
        ),
        stop_pair_repeat_count: normalize_json_non_negative_i64(record.get("stopPairRepeatCount")),
        stop_pair_warned: record.get("stopPairWarned").and_then(Value::as_bool),
    })
}

fn normalize_non_empty_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_json_non_negative_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Some(integer.max(0))
            } else if let Some(unsigned) = number.as_u64() {
                Some(i64::try_from(unsigned).unwrap_or(i64::MAX))
            } else {
                number
                    .as_f64()
                    .map(|float| normalize_non_negative_i64(float.floor() as i64))
            }
        }
        _ => None,
    }
}

fn normalize_non_negative_i64(value: i64) -> i64 {
    value.max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_normalizes_loop_state_and_rejects_missing_payload_hash() {
        let runtime = json!({
            "serverToolLoopState": {
                "flowId": " flow ",
                "payloadHash": " abc ",
                "repeatCount": 2.8,
                "startedAtMs": -10,
                "stopPairHash": " pair ",
                "stopPairRepeatCount": 3.2,
                "stopPairWarned": true
            }
        });
        let state = read_servertool_loop_state(&runtime).expect("state");
        assert_eq!(state.flow_id.as_deref(), Some("flow"));
        assert_eq!(state.payload_hash, "abc");
        assert_eq!(state.repeat_count, Some(2));
        assert_eq!(state.started_at_ms, Some(0));
        assert_eq!(state.stop_pair_hash.as_deref(), Some("pair"));
        assert_eq!(state.stop_pair_repeat_count, Some(3));
        assert_eq!(state.stop_pair_warned, Some(true));

        assert!(read_servertool_loop_state(&json!({
            "serverToolLoopState": { "flowId": "flow" }
        }))
        .is_none());
    }

    #[test]
    fn plan_increments_repeat_count_for_same_flow_and_payload() {
        let state = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some("vision_auto_flow".to_string()),
            decision: None,
            previous_loop_state: Some(json!({
                "flowId": "vision_auto_flow",
                "payloadHash": "hash-a",
                "repeatCount": 2,
                "startedAtMs": 100
            })),
            payload_hash: Some("hash-a".to_string()),
            stop_pair_hash: None,
            now_ms: 200,
        })
        .expect("state");
        assert_eq!(state.payload_hash, "hash-a");
        assert_eq!(state.repeat_count, Some(3));
        assert_eq!(state.started_at_ms, Some(100));
    }

    #[test]
    fn plan_resets_repeat_count_for_changed_payload() {
        let state = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some("vision_auto_flow".to_string()),
            decision: None,
            previous_loop_state: Some(json!({
                "flowId": "vision_auto_flow",
                "payloadHash": "hash-a",
                "repeatCount": 2,
                "startedAtMs": 100
            })),
            payload_hash: Some("hash-b".to_string()),
            stop_pair_hash: None,
            now_ms: 200,
        })
        .expect("state");
        assert_eq!(state.payload_hash, "hash-b");
        assert_eq!(state.repeat_count, Some(1));
        assert_eq!(state.started_at_ms, Some(100));
    }

    #[test]
    fn plan_uses_auto_hash_for_stop_message_and_flow_only() {
        let stop_state = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some(STOP_MESSAGE_FLOW_ID.to_string()),
            decision: None,
            previous_loop_state: None,
            payload_hash: Some("payload".to_string()),
            stop_pair_hash: Some("pair".to_string()),
            now_ms: 10,
        })
        .expect("state");
        assert_eq!(stop_state.payload_hash, AUTO_PAYLOAD_HASH);

        let flow_only_state = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some("web_search_flow".to_string()),
            decision: Some(ServertoolLoopStateDecisionInput {
                flow_only_loop_limit: Some(true),
            }),
            previous_loop_state: None,
            payload_hash: Some("payload".to_string()),
            stop_pair_hash: None,
            now_ms: 10,
        })
        .expect("state");
        assert_eq!(flow_only_state.payload_hash, AUTO_PAYLOAD_HASH);
    }

    #[test]
    fn plan_stop_pair_repeat_preserves_warned_only_for_same_pair() {
        let same_pair = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some(STOP_MESSAGE_FLOW_ID.to_string()),
            decision: None,
            previous_loop_state: Some(json!({
                "flowId": "stop_message_flow",
                "payloadHash": "__servertool_auto__",
                "repeatCount": 2,
                "startedAtMs": 100,
                "stopPairHash": "pair-a",
                "stopPairRepeatCount": 4,
                "stopPairWarned": true
            })),
            payload_hash: Some("ignored".to_string()),
            stop_pair_hash: Some("pair-a".to_string()),
            now_ms: 200,
        })
        .expect("state");
        assert_eq!(same_pair.stop_pair_repeat_count, Some(5));
        assert_eq!(same_pair.stop_pair_warned, Some(true));

        let changed_pair = plan_servertool_loop_state(ServertoolLoopStatePlanInput {
            flow_id: Some(STOP_MESSAGE_FLOW_ID.to_string()),
            decision: None,
            previous_loop_state: Some(json!({
                "flowId": "stop_message_flow",
                "payloadHash": "__servertool_auto__",
                "repeatCount": 2,
                "startedAtMs": 100,
                "stopPairHash": "pair-a",
                "stopPairRepeatCount": 4,
                "stopPairWarned": true
            })),
            payload_hash: Some("ignored".to_string()),
            stop_pair_hash: Some("pair-b".to_string()),
            now_ms: 200,
        })
        .expect("state");
        assert_eq!(changed_pair.stop_pair_repeat_count, Some(1));
        assert_eq!(changed_pair.stop_pair_warned, Some(false));
    }
}
