use std::ffi::{OsStr, OsString};
use std::fs::{File, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::Instant;

#[cfg(unix)]
#[path = "active_key_control_storage/unix.rs"]
mod native;
#[cfg(windows)]
#[path = "active_key_control_storage/windows.rs"]
mod native;

const NAMESPACE: &str = ".active-key-control";
const LOCK: &str = ".active-key-control.lock";
const RECORD: &str = "endpoint.json";

#[cfg(feature = "test-hooks")]
thread_local! {
    static FAIL_NEXT_RECORD_SYNC: std::cell::Cell<Option<Box<dyn FnOnce()>>> = const { std::cell::Cell::new(None) };
}

#[cfg(feature = "test-hooks")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V3ActiveKeyControlLockStage {
    ReadAcquire,
    WriteAcquire,
    ReadContended,
    WriteContended,
}

#[cfg(feature = "test-hooks")]
type LockObserver = std::sync::Arc<dyn Fn(&Path, V3ActiveKeyControlLockStage) + Send + Sync>;
#[cfg(feature = "test-hooks")]
static LOCK_OBSERVER: std::sync::Mutex<Option<LockObserver>> = std::sync::Mutex::new(None);

#[cfg(feature = "test-hooks")]
pub fn v3_test_only_set_active_key_control_lock_observer(observer: Option<LockObserver>) {
    *LOCK_OBSERVER.lock().unwrap() = observer;
}

#[cfg(feature = "test-hooks")]
fn observe_lock(path: &Path, stage: V3ActiveKeyControlLockStage) {
    let observer = LOCK_OBSERVER.lock().unwrap().clone();
    if let Some(observer) = observer {
        observer(path, stage);
    }
}

/// Canonical address of a listener's control record. Address resolution creates
/// nothing. The composed paths are for diagnostics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V3ActiveKeyControlPaths {
    pub root: PathBuf,
    pub record: PathBuf,
    parent: PathBuf,
    directories: Vec<OsString>,
}

impl V3ActiveKeyControlPaths {
    pub(crate) fn new(config_path: &Path, server_id: &str) -> io::Result<Self> {
        let config = std::fs::canonicalize(config_path)?;
        Self::from_canonical_config(&config, server_id)
    }

    /// Reconstruct an already resolved address even if the config file has gone.
    pub fn from_canonical_config(config: &Path, server_id: &str) -> io::Result<Self> {
        if !config.is_absolute()
            || config
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "control record requires a canonical config address",
            ));
        }
        let (Some(parent), Some(basename)) = (config.parent(), config.file_name()) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "canonical config has no basename or parent",
            ));
        };
        let mut directories = vec![NAMESPACE.into(), basename.into(), "listener".into()];
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for chunk in server_id.as_bytes().chunks(60) {
            let mut component = String::from("s-");
            for byte in chunk {
                component.push(HEX[(byte >> 4) as usize] as char);
                component.push(HEX[(byte & 0x0f) as usize] as char);
            }
            directories.push(component.into());
        }
        let root = parent.join(NAMESPACE);
        let mut record = parent.to_path_buf();
        record.extend(&directories);
        record.push(RECORD);
        Ok(Self {
            root,
            record,
            parent: parent.into(),
            directories,
        })
    }

    pub fn canonical_config_path(&self) -> PathBuf {
        self.parent.join(&self.directories[1])
    }

    /// Try once to read under the shared lock. A held lock returns WouldBlock.
    pub fn read(&self) -> io::Result<Vec<u8>> {
        let access = NamespaceAccess::open(&self.parent, false)?;
        self.try_once(&access, false)?;
        access.read(self)
    }

    /// Try once to take the exclusive lock, then run the synchronous operation.
    /// A held lock returns WouldBlock.
    /// The callback must not begin a nested storage transaction.
    pub fn with_write<T>(
        &self,
        operation: impl FnOnce(&V3ActiveKeyControlWrite<'_>) -> io::Result<T>,
    ) -> io::Result<T> {
        let access = NamespaceAccess::open(&self.parent, true)?;
        self.try_once(&access, true)?;
        operation(&V3ActiveKeyControlWrite {
            address: self,
            parent: &access.parent,
        })
    }

    /// Acquire the shared lock by `deadline` and await the complete read.
    pub async fn read_until(&self, deadline: Instant) -> io::Result<Vec<u8>> {
        let access = self.acquire_until(false, deadline).await?;
        let address = self.clone();
        tokio::task::spawn_blocking(move || access.read(&address))
            .await
            .map_err(io::Error::other)?
    }

    /// Acquire the exclusive lock by `deadline` and await the complete write.
    /// Once acquired, the transaction runs to completion even if the caller is cancelled.
    pub async fn with_write_until<T: Send + 'static>(
        &self,
        deadline: Instant,
        operation: impl FnOnce(&V3ActiveKeyControlWrite<'_>) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let access = self.acquire_until(true, deadline).await?;
        let address = self.clone();
        tokio::task::spawn_blocking(move || {
            // Move both handles into this job so the lock spans the whole operation.
            let access = access;
            operation(&V3ActiveKeyControlWrite {
                address: &address,
                parent: &access.parent,
            })
        })
        .await
        .map_err(io::Error::other)?
    }

    async fn acquire_until(&self, write: bool, deadline: Instant) -> io::Result<NamespaceAccess> {
        if Instant::now() >= deadline {
            return Err(acquisition_timeout());
        }
        let parent = self.parent.clone();
        let access = tokio::time::timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || NamespaceAccess::open(&parent, write)),
        )
        .await
        .map_err(|_| acquisition_timeout())?
        .map_err(io::Error::other)??;

        #[cfg(feature = "test-hooks")]
        self.observe_acquire(write);
        #[cfg(feature = "test-hooks")]
        let mut first_contention = true;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(acquisition_timeout());
            }
            match access.try_acquire(write) {
                Ok(()) => return Ok(access),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    #[cfg(feature = "test-hooks")]
                    if first_contention {
                        first_contention = false;
                        self.observe_contention(write);
                    }
                    tokio::time::sleep_until(deadline.min(now + Duration::from_millis(10))).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn try_once(&self, access: &NamespaceAccess, write: bool) -> io::Result<()> {
        #[cfg(feature = "test-hooks")]
        self.observe_acquire(write);
        let result = access.try_acquire(write);
        #[cfg(feature = "test-hooks")]
        if result
            .as_ref()
            .is_err_and(|error| error.kind() == io::ErrorKind::WouldBlock)
        {
            self.observe_contention(write);
        }
        result
    }

    #[cfg(feature = "test-hooks")]
    fn observe_acquire(&self, write: bool) {
        observe_lock(
            &self.record,
            if write {
                V3ActiveKeyControlLockStage::WriteAcquire
            } else {
                V3ActiveKeyControlLockStage::ReadAcquire
            },
        );
    }

    #[cfg(feature = "test-hooks")]
    fn observe_contention(&self, write: bool) {
        observe_lock(
            &self.record,
            if write {
                V3ActiveKeyControlLockStage::WriteContended
            } else {
                V3ActiveKeyControlLockStage::ReadContended
            },
        );
    }

    fn read_locked(&self, parent: &File) -> io::Result<Vec<u8>> {
        let directory = self.open_record_directory(parent)?;
        let mut file = native::open_file(&directory, OsStr::new(RECORD))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn open_record_directory(&self, parent: &File) -> io::Result<File> {
        let mut directory = None;
        for component in &self.directories {
            directory = Some(native::open_dir(
                directory.as_ref().unwrap_or(parent),
                component,
                false,
            )?);
        }
        Ok(directory.expect("a control address includes the namespace directory"))
    }
}

struct NamespaceAccess {
    parent: File,
    lock: File,
}

impl NamespaceAccess {
    fn open(path: &Path, write: bool) -> io::Result<Self> {
        let parent = native::open_parent(path)?;
        let lock = open_lock(&parent, write)?;
        Ok(Self { parent, lock })
    }

    fn read(&self, address: &V3ActiveKeyControlPaths) -> io::Result<Vec<u8>> {
        address.read_locked(&self.parent)
    }

    fn try_acquire(&self, write: bool) -> io::Result<()> {
        let result = if write {
            self.lock.try_lock()
        } else {
            self.lock.try_lock_shared()
        };
        match result {
            Ok(()) => Ok(()),
            Err(TryLockError::WouldBlock) => Err(io::ErrorKind::WouldBlock.into()),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

fn acquisition_timeout() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "active-key control namespace lock acquisition timed out",
    )
}

/// Byte-level operations for one address under its exclusive namespace lock.
pub struct V3ActiveKeyControlWrite<'a> {
    address: &'a V3ActiveKeyControlPaths,
    parent: &'a File,
}

impl V3ActiveKeyControlWrite<'_> {
    #[cfg(feature = "test-hooks")]
    pub fn test_fail_next_record_sync(before_rollback: impl FnOnce() + 'static) {
        FAIL_NEXT_RECORD_SYNC.set(Some(Box::new(before_rollback)));
    }

    pub fn read(&self) -> io::Result<Vec<u8>> {
        self.address.read_locked(self.parent)
    }

    /// Prepare the directory chain, then create a new record and sync it.
    /// Rollback attempts to remove the created leaf. An error can leave it present.
    pub fn publish(&self, bytes: &[u8], after_prepare: impl FnOnce()) -> io::Result<()> {
        let mut directories = Vec::new();
        let result = (|| {
            self.open_directories(&mut directories, true)?;
            after_prepare();
            let directory = directories.last().unwrap();
            let name = OsStr::new(RECORD);
            let mut file = native::create_file(directory, name)?;
            let written = file.write_all(bytes).and_then(|()| {
                #[cfg(feature = "test-hooks")]
                if let Some(before_rollback) = FAIL_NEXT_RECORD_SYNC.take() {
                    before_rollback();
                    return Err(io::Error::other("injected record sync failure"));
                }
                file.sync_all()
            });
            drop(file);
            if let Err(error) = written {
                return after_cleanup(
                    error,
                    native::remove_file(directory, name),
                    "remove incomplete owned control record",
                );
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(()),
            Err(error) => after_cleanup(
                error,
                self.prune_opened(directories),
                "prune owned control directories",
            ),
        }
    }

    pub fn remove(&self) -> io::Result<()> {
        let directory = self.address.open_record_directory(self.parent)?;
        native::remove_file(&directory, OsStr::new(RECORD))
    }

    pub fn prune_empty(&self) -> io::Result<()> {
        let mut directories = Vec::new();
        match self.open_directories(&mut directories, false) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.prune_opened(directories)
    }

    fn open_directories(&self, opened: &mut Vec<File>, create: bool) -> io::Result<()> {
        for component in &self.address.directories {
            opened.push(native::open_dir(
                opened.last().unwrap_or(self.parent),
                component,
                create,
            )?);
        }
        Ok(())
    }

    fn prune_opened(&self, mut opened: Vec<File>) -> io::Result<()> {
        while let Some(directory) = opened.pop() {
            drop(directory);
            let parent = opened.last().unwrap_or(self.parent);
            let component = &self.address.directories[opened.len()];
            match native::remove_dir(parent, component) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn open_lock(parent: &File, create: bool) -> io::Result<File> {
    let file = native::open_lock(parent, OsStr::new(LOCK), create)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "active-key control namespace lock is not a regular file",
        ));
    }
    Ok(file)
}

fn after_cleanup(error: io::Error, cleanup: io::Result<()>, action: &str) -> io::Result<()> {
    match cleanup {
        Ok(()) => Err(error),
        Err(cleanup) => Err(io::Error::other(format!("{error}; {action}: {cleanup}"))),
    }
}
