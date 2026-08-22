use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub struct V3ProviderCancellation {
    inner: Arc<V3ProviderCancellationInner>,
}

#[derive(Default)]
struct V3ProviderCancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for V3ProviderCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("V3ProviderCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl V3ProviderCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        let notified = self.inner.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}
