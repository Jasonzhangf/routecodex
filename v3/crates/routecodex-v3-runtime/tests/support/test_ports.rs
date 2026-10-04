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
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};

/// Returns a loopback port that this test binary has not handed out before.
pub fn free_port() -> u16 {
    let mut allocated = allocated_ports()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut candidates = next_candidate;
    reserve_unique_port(&mut candidates, &mut allocated)
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
    TcpListener::bind("127.0.0.1:0")
        .expect("bind an ephemeral loopback port")
        .local_addr()
        .expect("read the bound loopback address")
        .port()
}

fn allocated_ports() -> &'static Mutex<HashSet<u16>> {
    static ALLOCATED_PORTS: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();
    ALLOCATED_PORTS.get_or_init(|| Mutex::new(HashSet::new()))
}
