use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutingInstructionState {
    pub forced_target: Option<InstructionTarget>,
    pub sticky_target: Option<InstructionTarget>,
    pub prefer_target: Option<InstructionTarget>,
    pub allowed_providers: HashSet<String>,
    pub disabled_providers: HashSet<String>,
    pub disabled_keys: HashMap<String, HashSet<String>>,
    pub disabled_models: HashMap<String, HashSet<String>>,
    pub stop_message_state: StopMessageState,
    pub pre_command: PreCommandState,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct StopMessageState {
    pub stop_message_source: Option<String>,
    pub stop_message_text: Option<String>,
    pub stop_message_max_repeats: Option<i64>,
    pub stop_message_used: Option<i64>,
    pub stop_message_updated_at: Option<i64>,
    pub stop_message_last_used_at: Option<i64>,
    pub stop_message_stage_mode: Option<String>,
    pub stop_message_ai_mode: Option<String>,
    pub stop_message_ai_seed_prompt: Option<String>,
    pub stop_message_ai_history: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PreCommandState {
    pub pre_command_source: Option<String>,
    pub pre_command_script_path: Option<String>,
    pub pre_command_updated_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct InstructionTarget {
    pub provider: Option<String>,
    pub key_alias: Option<String>,
    pub key_index: Option<i64>,
    pub model: Option<String>,
    pub path_length: Option<i64>,
    pub process_mode: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RoutingInstruction {
    pub kind: String,
    pub target: Option<InstructionTarget>,
    pub provider: Option<String>,
    pub stop_message: Option<StopMessageInstruction>,
    pub pre_command: Option<PreCommandInstruction>,
}

#[derive(Debug, Clone)]
pub(crate) struct StopMessageInstruction {
    pub kind: String,
    pub text: Option<String>,
    pub max_repeats: Option<i64>,
    pub ai_mode: Option<String>,
    pub source: Option<String>,
    pub from_historical: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PreCommandInstruction {
    pub kind: String,
    pub script_path: Option<String>,
}

pub(crate) const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;
pub(crate) const DEFAULT_PRECOMMAND_SCRIPT: &str = "default.sh";
pub(crate) const DEFAULT_PRECOMMAND_SCRIPT_CONTENT: &str =
    "#!/usr/bin/env bash\n# RouteCodex default precommand hook (no-op).\n# You can edit this file to customize precommand behavior.\nexit 0\n";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopMessageInstructionParseOutput {
    pub kind: String,
    pub text: Option<String>,
    pub max_repeats: Option<i64>,
    pub ai_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopMessagePatchOutput {
    pub applied: bool,
    pub set: Map<String, Value>,
    pub unset: Vec<String>,
}
