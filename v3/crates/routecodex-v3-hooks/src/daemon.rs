use crate::*;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

pub const TIMER_TICK_INTERVAL_SECS: u64 = 1;

pub fn now_iso8601_utc() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    iso8601_utc_from_unix_seconds(seconds)
}

/// Runs one timer tick against the shared control state and reports the
/// per-schedule outcomes. The tick is intentionally a pure function over the
/// core so the control server can call it without owning a second scheduler.
pub fn timer_tick<T: AppServerTransport>(
    core: &mut HooksSidecarCore<T>,
    now_iso8601: &str,
) -> Vec<serde_json::Value> {
    core.run_due_schedules(now_iso8601)
        .into_iter()
        .map(|outcome| match outcome {
            Ok(outcome) => json!({ "ok": true, "outcome": outcome }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_round_trips_known_epoch_instants() {
        assert_eq!(iso8601_utc_from_unix_seconds(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso8601_utc_from_unix_seconds(1_752_624_000),
            "2025-07-16T00:00:00Z"
        );
    }
}
