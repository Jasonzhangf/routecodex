//! Process-wide unique loopback port allocation for integration tests.
//!
//! `TcpListener::bind("127.0.0.1:0")` only reports a port that was free at that
//! instant; the listener is dropped before the test's server binds it again, so
//! two callers can be handed the same port. Linux CI reddened on exactly that:
//! `Validation("enabled servers share listen address 127.0.0.1:42905")` and
//! `Address already in use (os error 98)`. Reserving every handed-out port for
//! the lifetime of the test binary removes the race.
//!
//! Included by several integration test binaries, so each one only uses part of
//! this module.

#![allow(dead_code)]

use std::collections::HashSet;
use std::fs::TryLockError;
use std::fs::{File, OpenOptions};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Mutex, OnceLock,
};

const TEST_PORT_POOL_START: u16 = 20_000;
const TEST_PORT_POOL_SIZE: u16 = 10_000;

/// Returns a loopback port reserved across test processes until this process exits.
pub fn free_port() -> u16 {
    let mut allocated = allocated_ports()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let allocated = &mut *allocated;
    loop {
        let port = next_candidate();
        if allocated.ports.contains(&port) {
            continue;
        }
        let Some(lock) = try_lock_port(port) else {
            continue;
        };
        if TcpListener::bind(("127.0.0.1", port)).is_err() {
            continue;
        }
        allocated.ports.insert(port);
        allocated.locks.push(lock);
        return port;
    }
}

/// Draws candidate ports until one is not already present in `allocated`.
pub fn reserve_unique_port(
    candidates: &mut dyn FnMut() -> u16,
    allocated: &mut HashSet<u16>,
) -> u16 {
    loop {
        let port = candidates();
        if allocated.insert(port) {
            return port;
        }
    }
}

fn next_candidate() -> u16 {
    static NEXT_OFFSET: OnceLock<AtomicU16> = OnceLock::new();
    let offset = NEXT_OFFSET
        .get_or_init(|| AtomicU16::new((std::process::id() as u16) % TEST_PORT_POOL_SIZE))
        .fetch_add(1, Ordering::Relaxed)
        % TEST_PORT_POOL_SIZE;
    TEST_PORT_POOL_START + offset
}

fn try_lock_port(port: u16) -> Option<File> {
    let lock_dir = std::env::temp_dir().join("routecodex-v3-test-port-locks");
    std::fs::create_dir_all(&lock_dir).expect("create loopback port lock directory");
    let path = lock_dir.join(format!("{port}.lock"));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .expect("open loopback port lock");
    match file.try_lock() {
        Ok(()) => Some(file),
        Err(TryLockError::WouldBlock) => None,
        Err(TryLockError::Error(error)) => panic!("lock loopback port {port}: {error}"),
    }
}

struct AllocatedPorts {
    ports: HashSet<u16>,
    locks: Vec<File>,
}

fn allocated_ports() -> &'static Mutex<AllocatedPorts> {
    static ALLOCATED_PORTS: OnceLock<Mutex<AllocatedPorts>> = OnceLock::new();
    ALLOCATED_PORTS.get_or_init(|| {
        Mutex::new(AllocatedPorts {
            ports: HashSet::new(),
            locks: Vec::new(),
        })
    })
}
