// feature_id: runtime.lifecycle.pid_cache
// feature_id: runtime.lifecycle.stop_intent
// feature_id: runtime.lifecycle.instance_registry
// feature_id: runtime.lifecycle.restart_command
// feature_id: runtime.lifecycle.start_command
//
// Runtime lifecycle decision owner. This module returns explicit plans only;
// TypeScript remains responsible for filesystem, HTTP, signal, and spawn IO.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_STOP_INTENT_MAX_AGE_MS: i64 = 60_000;
const INSTANCE_STATUSES: &[&str] = &[
    "declared",
    "bind",
    "ready",
    "healthy",
    "degraded",
    "shutdown-intent",
    "stop",
    "released",
    "released-cleaned",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePidCacheRecord {
    pub pid: i64,
    pub port: i64,
    pub written_at_ms: i64,
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePidCacheWriteInput {
    port: f64,
    pid: f64,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    now_ms: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePidCacheReadInput {
    port: f64,
    #[serde(default)]
    record: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePidCacheWritePlan {
    action: String,
    resource_id: String,
    record: RuntimePidCacheRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePidCacheReadPlan {
    matched: bool,
    should_delete: bool,
    reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<RuntimePidCacheRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStopIntentRecord {
    pub port: i64,
    pub requested_at_ms: i64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopIntentWriteInput {
    port: f64,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    pid: Option<f64>,
    #[serde(default)]
    requested_at_ms: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopIntentConsumeInput {
    port: f64,
    #[serde(default)]
    record: Option<Value>,
    #[serde(default)]
    now_ms: Option<f64>,
    #[serde(default)]
    max_age_ms: Option<f64>,
    #[serde(default)]
    ignore_pid: Option<f64>,
    #[serde(default)]
    preserve_matched: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopIntentWritePlan {
    action: String,
    resource_id: String,
    record: RuntimeStopIntentRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopIntentConsumePlan {
    matched: bool,
    should_delete: bool,
    reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstanceRecord {
    pub port: i64,
    pub host: String,
    pub command: String,
    pub config_path: String,
    pub owner_scope: String,
    pub started_at_ms: i64,
    pub status: String,
    pub status_updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstanceWriteInput {
    port: f64,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    config_path: Option<String>,
    #[serde(default)]
    owner_scope: Option<String>,
    #[serde(default)]
    started_at_ms: Option<f64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    status_updated_at_ms: Option<f64>,
    #[serde(default)]
    now_ms: Option<f64>,
    #[serde(default)]
    notes: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstanceStatusUpdateInput {
    port: f64,
    #[serde(default)]
    existing: Option<Value>,
    status: String,
    #[serde(default)]
    status_updated_at_ms: Option<f64>,
    #[serde(default)]
    now_ms: Option<f64>,
    #[serde(default)]
    notes: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstanceWritePlan {
    action: String,
    resource_id: String,
    record: RuntimeInstanceRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstanceStatusUpdatePlan {
    action: String,
    resource_id: String,
    reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<RuntimeInstanceRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestartApiKeyInput {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRestartRequestInput {
    #[serde(default)]
    old_pids: Vec<f64>,
    #[serde(default)]
    restart_api_key: Option<RestartApiKeyInput>,
    #[serde(default)]
    http_only: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRestartRequestPlan {
    preferred_transport: String,
    http_fallback_transport: String,
    reason_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStartRestartTakeoverGuardInput {
    #[serde(default)]
    explicit_restart: Option<bool>,
    #[serde(default)]
    exclusive: Option<bool>,
    #[serde(default)]
    daemon_supervisor: Option<bool>,
    #[serde(default)]
    occupied_ports: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStartRestartTakeoverGuardPlan {
    action: String,
    reason_code: String,
    ports: Vec<i64>,
}

fn parse_json<T: for<'de> Deserialize<'de>>(input_json: &str) -> Result<T, String> {
    serde_json::from_str(input_json)
        .map_err(|error| format!("parse runtime lifecycle input: {error}"))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("serialize runtime lifecycle output: {error}"))
}

fn trim_or(default_value: &str, value: Option<String>) -> String {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| default_value.to_string())
}

fn normalize_positive_i64(value: f64, label: &str) -> Result<i64, String> {
    if value.is_finite() && value > 0.0 {
        Ok(value.floor() as i64)
    } else {
        Err(format!(
            "runtime lifecycle {label} must be a positive finite number"
        ))
    }
}

fn normalize_optional_positive_i64(value: Option<f64>) -> Option<i64> {
    value
        .filter(|item| item.is_finite() && *item > 0.0)
        .map(|item| item.floor() as i64)
}

fn normalize_non_negative_i64(value: Option<f64>, default_value: i64) -> i64 {
    value
        .filter(|item| item.is_finite() && *item >= 0.0)
        .map(|item| item.floor() as i64)
        .unwrap_or(default_value)
}

fn normalize_instance_status(value: String, label: &str) -> Result<String, String> {
    let status = value.trim().to_string();
    if INSTANCE_STATUSES.contains(&status.as_str()) {
        Ok(status)
    } else {
        Err(format!(
            "runtime lifecycle {label} must be one of {}",
            INSTANCE_STATUSES.join(", ")
        ))
    }
}

fn is_status_transition_allowed(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    if to == "shutdown-intent" || to == "stop" {
        return from != "released-cleaned";
    }
    match from {
        "declared" => matches!(to, "bind" | "ready" | "healthy" | "degraded"),
        "bind" => matches!(to, "ready" | "healthy" | "degraded"),
        "ready" => matches!(to, "healthy" | "degraded"),
        "healthy" => to == "degraded",
        "degraded" => to == "healthy",
        "shutdown-intent" => matches!(to, "released" | "released-cleaned"),
        "stop" => matches!(to, "released" | "released-cleaned"),
        "released" => to == "released-cleaned",
        "released-cleaned" => false,
        _ => false,
    }
}

fn parse_pid_record(value: Option<Value>) -> Option<RuntimePidCacheRecord> {
    let record = value?;
    serde_json::from_value(record).ok()
}

fn parse_stop_intent_record(value: Option<Value>) -> Option<RuntimeStopIntentRecord> {
    let record = value?;
    serde_json::from_value(record).ok()
}

fn parse_instance_record(value: Option<Value>) -> Option<RuntimeInstanceRecord> {
    let record = value?;
    serde_json::from_value(record).ok()
}

pub fn plan_runtime_pid_cache_write_json(input_json: String) -> Result<String, String> {
    let input: RuntimePidCacheWriteInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let pid = normalize_positive_i64(input.pid, "pid")?;
    let record = RuntimePidCacheRecord {
        pid,
        port,
        written_at_ms: normalize_non_negative_i64(input.now_ms, 0),
        origin: trim_or("start", input.origin),
    };
    to_json(&RuntimePidCacheWritePlan {
        action: "write".to_string(),
        resource_id: "runtime.pid_cache".to_string(),
        record,
    })
}

pub fn plan_runtime_pid_cache_read_result_json(input_json: String) -> Result<String, String> {
    let input: RuntimePidCacheReadInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let record = match parse_pid_record(input.record) {
        Some(record) => record,
        None => {
            return to_json(&RuntimePidCacheReadPlan {
                matched: false,
                should_delete: false,
                reason_code: "missing".to_string(),
                record: None,
            })
        }
    };
    if record.port != port || record.pid <= 0 {
        return to_json(&RuntimePidCacheReadPlan {
            matched: false,
            should_delete: true,
            reason_code: "mismatch".to_string(),
            record: None,
        });
    }
    to_json(&RuntimePidCacheReadPlan {
        matched: true,
        should_delete: false,
        reason_code: "matched".to_string(),
        record: Some(record),
    })
}

pub fn plan_runtime_stop_intent_write_json(input_json: String) -> Result<String, String> {
    let input: RuntimeStopIntentWriteInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let record = RuntimeStopIntentRecord {
        port,
        requested_at_ms: normalize_non_negative_i64(input.requested_at_ms, 0),
        source: trim_or("unknown", input.source),
        pid: normalize_optional_positive_i64(input.pid),
    };
    to_json(&RuntimeStopIntentWritePlan {
        action: "write".to_string(),
        resource_id: "runtime.stop_intent".to_string(),
        record,
    })
}

pub fn plan_runtime_stop_intent_consume_json(input_json: String) -> Result<String, String> {
    let input: RuntimeStopIntentConsumeInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let record = match parse_stop_intent_record(input.record) {
        Some(record) => record,
        None => {
            return to_json(&RuntimeStopIntentConsumePlan {
                matched: false,
                should_delete: false,
                reason_code: "missing".to_string(),
                source: None,
                requested_at_ms: None,
                pid: None,
            })
        }
    };
    if record.port != port {
        return to_json(&RuntimeStopIntentConsumePlan {
            matched: false,
            should_delete: true,
            reason_code: "port_mismatch".to_string(),
            source: None,
            requested_at_ms: None,
            pid: None,
        });
    }
    let now_ms = normalize_non_negative_i64(input.now_ms, 0);
    let max_age_ms = normalize_non_negative_i64(input.max_age_ms, DEFAULT_STOP_INTENT_MAX_AGE_MS);
    if now_ms.saturating_sub(record.requested_at_ms) > max_age_ms {
        return to_json(&RuntimeStopIntentConsumePlan {
            matched: false,
            should_delete: true,
            reason_code: "stale".to_string(),
            source: None,
            requested_at_ms: None,
            pid: None,
        });
    }
    if normalize_optional_positive_i64(input.ignore_pid).is_some_and(|pid| Some(pid) == record.pid)
    {
        return to_json(&RuntimeStopIntentConsumePlan {
            matched: false,
            should_delete: false,
            reason_code: "ignored_pid".to_string(),
            source: None,
            requested_at_ms: None,
            pid: None,
        });
    }
    to_json(&RuntimeStopIntentConsumePlan {
        matched: true,
        should_delete: input.preserve_matched != Some(true),
        reason_code: "matched".to_string(),
        source: Some(record.source),
        requested_at_ms: Some(record.requested_at_ms),
        pid: record.pid,
    })
}

pub fn plan_runtime_instance_write_json(input_json: String) -> Result<String, String> {
    let input: RuntimeInstanceWriteInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let now_ms = normalize_non_negative_i64(input.now_ms, 0);
    let status = normalize_instance_status(trim_or("declared", input.status), "status")?;
    let record = RuntimeInstanceRecord {
        port,
        host: trim_or("127.0.0.1", input.host),
        command: trim_or("", input.command),
        config_path: trim_or("", input.config_path),
        owner_scope: trim_or("unknown", input.owner_scope),
        started_at_ms: normalize_non_negative_i64(input.started_at_ms, now_ms),
        status,
        status_updated_at_ms: normalize_non_negative_i64(input.status_updated_at_ms, now_ms),
        notes: input.notes,
    };
    to_json(&RuntimeInstanceWritePlan {
        action: "write".to_string(),
        resource_id: "runtime.instance_record".to_string(),
        record,
    })
}

pub fn plan_runtime_instance_status_update_json(input_json: String) -> Result<String, String> {
    let input: RuntimeInstanceStatusUpdateInput = parse_json(&input_json)?;
    let port = normalize_positive_i64(input.port, "port")?;
    let mut record = match parse_instance_record(input.existing) {
        Some(record) => record,
        None => {
            return to_json(&RuntimeInstanceStatusUpdatePlan {
                action: "ignore".to_string(),
                resource_id: "runtime.instance_record".to_string(),
                reason_code: "missing_instance".to_string(),
                record: None,
            })
        }
    };
    if record.port != port {
        return to_json(&RuntimeInstanceStatusUpdatePlan {
            action: "ignore".to_string(),
            resource_id: "runtime.instance_record".to_string(),
            reason_code: "port_mismatch".to_string(),
            record: None,
        });
    }
    let current_status = normalize_instance_status(record.status.clone(), "existing.status")?;
    let next_status = normalize_instance_status(input.status, "status")?;
    if !is_status_transition_allowed(&current_status, &next_status) {
        return Err(format!(
            "runtime lifecycle invalid instance status transition {current_status} -> {next_status}"
        ));
    }
    record.status = next_status;
    record.status_updated_at_ms = normalize_non_negative_i64(
        input.status_updated_at_ms,
        normalize_non_negative_i64(input.now_ms, 0),
    );
    if input.notes.is_some() {
        record.notes = input.notes;
    }
    to_json(&RuntimeInstanceStatusUpdatePlan {
        action: "write".to_string(),
        resource_id: "runtime.instance_record".to_string(),
        reason_code: "matched".to_string(),
        record: Some(record),
    })
}

pub fn plan_runtime_restart_request_json(input_json: String) -> Result<String, String> {
    let input: RuntimeRestartRequestInput = parse_json(&input_json)?;
    let has_old_pids = input
        .old_pids
        .iter()
        .any(|pid| pid.is_finite() && *pid > 0.0);
    let api_key = input.restart_api_key.unwrap_or(RestartApiKeyInput {
        source: Some("none".to_string()),
        value: None,
    });
    let api_key_source = trim_or("none", api_key.source);
    let has_api_key = api_key
        .value
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let http_only = input.http_only == Some(true);
    let plan = if http_only {
        RuntimeRestartRequestPlan {
            preferred_transport: "http".to_string(),
            http_fallback_transport: "http".to_string(),
            reason_code: "http_only".to_string(),
        }
    } else if has_old_pids && api_key_source == "config" && has_api_key {
        RuntimeRestartRequestPlan {
            preferred_transport: "http".to_string(),
            http_fallback_transport: "signal".to_string(),
            reason_code: "config_apikey_with_local_pid".to_string(),
        }
    } else if has_old_pids {
        RuntimeRestartRequestPlan {
            preferred_transport: "signal".to_string(),
            http_fallback_transport: "signal".to_string(),
            reason_code: "local_pid_without_config_apikey".to_string(),
        }
    } else if has_api_key {
        RuntimeRestartRequestPlan {
            preferred_transport: "http".to_string(),
            http_fallback_transport: "http".to_string(),
            reason_code: "apikey_without_local_pid".to_string(),
        }
    } else {
        RuntimeRestartRequestPlan {
            preferred_transport: "none".to_string(),
            http_fallback_transport: "none".to_string(),
            reason_code: "no_restart_transport".to_string(),
        }
    };
    to_json(&plan)
}

pub fn plan_runtime_start_restart_takeover_guard_json(
    input_json: String,
) -> Result<String, String> {
    let input: RuntimeStartRestartTakeoverGuardInput = parse_json(&input_json)?;
    let ports: Vec<i64> = input
        .occupied_ports
        .iter()
        .filter_map(|port| normalize_optional_positive_i64(Some(*port)))
        .collect();
    if input.exclusive == Some(true) || input.daemon_supervisor == Some(true) {
        return to_json(&RuntimeStartRestartTakeoverGuardPlan {
            action: "allow".to_string(),
            reason_code: "explicit_takeover_owner".to_string(),
            ports,
        });
    }
    if ports.is_empty() {
        return to_json(&RuntimeStartRestartTakeoverGuardPlan {
            action: "allow".to_string(),
            reason_code: "no_existing_runtime".to_string(),
            ports,
        });
    }
    if input.explicit_restart == Some(true) {
        return to_json(&RuntimeStartRestartTakeoverGuardPlan {
            action: "refuse".to_string(),
            reason_code: "explicit_start_restart_existing_runtime".to_string(),
            ports,
        });
    }
    to_json(&RuntimeStartRestartTakeoverGuardPlan {
        action: "refuse".to_string(),
        reason_code: "start_existing_runtime_requires_restart_command".to_string(),
        ports,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_plan(raw: String) -> Value {
        serde_json::from_str(&raw).expect("plan must be valid json")
    }

    #[test]
    fn pid_cache_and_stop_intent_plans_keep_decisions_in_rust() {
        let pid_write = parse_plan(
            plan_runtime_pid_cache_write_json(
                r#"{"port":5520,"pid":4242,"origin":"start","nowMs":1700000000000}"#.to_string(),
            )
            .expect("pid plan"),
        );
        assert_eq!(pid_write["action"], "write");
        assert_eq!(pid_write["resourceId"], "runtime.pid_cache");
        assert_eq!(pid_write["record"]["port"], 5520);
        assert_eq!(pid_write["record"]["pid"], 4242);

        let stale_stop = parse_plan(
            plan_runtime_stop_intent_consume_json(
                r#"{"port":5520,"record":{"port":5520,"source":"jest","requestedAtMs":1700000000000},"nowMs":1700000100000,"maxAgeMs":10000}"#
                    .to_string(),
            )
            .expect("stop-intent plan"),
        );
        assert_eq!(stale_stop["matched"], false);
        assert_eq!(stale_stop["shouldDelete"], true);
        assert_eq!(stale_stop["reasonCode"], "stale");
    }

    #[test]
    fn restart_and_start_takeover_plans_are_native_owned() {
        let restart = parse_plan(
            plan_runtime_restart_request_json(
                r#"{"oldPids":[71641],"restartApiKey":{"source":"none","value":""},"httpOnly":false}"#
                    .to_string(),
            )
            .expect("restart plan"),
        );
        assert_eq!(restart["preferredTransport"], "signal");
        assert_eq!(restart["httpFallbackTransport"], "signal");
        assert_eq!(restart["reasonCode"], "local_pid_without_config_apikey");

        let guard = parse_plan(
            plan_runtime_start_restart_takeover_guard_json(
                r#"{"explicitRestart":true,"exclusive":false,"daemonSupervisor":false,"occupiedPorts":[5555]}"#
                    .to_string(),
            )
            .expect("start guard"),
        );
        assert_eq!(guard["action"], "refuse");
        assert_eq!(
            guard["reasonCode"],
            "explicit_start_restart_existing_runtime"
        );
        assert_eq!(guard["ports"][0], 5555);

        let default_start_guard = parse_plan(
            plan_runtime_start_restart_takeover_guard_json(
                r#"{"explicitRestart":false,"exclusive":false,"daemonSupervisor":false,"occupiedPorts":[5556]}"#
                    .to_string(),
            )
            .expect("default start guard"),
        );
        assert_eq!(default_start_guard["action"], "refuse");
        assert_eq!(
            default_start_guard["reasonCode"],
            "start_existing_runtime_requires_restart_command"
        );
        assert_eq!(default_start_guard["ports"][0], 5556);
    }

    #[test]
    fn instance_status_transition_rules_are_native_owned() {
        let invalid_status = plan_runtime_instance_write_json(
            r#"{"port":5520,"host":"127.0.0.1","command":"node","configPath":"/tmp/config.toml","ownerScope":"test","status":"starting"}"#
                .to_string(),
        )
        .expect_err("invalid instance status must fail");
        assert!(invalid_status.contains("runtime lifecycle status must be one of"));

        let healthy = parse_plan(
            plan_runtime_instance_write_json(
                r#"{"port":5520,"host":"127.0.0.1","command":"node","configPath":"/tmp/config.toml","ownerScope":"test","status":"healthy"}"#
                    .to_string(),
            )
            .expect("healthy instance write"),
        );
        let invalid_transition = plan_runtime_instance_status_update_json(
            serde_json::json!({
                "port": 5520,
                "existing": healthy["record"],
                "status": "bind",
                "nowMs": 1700000000200_i64
            })
            .to_string(),
        )
        .expect_err("backward status transition must fail");
        assert!(invalid_transition.contains("invalid instance status transition healthy -> bind"));
    }
}
