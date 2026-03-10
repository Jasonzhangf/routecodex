use super::*;
use serde_json::json;
use std::sync::{Mutex, MutexGuard, OnceLock};

static SIGNATURE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn signature_cache_test_guard() -> MutexGuard<'static, ()> {
    SIGNATURE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("signature cache test lock poisoned")
}

mod core;
mod req_profiles;
mod resp_profiles;
