use crate::{
    ActiveKeyControlOwner, V3ActiveKeyControlCleanupFailure, ACTIVE_KEY_CONTROL_ACQUISITION_BUDGET,
};
use routecodex_v3_config::{V3ActiveKeyControlPaths, V3ActiveKeyControlWrite};
use serde::{Deserialize, Serialize};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::time::Instant;

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StorageBoundaryStage {
    DirectoriesPrepared,
}

#[cfg(test)]
pub(crate) type StorageBoundaryObserver = Box<dyn Fn(StorageBoundaryStage) + Send>;

#[cfg(test)]
thread_local! {
    static STORAGE_BOUNDARY_OBSERVER: std::cell::RefCell<Option<StorageBoundaryObserver>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_storage_boundary_observer(observer: Option<StorageBoundaryObserver>) {
    STORAGE_BOUNDARY_OBSERVER.with(|slot| *slot.borrow_mut() = observer);
}

#[cfg(test)]
pub(crate) fn take_storage_boundary_observer() -> Option<StorageBoundaryObserver> {
    STORAGE_BOUNDARY_OBSERVER.with(|slot| slot.borrow_mut().take())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ActiveKeyControlEndpointRecord {
    pub schema_version: u8,
    pub server_id: String,
    pub business_addr: SocketAddr,
    pub control_addr: SocketAddr,
    pub owner_pid: u32,
}

/// Exact record disposition carried by an adopted managed exec owner.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ActiveKeyControlExecHandoff {
    records: Vec<InheritedRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InheritedRecord {
    canonical_config: std::ffi::OsString,
    record: ActiveKeyControlEndpointRecord,
}

impl V3ActiveKeyControlExecHandoff {
    pub fn include_verified_custody(&mut self, other: Self) {
        for item in other.records {
            if !self.records.contains(&item) {
                self.records.push(item);
            }
        }
    }
    pub(crate) fn retain_unrepresented_owners(
        &self,
        owners: &mut Vec<ActiveKeyControlOwner>,
    ) -> io::Result<()> {
        for item in &self.records {
            let config = Path::new(&item.canonical_config);
            if owners.iter().any(|owner| {
                owner.record == item.record && owner.record_paths.canonical_config_path() == config
            }) {
                continue;
            }
            owners.push(ActiveKeyControlOwner {
                transport: None,
                record_paths: V3ActiveKeyControlPaths::from_canonical_config(
                    config,
                    &item.record.server_id,
                )?,
                record: item.record.clone(),
                record_pending: true,
                record_live: false,
            });
        }
        Ok(())
    }
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub(crate) fn capture(owners: &[ActiveKeyControlOwner]) -> Option<Self> {
        let records: Vec<_> = owners
            .iter()
            .filter(|owner| owner.record_pending)
            .map(|owner| InheritedRecord {
                canonical_config: owner.record_paths.canonical_config_path().into_os_string(),
                record: owner.record.clone(),
            })
            .collect();
        (!records.is_empty()).then_some(Self { records })
    }

    #[cfg(test)]
    fn into_pending_owners(self) -> io::Result<Vec<ActiveKeyControlOwner>> {
        self.validated_owners(true)
    }

    pub fn validate_managed_startup(&self) -> io::Result<()> {
        self.clone().validated_owners(false).map(|_| ())
    }

    fn validated_owners(self, record_pending: bool) -> io::Result<Vec<ActiveKeyControlOwner>> {
        let mut addresses = std::collections::BTreeSet::new();
        let mut records = Vec::with_capacity(self.records.len());
        for InheritedRecord {
            canonical_config,
            record,
        } in self.records
        {
            let config = std::path::PathBuf::from(canonical_config);
            let paths = V3ActiveKeyControlPaths::from_canonical_config(&config, &record.server_id)?;
            if record.schema_version != 1
                || record.server_id.is_empty()
                || !record.control_addr.ip().is_loopback()
                || record.owner_pid != std::process::id()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "inconsistent or duplicate active-key control handoff address",
                ));
            }
            if !addresses.insert((paths.canonical_config_path(), record.server_id.clone())) {
                if record_pending {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "ambiguous endpoint scope cannot create an independent cleanup owner",
                    ));
                }
                // The journal supplies all exact alternatives at the locked
                // comparison. Startup needs one address to dispatch that work.
                continue;
            }
            records.push((paths, record));
        }
        // Do not construct a cleanup owner until the entire handoff is validated.
        Ok(records
            .into_iter()
            .map(|(record_paths, record)| ActiveKeyControlOwner {
                transport: None,
                record_paths,
                record,
                record_pending,
                record_live: false,
            })
            .collect())
    }

    pub async fn retire_failed_startup(
        &mut self,
    ) -> io::Result<Vec<V3ActiveKeyControlCleanupFailure>> {
        self.retire_exact(std::process::id()).await
    }

    /// Lifecycle must verify the declaration and dead managed owner before calling.
    pub async fn retire_after_managed_exit(
        &mut self,
        verified_exited_pid: u32,
    ) -> io::Result<Vec<V3ActiveKeyControlCleanupFailure>> {
        if verified_exited_pid == std::process::id() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "managed recovery owner has not exited",
            ));
        }
        self.retire_exact(verified_exited_pid).await
    }

    async fn retire_exact(
        &mut self,
        pid: u32,
    ) -> io::Result<Vec<V3ActiveKeyControlCleanupFailure>> {
        let mut groups = std::collections::BTreeMap::<_, Vec<_>>::new();
        for inherited in &self.records {
            let record = &inherited.record;
            if record.schema_version != 1
                || record.server_id.is_empty()
                || !record.control_addr.ip().is_loopback()
                || record.owner_pid != pid
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "inconsistent active-key startup custody",
                ));
            }
            groups
                .entry((inherited.canonical_config.clone(), record.server_id.clone()))
                .or_default()
                .push(record.clone());
        }
        let scopes = groups
            .into_iter()
            .map(|((config, server_id), alternatives)| {
                let paths =
                    V3ActiveKeyControlPaths::from_canonical_config(Path::new(&config), &server_id)?;
                Ok((config, server_id, paths, alternatives))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let deadline = Instant::now() + ACTIVE_KEY_CONTROL_ACQUISITION_BUDGET;
        let mut failures = Vec::new();
        for (config, server_id, paths, alternatives) in scopes {
            let business_addr = alternatives[0].business_addr;
            let result = paths
                .with_write_until(deadline, move |transaction| {
                    Ok(retire_control_scope(transaction, &alternatives))
                })
                .await;
            let (resolved, outcome) = result.unwrap_or_else(|error| (false, Err(error)));
            if resolved {
                self.records.retain(|inherited| {
                    inherited.canonical_config != config || inherited.record.server_id != server_id
                });
            }
            if let Err(error) = outcome {
                failures.push(V3ActiveKeyControlCleanupFailure {
                    pending: !resolved,
                    server_id,
                    business_addr,
                    record_path: paths.record,
                    error,
                });
            }
        }
        Ok(failures)
    }
}

type PersistControlCustody = dyn Fn(&V3ActiveKeyControlExecHandoff) -> io::Result<()> + Send + Sync;

/// Write-ahead custody for managed startup. The caller retains the durable value
/// across early errors or cancellation. Only Server interprets endpoint records.
#[derive(Clone)]
pub struct V3ActiveKeyControlStartup {
    handoff: Arc<Mutex<V3ActiveKeyControlExecHandoff>>,
    persist: Arc<PersistControlCustody>,
}

impl V3ActiveKeyControlStartup {
    pub fn new(
        handoff: V3ActiveKeyControlExecHandoff,
        persist: impl Fn(&V3ActiveKeyControlExecHandoff) -> io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            handoff: Arc::new(Mutex::new(handoff)),
            persist: Arc::new(persist),
        }
    }

    pub fn snapshot(&self) -> V3ActiveKeyControlExecHandoff {
        self.handoff.lock().unwrap().clone()
    }

    pub(crate) fn inherited_owners(&self) -> io::Result<Vec<ActiveKeyControlOwner>> {
        self.snapshot().validated_owners(false)
    }

    fn alternatives(
        &self,
        paths: &V3ActiveKeyControlPaths,
        server_id: &str,
    ) -> Vec<ActiveKeyControlEndpointRecord> {
        let config = paths.canonical_config_path();
        self.handoff
            .lock()
            .unwrap()
            .records
            .iter()
            .filter(|item| item.canonical_config == config && item.record.server_id == server_id)
            .map(|item| item.record.clone())
            .collect()
    }

    fn write_ahead(
        &self,
        paths: &V3ActiveKeyControlPaths,
        record: &ActiveKeyControlEndpointRecord,
    ) -> io::Result<()> {
        let mut current = self.handoff.lock().unwrap();
        let mut next = current.clone();
        let intended = InheritedRecord {
            canonical_config: paths.canonical_config_path().into_os_string(),
            record: record.clone(),
        };
        if !next.records.contains(&intended) {
            next.records.push(intended);
        }
        self.persist(&mut current, next)
    }

    fn settle(
        &self,
        paths: &V3ActiveKeyControlPaths,
        server_id: &str,
        record: Option<&ActiveKeyControlEndpointRecord>,
    ) -> io::Result<()> {
        let config = paths.canonical_config_path().into_os_string();
        let mut current = self.handoff.lock().unwrap();
        let mut next = current.clone();
        next.records
            .retain(|item| item.canonical_config != config || item.record.server_id != server_id);
        if let Some(record) = record {
            next.records.push(InheritedRecord {
                canonical_config: config,
                record: record.clone(),
            });
        }
        self.persist(&mut current, next)
    }

    fn persist(
        &self,
        current: &mut V3ActiveKeyControlExecHandoff,
        next: V3ActiveKeyControlExecHandoff,
    ) -> io::Result<()> {
        if *current != next {
            (self.persist)(&next)?;
            *current = next;
        }
        Ok(())
    }
}

pub(crate) fn record_path(
    config_path: &Path,
    server_id: &str,
) -> io::Result<V3ActiveKeyControlPaths> {
    routecodex_v3_config::v3_active_key_control_paths(config_path, server_id)
}

pub(crate) fn control_bind_address(business: SocketAddr) -> Option<SocketAddr> {
    match business {
        SocketAddr::V4(addr) if addr.ip().is_loopback() => Some(business),
        SocketAddr::V6(addr) if addr.ip().is_loopback() => Some(business),
        SocketAddr::V4(addr) if addr.ip().is_unspecified() => Some(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            addr.port(),
        )),
        SocketAddr::V6(addr) if addr.ip().is_unspecified() => Some(SocketAddr::new(
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
            addr.port(),
        )),
        _ => None,
    }
}

pub(crate) fn companion_bind_address() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

pub(crate) fn make_record(
    server_id: &str,
    business_addr: SocketAddr,
    control_addr: SocketAddr,
) -> ActiveKeyControlEndpointRecord {
    ActiveKeyControlEndpointRecord {
        schema_version: 1,
        server_id: server_id.to_string(),
        business_addr,
        control_addr,
        owner_pid: std::process::id(),
    }
}

#[cfg(test)]
fn publish_record(
    paths: &V3ActiveKeyControlPaths,
    record: &ActiveKeyControlEndpointRecord,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
    paths.with_write(|transaction| transaction.publish(&bytes, || {}))
}

#[cfg(test)]
async fn publish_record_until(
    paths: V3ActiveKeyControlPaths,
    record: ActiveKeyControlEndpointRecord,
    deadline: Instant,
    inherited: Option<&mut ActiveKeyControlOwner>,
    observer: Option<StorageBoundaryObserver>,
) -> io::Result<ActiveKeyControlOwner> {
    publish_startup_record(paths, record, deadline, inherited, None, observer).await
}

pub(crate) async fn publish_startup_record(
    paths: V3ActiveKeyControlPaths,
    record: ActiveKeyControlEndpointRecord,
    deadline: Instant,
    mut inherited: Option<&mut ActiveKeyControlOwner>,
    startup: Option<&V3ActiveKeyControlStartup>,
    #[cfg(test)] observer: Option<StorageBoundaryObserver>,
) -> io::Result<ActiveKeyControlOwner> {
    let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
    let expected = match startup {
        Some(startup) => startup.alternatives(&paths, &record.server_id),
        None => inherited
            .as_ref()
            .map(|owner| owner.record.clone())
            .into_iter()
            .collect(),
    };
    let transaction_startup = startup.cloned();
    let owned_paths = paths.clone();
    let (inherited_resolved, published) = paths
        .with_write_until(deadline, move |transaction| {
            if transaction_startup.is_some() || !expected.is_empty() {
                let current = read_control_record(transaction)?;
                if let Some(current) = &current {
                    if !expected.contains(current) {
                        if let Some(startup) = &transaction_startup {
                            startup.settle(&owned_paths, &record.server_id, None)?;
                        }
                        return Ok((true, Err(io::Error::new(
                            io::ErrorKind::AlreadyExists,
                            "active-key control conflict: endpoint record has a different owner",
                        ))));
                    }
                }
                // Authority is checked under the same lock before recording
                // intent. Equality with the intended record grants no custody.
                if let Some(startup) = &transaction_startup {
                    startup.write_ahead(&owned_paths, &record)?;
                }
                if current.is_some() {
                    transaction.remove()?;
                }
            }
            let published = transaction.publish(&bytes, || {
                #[cfg(test)]
                if let Some(observer) = observer {
                    observer(StorageBoundaryStage::DirectoriesPrepared);
                }
            });
            if let Some(startup) = &transaction_startup {
                let disposition = match &published {
                    Ok(()) => Ok(Some(record.clone())),
                    Err(_) => read_control_record(transaction).map(|current| {
                        current.filter(|item| item == &record || expected.contains(item))
                    }),
                };
                if let Err(error) = disposition.and_then(|remaining| {
                    startup.settle(&owned_paths, &record.server_id, remaining.as_ref())
                }) {
                    eprintln!(
                        "V3 active-key control startup custody settlement failed for {}: {error}",
                        record.server_id
                    );
                }
            }
            // If startup is cancelled during the locked write, dropping this
            // result still closes the published record once the lock is released.
            Ok((
                true,
                published.map(|()| ActiveKeyControlOwner {
                    transport: None,
                    record_paths: owned_paths,
                    record,
                    record_pending: true,
                    record_live: true,
                }),
            ))
        })
        .await?;
    if inherited_resolved {
        if let Some(owner) = inherited.as_mut() {
            owner.record_pending = false;
        }
    }
    published
}

pub(crate) async fn retire_inherited_record_until(
    owner: &mut ActiveKeyControlOwner,
    deadline: Instant,
    startup: Option<&V3ActiveKeyControlStartup>,
) -> io::Result<()> {
    let expected = owner.record.clone();
    let paths = owner.record_paths.clone();
    let alternatives = match startup {
        Some(startup) => startup.alternatives(&paths, &expected.server_id),
        None => vec![expected.clone()],
    };
    let startup = startup.cloned();
    let (resolved, result) = owner
        .record_paths
        .with_write_until(deadline, move |transaction| {
            let (resolved, result) = retire_control_scope(transaction, &alternatives);
            if resolved {
                if let Some(startup) = startup {
                    startup.settle(&paths, &expected.server_id, None)?;
                }
            }
            Ok((resolved, result))
        })
        .await?;
    owner.record_pending = !resolved;
    result
}

// Once the exact leaf is gone or confirmed foreign, the predecessor no longer
// has disposition rights. A replacement publishes in the same locked scope.
fn retire_control_scope(
    transaction: &V3ActiveKeyControlWrite<'_>,
    alternatives: &[ActiveKeyControlEndpointRecord],
) -> (bool, io::Result<()>) {
    match read_control_record(transaction) {
        Ok(None) => (true, transaction.prune_empty()),
        Ok(Some(current)) if alternatives.contains(&current) => match transaction.remove() {
            Ok(()) => (true, transaction.prune_empty()),
            Err(error) => (false, Err(error)),
        },
        Ok(Some(_)) => (
            true,
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "active-key control conflict: inherited endpoint record differs",
            )),
        ),
        Err(error) => (false, Err(error)),
    }
}

fn read_control_record(
    transaction: &V3ActiveKeyControlWrite<'_>,
) -> io::Result<Option<ActiveKeyControlEndpointRecord>> {
    let bytes = match transaction.read() {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let record: ActiveKeyControlEndpointRecord =
        serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("active-key control conflict: malformed endpoint record: {error}"),
            )
        })?;
    if record.schema_version != 1
        || record.owner_pid == 0
        || record.server_id.is_empty()
        || !record.control_addr.ip().is_loopback()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "active-key control conflict: unknown endpoint record",
        ));
    }
    Ok(Some(record))
}

pub(crate) fn try_remove_owned_record(
    paths: &V3ActiveKeyControlPaths,
    expected: &ActiveKeyControlEndpointRecord,
) -> io::Result<bool> {
    paths.with_write(|transaction| remove_owned_record(transaction, expected))
}

pub(crate) async fn remove_owned_record_until(
    paths: &V3ActiveKeyControlPaths,
    expected: &ActiveKeyControlEndpointRecord,
    deadline: Instant,
) -> io::Result<bool> {
    let expected = expected.clone();
    paths
        .with_write_until(deadline, move |transaction| {
            remove_owned_record(transaction, &expected)
        })
        .await
}

fn remove_owned_record(
    transaction: &V3ActiveKeyControlWrite<'_>,
    expected: &ActiveKeyControlEndpointRecord,
) -> io::Result<bool> {
    let Some(current) = read_control_record(transaction)? else {
        transaction.prune_empty()?;
        return Ok(false);
    };
    if &current != expected {
        return Ok(false);
    }
    transaction.remove()?;
    transaction.prune_empty()?;
    Ok(true)
}

#[cfg(test)]
#[path = "active_key_control/exec_tests.rs"]
mod tests_active_key_exec;

#[cfg(test)]
mod tests {
    use super::*;

    // Included in the canonical Server library filter tests::active_key_.
    #[tokio::test]
    async fn active_key_storage_expiry_and_cancel_leave_no_waiter() {
        use std::time::Duration;

        let directory = std::env::temp_dir().join(format!(
            "active-key-storage-contention-{}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let config = directory.join("config.toml");
        std::fs::write(&config, "").unwrap();
        let existing_paths = record_path(&config, "existing").unwrap();
        let expired_paths = record_path(&config, "expired").unwrap();
        let record = make_record(
            "existing",
            "127.0.0.1:3220".parse().unwrap(),
            "127.0.0.1:3221".parse().unwrap(),
        );
        publish_record(&existing_paths, &record).unwrap();
        let existing_bytes = existing_paths.read().unwrap();
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join(".active-key-control.lock"))
            .unwrap();
        holder.try_lock().unwrap();

        let synchronous_read = existing_paths.read();
        let synchronous_write = expired_paths.with_write(|transaction| {
            transaction.publish(b"unexpected synchronous publication", || {})
        });
        let deadline = Instant::now() + Duration::from_millis(150);
        let (read, write) = tokio::join!(
            existing_paths.read_until(deadline),
            expired_paths.with_write_until(deadline, |transaction| {
                transaction.publish(b"unexpected expired publication", || {})
            }),
        );
        let cancelled = {
            let deletion = remove_owned_record_until(
                &existing_paths,
                &record,
                Instant::now() + Duration::from_secs(5),
            );
            tokio::pin!(deletion);
            tokio::select! {
                _ = &mut deletion => false,
                () = tokio::time::sleep(Duration::from_millis(60)) => true,
            }
        };
        drop(holder);

        let follow_up = existing_paths
            .read_until(Instant::now() + Duration::from_secs(1))
            .await;
        let removed = remove_owned_record_until(
            &existing_paths,
            &record,
            Instant::now() + Duration::from_secs(1),
        )
        .await;
        let expired_record = expired_paths.read();
        std::fs::remove_dir_all(&directory).unwrap();

        assert!(cancelled, "the deletion completed while the lock was held");
        assert_eq!(
            synchronous_read.unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            synchronous_write.unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(read.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(write.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(follow_up.unwrap(), existing_bytes, "cancelled deletion ran");
        assert!(
            removed.unwrap(),
            "a new operation must remove the owned record"
        );
        assert_eq!(expired_record.unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn write_failure_removes_partial_owned_record_and_empty_directories() {
        const CHILD: &str = "RCC_CONTROL_WRITE_FAILURE_CHILD";
        if let Some(directory) = std::env::var_os(CHILD) {
            let config = std::path::PathBuf::from(directory).join("config.toml");
            let paths = record_path(&config, "failed").unwrap();
            let survivor = record_path(&config, "survivor").unwrap();
            let survivor_record = make_record(
                "survivor",
                "127.0.0.1:3220".parse().unwrap(),
                "127.0.0.1:3221".parse().unwrap(),
            );
            publish_record(&survivor, &survivor_record).unwrap();
            let retained = survivor.read().unwrap();
            let (exec_paths, inherited) =
                tests_active_key_exec::prepare_failed_replacement(&config);
            unsafe {
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                let limit = libc::rlimit {
                    rlim_cur: 16,
                    rlim_max: 16,
                };
                assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            }
            let record = make_record(
                "failed",
                "127.0.0.1:3210".parse().unwrap(),
                "127.0.0.1:3211".parse().unwrap(),
            );
            let error = publish_record(&paths, &record).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(libc::EFBIG));
            assert_eq!(paths.read().unwrap_err().kind(), io::ErrorKind::NotFound);
            assert_eq!(
                std::fs::metadata(paths.record.parent().unwrap())
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::NotFound
            );
            assert_eq!(survivor.read().unwrap(), retained);
            tests_active_key_exec::check_failed_replacement(exec_paths, inherited);
            assert_eq!(survivor.read().unwrap(), retained);
            assert!(try_remove_owned_record(&survivor, &survivor_record).unwrap());
            assert_eq!(
                std::fs::metadata(&paths.root).unwrap_err().kind(),
                io::ErrorKind::NotFound
            );
            assert!(config.with_file_name(".active-key-control.lock").is_file());
            return;
        }
        let directory = std::env::temp_dir().join(format!(
            "active-control-write-failure-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("config.toml"), "").unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "active_key_control::tests::write_failure_removes_partial_owned_record_and_empty_directories", "--nocapture"])
            .env(CHILD, &directory).output().unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
    }

    #[test]
    fn address_mapping_preserves_loopback_and_matches_wildcard_family() {
        let specific: SocketAddr = "127.0.0.2:3210".parse().unwrap();
        assert_eq!(control_bind_address(specific), Some(specific));
        let ipv4: SocketAddr = "0.0.0.0:3210".parse().unwrap();
        assert_eq!(
            control_bind_address(ipv4),
            Some("127.0.0.1:3210".parse().unwrap())
        );
        let ipv6: SocketAddr = "[::]:3210".parse().unwrap();
        assert_eq!(
            control_bind_address(ipv6),
            Some("[::1]:3210".parse().unwrap())
        );
        let external: SocketAddr = "192.0.2.4:3210".parse().unwrap();
        assert_eq!(control_bind_address(external), None);
    }

    #[test]
    fn record_cleanup_removes_only_the_published_owner_endpoint() {
        let dir =
            std::env::temp_dir().join(format!("active-key-control-record-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        std::fs::write(&config, "").unwrap();
        let paths = record_path(&config, "listener").unwrap();
        let record = make_record(
            "listener",
            "127.0.0.1:3210".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap(),
        );
        publish_record(&paths, &record).unwrap();
        let other = make_record(
            "listener",
            record.business_addr,
            "127.0.0.1:3211".parse().unwrap(),
        );
        assert_eq!(
            publish_record(&paths, &other).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(!try_remove_owned_record(&paths, &other).unwrap());
        assert_eq!(
            serde_json::from_slice::<ActiveKeyControlEndpointRecord>(&paths.read().unwrap())
                .unwrap(),
            record
        );
        assert!(try_remove_owned_record(&paths, &record).unwrap());
        assert_eq!(paths.read().unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(
            std::fs::metadata(&paths.root).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(config.with_file_name(".active-key-control.lock").is_file());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
