//! Read-only RPM observations.
//!
//! The atomic admission owner in `FileStateStore` performs RPM enforcement.

use crate::store::{compose_key, now_ms, FileStateStore};
use crate::types::{AcquireContext, TrafficPolicy};

pub struct RpmController;

impl RpmController {
    pub fn new() -> Self {
        Self
    }

    pub fn window_count(
        &self,
        ctx: &AcquireContext,
        config: &TrafficPolicy,
        store: &FileStateStore,
    ) -> u32 {
        let key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());
        let now = now_ms();
        let window_start = now.saturating_sub(config.rpm_window_ms);
        store.rpm_event_count(&key, window_start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_window_count_is_zero() {
        let ctrl = RpmController::new();
        let ctx = AcquireContext::new("test", "req-1");
        let config = TrafficPolicy::default_multi();
        let store = FileStateStore::new("/tmp/traffic-test");
        assert_eq!(ctrl.window_count(&ctx, &config, &store), 0);
    }
}
