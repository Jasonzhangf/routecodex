use chrono::{Datelike, Local, NaiveDate, TimeZone};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutingInstructionState {
    pub forced_target: Option<InstructionTarget>,
    pub prefer_target: Option<InstructionTarget>,
    pub allowed_providers: HashSet<String>,
    pub disabled_providers: HashSet<String>,
    pub disabled_keys: HashMap<String, HashSet<String>>,
    pub disabled_models: HashMap<String, HashSet<String>>,
    pub stop_message_state: StopMessageState,
    pub pre_command: PreCommandState,
    pub chat_process_last_total_tokens: Option<i64>,
    pub chat_process_last_input_tokens: Option<i64>,
    pub chat_process_last_message_count: Option<i64>,
    pub chat_process_last_updated_at: Option<i64>,
}

/// Global request counter — persisted independently of per-session routing state.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalRequestCounter {
    /// Lifetime total request count (never resets).
    pub total_requests: i64,
    /// Today's local-date request count (resets at local midnight).
    pub daily_requests: i64,
    /// Unix ms timestamp of the last request (used to detect day boundary).
    pub last_request_at_ms: i64,
    /// Local date string of the last request day, e.g. "2026-06-29" (YYYY-MM-DD, local time).
    pub last_request_day: Option<String>,
}

impl GlobalRequestCounter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the start-of-day Unix ms timestamp for the given local date string (YYYY-MM-DD).
    pub fn parse_day_start_ms(day: &str) -> Option<i64> {
        let parts: Vec<&str> = day.split('-').collect();
        if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
            return None;
        }
        let year: i32 = parts[0].parse().ok()?;
        let month: u32 = parts[1].parse().ok()?;
        let day: u32 = parts[2].parse().ok()?;
        let naive = NaiveDate::from_ymd_opt(year, month, day)?;
        let local_date = naive.and_hms_opt(0, 0, 0)?;
        let local_dt = Local.from_local_datetime(&local_date).single()?;
        Some(local_dt.timestamp_millis())
    }

    /// Returns the current local date string (YYYY-MM-DD) and start-of-day ms.
    pub fn current_local_day() -> (String, i64) {
        let now_local = Local::now();
        let day_str = format!(
            "{:04}-{:02}-{:02}",
            now_local.year(),
            now_local.month(),
            now_local.day()
        );
        let day_start_ms =
            GlobalRequestCounter::parse_day_start_ms(&day_str).unwrap_or_else(|| {
                let today = now_local.date_naive();
                Local
                    .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
                    .single()
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(0)
            });
        (day_str, day_start_ms)
    }

    /// Atomically update counter: if local day has rolled over, reset daily count.
    /// Returns the post-update (total, daily) pair.
    pub fn tick(&mut self, now_ms: i64) -> (i64, i64) {
        let (today_str, day_start_ms) = GlobalRequestCounter::current_local_day();
        let day_rolled = self
            .last_request_day
            .as_deref()
            .map(|prev| prev != today_str)
            .unwrap_or(true);
        if day_rolled {
            self.daily_requests = 0;
        }
        // Increment counters unconditionally; max(1) only protects against panic on overflow.
        self.total_requests = self.total_requests.saturating_add(1);
        self.daily_requests = self.daily_requests.saturating_add(1);
        // Guard: never report zero after a successful tick.
        if self.total_requests < 1 {
            self.total_requests = 1;
        }
        if self.daily_requests < 1 {
            self.daily_requests = 1;
        }
        self.last_request_at_ms = now_ms;
        self.last_request_day = Some(today_str);
        let _ = day_start_ms;
        (self.total_requests, self.daily_requests)
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct StopMessageState {
    pub stop_message_source: Option<String>,
    pub stop_message_provider_key: Option<String>,
    pub stop_message_text: Option<String>,
    pub stop_message_max_repeats: Option<i64>,
    pub stop_message_used: Option<i64>,
    pub stop_message_updated_at: Option<i64>,
    pub stop_message_last_used_at: Option<i64>,
    pub stop_message_stage_mode: Option<String>,
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
    pub stage_mode: Option<String>,
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
    pub stage_mode: Option<String>,
    pub ai_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopMessagePatchOutput {
    pub applied: bool,
    pub set: Map<String, Value>,
    pub unset: Vec<String>,
}
