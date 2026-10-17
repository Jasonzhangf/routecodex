//! Aggregate custody of the Runtime probe task and reversible maintenance.
use super::*;
use tokio::sync::{mpsc, watch};

async fn wait_for_terminal(receiver: &mut watch::Receiver<bool>) {
    // Drop the watch read guard before returning to a select arm that may await.
    let _ = receiver.wait_for(|value| *value).await;
}

struct Quiesce {
    maintenance: V3ServerMaintenanceGuard,
    joined: oneshot::Sender<Result<(), String>>,
    rollback: oneshot::Receiver<()>,
}

#[derive(Debug)]
pub(crate) struct AggregateProbeLifecycle {
    commands: mpsc::UnboundedSender<Quiesce>,
    terminal: watch::Sender<bool>,
    terminal_state: Arc<std::sync::Mutex<bool>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// Closing this sender requests rollback. It stays armed through native exec:
/// a successful exec cannot return; every returned error drops the guard.
#[derive(Debug)]
pub(crate) struct ProbeQuiescenceGuard {
    _rollback: oneshot::Sender<()>,
}

impl AggregateProbeLifecycle {
    pub(crate) fn start(
        health: Vec<(Arc<V3Config05ManifestPublished>, Arc<V3ResponsesRelayProviderHealthHandle>)>,
    ) -> Result<Self, String> {
        let spawn_probes = move |resume: bool| -> Result<_, String> {
            let mut futures: Vec<Pin<Box<dyn Future<Output = ()> + Send>>> = Vec::new();
            let mut shutdowns = Vec::new();
            for (manifest, health) in &health {
                let runtime_health = health.runtime_health();
                let (shutdown, shutdown_rx) = oneshot::channel();
                let future: Pin<Box<dyn Future<Output = ()> + Send>> = if resume {
                    Box::pin(runtime_health.aggregate_provider_probe_lifecycle_resume(
                        Arc::clone(manifest), shutdown_rx,
                    )?)
                } else {
                    Box::pin(runtime_health.aggregate_provider_probe_lifecycle(
                        Arc::clone(manifest), shutdown_rx,
                    )?)
                };
                shutdowns.push(shutdown);
                futures.push(future);
            }
            Ok((tokio::spawn(async move {
                futures_util::future::join_all(futures).await;
            }), shutdowns))
        };
        let (probe, shutdown) = spawn_probes(false)?;
        let (commands, mut receiver) = mpsc::unbounded_channel::<Quiesce>();
        let (terminal, mut terminal_rx) = watch::channel(false);
        let terminal_state = Arc::new(std::sync::Mutex::new(false));
        let owner_terminal_state = Arc::clone(&terminal_state);
        let task = tokio::spawn(async move {
            let mut probe = probe;
            let mut shutdown = shutdown;
            loop {
                let command = tokio::select! {
                    biased;
                    _ = wait_for_terminal(&mut terminal_rx) => None,
                    command = receiver.recv() => command,
                    result = &mut probe => {
                        eprintln!("V3 aggregate probe owner stopped unexpectedly: {result:?}; scheduled recovery unavailable");
                        // Owner faults require explicit lifecycle recovery.
                        let command = tokio::select! {
                            biased;
                            _ = wait_for_terminal(&mut terminal_rx) => None,
                            command = receiver.recv() => command,
                        };
                        if let Some(command) = command {
                            let _ = command.joined.send(Err("aggregate probe owner stopped unexpectedly; maintenance retained".into()));
                            let _ = terminal_rx.wait_for(|value| *value).await;
                            drop(command.maintenance);
                        }
                        return;
                    }
                };
                // This task, rather than the preparation future, retains the
                // old JoinHandle across the cancellation and join boundary.
                probe.abort();
                let join_failure = (&mut probe)
                    .await
                    .err()
                    .filter(|error| !error.is_cancelled());
                if let Some(error) = &join_failure {
                    eprintln!("V3 aggregate probe join failed: {error}");
                }
                drop(shutdown);
                let Some(command) = command else { return };
                let Quiesce {
                    maintenance,
                    joined,
                    mut rollback,
                } = command;
                if let Some(error) = join_failure {
                    eprintln!("V3 aggregate probe maintenance retained after owner failure");
                    let _ = joined.send(Err(format!("aggregate probe join failed: {error}")));
                    let _ = terminal_rx.wait_for(|value| *value).await;
                    drop(maintenance);
                    return;
                }
                let _ = joined.send(Ok(()));
                tokio::select! {
                    biased;
                    _ = wait_for_terminal(&mut terminal_rx) => return,
                    _ = &mut rollback => {}
                }
                // Serialize terminal intent with registration, including calls
                // from another executor thread. No late guard may restore an
                // owner after terminal shutdown has acquired this boundary.
                let registration = {
                    let terminal = owner_terminal_state
                        .lock()
                        .expect("aggregate probe terminal lock");
                    if *terminal {
                        None
                    } else {
                        Some(spawn_probes(true))
                    }
                };
                let (next_probe, next_shutdown) = match registration {
                    None => return,
                    Some(Ok(tasks)) => tasks,
                    Some(Err(error)) => {
                        eprintln!("V3 aggregate probe restoration failed: {error}; maintenance retained, ordinary admission unavailable");
                        let _ = terminal_rx.wait_for(|value| *value).await;
                        drop(maintenance);
                        return;
                    }
                };
                probe = next_probe;
                shutdown = next_shutdown;
                // Runtime registration is synchronous and old ownership joined.
                // Only now may ordinary business admission resume.
                drop(maintenance);
            }
        });
        Ok(Self {
            commands,
            terminal,
            terminal_state,
            task: Some(task),
        })
    }

    pub(crate) async fn quiesce(
        &self,
        maintenance: V3ServerMaintenanceGuard,
    ) -> Result<ProbeQuiescenceGuard, String> {
        let (rollback, rollback_rx) = oneshot::channel();
        let guard = ProbeQuiescenceGuard {
            _rollback: rollback,
        };
        let (joined, joined_rx) = oneshot::channel();
        self.commands
            .send(Quiesce {
                maintenance,
                joined,
                rollback: rollback_rx,
            })
            .map_err(|_| "aggregate probe lifecycle owner unavailable".to_string())?;
        // Guard ownership and maintenance custody precede the first stop await.
        joined_rx
            .await
            .map_err(|_| "aggregate probe quiescence owner stopped".to_string())??;
        Ok(guard)
    }

    pub(crate) fn terminate(&self) {
        *self
            .terminal_state
            .lock()
            .expect("aggregate probe terminal lock") = true;
        self.terminal.send_replace(true);
    }

    pub(crate) async fn join(&mut self) {
        self.terminate();
        if let Some(task) = self.task.take() {
            if let Err(error) = task.await {
                eprintln!("V3 aggregate probe supervisor failed: {error}");
            }
        }
    }
}

impl Drop for AggregateProbeLifecycle {
    fn drop(&mut self) {
        // The single aggregate supervisor owns terminal cleanup; never spawn
        // a per-preparation cleanup task or restore after aggregate disposal.
        self.terminate();
    }
}
