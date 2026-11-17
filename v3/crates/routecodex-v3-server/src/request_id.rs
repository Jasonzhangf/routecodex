use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Version 2 keeps success counts (`totalCount`/`windowCount`) separate from the
/// monotonic allocation `sequence`. Only a confirmed successful response commits
/// counts; every request (including errors) consumes a sequence number.
pub(crate) const V3_REQUEST_ID_COUNTER_VERSION: u64 = 2;

#[derive(Debug, Default, Clone)]
pub(crate) struct V3RequestCounterState {
    pub(crate) total_count: u64,
    pub(crate) window_count: u64,
    pub(crate) window_key: String,
    pub(crate) updated_at: String,
    pub(crate) sequence: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct V3AllocatedRequestIdentity {
    pub(crate) request_id: String,
    pub(crate) pipeline_id: String,
    /// Success count this request will have once it commits, used for display.
    pub(crate) total_count: u64,
    /// Local-day success count this request will have once it commits.
    pub(crate) daily_count: u64,
    success_commit: Arc<AtomicBool>,
}

impl V3AllocatedRequestIdentity {
    /// Claims the single success commit for this request. Returns `true` only for
    /// the first caller, so provider retries, provider switches and continuation
    /// frames sharing one allocation cannot count twice.
    pub(crate) fn claim_success_commit(&self) -> bool {
        !self.success_commit.swap(true, Ordering::SeqCst)
    }
}

#[cfg(test)]
impl V3AllocatedRequestIdentity {
    /// Typed fixture for projection tests that never touch the counter file.
    pub(crate) fn for_test(
        request_id: &str,
        pipeline_id: &str,
        total_count: u64,
        daily_count: u64,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            pipeline_id: pipeline_id.to_string(),
            total_count,
            daily_count,
            success_commit: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Debug)]
pub(crate) struct V3RequestIdCounter {
    pub(crate) state_file: PathBuf,
    pub(crate) state: V3RequestCounterState,
    pub(crate) loaded: bool,
}

impl V3RequestIdCounter {
    pub(crate) fn new() -> Self {
        Self {
            state_file: resolve_v3_request_id_counter_file(),
            state: V3RequestCounterState::default(),
            loaded: false,
        }
    }

    pub(crate) fn next_request_identity(
        &mut self,
        entry: &str,
        provider: &str,
        model: &str,
    ) -> Result<V3AllocatedRequestIdentity, String> {
        let clock = v3_request_id_clock_now()?;
        self.ensure_loaded(&clock)?;
        self.roll_local_day(&clock);
        // Allocation alone never proves a successful response, so it only
        // advances the monotonic sequence that keeps request ids unique.
        self.state.sequence = self
            .state
            .sequence
            .checked_add(1)
            .ok_or_else(|| "V3 request id sequence counter overflowed".to_string())?;
        self.state.updated_at = clock.utc_iso.clone();
        self.persist()?;
        let total_count = self
            .state
            .total_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id total counter overflowed".to_string())?;
        let daily_count = self
            .state
            .window_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id daily counter overflowed".to_string())?;
        Ok(V3AllocatedRequestIdentity {
            request_id: format!(
                "{entry}-{provider}-{model}-{}-{}",
                clock.local_timestamp, self.state.sequence
            ),
            pipeline_id: format!("{entry}-pipeline-{}", self.state.sequence),
            total_count,
            daily_count,
            success_commit: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Commits one successful client response. Only this call advances
    /// `totalCount`/`windowCount`; error responses never reach it.
    pub(crate) fn commit_request_success(&mut self) -> Result<(), String> {
        let clock = v3_request_id_clock_now()?;
        self.ensure_loaded(&clock)?;
        self.roll_local_day(&clock);
        self.state.total_count = self
            .state
            .total_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id total counter overflowed".to_string())?;
        self.state.window_count = self
            .state
            .window_count
            .checked_add(1)
            .ok_or_else(|| "V3 request id daily counter overflowed".to_string())?;
        self.state.updated_at = clock.utc_iso.clone();
        self.persist()
    }

    fn roll_local_day(&mut self, clock: &V3RequestIdClock) {
        if self.state.window_key != clock.local_date_key {
            self.state.window_key = clock.local_date_key.clone();
            self.state.window_count = 0;
        }
    }

    fn ensure_loaded(&mut self, clock: &V3RequestIdClock) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        if !self.state_file.exists() {
            self.state = V3RequestCounterState {
                total_count: 0,
                window_count: 0,
                window_key: clock.local_date_key.clone(),
                updated_at: clock.utc_iso.clone(),
                sequence: 0,
            };
            self.loaded = true;
            return Ok(());
        }
        let mut file = fs::File::open(&self.state_file).map_err(|error| {
            format!(
                "failed to read V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|error| {
            format!(
                "failed to read V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "failed to parse V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })?;
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version != 1 && version != V3_REQUEST_ID_COUNTER_VERSION {
            return Err(format!(
                "unsupported V3 request id counter version {version} in {}",
                self.state_file.display()
            ));
        }
        let total_count = value
            .get("totalCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing totalCount",
                    self.state_file.display()
                )
            })?;
        let window_count = value
            .get("windowCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing windowCount",
                    self.state_file.display()
                )
            })?;
        let window_key = value
            .get("windowKey")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "V3 request id counter {} is missing windowKey",
                    self.state_file.display()
                )
            })?
            .to_string();
        let updated_at = value
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // A version 1 file stored only success counts. Its counts stay the
        // historical baseline, and the sequence starts at the larger one so a
        // migrated counter can never re-issue an already published request id.
        let sequence = value
            .get("sequence")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| total_count.max(window_count));
        self.state = V3RequestCounterState {
            total_count,
            window_count,
            window_key,
            updated_at,
            sequence,
        };
        self.loaded = true;
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.state_file.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create V3 request id counter directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let body = json!({
            "version": V3_REQUEST_ID_COUNTER_VERSION,
            "totalCount": self.state.total_count,
            "windowCount": self.state.window_count,
            "windowKey": self.state.window_key,
            "sequence": self.state.sequence,
            "updatedAt": self.state.updated_at,
        });
        let tmp = self
            .state_file
            .with_extension(format!("json.tmp.{}", std::process::id()));
        let encoded = serde_json::to_vec_pretty(&body)
            .map_err(|error| format!("failed to serialize V3 request id counter: {error}"))?;
        fs::write(&tmp, encoded).map_err(|error| {
            format!(
                "failed to write V3 request id counter temp file {}: {error}",
                tmp.display()
            )
        })?;
        fs::rename(&tmp, &self.state_file).map_err(|error| {
            format!(
                "failed to publish V3 request id counter {}: {error}",
                self.state_file.display()
            )
        })
    }
}

#[derive(Debug)]
pub(crate) struct V3RequestIdClock {
    pub(crate) local_timestamp: String,
    pub(crate) local_date_key: String,
    pub(crate) utc_iso: String,
}

fn resolve_v3_request_id_counter_file() -> PathBuf {
    if let Some(path) = non_empty_env_path("ROUTECODEX_REQUEST_ID_COUNTER_FILE")
        .or_else(|| non_empty_env_path("RCC_REQUEST_ID_COUNTER_FILE"))
    {
        return path;
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".rcc")
        .join("state")
        .join("request-id-counter.json")
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn v3_request_id_clock_now() -> Result<V3RequestIdClock, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("V3 request id clock moved backwards: {error}"))?;
    let epoch_ms = duration.as_millis();
    let seconds = (epoch_ms / 1000) as libc::time_t;
    let millis = (epoch_ms % 1000) as u32;
    let local = format_v3_tm(seconds, true)?;
    let utc = format_v3_tm(seconds, false)?;
    Ok(V3RequestIdClock {
        local_timestamp: format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}{:03}",
            local.year, local.month, local.day, local.hour, local.minute, local.second, millis
        ),
        local_date_key: format!("{:04}{:02}{:02}", local.year, local.month, local.day),
        utc_iso: format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second, millis
        ),
    })
}

#[derive(Debug)]
pub(crate) struct V3RequestIdTm {
    pub(crate) year: i32,
    pub(crate) month: i32,
    pub(crate) day: i32,
    pub(crate) hour: i32,
    pub(crate) minute: i32,
    pub(crate) second: i32,
}

pub(crate) fn format_v3_tm(seconds: libc::time_t, local: bool) -> Result<V3RequestIdTm, String> {
    let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
    let result = unsafe {
        if local {
            libc::localtime_r(&seconds, raw.as_mut_ptr())
        } else {
            libc::gmtime_r(&seconds, raw.as_mut_ptr())
        }
    };
    if result.is_null() {
        return Err("failed to format V3 request id timestamp".to_string());
    }
    let tm = unsafe { raw.assume_init() };
    Ok(V3RequestIdTm {
        year: tm.tm_year + 1900,
        month: tm.tm_mon + 1,
        day: tm.tm_mday,
        hour: tm.tm_hour,
        minute: tm.tm_min,
        second: tm.tm_sec,
    })
}
