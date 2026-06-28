//! Concurrency control — maxInFlight 并发容量管理
//!
//! 检查当前活跃 lease 数量是否超过 maxInFlight 上限。
//! 实际 lease 管理由 FileStateStore 执行；ConcurrencyController 只做检查。

use crate::store::FileStateStore;
use crate::types::{AcquireContext, GovernorError, TrafficPolicy};

pub struct ConcurrencyController;

impl ConcurrencyController {
    pub fn new() -> Self {
        Self
    }

    /// 检查并发容量是否可用
    ///
    /// 如果当前活跃 lease >= maxInFlight，返回 ConcurrencySaturated 错误。
    pub fn check_available(
        &self,
        ctx: &AcquireContext,
        config: &TrafficPolicy,
        store: &FileStateStore,
    ) -> Result<(), GovernorError> {
        let key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());
        let active = store.active_lease_count(&key);
        if active >= config.max_in_flight {
            return Err(GovernorError::ConcurrencySaturated {
                runtime_key: key,
                current: active,
                max: config.max_in_flight,
            });
        }
        Ok(())
    }

    /// 获取当前活跃 lease 数量
    pub fn active_count(&self, ctx: &AcquireContext) -> u32 {
        // 简化：实际应由 store 统计
        0
    }

    /// 获取指定 key 的活跃 lease 数量
    pub fn active_count_for_keys(&self, _keys: &[&str]) -> u32 {
        0
    }
}

fn compose_key(runtime_key: &str, scope_key: Option<&str>) -> String {
    match scope_key {
        Some(scope) if !scope.is_empty() => format!("{}::{}", scope, runtime_key),
        _ => runtime_key.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_key_without_scope() {
        assert_eq!(compose_key("openai", None), "openai");
        assert_eq!(compose_key("deepseek", Some("")), "deepseek");
    }

    #[test]
    fn compose_key_with_scope() {
        assert_eq!(
            compose_key("openai", Some("port:5555")),
            "port:5555::openai"
        );
    }

    #[test]
    fn check_available_when_no_state_is_ok() {
        let ctrl = ConcurrencyController::new();
        let ctx = AcquireContext::new("test", "req-1");
        let config = TrafficPolicy::default_multi();
        let store = FileStateStore::new("/tmp/traffic-test");
        assert!(ctrl.check_available(&ctx, &config, &store).is_ok());
    }
}
