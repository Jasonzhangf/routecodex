//! Aggregate custody of the Runtime probe tasks and reversible maintenance.
//!
//! One aggregate supervisor owns one recovery scheduler per business listener.
//! Each listener's scheduler is registered against its own provider-health
//! handle, so a probe from one port can never mutate another port's state.
use super::*;
use tokio::sync::{mpsc, watch};

/// One supervised recovery owner for one business listener.
struct ListenerProbeOwner {
    probe: tokio::task::JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ListenerProbeOwner {
    fn start(
        manifest: &Arc<V3Config05ManifestPublished>,
        health: &Arc<V3ResponsesRelayProviderHealthHandle>,
        resume: bool,
    ) -> Result<Self, String> {
        let runtime_health = health.runtime_health();
        let (shutdown, shutdown_rx) = oneshot::channel();
        let future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = if resume {
            Box::pin(
                runtime_health
                    .aggregate_provider_probe_lifecycle_resume(Arc::clone(manifest), shutdown_rx)?,
            )
        } else {
            Box::pin(
                runtime_health
                    .aggregate_provider_probe_lifecycle(Arc::clone(manifest), shutdown_rx)?,
            )
        };
        Ok(Self {
            probe: tokio::spawn(future),
            shutdown: Some(shutdown),
        })
    }

    /// Stop and join this port's owner. Returns an unexpected join fault so the
    /// supervisor retains maintenance instead of resuming half-closed admission.
    async fn stop(&mut self) -> Option<String> {
        self.probe.abort();
        let join_failure = (&mut self.probe)
            .await
            .err()
            .filter(|error| !error.is_cancelled())
            .map(|error| error.to_string());
        self.shutdown.take();
        join_failure
    }
}

struct ListenerProbeOwners {
    owners: Vec<ListenerProbeOwner>,
}

impl ListenerProbeOwners {
    fn start(
        manifest: &Arc<V3Config05ManifestPublished>,
        healths: &[Arc<V3ResponsesRelayProviderHealthHandle>],
        resume: bool,
    ) -> Result<Self, String> {
        let mut owners = Vec::with_capacity(healths.len());
        for health in healths {
            match ListenerProbeOwner::start(manifest, health, resume) {
                Ok(owner) => owners.push(owner),
                Err(error) => {
                    for owner in &owners {
                        owner.probe.abort();
                    }
                    return Err(error);
                }
            }
        }
        Ok(Self { owners })
    }

    async fn stop(&mut self) -> Option<String> {
        let mut fault = None;
        for owner in &mut self.owners {
            if let Some(error) = owner.stop().await {
                fault.get_or_insert(error);
            }
        }
        self.owners.clear();
        fault
    }
}

async fn wait_for_terminal(receiver: &mut watch::Receiver<bool>) {
    // Drop the watch read guard before returning to a select arm that may await.
    let _ = receiver.wait_for(|value| *value).await;
}

struct Quiesce {
    maintenance: V3ServerMaintenanceGuard,
    joined: oneshot::Sender<Result<(), String>>,
    rollback: oneshot::Receiver<()>,
}

enum SupervisorWake {
    Terminal,
    Command(Option<Quiesce>),
    Stopped { index: usize, error: String },
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
        manifest: Arc<V3Config05ManifestPublished>,
        healths: Vec<Arc<V3ResponsesRelayProviderHealthHandle>>,
    ) -> Result<Self, String> {
        let mut owners = ListenerProbeOwners::start(&manifest, &healths, false)?;
        let (commands, mut receiver) = mpsc::unbounded_channel::<Quiesce>();
        let (terminal, mut terminal_rx) = watch::channel(false);
        let terminal_state = Arc::new(std::sync::Mutex::new(false));
        let owner_terminal_state = Arc::clone(&terminal_state);
        let task = tokio::spawn(async move {
            loop {
                let wake = if owners.owners.is_empty() {
                    tokio::select! {
                        biased;
                        _ = wait_for_terminal(&mut terminal_rx) => SupervisorWake::Terminal,
                        command = receiver.recv() => SupervisorWake::Command(command),
                    }
                } else {
                    tokio::select! {
                        biased;
                        _ = wait_for_terminal(&mut terminal_rx) => SupervisorWake::Terminal,
                        command = receiver.recv() => SupervisorWake::Command(command),
                        (index, result) = async {
                            let futures = owners
                                .owners
                                .iter_mut()
                                .map(|owner| &mut owner.probe);
                            let (result, index, _) =
                                futures_util::future::select_all(futures).await;
                            (index, result)
                        } => SupervisorWake::Stopped {
                            index,
                            error: match result {
                                Ok(()) => "listener probe owner stopped".to_string(),
                                Err(error) => error.to_string(),
                            },
                        },
                    }
                };
                match wake {
                    SupervisorWake::Terminal => return,
                    SupervisorWake::Stopped { index, error } => {
                        eprintln!(
                            "V3 aggregate probe owner {index} stopped unexpectedly: {error}; scheduled recovery unavailable"
                        );
                        // Owner faults require explicit lifecycle recovery.
                        let command = tokio::select! {
                            biased;
                            _ = wait_for_terminal(&mut terminal_rx) => None,
                            command = receiver.recv() => command,
                        };
                        if let Some(command) = command {
                            let _ = command.joined.send(Err(
                                "aggregate probe owner stopped unexpectedly; maintenance retained"
                                    .into(),
                            ));
                            let _ = terminal_rx.wait_for(|value| *value).await;
                            drop(command.maintenance);
                        }
                        return;
                    }
                    SupervisorWake::Command(command) => {
                        // This task, rather than the preparation future, retains
                        // the old JoinHandles across the cancellation boundary.
                        let join_failure = owners.stop().await;
                        if let Some(error) = &join_failure {
                            eprintln!("V3 aggregate probe join failed: {error}");
                        }
                        let Some(command) = command else { return };
                        let Quiesce {
                            maintenance,
                            joined,
                            mut rollback,
                        } = command;
                        if let Some(error) = join_failure {
                            eprintln!(
                                "V3 aggregate probe maintenance retained after owner failure"
                            );
                            let _ =
                                joined.send(Err(format!("aggregate probe join failed: {error}")));
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
                        // Serialize terminal intent with registration, including
                        // calls from another executor thread. No late guard may
                        // restore an owner after terminal shutdown has acquired
                        // this boundary.
                        let registration = {
                            let terminal = owner_terminal_state
                                .lock()
                                .expect("aggregate probe terminal lock");
                            if *terminal {
                                None
                            } else {
                                Some(ListenerProbeOwners::start(&manifest, &healths, true))
                            }
                        };
                        owners = match registration {
                            None => return,
                            Some(Ok(owners)) => owners,
                            Some(Err(error)) => {
                                eprintln!(
                                    "V3 aggregate probe restoration failed: {error}; maintenance retained, ordinary admission unavailable"
                                );
                                let _ = terminal_rx.wait_for(|value| *value).await;
                                drop(maintenance);
                                return;
                            }
                        };
                        // Runtime registration is synchronous and old ownership
                        // joined. Only now may ordinary business admission resume.
                        drop(maintenance);
                    }
                }
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
        // The single aggregate supervisor owns terminal cleanup; never spawn a
        // per-preparation cleanup task or restore after aggregate disposal.
        self.terminate();
    }
}
