//! Process-local fixture state. The lock outlives the home guard so restoration
//! and removal finish before another public test can start a listener.
use std::{ffi::OsString, path::PathBuf};
use tokio::sync::{Mutex, MutexGuard};

pub struct ServerTestLock(Mutex<()>);

impl ServerTestLock {
    pub const fn new() -> Self {
        Self(Mutex::const_new(()))
    }

    pub async fn lock(&self) -> (TestHomeGuard, MutexGuard<'_, ()>) {
        let lock = self.0.lock().await;
        (TestHomeGuard::new(), lock)
    }
}

pub struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "fa22072-boundary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(&self.path).unwrap();
        assert!(!self.path.exists(), "owned fixture home must be absent");
        eprintln!(
            "fixture-home-cleanup absent=true path={}",
            self.path.display()
        );
    }
}
