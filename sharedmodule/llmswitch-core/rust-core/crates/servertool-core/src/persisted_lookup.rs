// feature_id: hub.servertool_stopless_cli_continuation
use crate::stop_gateway_context;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;
pub const STOP_MESSAGE_PERSISTED_LOOKUP_POLICY: &str = "strict_session_only";
pub const STOP_MESSAGE_FOLLOWUP_FLOW_ID: &str = "stop_message_flow";
pub const STOP_MESSAGE_FOLLOWUP_SOURCE: &str = "servertool.stop_message";
pub const STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT: &str = "继续执行";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlannerInput {
    pub record: Value,
    pub runtime_metadata: Option<Value>,
    pub options: Option<StopMessagePersistedLookupPlannerOptions>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlannerOptions {
    pub include_snapshot_lookup: Option<bool>,
    pub include_tombstone_lookup: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedLookupPlanOutput {
    pub strict_session_scope: Option<String>,
    pub sticky_key: Option<String>,
    pub candidate_keys: Vec<String>,
    pub lookup_policy: String,
    pub read_stop_message_snapshot: bool,
    pub read_stop_message_tombstone: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedStateSelectionInput {
    pub states: Vec<StopMessagePersistedStateCandidate>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedStateCandidate {
    pub key: Option<String>,
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedTombstoneState {
    pub exhausted_default: bool,
    pub cleared: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessagePersistedStateSelectionOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<RuntimeStopMessageStateSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_mode: Option<String>,
    pub tombstone: StopMessagePersistedTombstoneState,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStopMessageStateSnapshot {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    pub max_repeats: i64,
    pub used: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_feedback: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingSnapshotPlanInput {
    pub raw: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingStateApplyPlanInput {
    pub snapshot: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingStateApplyPlanOutput {
    pub source: String,
    pub text: String,
    pub max_repeats: i64,
    pub used: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_mode: Option<String>,
    pub ai_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_seed_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_history: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingStateClearPlanInput {
    pub now: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingStateClearPlanOutput {
    pub timestamp: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStopMessageStateFromAdapterContextInput {
    pub runtime_metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRecordRuntimeMetadataInput {
    pub record: Value,
    pub runtime_metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageFollowupToolContentMaxCharsInput {
    pub env_value: Option<Value>,
    pub provider_key: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistStopMessageStatePlanInput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistStopMessageStatePlanOutput {
    pub action: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageDefaultSnapshotInput {
    pub base: Value,
    pub adapter_context: Option<Value>,
    pub options: Option<StopMessageDefaultSnapshotOptions>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageDefaultSnapshotOptions {
    pub text: Option<Value>,
    pub max_repeats: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageImplicitGeminiSnapshotInput {
    pub base: Value,
    pub adapter_context: Option<Value>,
    pub provider_protocol: Option<String>,
    pub record: Value,
}

pub fn plan_stop_message_persisted_lookup(
    input: &StopMessagePersistedLookupPlannerInput,
) -> StopMessagePersistedLookupPlanOutput {
    let merged_metadata =
        merge_runtime_metadata_with_record(&input.record, input.runtime_metadata.as_ref());
    let (strict_session_scope, sticky_key, candidate_keys) =
        collect_stop_message_persisted_candidate_keys(&input.record, &merged_metadata);
    let options = input.options.as_ref();

    StopMessagePersistedLookupPlanOutput {
        strict_session_scope,
        sticky_key,
        candidate_keys,
        lookup_policy: STOP_MESSAGE_PERSISTED_LOOKUP_POLICY.to_string(),
        read_stop_message_snapshot: options
            .and_then(|options| options.include_snapshot_lookup)
            .unwrap_or(true),
        read_stop_message_tombstone: options
            .and_then(|options| options.include_tombstone_lookup)
            .unwrap_or(true),
    }
}

pub fn plan_stop_message_persisted_state_selection(
    input: &StopMessagePersistedStateSelectionInput,
) -> StopMessagePersistedStateSelectionOutput {
    let mut snapshot: Option<RuntimeStopMessageStateSnapshot> = None;
    let mut stage_mode: Option<String> = None;
    let mut tombstone = StopMessagePersistedTombstoneState {
        exhausted_default: false,
        cleared: false,
    };

    for candidate in &input.states {
        if !is_persistent_stop_message_scope(candidate.key.as_deref()) {
            continue;
        }
        let state = &candidate.state;

        if snapshot.is_none() {
            let candidate_snapshot = resolve_stop_message_snapshot(Some(state));
            if candidate_snapshot
                .as_ref()
                .is_some_and(is_default_stop_message_exhausted)
            {
                if !tombstone.cleared {
                    tombstone = StopMessagePersistedTombstoneState {
                        exhausted_default: true,
                        cleared: false,
                    };
                }
            } else if let Some(candidate_snapshot) = candidate_snapshot {
                snapshot = Some(candidate_snapshot);
            }
        }

        if stage_mode.is_none() && !is_stop_message_cleared_tombstone(state) {
            stage_mode = state.as_object().and_then(|record| {
                normalize_stop_message_stage_mode(record.get("stopMessageStageMode"))
            });
        }

        if !tombstone.exhausted_default && !tombstone.cleared {
            if state
                .as_object()
                .and_then(|record| read_trimmed_string(record.get("stopMessageSource")))
                .as_deref()
                == Some("default_exhausted")
            {
                tombstone = StopMessagePersistedTombstoneState {
                    exhausted_default: true,
                    cleared: false,
                };
            } else if let Some(candidate_snapshot) = resolve_stop_message_snapshot(Some(state)) {
                if is_default_stop_message_exhausted(&candidate_snapshot) {
                    tombstone = StopMessagePersistedTombstoneState {
                        exhausted_default: true,
                        cleared: false,
                    };
                }
            } else if is_stop_message_cleared_tombstone(state) {
                tombstone = StopMessagePersistedTombstoneState {
                    exhausted_default: false,
                    cleared: true,
                };
            }
        }
    }

    StopMessagePersistedStateSelectionOutput {
        snapshot,
        stage_mode,
        tombstone,
    }
}

pub fn resolve_runtime_stop_message_state(
    runtime_metadata: &Value,
) -> Option<RuntimeStopMessageStateSnapshot> {
    if let Some(snapshot) = resolve_runtime_stopless_control_snapshot(runtime_metadata) {
        return Some(snapshot);
    }
    let runtime = runtime_metadata.as_object()?;
    let state = runtime.get("stopMessageState");
    if let Some(direct) = resolve_stop_message_snapshot(state) {
        return Some(direct);
    }

    let loop_state = runtime
        .get("serverToolLoopState")
        .and_then(Value::as_object)?;
    if read_trimmed_string(loop_state.get("flowId")).as_deref()
        != Some(STOP_MESSAGE_FOLLOWUP_FLOW_ID)
    {
        return None;
    }
    let max_repeats = read_js_nonnegative_integer(loop_state.get("maxRepeats"))?;
    let used = state
        .and_then(Value::as_object)
        .and_then(|state| read_js_nonnegative_integer(state.get("stopMessageUsed")))
        .unwrap_or(0);
    let text = state
        .and_then(Value::as_object)
        .and_then(|state| read_trimmed_string(state.get("stopMessageText")))
        .unwrap_or_else(|| STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT.to_string());

    Some(RuntimeStopMessageStateSnapshot {
        text,
        provider_key: state
            .and_then(Value::as_object)
            .and_then(|state| read_trimmed_string(state.get("stopMessageProviderKey"))),
        max_repeats,
        used,
        trigger_hint: None,
        schema_feedback: None,
        source: Some(STOP_MESSAGE_FOLLOWUP_SOURCE.to_string()),
        updated_at: None,
        last_used_at: None,
        stage_mode: Some("on".to_string()),
        ai_mode: None,
    })
}

fn resolve_runtime_stopless_control_snapshot(
    runtime_metadata: &Value,
) -> Option<RuntimeStopMessageStateSnapshot> {
    let runtime = runtime_metadata.as_object()?;
    let stopless = runtime
        .get("metadataCenterSnapshot")
        .and_then(Value::as_object)
        .and_then(|snapshot| snapshot.get("runtimeControl"))
        .and_then(Value::as_object)
        .and_then(|runtime_control| runtime_control.get("stopless"))
        .and_then(Value::as_object)
        .or_else(|| {
            runtime
                .get("runtime_control")
                .and_then(Value::as_object)
                .and_then(|runtime_control| runtime_control.get("stopless"))
                .and_then(Value::as_object)
        })
        .or_else(|| runtime.get("stopless").and_then(Value::as_object))?;
    if read_trimmed_string(stopless.get("flowId")).as_deref() != Some(STOP_MESSAGE_FOLLOWUP_FLOW_ID)
    {
        return None;
    }
    let max_repeats = read_js_nonnegative_integer(stopless.get("maxRepeats"))?;
    if max_repeats <= 0 {
        return None;
    }
    let repeat_count = read_js_nonnegative_integer(stopless.get("repeatCount")).unwrap_or(0);
    let text = read_trimmed_string(stopless.get("continuationPrompt"))
        .unwrap_or_else(|| STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT.to_string());

    Some(RuntimeStopMessageStateSnapshot {
        text,
        provider_key: None,
        max_repeats,
        used: repeat_count,
        trigger_hint: read_trimmed_string(stopless.get("triggerHint")),
        schema_feedback: stopless
            .get("schemaFeedback")
            .filter(|value| value.is_object())
            .cloned(),
        source: Some(STOP_MESSAGE_FOLLOWUP_SOURCE.to_string()),
        updated_at: read_finite_number(stopless.get("updatedAt")),
        last_used_at: None,
        stage_mode: Some("on".to_string()),
        ai_mode: None,
    })
}

pub fn resolve_runtime_stop_message_state_from_adapter_context(
    input: &RuntimeStopMessageStateFromAdapterContextInput,
) -> Option<RuntimeStopMessageStateSnapshot> {
    if let Some(runtime) = input.runtime_metadata.as_ref() {
        if let Some(snapshot) = resolve_runtime_stop_message_state(runtime) {
            return Some(snapshot);
        }
    }
    None
}

pub fn read_runtime_stop_message_stage_mode(runtime_metadata: &Value) -> Option<String> {
    let runtime = runtime_metadata.as_object()?;
    let state = runtime.get("stopMessageState").and_then(Value::as_object)?;
    normalize_stop_message_stage_mode(state.get("stopMessageStageMode"))
}

pub fn normalize_stop_message_stage_mode_value(raw: &Value) -> Option<String> {
    normalize_stop_message_stage_mode(Some(raw))
}

pub fn has_armed_stop_message_state(state: &Value) -> bool {
    let Some(record) = state.as_object() else {
        return false;
    };
    let stage_mode = normalize_stop_message_stage_mode(record.get("stopMessageStageMode"));
    if stage_mode.as_deref() == Some("off") {
        return false;
    }
    let text = read_trimmed_string(record.get("stopMessageText")).unwrap_or_default();
    let max_repeats = resolve_stop_message_max_repeats(
        record.get("stopMessageMaxRepeats"),
        stage_mode.as_deref(),
    );
    !text.is_empty() && max_repeats > 0
}

pub fn plan_stop_message_routing_snapshot(
    input: &StopMessageRoutingSnapshotPlanInput,
) -> Option<RuntimeStopMessageStateSnapshot> {
    resolve_stop_message_snapshot(Some(&input.raw))
}

pub fn plan_stop_message_routing_state_apply(
    input: &StopMessageRoutingStateApplyPlanInput,
) -> Result<StopMessageRoutingStateApplyPlanOutput, String> {
    let record = input
        .snapshot
        .as_object()
        .ok_or_else(|| "stop-message routing apply snapshot must be an object".to_string())?;
    let text = read_trimmed_string(record.get("text"))
        .ok_or_else(|| "stop-message routing apply snapshot requires text".to_string())?;
    let max_repeats =
        read_positive_finite_floor_value(record.get("maxRepeats")).ok_or_else(|| {
            "stop-message routing apply snapshot requires positive maxRepeats".to_string()
        })?;
    let used = read_finite_number(record.get("used"))
        .map(|value| value.floor() as i64)
        .map(|value| value.max(0))
        .unwrap_or(0);
    let source =
        read_trimmed_string(record.get("source")).unwrap_or_else(|| "explicit".to_string());
    let stage_mode = normalize_stop_message_stage_mode(record.get("stageMode"));
    let ai_seed_prompt = read_trimmed_string(record.get("aiSeedPrompt"));
    let ai_history = record
        .get("aiHistory")
        .and_then(Value::as_array)
        .map(|items| Value::Array(items.clone()));

    Ok(StopMessageRoutingStateApplyPlanOutput {
        source,
        text,
        max_repeats,
        used,
        updated_at: read_finite_number(record.get("updatedAt")),
        last_used_at: read_finite_number(record.get("lastUsedAt")),
        stage_mode,
        ai_mode: "off".to_string(),
        ai_seed_prompt,
        ai_history,
    })
}

pub fn plan_stop_message_routing_state_clear(
    input: &StopMessageRoutingStateClearPlanInput,
) -> StopMessageRoutingStateClearPlanOutput {
    let timestamp = input
        .now
        .as_ref()
        .and_then(|value| read_finite_number(Some(value)))
        .map(|value| value.floor() as i64)
        .unwrap_or_else(current_time_millis);
    StopMessageRoutingStateClearPlanOutput { timestamp }
}

pub fn read_servertool_followup_flow_id(runtime_metadata: &Value) -> String {
    runtime_metadata
        .as_object()
        .and_then(|runtime| {
            runtime
                .get("metadataCenterSnapshot")
                .and_then(Value::as_object)
                .and_then(|snapshot| snapshot.get("runtimeControl"))
                .and_then(Value::as_object)
                .and_then(|runtime_control| runtime_control.get("stopless"))
                .and_then(Value::as_object)
                .and_then(|stopless| read_trimmed_string(stopless.get("flowId")))
        })
        .or_else(|| {
            runtime_metadata
                .as_object()
                .and_then(|runtime| runtime.get("runtime_control"))
                .and_then(Value::as_object)
                .and_then(|runtime_control| runtime_control.get("stopless"))
                .and_then(Value::as_object)
                .and_then(|stopless| read_trimmed_string(stopless.get("flowId")))
        })
        .or_else(|| {
            runtime_metadata
                .as_object()
                .and_then(|runtime| runtime.get("stopless"))
                .and_then(Value::as_object)
                .and_then(|stopless| read_trimmed_string(stopless.get("flowId")))
        })
        .or_else(|| {
            runtime_metadata
                .as_object()
                .and_then(|runtime| runtime.get("serverToolLoopState"))
                .and_then(Value::as_object)
                .and_then(|loop_state| read_trimmed_string(loop_state.get("flowId")))
        })
        .unwrap_or_default()
}

pub fn resolve_bd_working_directory_for_record(
    input: &ServertoolRecordRuntimeMetadataInput,
) -> Option<String> {
    ["workdir", "cwd", "workingDirectory"]
        .into_iter()
        .find_map(|key| {
            read_session_scope_value(&input.record, input.runtime_metadata.as_ref(), key)
        })
}

pub fn resolve_stop_message_followup_provider_key(
    input: &ServertoolRecordRuntimeMetadataInput,
) -> String {
    read_trimmed_string(input.record.get("providerKey"))
        .or_else(|| read_trimmed_string(input.record.get("providerId")))
        .or_else(|| {
            input
                .record
                .get("metadata")
                .and_then(read_provider_key_from_metadata)
        })
        .or_else(|| {
            input
                .runtime_metadata
                .as_ref()
                .and_then(read_provider_key_from_metadata)
        })
        .unwrap_or_default()
}

pub fn resolve_client_connection_state(value: &Value) -> Option<Value> {
    if value.is_object() {
        Some(value.clone())
    } else {
        None
    }
}

pub fn has_compaction_flag(runtime_metadata: &Value) -> bool {
    runtime_metadata
        .as_object()
        .and_then(|runtime| runtime.get("compactionRequest"))
        .is_some_and(|flag| {
            flag.as_bool() == Some(true)
                || flag
                    .as_str()
                    .map(|value| value.trim().eq_ignore_ascii_case("true"))
                    .unwrap_or(false)
        })
}

pub fn resolve_entry_endpoint(record: &Value) -> String {
    read_trimmed_string(record.get("entryEndpoint"))
        .or_else(|| {
            record
                .get("metadata")
                .and_then(|metadata| read_trimmed_string(metadata.get("entryEndpoint")))
        })
        .unwrap_or_else(|| "/v1/chat/completions".to_string())
}

pub fn resolve_stop_message_followup_tool_content_max_chars(
    input: &StopMessageFollowupToolContentMaxCharsInput,
) -> Option<i64> {
    if let Some(raw) = input
        .env_value
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return read_positive_finite_floor(raw).map(|value| value.max(64));
    }

    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if model == "kimi-k2.5" || model.starts_with("kimi-k2.5-") {
        return Some(1200);
    }

    None
}

pub fn plan_persist_stop_message_state(
    input: &PersistStopMessageStatePlanInput,
) -> Result<PersistStopMessageStatePlanOutput, String> {
    let state = input
        .state
        .as_object()
        .ok_or_else(|| "persist stop-message state input must be an object".to_string())?;

    let has_non_stop_message_state = js_truthy(state.get("forcedTarget"))
        || js_truthy(state.get("preferTarget"))
        || json_collection_has_items(state.get("allowedProviders"))
        || json_collection_has_items(state.get("disabledProviders"))
        || json_collection_has_items(state.get("disabledKeys"))
        || json_collection_has_items(state.get("disabledModels"))
        || read_trimmed_string(state.get("preCommandScriptPath")).is_some()
        || read_finite_number(state.get("preCommandUpdatedAt")).is_some();
    let has_lifecycle_stamp = read_finite_number(state.get("stopMessageLastUsedAt")).is_some();
    let is_empty = read_trimmed_string(state.get("stopMessageText")).is_none()
        && read_trimmed_string(state.get("stopMessageProviderKey")).is_none()
        && read_finite_number(state.get("stopMessageMaxRepeats")).is_none()
        && read_finite_number(state.get("stopMessageUsed")).is_none()
        && read_trimmed_string(state.get("stopMessageStageMode")).is_none()
        && !has_lifecycle_stamp
        && !has_non_stop_message_state;

    Ok(PersistStopMessageStatePlanOutput {
        action: if is_empty { "clear" } else { "save" }.to_string(),
    })
}

pub fn resolve_default_stop_message_snapshot(
    input: &StopMessageDefaultSnapshotInput,
) -> Option<RuntimeStopMessageStateSnapshot> {
    if !is_stop_eligible_for_servertool(&input.base, input.adapter_context.as_ref()) {
        return None;
    }

    let options = input.options.as_ref();
    let text = options
        .and_then(|options| read_trimmed_string(options.text.as_ref()))
        .unwrap_or_else(|| STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT.to_string());
    let max_repeats = options
        .and_then(|options| read_positive_finite_floor_value(options.max_repeats.as_ref()))
        .unwrap_or(1);

    Some(RuntimeStopMessageStateSnapshot {
        text,
        provider_key: None,
        max_repeats,
        used: 0,
        trigger_hint: None,
        schema_feedback: None,
        source: Some("default".to_string()),
        updated_at: None,
        last_used_at: None,
        stage_mode: None,
        ai_mode: None,
    })
}

pub fn resolve_implicit_gemini_stop_message_snapshot(
    input: &StopMessageImplicitGeminiSnapshotInput,
) -> Option<RuntimeStopMessageStateSnapshot> {
    let provider_protocol = input
        .provider_protocol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| {
            read_trimmed_string(input.record.get("providerProtocol"))
                .map(|value| value.to_ascii_lowercase())
        })
        .unwrap_or_default();
    if provider_protocol != "gemini-chat" {
        return None;
    }

    let entry_endpoint = resolve_entry_endpoint(&input.record).to_ascii_lowercase();
    if !entry_endpoint.contains("/v1/responses") {
        return None;
    }

    if !is_stop_eligible_for_servertool(&input.base, input.adapter_context.as_ref()) {
        return None;
    }

    if !is_empty_assistant_reply(&input.base) {
        return None;
    }

    Some(RuntimeStopMessageStateSnapshot {
        text: STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT.to_string(),
        provider_key: read_trimmed_string(input.record.get("providerKey"))
            .or_else(|| read_trimmed_string(input.record.get("providerId"))),
        max_repeats: 1,
        used: 0,
        trigger_hint: None,
        schema_feedback: None,
        source: Some("auto".to_string()),
        updated_at: None,
        last_used_at: None,
        stage_mode: None,
        ai_mode: None,
    })
}

fn resolve_stop_message_snapshot(raw: Option<&Value>) -> Option<RuntimeStopMessageStateSnapshot> {
    let record = raw?.as_object()?;
    let text = read_trimmed_string(record.get("stopMessageText"))?;
    let stage_mode = normalize_stop_message_stage_mode(record.get("stopMessageStageMode"));
    if stage_mode.as_deref() == Some("off") {
        return None;
    }
    let max_repeats = resolve_stop_message_max_repeats(
        record.get("stopMessageMaxRepeats"),
        stage_mode.as_deref(),
    );
    if max_repeats <= 0 {
        return None;
    }
    let used = read_finite_number(record.get("stopMessageUsed"))
        .map(|value| value.floor() as i64)
        .map(|value| value.max(0))
        .unwrap_or(0);
    let provider_key = read_trimmed_string(record.get("stopMessageProviderKey"));
    let updated_at = read_nonzero_finite_number(record.get("stopMessageUpdatedAt"));
    let last_used_at = read_nonzero_finite_number(record.get("stopMessageLastUsedAt"));
    let source = read_trimmed_string(record.get("stopMessageSource"));

    Some(RuntimeStopMessageStateSnapshot {
        text,
        provider_key,
        max_repeats,
        used,
        trigger_hint: None,
        schema_feedback: None,
        source,
        updated_at,
        last_used_at,
        stage_mode,
        ai_mode: None,
    })
}

fn is_default_stop_message_exhausted(snapshot: &RuntimeStopMessageStateSnapshot) -> bool {
    snapshot.source.as_deref() == Some("default")
        && snapshot.max_repeats > 0
        && snapshot.used >= snapshot.max_repeats
}

fn is_stop_message_cleared_tombstone(state: &Value) -> bool {
    let Some(record) = state.as_object() else {
        return false;
    };
    let has_text = read_trimmed_string(record.get("stopMessageText")).is_some();
    let has_lifecycle_stamp = read_finite_number(record.get("stopMessageLastUsedAt")).is_some();
    !has_text && has_lifecycle_stamp
}

fn is_persistent_stop_message_scope(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    value.starts_with("session:")
}

fn is_stop_eligible_for_servertool(base: &Value, adapter_context: Option<&Value>) -> bool {
    read_stop_gateway_eligible_from_adapter_context(adapter_context)
        .unwrap_or_else(|| stop_gateway_context::is_stop_eligible(base))
}

fn read_stop_gateway_eligible_from_adapter_context(
    adapter_context: Option<&Value>,
) -> Option<bool> {
    let record = adapter_context?.as_object()?;
    let raw = record
        .get("runtimeControl")
        .or_else(|| record.get("runtime_control"))
        .and_then(Value::as_object)
        .and_then(|runtime| runtime.get("stopGatewayContext"))
        .or_else(|| {
            record
                .get("metadataCenterSnapshot")
                .and_then(Value::as_object)
                .and_then(|snapshot| snapshot.get("runtimeControl"))
                .and_then(Value::as_object)
                .and_then(|runtime| runtime.get("stopGatewayContext"))
        })?;
    let context = raw.as_object()?;
    let _observed = context.get("observed").and_then(Value::as_bool)?;
    let eligible = context.get("eligible").and_then(Value::as_bool)?;
    let _source = normalize_stop_gateway_source(context.get("source"))?;
    let _reason = read_trimmed_string(context.get("reason"))?;
    Some(eligible)
}

fn normalize_stop_gateway_source(value: Option<&Value>) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_ascii_lowercase();
    match normalized.as_str() {
        "chat" | "responses" | "none" => Some(normalized),
        _ => Some("none".to_string()),
    }
}

fn is_empty_assistant_reply(base: &Value) -> bool {
    let Some(payload) = base.as_object() else {
        return false;
    };

    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        if !choices.is_empty() {
            let Some(first) = choices.first().and_then(Value::as_object) else {
                return false;
            };
            let finish_reason = read_trimmed_string(first.get("finish_reason"))
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if finish_reason != "stop" {
                return false;
            }
            let Some(message) = first.get("message").and_then(Value::as_object) else {
                return false;
            };
            if message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                return false;
            }
            let text = message
                .get("content")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            return text.is_empty();
        }
    }

    let status = read_trimmed_string(payload.get("status"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !status.is_empty() && status != "completed" {
        return false;
    }
    if payload
        .get("required_action")
        .is_some_and(|required_action| required_action.is_object())
    {
        return false;
    }
    if responses_output_text_nonempty(base) {
        return false;
    }
    let output = payload
        .get("output")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if output.iter().any(has_tool_like_output) {
        return false;
    }
    true
}

fn responses_output_text_nonempty(base: &Value) -> bool {
    let Some(payload) = base.as_object() else {
        return false;
    };
    if let Some(text) = payload.get("output_text").and_then(Value::as_str) {
        return !text.trim().is_empty();
    }
    if let Some(items) = payload.get("output_text").and_then(Value::as_array) {
        if items
            .iter()
            .filter_map(Value::as_str)
            .any(|entry| !entry.trim().is_empty())
        {
            return true;
        }
    }

    let output = payload
        .get("output")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for item in output {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(type_name) =
            read_trimmed_string(record.get("type")).map(|value| value.to_ascii_lowercase())
        else {
            continue;
        };
        if type_name.contains("tool")
            || type_name.contains("function")
            || type_name.contains("call")
        {
            if extract_tool_or_unknown_text_nonempty(item) {
                return true;
            }
            continue;
        }
        if type_name != "message" {
            continue;
        }
        let content = record
            .get("content")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for part in content {
            let Some(part_record) = part.as_object() else {
                continue;
            };
            let part_type = read_trimmed_string(part_record.get("type"))
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(part_type.as_str(), "output_text" | "text" | "input_text") {
                if part_record
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
                {
                    return true;
                }
                continue;
            }
            for key in [
                "text",
                "input",
                "arguments",
                "args",
                "patch",
                "content",
                "value",
            ] {
                if extract_unknown_text_nonempty(part_record.get(key), 0) {
                    return true;
                }
            }
        }
    }
    false
}

fn extract_tool_or_unknown_text_nonempty(item: &Value) -> bool {
    let Some(record) = item.as_object() else {
        return false;
    };
    for key in ["input", "arguments", "args", "patch"] {
        if extract_unknown_text_nonempty(record.get(key), 0) {
            return true;
        }
    }
    extract_unknown_text_nonempty(Some(item), 0)
}

fn extract_unknown_text_nonempty(value: Option<&Value>, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Number(_)) | Some(Value::Bool(_)) => true,
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| extract_unknown_text_nonempty(Some(entry), depth + 1)),
        Some(Value::Object(record)) => {
            let priority_keys = [
                "text",
                "content",
                "value",
                "summary",
                "reasoning",
                "thinking",
                "analysis",
                "function",
                "input",
                "arguments",
                "args",
                "patch",
                "payload",
                "result",
                "command",
                "message",
                "output_text",
                "name",
            ];
            let mut saw_priority_key = false;
            for key in priority_keys {
                if let Some(child) = record.get(key) {
                    saw_priority_key = true;
                    if extract_unknown_text_nonempty(Some(child), depth + 1) {
                        return true;
                    }
                }
            }
            !saw_priority_key
                && record
                    .values()
                    .filter_map(Value::as_str)
                    .any(|text| !text.trim().is_empty())
        }
    }
}

fn has_tool_like_output(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let type_name = read_trimmed_string(record.get("type"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    !type_name.is_empty()
        && (type_name == "tool_call"
            || type_name == "tool_use"
            || type_name == "function_call"
            || type_name.contains("tool"))
}

fn read_session_scope_value(
    record: &Value,
    runtime_metadata: Option<&Value>,
    key: &str,
) -> Option<String> {
    let metadata = record.get("metadata");
    read_trimmed_string(record.get(key))
        .or_else(|| metadata.and_then(|metadata| read_trimmed_string(metadata.get(key))))
        .or_else(|| read_hub_capture_context_value(record, key))
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("context"))
                .and_then(|context| read_trimmed_string(context.get(key)))
        })
        .or_else(|| metadata.and_then(|metadata| read_hub_capture_context_value(metadata, key)))
        .or_else(|| runtime_metadata.and_then(|runtime| read_trimmed_string(runtime.get(key))))
        .or_else(|| {
            runtime_metadata.and_then(|runtime| read_hub_capture_context_value(runtime, key))
        })
}

fn read_hub_capture_context_value(source: &Value, key: &str) -> Option<String> {
    if !source.is_object() {
        return None;
    }
    let hub_capture = source.get("__hub_capture");
    let captured_context = source.get("capturedContext");
    let captured_hub_capture = captured_context.and_then(|context| context.get("__hub_capture"));
    let candidates = [
        Some(source),
        source.get("context"),
        hub_capture,
        hub_capture.and_then(|value| value.get("context")),
        captured_context,
        captured_context.and_then(|value| value.get("context")),
        captured_hub_capture,
        captured_hub_capture.and_then(|value| value.get("context")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|candidate| read_trimmed_string(candidate.get(key)))
}

fn read_provider_key_from_metadata(value: &Value) -> Option<String> {
    if !value.is_object() {
        return None;
    }
    read_trimmed_string(value.get("providerKey"))
        .or_else(|| read_trimmed_string(value.get("providerId")))
        .or_else(|| read_trimmed_string(value.get("targetProviderKey")))
        .or_else(|| {
            value.get("target").and_then(|target| {
                read_trimmed_string(target.get("providerKey"))
                    .or_else(|| read_trimmed_string(target.get("providerId")))
            })
        })
}

fn resolve_stop_message_max_repeats(value: Option<&Value>, stage_mode: Option<&str>) -> i64 {
    let parsed = read_finite_number(value)
        .map(|value| value.floor() as i64)
        .unwrap_or(0);
    if parsed > 0 {
        return parsed;
    }
    if matches!(stage_mode, Some("on" | "auto")) {
        return DEFAULT_STOP_MESSAGE_MAX_REPEATS;
    }
    0
}

fn normalize_stop_message_stage_mode(value: Option<&Value>) -> Option<String> {
    normalize_one_of(value, &["on", "off", "auto"])
}

fn normalize_one_of(value: Option<&Value>, allowed: &[&str]) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_lowercase();
    if allowed.iter().any(|item| *item == normalized) {
        return Some(normalized);
    }
    None
}

pub fn collect_stop_message_persisted_candidate_keys(
    direct_record: &Value,
    resolver_metadata: &Value,
) -> (Option<String>, Option<String>, Vec<String>) {
    let strict_session_scope = resolve_stop_message_session_scope(resolver_metadata);
    let sticky_key = strict_session_scope.clone();
    let row = direct_record.as_object();
    let mut candidate_keys: Vec<String> = Vec::new();

    push_unique_scope_key(&mut candidate_keys, strict_session_scope.clone());

    if let Some(session_id) = row.and_then(|obj| read_trimmed_string(obj.get("sessionId"))) {
        push_unique_scope_key(&mut candidate_keys, Some(format!("session:{}", session_id)));
    }

    push_unique_scope_key(&mut candidate_keys, sticky_key.clone());

    (strict_session_scope, sticky_key, candidate_keys)
}

pub fn resolve_stop_message_session_scope(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    read_trimmed_string(row.get("sessionId")).map(|session_id| format!("session:{session_id}"))
}

/// Synchronously build a `session:<sessionId>`-keyed stop-message persisted state
/// payload that the CLI binary can write to disk after running the stopless
/// continuation shell. This is the **only** owner of session-scoped stop-message
/// state mutation: it never falls back to `tmux:`, `conversation:`, or
/// `requestId`-based keys.
///
/// `next_used` is clamped into `[0, max_repeats]`. `text` is required; an empty
pub fn resolve_servertool_sticky_key(metadata: &Value) -> String {
    if let Some(session_scope) = resolve_session_scope(metadata) {
        return session_scope;
    }
    resolve_routing_state_key(metadata)
}

pub fn resolve_servertool_state_key(metadata: &Value) -> String {
    if let Some(request_chain_key) = resolve_continuation_request_chain_key(metadata) {
        return request_chain_key;
    }
    if let Some(stop_scope) = resolve_stop_message_session_scope(metadata) {
        return stop_scope;
    }
    read_trimmed_string(metadata.get("requestId")).unwrap_or_else(|| "default".to_string())
}

fn merge_runtime_metadata_with_record(record: &Value, runtime_metadata: Option<&Value>) -> Value {
    match (record, runtime_metadata) {
        (Value::Object(record), Some(Value::Object(runtime))) => {
            let mut out = runtime.clone();
            for (key, value) in record {
                out.insert(key.clone(), value.clone());
            }
            Value::Object(out)
        }
        (record, _) => record.clone(),
    }
}

fn resolve_session_scope(metadata: &Value) -> Option<String> {
    read_trimmed_string(metadata.get("sessionId")).map(|session_id| format!("session:{session_id}"))
}

fn resolve_routing_state_key(metadata: &Value) -> String {
    if let Some(request_chain_key) = resolve_continuation_request_chain_key(metadata) {
        return request_chain_key;
    }

    if metadata.get("providerProtocol").and_then(Value::as_str) == Some("openai-responses") {
        if let Some(previous_request_id) = resolve_legacy_responses_request_chain_key(metadata) {
            return previous_request_id;
        }
        if let Some(request_id) = read_trimmed_string(metadata.get("requestId")) {
            return request_id;
        }
    }

    read_trimmed_string(metadata.get("requestId")).unwrap_or_else(|| "default".to_string())
}

fn resolve_continuation_request_chain_key(metadata: &Value) -> Option<String> {
    let continuation = metadata.get("continuation").and_then(Value::as_object)?;
    let continuation_scope = read_trimmed_string(continuation.get("continuationScope"))
        .or_else(|| read_trimmed_string(continuation.get("stickyScope")))?;
    if continuation_scope != "request_chain" {
        return None;
    }
    read_trimmed_string(continuation.get("chainId")).or_else(|| {
        continuation
            .get("resumeFrom")
            .and_then(Value::as_object)
            .and_then(|resume_from| read_trimmed_string(resume_from.get("requestId")))
    })
}

fn resolve_legacy_responses_request_chain_key(metadata: &Value) -> Option<String> {
    metadata
        .get("responsesResume")
        .and_then(|resume| read_trimmed_string(resume.get("previousRequestId")))
}

fn push_unique_scope_key(out: &mut Vec<String>, value: Option<String>) {
    let Some(raw) = value else {
        return;
    };
    let normalized = raw.trim();
    if normalized.is_empty() {
        return;
    }
    if !out.iter().any(|entry| entry == normalized) {
        out.push(normalized.to_string());
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn json_collection_has_items(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(items)) => !items.is_empty(),
        _ => false,
    }
}

fn read_finite_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    match value {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        _ => None,
    }
}

fn read_nonzero_finite_number(value: Option<&Value>) -> Option<f64> {
    read_finite_number(value).filter(|value| *value != 0.0)
}

fn read_js_nonnegative_integer(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().ok()?
            }
        }
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => return None,
    };
    if !number.is_finite() {
        return None;
    }
    let floored = number.floor();
    if floored < 0.0 {
        return None;
    }
    Some(floored as i64)
}

fn read_positive_finite_floor(raw: &str) -> Option<i64> {
    let parsed = raw.parse::<f64>().ok()?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return None;
    }
    Some(parsed.floor() as i64)
}

fn read_positive_finite_floor_value(value: Option<&Value>) -> Option<i64> {
    let parsed = read_finite_number(value)?;
    if parsed <= 0.0 {
        return None;
    }
    Some(parsed.floor() as i64)
}

fn current_time_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plan_uses_stable_direct_candidate_order_and_dedupes() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "tmuxSessionId": "tmux-a",
                "clientTmuxSessionId": "tmux-a",
                "sessionId": "sess-a",
                "conversationId": "conv-a"
            }),
            runtime_metadata: None,
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(plan.strict_session_scope.as_deref(), Some("session:sess-a"));
        assert_eq!(plan.sticky_key.as_deref(), Some("session:sess-a"));
        assert_eq!(plan.candidate_keys, vec!["session:sess-a"]);
        assert_eq!(plan.lookup_policy, STOP_MESSAGE_PERSISTED_LOOKUP_POLICY);
        assert!(plan.read_stop_message_snapshot);
        assert!(plan.read_stop_message_tombstone);
    }

    #[test]
    fn routing_snapshot_rejects_off_or_missing_text() {
        assert!(
            plan_stop_message_routing_snapshot(&StopMessageRoutingSnapshotPlanInput {
                raw: json!({
                    "stopMessageText": " continue ",
                    "stopMessageStageMode": "off",
                    "stopMessageMaxRepeats": 3
                }),
            })
            .is_none()
        );

        assert!(
            plan_stop_message_routing_snapshot(&StopMessageRoutingSnapshotPlanInput {
                raw: json!({
                    "stopMessageStageMode": "on",
                    "stopMessageMaxRepeats": 3
                }),
            })
            .is_none()
        );
    }

    #[test]
    fn routing_snapshot_defaults_max_repeats_and_ai_mode() {
        let snapshot = plan_stop_message_routing_snapshot(&StopMessageRoutingSnapshotPlanInput {
            raw: json!({
                "stopMessageText": " continue ",
                "stopMessageStageMode": " AUTO ",
                "stopMessageUsed": 2.9,
            }),
        })
        .expect("snapshot");

        assert_eq!(snapshot.text, "continue");
        assert_eq!(snapshot.max_repeats, DEFAULT_STOP_MESSAGE_MAX_REPEATS);
        assert_eq!(snapshot.used, 2);
        assert_eq!(snapshot.stage_mode.as_deref(), Some("auto"));
        assert_eq!(snapshot.ai_mode, None);
    }

    #[test]
    fn persisted_state_selection_is_rust_owned_for_snapshot_stage_and_tombstone() {
        let selection =
            plan_stop_message_persisted_state_selection(&StopMessagePersistedStateSelectionInput {
                states: vec![
                    StopMessagePersistedStateCandidate {
                        key: Some("request:ignored".to_string()),
                        state: json!({
                            "stopMessageText": "ignored",
                            "stopMessageMaxRepeats": 1
                        }),
                    },
                    StopMessagePersistedStateCandidate {
                        key: Some("tmux:default-exhausted".to_string()),
                        state: json!({
                            "stopMessageText": "default done",
                            "stopMessageMaxRepeats": 1,
                            "stopMessageUsed": 1,
                            "stopMessageSource": "default",
                            "stopMessageStageMode": "auto"
                        }),
                    },
                    StopMessagePersistedStateCandidate {
                        key: Some("session:active".to_string()),
                        state: json!({
                            "stopMessageText": " persisted continue ",
                            "stopMessageMaxRepeats": 4,
                            "stopMessageUsed": 2,
                            "stopMessageSource": "explicit",
                            "stopMessageStageMode": "on"
                        }),
                    },
                ],
            });

        let snapshot = selection.snapshot.expect("persisted snapshot");
        assert_eq!(snapshot.text, "persisted continue");
        assert_eq!(snapshot.max_repeats, 4);
        assert_eq!(snapshot.used, 2);
        assert_eq!(selection.stage_mode.as_deref(), Some("on"));
        assert!(!selection.tombstone.exhausted_default);
        assert!(!selection.tombstone.cleared);
    }

    #[test]
    fn persisted_state_selection_reports_session_cleared_tombstone_without_stage_mode() {
        let selection =
            plan_stop_message_persisted_state_selection(&StopMessagePersistedStateSelectionInput {
                states: vec![StopMessagePersistedStateCandidate {
                    key: Some("session:cleared".to_string()),
                    state: json!({
                        "stopMessageLastUsedAt": 1234,
                        "stopMessageStageMode": "on"
                    }),
                }],
            });

        assert!(selection.snapshot.is_none());
        assert!(selection.stage_mode.is_none());
        assert!(!selection.tombstone.exhausted_default);
        assert!(selection.tombstone.cleared);
    }

    #[test]
    fn persisted_state_selection_ignores_non_session_scopes() {
        let selection =
            plan_stop_message_persisted_state_selection(&StopMessagePersistedStateSelectionInput {
                states: vec![
                    StopMessagePersistedStateCandidate {
                        key: Some("tmux:legacy".to_string()),
                        state: json!({
                            "stopMessageText": "tmux should not match",
                            "stopMessageMaxRepeats": 4,
                            "stopMessageUsed": 1,
                            "stopMessageStageMode": "on"
                        }),
                    },
                    StopMessagePersistedStateCandidate {
                        key: Some("conversation:legacy".to_string()),
                        state: json!({
                            "stopMessageLastUsedAt": 1234,
                            "stopMessageStageMode": "on"
                        }),
                    },
                ],
            });

        assert!(selection.snapshot.is_none());
        assert!(selection.stage_mode.is_none());
        assert!(!selection.tombstone.exhausted_default);
        assert!(!selection.tombstone.cleared);
    }

    #[test]
    fn routing_apply_plan_normalizes_fields() {
        let plan = plan_stop_message_routing_state_apply(&StopMessageRoutingStateApplyPlanInput {
            snapshot: json!({
                "text": " continue ",
                "maxRepeats": 4.8,
                "used": -2,
                "source": " persisted ",
                "stageMode": " ON ",
                "aiMode": " OFF ",
                "aiSeedPrompt": " seed ",
                "aiHistory": [{ "role": "assistant" }],
                "updatedAt": 101.5,
                "lastUsedAt": 102.5
            }),
        })
        .expect("apply plan");

        assert_eq!(plan.source, "persisted");
        assert_eq!(plan.text, "continue");
        assert_eq!(plan.max_repeats, 4);
        assert_eq!(plan.used, 0);
        assert_eq!(plan.stage_mode.as_deref(), Some("on"));
        assert_eq!(plan.ai_mode, "off");
        assert_eq!(plan.ai_seed_prompt.as_deref(), Some("seed"));
        assert_eq!(plan.ai_history, Some(json!([{ "role": "assistant" }])));
        assert_eq!(plan.updated_at, Some(101.5));
        assert_eq!(plan.last_used_at, Some(102.5));
    }

    #[test]
    fn routing_clear_plan_floors_timestamp() {
        let plan = plan_stop_message_routing_state_clear(&StopMessageRoutingStateClearPlanInput {
            now: Some(json!(1234.9)),
        });

        assert_eq!(plan.timestamp, 1234);
    }

    #[test]
    fn plan_appends_strict_scope_and_sticky_key_after_direct_family() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "sessionId": "record-session"
            }),
            runtime_metadata: Some(json!({
                "clientTmuxSessionId": "runtime-tmux",
                "stopMessageClientInjectScope": "conversation:sticky-conv"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:record-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:record-session"));
        assert_eq!(plan.candidate_keys, vec!["session:record-session"]);
    }

    #[test]
    fn record_metadata_overrides_runtime_metadata_for_scope_resolution() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "sessionId": "record-session"
            }),
            runtime_metadata: Some(json!({
                "sessionId": "runtime-session",
                "conversationId": "runtime-conv"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(plan.candidate_keys, vec!["session:record-session"]);
        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:record-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:record-session"));
    }

    #[test]
    fn runtime_session_scope_participates_even_when_direct_record_lacks_session_id() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "requestId": "req-stopless"
            }),
            runtime_metadata: Some(json!({
                "sessionId": "runtime-session"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:runtime-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:runtime-session"));
        assert_eq!(plan.candidate_keys, vec!["session:runtime-session"]);
    }

    #[test]
    fn options_only_control_snapshot_and_tombstone_reads() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({
                "conversationId": "conv-a"
            }),
            runtime_metadata: None,
            options: Some(StopMessagePersistedLookupPlannerOptions {
                include_snapshot_lookup: Some(false),
                include_tombstone_lookup: Some(false),
            }),
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert!(plan.candidate_keys.is_empty());
        assert!(plan.strict_session_scope.is_none());
        assert!(plan.sticky_key.is_none());
        assert!(!plan.read_stop_message_snapshot);
        assert!(!plan.read_stop_message_tombstone);
    }

    #[test]
    fn runtime_metadata_session_scope_becomes_stopless_candidate_key() {
        let input = StopMessagePersistedLookupPlannerInput {
            record: json!({}),
            runtime_metadata: Some(json!({
                "sessionId": "runtime-session"
            })),
            options: None,
        };

        let plan = plan_stop_message_persisted_lookup(&input);

        assert_eq!(
            plan.strict_session_scope.as_deref(),
            Some("session:runtime-session")
        );
        assert_eq!(plan.sticky_key.as_deref(), Some("session:runtime-session"));
        assert_eq!(plan.candidate_keys, vec!["session:runtime-session"]);
    }

    #[test]
    fn sticky_key_preserves_request_chain_before_request_id_default() {
        assert_eq!(
            resolve_servertool_sticky_key(&json!({
                "continuation": {
                    "continuationScope": "request_chain",
                    "resumeFrom": { "requestId": "req-parent" }
                },
                "requestId": "req-child"
            })),
            "req-parent"
        );
        assert_eq!(resolve_servertool_sticky_key(&json!({})), "default");
    }

    #[test]
    fn state_key_preserves_request_chain_before_session_scope() {
        assert_eq!(
            resolve_servertool_state_key(&json!({
                "continuation": {
                    "stickyScope": "request_chain",
                    "resumeFrom": { "requestId": "req-parent" }
                },
                "sessionId": "session-should-lose",
                "requestId": "req-child"
            })),
            "req-parent"
        );
    }

    #[test]
    fn state_key_uses_stop_message_scope_before_request_id() {
        assert_eq!(
            resolve_servertool_state_key(&json!({
                "clientTmuxSessionId": "tmux-a",
                "requestId": "req-a"
            })),
            "req-a"
        );
        assert_eq!(
            resolve_servertool_state_key(&json!({
                "sessionId": "session-a",
                "requestId": "req-a"
            })),
            "session:session-a"
        );
    }

    #[test]
    fn state_key_falls_back_to_request_id_then_default() {
        assert_eq!(
            resolve_servertool_state_key(&json!({
                "requestId": "req-a"
            })),
            "req-a"
        );
        assert_eq!(resolve_servertool_state_key(&json!({})), "default");
    }

    #[test]
    fn runtime_stop_state_resolves_direct_snapshot_with_defaults() {
        let snapshot = resolve_runtime_stop_message_state(&json!({
            "stopMessageState": {
                "stopMessageText": "  keep going  ",
                "stopMessageStageMode": "AUTO",
                "stopMessageUsed": 2.7,
                "stopMessageUpdatedAt": 1234,
                "stopMessageLastUsedAt": 0,
                "stopMessageSource": " explicit "
            }
        }))
        .expect("snapshot");

        assert_eq!(
            snapshot,
            RuntimeStopMessageStateSnapshot {
                text: "keep going".to_string(),
                provider_key: None,
                max_repeats: DEFAULT_STOP_MESSAGE_MAX_REPEATS,
                used: 2,
                trigger_hint: None,
                schema_feedback: None,
                source: Some("explicit".to_string()),
                updated_at: Some(1234.0),
                last_used_at: None,
                stage_mode: Some("auto".to_string()),
                ai_mode: None,
            }
        );
    }

    #[test]
    fn runtime_stop_state_uses_loop_state_max_repeats_without_repeat_count() {
        let snapshot = resolve_runtime_stop_message_state(&json!({
            "stopMessageState": {
                "stopMessageUsed": "2",
                "stopMessageText": "  "
            },
            "serverToolLoopState": {
                "flowId": "stop_message_flow",
                "repeatCount": 99,
                "maxRepeats": "3"
            }
        }))
        .expect("snapshot");

        assert_eq!(
            snapshot,
            RuntimeStopMessageStateSnapshot {
                text: STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT.to_string(),
                provider_key: None,
                max_repeats: 3,
                used: 2,
                trigger_hint: None,
                schema_feedback: None,
                source: Some(STOP_MESSAGE_FOLLOWUP_SOURCE.to_string()),
                updated_at: None,
                last_used_at: None,
                stage_mode: Some("on".to_string()),
                ai_mode: None,
            }
        );

        assert!(resolve_runtime_stop_message_state(&json!({
            "serverToolLoopState": {
                "flowId": "stop_message_flow",
                "repeatCount": 3
            }
        }))
        .is_none());
    }

    #[test]
    fn runtime_stop_state_prefers_canonical_stopless_control_over_legacy_state() {
        let snapshot = resolve_runtime_stop_message_state(&json!({
            "metadataCenterSnapshot": {
                "runtimeControl": {
                    "stopless": {
                        "flowId": "stop_message_flow",
                        "repeatCount": 2,
                        "maxRepeats": 3,
                        "continuationPrompt": " continue from stopless ",
                        "triggerHint": "invalid_schema",
                        "schemaFeedback": {
                            "reasonCode": "stop_schema_next_step_missing"
                        }
                    }
                }
            },
            "stopMessageState": {
                "stopMessageText": " stale runtime text ",
                "stopMessageStageMode": "on",
                "stopMessageMaxRepeats": 9,
                "stopMessageUsed": 0
            },
            "serverToolLoopState": {
                "flowId": "stop_message_flow",
                "repeatCount": 9,
                "maxRepeats": 9
            }
        }))
        .expect("snapshot");

        assert_eq!(snapshot.text, "continue from stopless");
        assert_eq!(snapshot.max_repeats, 3);
        assert_eq!(snapshot.used, 2);
        assert_eq!(snapshot.trigger_hint.as_deref(), Some("invalid_schema"));
        assert_eq!(
            snapshot.schema_feedback,
            Some(json!({
                "reasonCode": "stop_schema_next_step_missing"
            }))
        );
        assert_eq!(
            snapshot.source.as_deref(),
            Some(STOP_MESSAGE_FOLLOWUP_SOURCE)
        );
    }

    #[test]
    fn runtime_stop_stage_mode_reads_state_only() {
        assert_eq!(
            read_runtime_stop_message_stage_mode(&json!({
                "stopMessageState": {
                    "stopMessageStageMode": " OFF "
                }
            }))
            .as_deref(),
            Some("off")
        );
        assert_eq!(
            read_runtime_stop_message_stage_mode(&json!({
                "serverToolLoopState": {
                    "flowId": "stop_message_flow"
                }
            })),
            None
        );
    }

    #[test]
    fn servertool_followup_flow_id_reads_loop_state_only() {
        assert_eq!(
            read_servertool_followup_flow_id(&json!({
                "serverToolLoopState": {
                    "flowId": " stop_message_flow "
                },
                "flowId": "wrong-root"
            })),
            "stop_message_flow"
        );
        assert_eq!(
            read_servertool_followup_flow_id(&json!({
                "serverToolLoopState": {
                    "flowId": " "
                }
            })),
            ""
        );
    }

    #[test]
    fn servertool_followup_flow_id_prefers_canonical_stopless_flow_id() {
        assert_eq!(
            read_servertool_followup_flow_id(&json!({
                "metadataCenterSnapshot": {
                    "runtimeControl": {
                        "stopless": {
                            "flowId": " stop_message_flow "
                        }
                    }
                },
                "serverToolLoopState": {
                    "flowId": "legacy_flow"
                }
            })),
            "stop_message_flow"
        );
    }

    #[test]
    fn bd_working_directory_uses_record_metadata_capture_then_runtime_order() {
        assert_eq!(
            resolve_bd_working_directory_for_record(&ServertoolRecordRuntimeMetadataInput {
                record: json!({ "workdir": " /repo/direct ", "cwd": "/repo/cwd" }),
                runtime_metadata: Some(json!({ "workdir": "/repo/runtime" })),
            })
            .as_deref(),
            Some("/repo/direct")
        );

        assert_eq!(
            resolve_bd_working_directory_for_record(&ServertoolRecordRuntimeMetadataInput {
                record: json!({
                    "metadata": {
                        "capturedContext": {
                            "__hub_capture": {
                                "context": { "workdir": " /repo/captured " }
                            }
                        }
                    }
                }),
                runtime_metadata: Some(json!({ "workdir": "/repo/runtime" })),
            })
            .as_deref(),
            Some("/repo/captured")
        );

        assert_eq!(
            resolve_bd_working_directory_for_record(&ServertoolRecordRuntimeMetadataInput {
                record: json!({}),
                runtime_metadata: Some(json!({
                    "__hub_capture": {
                        "context": { "workingDirectory": " /repo/runtime-capture " }
                    }
                })),
            })
            .as_deref(),
            Some("/repo/runtime-capture")
        );
    }

    #[test]
    fn followup_provider_key_uses_record_then_metadata_then_runtime() {
        assert_eq!(
            resolve_stop_message_followup_provider_key(&ServertoolRecordRuntimeMetadataInput {
                record: json!({
                    "providerKey": " direct.key ",
                    "metadata": { "providerKey": "metadata.key" }
                }),
                runtime_metadata: Some(json!({ "providerKey": "runtime.key" })),
            }),
            "direct.key"
        );

        assert_eq!(
            resolve_stop_message_followup_provider_key(&ServertoolRecordRuntimeMetadataInput {
                record: json!({
                    "metadata": {
                        "target": { "providerId": " target.provider " }
                    }
                }),
                runtime_metadata: Some(json!({ "providerKey": "runtime.key" })),
            }),
            "target.provider"
        );

        assert_eq!(
            resolve_stop_message_followup_provider_key(&ServertoolRecordRuntimeMetadataInput {
                record: json!({}),
                runtime_metadata: Some(json!({ "targetProviderKey": " runtime.target " })),
            }),
            "runtime.target"
        );
    }

    #[test]
    fn runtime_context_helpers_match_ts_contracts() {
        assert_eq!(
            resolve_client_connection_state(&json!({ "disconnected": true })),
            Some(json!({ "disconnected": true }))
        );
        assert_eq!(resolve_client_connection_state(&json!([])), None);
        assert!(has_compaction_flag(&json!({ "compactionRequest": true })));
        assert!(has_compaction_flag(
            &json!({ "compactionRequest": " true " })
        ));
        assert!(!has_compaction_flag(
            &json!({ "compactionRequest": "false" })
        ));
        assert!(!has_compaction_flag(&json!({})));
    }

    #[test]
    fn entry_endpoint_uses_record_then_metadata_then_default() {
        assert_eq!(
            resolve_entry_endpoint(&json!({
                "entryEndpoint": " /v1/responses ",
                "metadata": { "entryEndpoint": "/v1/messages" }
            })),
            "/v1/responses"
        );
        assert_eq!(
            resolve_entry_endpoint(&json!({
                "metadata": { "entryEndpoint": " /v1/messages " }
            })),
            "/v1/messages"
        );
        assert_eq!(resolve_entry_endpoint(&json!({})), "/v1/chat/completions");
    }

    #[test]
    fn followup_tool_content_max_chars_uses_env_then_model() {
        assert_eq!(
            resolve_stop_message_followup_tool_content_max_chars(
                &StopMessageFollowupToolContentMaxCharsInput {
                    env_value: Some(json!(" 32.9 ")),
                    provider_key: None,
                    model: Some("other".to_string()),
                }
            ),
            Some(64)
        );
        assert_eq!(
            resolve_stop_message_followup_tool_content_max_chars(
                &StopMessageFollowupToolContentMaxCharsInput {
                    env_value: Some(json!(" 2000.9 ")),
                    provider_key: None,
                    model: Some("kimi-k2.5".to_string()),
                }
            ),
            Some(2000)
        );
        assert_eq!(
            resolve_stop_message_followup_tool_content_max_chars(
                &StopMessageFollowupToolContentMaxCharsInput {
                    env_value: Some(json!("invalid")),
                    provider_key: None,
                    model: Some("kimi-k2.5".to_string()),
                }
            ),
            None
        );
        assert_eq!(
            resolve_stop_message_followup_tool_content_max_chars(
                &StopMessageFollowupToolContentMaxCharsInput {
                    env_value: None,
                    provider_key: None,
                    model: Some(" KIMI-K2.5-preview ".to_string()),
                }
            ),
            Some(1200)
        );
        assert_eq!(
            resolve_stop_message_followup_tool_content_max_chars(
                &StopMessageFollowupToolContentMaxCharsInput {
                    env_value: None,
                    provider_key: Some("demo.key".to_string()),
                    model: Some("other".to_string()),
                }
            ),
            None
        );
    }

    #[test]
    fn runtime_metadata_stop_state_wins_without_request_records() {
        let input = RuntimeStopMessageStateFromAdapterContextInput {
            runtime_metadata: Some(json!({
                "stopMessageState": {
                    "stopMessageText": " runtime text ",
                    "stopMessageStageMode": "on",
                    "stopMessageMaxRepeats": 4,
                    "stopMessageUsed": 1
                }
            })),
        };

        let snapshot = resolve_runtime_stop_message_state_from_adapter_context(&input)
            .expect("runtime snapshot");

        assert_eq!(snapshot.text, "runtime text");
        assert_eq!(snapshot.max_repeats, 4);
        assert_eq!(snapshot.used, 1);
        assert_ne!(snapshot.source.as_deref(), Some("client_exec_result"));
    }

    #[test]
    fn runtime_metadata_does_not_restore_stopless_state_from_context_payload() {
        let input = RuntimeStopMessageStateFromAdapterContextInput {
            runtime_metadata: Some(json!({
                "responsesRequestContext": {
                    "context": {
                        "input": [{
                            "type": "function_call_output",
                            "output": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"from responsesRequestContext\",\"repeatCount\":2,\"maxRepeats\":3}"
                        }]
                    }
                }
            })),
        };

        assert!(resolve_runtime_stop_message_state_from_adapter_context(&input).is_none());
    }

    #[test]
    fn runtime_control_stopless_is_the_only_context_state_source() {
        let input = RuntimeStopMessageStateFromAdapterContextInput {
            runtime_metadata: Some(json!({
                "metadataCenterSnapshot": {
                    "continuationContext": {
                        "responsesResume": {
                            "toolOutputsDetailed": [{
                                "outputText": "{\"toolName\":\"stop_message_auto\",\"flowId\":\"stop_message_flow\",\"continuationPrompt\":\"must not win\",\"repeatCount\":1,\"maxRepeats\":3}"
                            }]
                        }
                    },
                    "runtimeControl": {
                        "stopless": {
                            "active": true,
                            "flowId": "stop_message_flow",
                            "repeatCount": 2,
                            "maxRepeats": 3,
                            "triggerHint": "invalid_schema",
                            "continuationPrompt": "from metadata center runtime control",
                            "schemaFeedback": {
                                "reasonCode": "stop_schema_next_step_missing",
                                "missingFields": ["next_step"]
                            }
                        }
                    }
                }
            })),
        };

        let snapshot = resolve_runtime_stop_message_state_from_adapter_context(&input)
            .expect("runtime control stopless snapshot");
        assert_eq!(snapshot.text, "from metadata center runtime control");
        assert_eq!(snapshot.max_repeats, 3);
        assert_eq!(snapshot.used, 2);
        assert_eq!(snapshot.trigger_hint.as_deref(), Some("invalid_schema"));
        assert_eq!(
            snapshot.schema_feedback,
            Some(json!({
                "reasonCode": "stop_schema_next_step_missing",
                "missingFields": ["next_step"]
            }))
        );
        assert_eq!(snapshot.source.as_deref(), Some(STOP_MESSAGE_FOLLOWUP_SOURCE));
    }

    #[test]
    fn missing_runtime_metadata_ignores_stopless_command_seed() {
        let input = RuntimeStopMessageStateFromAdapterContextInput {
            runtime_metadata: None,
        };

        assert!(resolve_runtime_stop_message_state_from_adapter_context(&input).is_none());
    }

    #[test]
    fn missing_runtime_metadata_ignores_non_stopless_exec_output() {
        let input = RuntimeStopMessageStateFromAdapterContextInput {
            runtime_metadata: None,
        };

        assert!(resolve_runtime_stop_message_state_from_adapter_context(&input).is_none());
    }

    #[test]
    fn persist_stop_message_state_plan_keeps_empty_decision_in_rust() {
        let clear = plan_persist_stop_message_state(&PersistStopMessageStatePlanInput {
            state: json!({
                "allowedProviders": [],
                "disabledProviders": [],
                "disabledKeys": [],
                "disabledModels": [],
                "stopMessageText": " ",
                "stopMessageStageMode": " ",
                "preCommandScriptPath": " "
            }),
        })
        .expect("clear plan");
        assert_eq!(clear.action, "clear");

        let stop_state = plan_persist_stop_message_state(&PersistStopMessageStatePlanInput {
            state: json!({
                "allowedProviders": [],
                "disabledProviders": [],
                "disabledKeys": [],
                "disabledModels": [],
                "stopMessageMaxRepeats": 3
            }),
        })
        .expect("save stop state plan");
        assert_eq!(stop_state.action, "save");

        let non_stop_state = plan_persist_stop_message_state(&PersistStopMessageStatePlanInput {
            state: json!({
                "allowedProviders": ["provider.a"],
                "disabledProviders": [],
                "disabledKeys": [],
                "disabledModels": []
            }),
        })
        .expect("save non stop state plan");
        assert_eq!(non_stop_state.action, "save");

        let lifecycle_stamp = plan_persist_stop_message_state(&PersistStopMessageStatePlanInput {
            state: json!({
                "allowedProviders": [],
                "disabledProviders": [],
                "disabledKeys": [],
                "disabledModels": [],
                "stopMessageLastUsedAt": 0
            }),
        })
        .expect("save lifecycle stamp plan");
        assert_eq!(lifecycle_stamp.action, "save");
    }

    #[test]
    fn default_stop_message_snapshot_uses_rust_stop_eligibility_and_defaults() {
        let snapshot = resolve_default_stop_message_snapshot(&StopMessageDefaultSnapshotInput {
            base: json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": { "role": "assistant", "content": "done" }
                }]
            }),
            adapter_context: None,
            options: None,
        })
        .expect("default snapshot");

        assert_eq!(snapshot.text, STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT);
        assert_eq!(snapshot.max_repeats, 1);
        assert_eq!(snapshot.used, 0);
        assert_eq!(snapshot.source.as_deref(), Some("default"));
    }

    #[test]
    fn default_stop_message_snapshot_uses_custom_text_and_floored_repeats() {
        let snapshot = resolve_default_stop_message_snapshot(&StopMessageDefaultSnapshotInput {
            base: json!({
                "status": "completed",
                "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "done" }] }]
            }),
            adapter_context: None,
            options: Some(StopMessageDefaultSnapshotOptions {
                text: Some(json!(" custom continue ")),
                max_repeats: Some(json!(2.9)),
            }),
        })
        .expect("custom snapshot");

        assert_eq!(snapshot.text, "custom continue");
        assert_eq!(snapshot.max_repeats, 2);
        assert_eq!(snapshot.source.as_deref(), Some("default"));
    }

    #[test]
    fn default_stop_message_snapshot_respects_runtime_control_stop_gateway_context() {
        let snapshot = resolve_default_stop_message_snapshot(&StopMessageDefaultSnapshotInput {
            base: json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{ "id": "call_1" }]
                    }
                }]
            }),
            adapter_context: Some(json!({
                "runtimeControl": {
                    "stopGatewayContext": {
                        "observed": true,
                        "eligible": true,
                        "source": "chat",
                        "reason": "cached"
                    }
                }
            })),
            options: None,
        })
        .expect("metadata cached eligibility");

        assert_eq!(snapshot.source.as_deref(), Some("default"));
    }

    #[test]
    fn default_stop_message_snapshot_ignores_legacy_rt_stop_gateway_context() {
        let snapshot = resolve_default_stop_message_snapshot(&StopMessageDefaultSnapshotInput {
            base: json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{ "id": "call_1" }]
                    }
                }]
            }),
            adapter_context: Some(json!({
                "__rt": {
                    "stopGatewayContext": {
                        "observed": true,
                        "eligible": true,
                        "source": "chat",
                        "reason": "legacy"
                    }
                }
            })),
            options: None,
        });

        assert!(snapshot.is_none());
    }

    #[test]
    fn default_stop_message_snapshot_rejects_tool_call_response() {
        let snapshot = resolve_default_stop_message_snapshot(&StopMessageDefaultSnapshotInput {
            base: json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{ "id": "call_1" }]
                    }
                }]
            }),
            adapter_context: None,
            options: None,
        });

        assert!(snapshot.is_none());
    }

    #[test]
    fn implicit_gemini_snapshot_requires_responses_endpoint_and_empty_reply() {
        let snapshot = resolve_implicit_gemini_stop_message_snapshot(
            &StopMessageImplicitGeminiSnapshotInput {
                base: json!({
                    "status": "completed",
                    "output": []
                }),
                adapter_context: Some(json!({
                    "runtimeControl": {
                        "stopGatewayContext": {
                            "observed": true,
                            "eligible": true,
                            "source": "responses",
                            "reason": "status_completed"
                        }
                    }
                })),
                provider_protocol: Some(" GEMINI-CHAT ".to_string()),
                record: json!({
                    "entryEndpoint": "/v1/responses"
                }),
            },
        )
        .expect("implicit gemini snapshot");

        assert_eq!(snapshot.text, STOP_MESSAGE_FOLLOWUP_DEFAULT_TEXT);
        assert_eq!(snapshot.max_repeats, 1);
        assert_eq!(snapshot.used, 0);
        assert_eq!(snapshot.source.as_deref(), Some("auto"));
    }

    #[test]
    fn implicit_gemini_snapshot_rejects_non_gemini_or_non_responses() {
        assert!(resolve_implicit_gemini_stop_message_snapshot(
            &StopMessageImplicitGeminiSnapshotInput {
                base: json!({ "status": "completed", "output": [] }),
                adapter_context: Some(json!({
                    "runtimeControl": {
                        "stopGatewayContext": {
                            "observed": true,
                            "eligible": true,
                            "source": "responses",
                            "reason": "status_completed"
                        }
                    }
                })),
                provider_protocol: Some("openai-responses".to_string()),
                record: json!({ "entryEndpoint": "/v1/responses" }),
            }
        )
        .is_none());
        assert!(resolve_implicit_gemini_stop_message_snapshot(
            &StopMessageImplicitGeminiSnapshotInput {
                base: json!({ "status": "completed", "output": [] }),
                adapter_context: Some(json!({
                    "runtimeControl": {
                        "stopGatewayContext": {
                            "observed": true,
                            "eligible": true,
                            "source": "responses",
                            "reason": "status_completed"
                        }
                    }
                })),
                provider_protocol: Some("gemini-chat".to_string()),
                record: json!({ "entryEndpoint": "/v1/chat/completions" }),
            }
        )
        .is_none());
    }

    #[test]
    fn implicit_gemini_snapshot_rejects_non_empty_or_tool_like_output() {
        let base_input = StopMessageImplicitGeminiSnapshotInput {
            base: json!({
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "visible" }]
                }]
            }),
            adapter_context: Some(json!({
                "runtimeControl": {
                    "stopGatewayContext": {
                        "observed": true,
                        "eligible": true,
                        "source": "responses",
                        "reason": "status_completed"
                    }
                }
            })),
            provider_protocol: Some("gemini-chat".to_string()),
            record: json!({ "entryEndpoint": "/v1/responses" }),
        };
        assert!(resolve_implicit_gemini_stop_message_snapshot(&base_input).is_none());

        let tool_like = StopMessageImplicitGeminiSnapshotInput {
            base: json!({
                "status": "completed",
                "output": [{ "type": "function_call", "arguments": "{}" }]
            }),
            ..base_input
        };
        assert!(resolve_implicit_gemini_stop_message_snapshot(&tool_like).is_none());
    }
}
