//! Types for the Traffic Governor system.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Acquire context — 由调用者传入
// ---------------------------------------------------------------------------

/// 获取流量许可的上下文
pub struct AcquireContext {
    pub runtime_key: String,
    pub provider_key: Option<String>,
    pub request_id: String,
    pub scope_key: Option<String>,

    // 配置覆盖（来自 MetadataCenter runtime_control）
    pub max_in_flight: Option<usize>,
    pub acquire_timeout_ms: Option<u64>,
    pub stale_lease_ms: Option<u64>,
    pub requests_per_minute: Option<u32>,
    pub rpm_timeout_ms: Option<u64>,
}

impl AcquireContext {
    pub fn new(runtime_key: &str, request_id: &str) -> Self {
        Self {
            runtime_key: runtime_key.to_string(),
            provider_key: None,
            request_id: request_id.to_string(),
            scope_key: None,
            max_in_flight: None,
            acquire_timeout_ms: None,
            stale_lease_ms: None,
            requests_per_minute: None,
            rpm_timeout_ms: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Traffic Policy
// ---------------------------------------------------------------------------

/// 流量治理策略 — 由 MetadataCenter runtime_control 决定
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficPolicy {
    pub max_in_flight: usize,
    pub acquire_timeout_ms: u64,
    pub stale_lease_ms: u64,
    pub requests_per_minute: u32,
    pub rpm_timeout_ms: u64,
    pub rpm_window_ms: u64,
}

impl TrafficPolicy {
    pub fn default_single() -> Self {
        Self {
            max_in_flight: 1,
            acquire_timeout_ms: 60_000,
            stale_lease_ms: 300_000,
            requests_per_minute: 60,
            rpm_timeout_ms: 60_000,
            rpm_window_ms: 60_000,
        }
    }

    pub fn default_multi() -> Self {
        Self {
            max_in_flight: 2,
            acquire_timeout_ms: 60_000,
            stale_lease_ms: 300_000,
            requests_per_minute: 120,
            rpm_timeout_ms: 60_000,
            rpm_window_ms: 60_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Permit & AcquireResult
// ---------------------------------------------------------------------------

/// 流量许可凭证
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permit {
    pub runtime_key: String,
    pub provider_key: Option<String>,
    pub request_id: String,
    pub lease_id: String,
    pub state_key: String,
    pub scope_key: Option<String>,
    pub max_in_flight: usize,
    pub pid: u32,
    pub server_id: String,
    pub started_at: u64,
    pub expires_at: u64,
}

/// Acquire 操作的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcquireResult {
    pub permit: Permit,
    pub policy: TrafficPolicy,
    pub waited_ms: u64,
    pub active_in_flight: u32,
    pub rpm_in_window: u32,
}

/// Release 操作的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseResult {
    pub released: bool,
    pub active_in_flight: u32,
}

// ---------------------------------------------------------------------------
// Lease & RPM Event (持久化)
// ---------------------------------------------------------------------------

/// 并发租约 — 存储在文件中
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficLease {
    pub lease_id: String,
    pub request_id: String,
    pub pid: u32,
    pub server_id: String,
    pub started_at: u64,
    pub expires_at: u64,
}

/// RPM 事件记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpmEvent {
    pub request_id: String,
    pub started_at: u64,
}

/// 完整的流量状态（每个 runtimeKey 一个文件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficState {
    pub version: u32,
    pub updated_at: u64,
    pub leases: Vec<TrafficLease>,
    pub rpm_events: Vec<RpmEvent>,
}

impl TrafficState {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: 0,
            leases: Vec::new(),
            rpm_events: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Outcome Event (用于 adaptive)
// ---------------------------------------------------------------------------

/// Provider 调用结果事件
#[derive(Debug, Clone)]
pub struct OutcomeEvent {
    pub runtime_key: String,
    pub provider_key: Option<String>,
    pub request_id: Option<String>,
    pub success: bool,
    pub status_code: Option<u16>,
    pub error_code: Option<String>,
    pub upstream_code: Option<String>,
    pub reason: Option<String>,
    pub active_in_flight: Option<u32>,
    pub observed_at_ms: Option<u64>,
    pub configured_max_in_flight: Option<usize>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum GovernorError {
    /// 并发容量饱和
    ConcurrencySaturated {
        runtime_key: String,
        current: usize,
        max: usize,
    },
    /// RPM 超限
    RpmExceeded {
        runtime_key: String,
        current: u32,
        max: u32,
    },
    /// 超时
    Timeout { operation: String, timeout_ms: u64 },
    /// 文件 I/O 错误
    IoError(String),
    /// 序列化错误
    SerializationError(String),
    /// 无效的配置
    InvalidConfig(String),
}

impl std::fmt::Display for GovernorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GovernorError::ConcurrencySaturated {
                runtime_key,
                current,
                max,
            } => {
                write!(
                    f,
                    "concurrency saturated for {runtime_key}: {current}/{max}"
                )
            }
            GovernorError::RpmExceeded {
                runtime_key,
                current,
                max,
            } => {
                write!(f, "RPM exceeded for {runtime_key}: {current}/{max}")
            }
            GovernorError::Timeout {
                operation,
                timeout_ms,
            } => {
                write!(f, "{operation} timed out after {timeout_ms}ms")
            }
            GovernorError::IoError(msg) => write!(f, "I/O error: {msg}"),
            GovernorError::SerializationError(msg) => write!(f, "serialization error: {msg}"),
            GovernorError::InvalidConfig(msg) => write!(f, "invalid config: {msg}"),
        }
    }
}

impl std::error::Error for GovernorError {}

// ---------------------------------------------------------------------------
// Adaptive Concurrency State
// ---------------------------------------------------------------------------

/// 自适应并发状态（每个 runtime 一份）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptiveState {
    pub runtime_key: String,
    pub base_cap: u32,
    pub min_cap: u32,
    pub hard_max_cap: u32,
    pub current_cap: u32,
    pub tentative_cap: u32,
    pub safe_cap: u32,
    pub cooldown_until_ms: u64,
    pub saturated_no429_streak: u32,
    pub saturated429_streak: u32,
    pub tried_increase_caps: Vec<u32>,
    pub updated_at_ms: u64,
}

/// 自适应分钟桶
#[derive(Debug, Clone)]
pub struct AdaptiveMinuteBucket {
    pub minute: i64,
    pub requests: u32,
    pub http429: u32,
    pub peak_in_flight: u32,
}

/// 自适应持久化配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptivePersistedConfig {
    pub version: u32,
    pub updated_at: u64,
    pub runtimes: HashMap<String, AdaptiveState>,
}
