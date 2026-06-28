//! RPM (Requests Per Minute) controller
//!
//! 检查过去 rpm_window_ms 内的 RPM event 数量是否超过 requests_per_minute 上限。
//! 实际 RPM event 存储由 FileStateStore 执行；RpmController 只做检查。

use crate::store::FileStateStore;
use crate::types::{AcquireContext, GovernorError, TrafficPolicy};

pub struct RpmController;

impl RpmController {
    pub fn new() -> Self {
        Self
    }

    /// 检查 RPM 是否超限
    ///
    /// 如果过去 rpm_window_ms 内的 event 数 >= requests_per_minute，返回 RpmExceeded 错误。
    pub fn check_available(
        &self,
        ctx: &AcquireContext,
        config: &TrafficPolicy,
        store: &FileStateStore,
    ) -> Result<(), GovernorError> {
        let key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());
        let now = now_ms();
        let window_start = now.saturating_sub(config.rpm_window_ms);
        let count = store.rpm_event_count(&key, window_start);
        if count >= config.requests_per_minute {
            return Err(GovernorError::RpmExceeded {
                runtime_key: key,
                current: count,
                max: config.requests_per_minute,
            });
        }
        Ok(())
    }

    /// 获取当前 RPM 窗口内的事件数
    pub fn window_count(&self, _ctx: &AcquireContext) -> u32 {
        0
    }
}

fn compose_key(runtime_key: &str, scope_key: Option<&str>) -> String {
    match scope_key {
        Some(scope) if !scope.is_empty() => format!("{}::{}", scope, runtime_key),
        _ => runtime_key.to_string(),
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_rpm_no_state_is_ok() {
        let ctrl = RpmController::new();
        let ctx = AcquireContext::new("test", "req-1");
        let config = TrafficPolicy::default_multi();
        let store = FileStateStore::new("/tmp/traffic-test");
        assert!(ctrl.check_available(&ctx, &config, &store).is_ok());
    }
}
