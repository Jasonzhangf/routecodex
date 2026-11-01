//! Listener accept-loop failure ownership.
//!
//! A listener's accept loop is the boundary that owns accept errors. The loop
//! keeps its port across a transient failure and records what happened, so the
//! failure is observable instead of being lost. Binding and accept share one
//! EINTR predicate, which the crate root also uses for listener bind retry.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::{v3_io_error_is_eintr, V3FrontTransportBroker};

/// Bounded pause after an accept() failure.
///
/// A descriptor-exhaustion errno (EMFILE/ENFILE) only clears when descriptors
/// are released, so retrying without a pause would spin the listener task and
/// starve the runtime. Every other accept errno is a single-connection race.
const V3_LISTENER_ACCEPT_ERROR_PAUSE: Duration = Duration::from_millis(50);

/// Record of one listener's accept failures.
///
/// The accept task owns this record: it counts accept failures and keeps the
/// last reason, so a listener that keeps failing to accept is observable.
#[derive(Debug)]
pub(crate) struct V3ListenerAcceptState {
    accept_failures: AtomicU64,
    last_accept_error: Mutex<Option<String>>,
}

impl V3ListenerAcceptState {
    pub(crate) fn new() -> Self {
        Self {
            accept_failures: AtomicU64::new(0),
            last_accept_error: Mutex::new(None),
        }
    }

    pub(crate) fn accept_failures(&self) -> u64 {
        self.accept_failures.load(Ordering::Acquire)
    }

    pub(crate) fn last_accept_error(&self) -> Option<String> {
        self.last_accept_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn record_accept_failure(&self, error: &io::Error) {
        self.accept_failures.fetch_add(1, Ordering::AcqRel);
        let reason = error.to_string();
        eprintln!(
            "V3 listener accept failed: {reason}; keeping the port accepting (bounded pause before retry)"
        );
        let mut last = self
            .last_accept_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *last = Some(reason);
    }
}

/// Serve one listener's front HTTP port until its shutdown signal arrives.
///
/// An accept failure ends only the affected accept. Terminating the loop would
/// leave the port bound but dead while the process still reports a running
/// listener, so the failure is recorded and the port keeps accepting.
pub(crate) async fn run_v3_listener_accept_loop(
    listener: TcpListener,
    app_for_serve: Router,
    shutdown_rx: oneshot::Receiver<()>,
    connection_broker: V3FrontTransportBroker,
    accept_state: Arc<V3ListenerAcceptState>,
) {
    let mut shutdown_rx = shutdown_rx;
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            accepted = listener.accept() => {
                let (stream, remote_addr) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        // EMFILE/ENFILE clear once descriptors are released and
                        // ECONNABORTED is a single-connection race.
                        accept_state.record_accept_failure(&error);
                        if !v3_io_error_is_eintr(&error) {
                            // Spin-free retry: descriptor exhaustion only clears
                            // when other tasks release descriptors.
                            tokio::time::sleep(V3_LISTENER_ACCEPT_ERROR_PAUSE).await;
                        }
                        continue;
                    }
                };
                let connection_identity = connection_broker.allocate_connection_identity();
                let service = app_for_serve.clone().into_service();
                let request_connection_broker = connection_broker.clone();
                tokio::spawn(async move {
                    if let Err(error) = crate::serve_v3_front_http_connection(
                        stream,
                        remote_addr,
                        connection_identity,
                        request_connection_broker,
                        service,
                    ).await {
                        eprintln!("V3 Front HTTP connection failed: {error:?}");
                    }
                });
            }
        }
    }
}
