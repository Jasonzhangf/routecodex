//! Adaptive Concurrency — 基于 429/saturation 模式的动态并发调整
//!
//! 根据过去 ADAPTIVE_WINDOW_MINUTES 分钟的 provider 调用结果，
//! 动态调整当前并发容量 (current_cap)：
//! - 连续非饱和 → 尝试增加容量
//! - 饱和 + 429 → 降低容量
//! - 饱和但无 429 → 维持

use crate::types::*;

const ADAPTIVE_WINDOW_MINUTES: i64 = 15;
const ADAPTIVE_STREAK_THRESHOLD: u32 = 5;
const ADAPTIVE_DEFAULT_HARD_MAX: u32 = 64;
const ADAPTIVE_DEFAULT_HARD_MULTIPLIER: u32 = 2;

pub struct AdaptiveController;

impl AdaptiveController {
    pub fn new() -> Self {
        Self
    }

    /// 观察 provider 调用结果
    pub fn observe(&self, _event: &OutcomeEvent) {
        // 后续实现：更新分钟桶 → 评估状态 → 调整 current_cap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_does_not_panic() {
        let ctrl = AdaptiveController::new();
        let event = OutcomeEvent {
            runtime_key: "openai".into(),
            provider_key: None,
            request_id: Some("req-1".into()),
            success: true,
            status_code: Some(200),
            error_code: None,
            upstream_code: None,
            reason: None,
            active_in_flight: Some(2),
            observed_at_ms: None,
            configured_max_in_flight: None,
        };
        ctrl.observe(&event);
    }
}
