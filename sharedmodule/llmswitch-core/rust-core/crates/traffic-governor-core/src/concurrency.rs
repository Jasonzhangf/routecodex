//! Read-only concurrency observations.
//!
//! Admission and lease creation are atomic operations owned by `FileStateStore`;
//! this module must not implement a second check-then-create admission path.

use crate::store::{compose_key, FileStateStore};
use crate::types::AcquireContext;

pub struct ConcurrencyController;

impl ConcurrencyController {
    pub fn new() -> Self {
        Self
    }

    pub fn active_count(&self, ctx: &AcquireContext, store: &FileStateStore) -> u32 {
        let key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());
        store.active_count_for_state_key(&key)
    }

    pub fn active_count_for_state_key(&self, state_key: &str, store: &FileStateStore) -> u32 {
        store.active_count_for_state_key(state_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_count_without_scope() {
        let ctrl = ConcurrencyController::new();
        let store = FileStateStore::new("/tmp/traffic-test");
        let ctx = AcquireContext::new("openai", "request:one");
        assert_eq!(compose_key("openai", None), "openai");
        assert_eq!(ctrl.active_count(&ctx, &store), 0);
    }

    #[test]
    fn active_count_with_scope() {
        let ctrl = ConcurrencyController::new();
        let store = FileStateStore::new("/tmp/traffic-test");
        let mut ctx = AcquireContext::new("openai", "request:one");
        ctx.scope_key = Some("port:5555".to_string());
        assert_eq!(
            compose_key("openai", Some("port:5555")),
            "port:5555::openai"
        );
        assert_eq!(ctrl.active_count(&ctx, &store), 0);
    }
}
