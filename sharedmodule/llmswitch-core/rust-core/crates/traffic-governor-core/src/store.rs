//! File-based state store — 跨进程状态持久化
//!
//! 将 lease 和 RPM event 持久化到文件系统，实现跨进程同步。
//! 状态文件路径: <store_root>/state/<runtimeKey>.json
//! 锁文件路径: <store_root>/locks/<runtimeKey>.lock

use crate::types::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 文件系统状态存储
///
/// 当前实现使用内存存储（Rust-native 测试阶段），后续接入文件 I/O。
pub struct FileStateStore {
    root: PathBuf,
    // 内存状态（过渡期使用）
    leases: Mutex<HashMap<String, Vec<TrafficLease>>>,
    rpm_events: Mutex<HashMap<String, Vec<RpmEvent>>>,
}

impl FileStateStore {
    pub fn new(root: &str) -> Self {
        Self {
            root: PathBuf::from(root),
            leases: Mutex::new(HashMap::new()),
            rpm_events: Mutex::new(HashMap::new()),
        }
    }

    /// 获取指定 runtimeKey 的活跃 lease 数
    pub fn active_lease_count(&self, key: &str) -> usize {
        let now = now_ms();
        let leases = self.leases.lock().unwrap();
        let mut count = 0;
        if let Some(entries) = leases.get(key) {
            for lease in entries {
                if lease.expires_at > now {
                    count += 1;
                }
            }
        }
        count
    }

    /// 获取指定 runtimeKey 在时间窗口内的 RPM event 数
    pub fn rpm_event_count(&self, key: &str, window_start: u64) -> u32 {
        let events = self.rpm_events.lock().unwrap();
        let mut count = 0u32;
        if let Some(entries) = events.get(key) {
            for event in entries {
                if event.started_at >= window_start {
                    count += 1;
                }
            }
        }
        count
    }

    /// 创建 lease — 记录到文件
    pub fn create_lease(
        &self,
        ctx: &AcquireContext,
        config: &TrafficPolicy,
    ) -> Result<Permit, GovernorError> {
        let now = now_ms();
        let lease_id = format!("lease-{}", uuid::Uuid::new_v4());
        let pid = std::process::id();
        let server_id = format!("pid-{}", pid);

        let lease = TrafficLease {
            lease_id: lease_id.clone(),
            request_id: ctx.request_id.clone(),
            pid,
            server_id: server_id.clone(),
            started_at: now,
            expires_at: now + config.acquire_timeout_ms,
        };

        let rpm_event = RpmEvent {
            request_id: ctx.request_id.clone(),
            started_at: now,
        };

        let key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());

        // 写入内存
        {
            let mut leases = self.leases.lock().unwrap();
            leases.entry(key.clone()).or_default().push(lease);
        }
        {
            let mut events = self.rpm_events.lock().unwrap();
            events.entry(key.clone()).or_default().push(rpm_event);
        }

        Ok(Permit {
            runtime_key: ctx.runtime_key.clone(),
            provider_key: ctx.provider_key.clone(),
            request_id: ctx.request_id.clone(),
            lease_id,
            state_key: key,
            scope_key: ctx.scope_key.clone(),
            max_in_flight: config.max_in_flight,
            pid,
            server_id,
            started_at: now,
            expires_at: now + config.acquire_timeout_ms,
        })
    }

    /// 释放 lease
    pub fn release_lease(&self, permit: &Permit) -> Result<bool, GovernorError> {
        let mut leases = self.leases.lock().unwrap();
        if let Some(entries) = leases.get_mut(&permit.state_key) {
            let before = entries.len();
            entries.retain(|l| l.lease_id != permit.lease_id);
            Ok(entries.len() < before)
        } else {
            Ok(false)
        }
    }
}

fn compose_key(runtime_key: &str, scope_key: Option<&str>) -> String {
    match scope_key {
        Some(scope) if !scope.is_empty() => format!("{}::{}", scope, runtime_key),
        _ => runtime_key.to_string(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx(runtime: &str, req: &str) -> AcquireContext {
        AcquireContext::new(runtime, req)
    }

    #[test]
    fn create_and_count_lease() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let ctx = make_ctx("openai", "req-1");
        let config = TrafficPolicy::default_multi();
        let permit = store.create_lease(&ctx, &config).unwrap();
        assert_eq!(store.active_lease_count("openai"), 1);
        assert_eq!(permit.runtime_key, "openai");
    }

    #[test]
    fn release_lease() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let ctx = make_ctx("openai", "req-1");
        let config = TrafficPolicy::default_multi();
        let permit = store.create_lease(&ctx, &config).unwrap();
        assert_eq!(store.active_lease_count("openai"), 1);
        store.release_lease(&permit).unwrap();
        assert_eq!(store.active_lease_count("openai"), 0);
    }

    #[test]
    fn multiple_leases_counted() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let policy = TrafficPolicy {
            max_in_flight: 5,
            ..TrafficPolicy::default_multi()
        };
        for i in 0..3 {
            let ctx = make_ctx("openai", &format!("req-{}", i));
            store.create_lease(&ctx, &policy).unwrap();
        }
        assert_eq!(store.active_lease_count("openai"), 3);
    }

    #[test]
    fn rpm_event_counted() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let ctx = make_ctx("openai", "req-1");
        let config = TrafficPolicy::default_multi();
        store.create_lease(&ctx, &config).unwrap();
        let count = store.rpm_event_count("openai", 0);
        assert_eq!(count, 1);
    }

    #[test]
    fn different_keys_isolated() {
        let store = FileStateStore::new("/tmp/traffic-test");
        store
            .create_lease(&make_ctx("openai", "r1"), &TrafficPolicy::default_multi())
            .unwrap();
        assert_eq!(store.active_lease_count("openai"), 1);
        assert_eq!(store.active_lease_count("deepseek"), 0);
    }
}
