type V3ManagedProbe =
    std::pin::Pin<Box<dyn Future<Output = Result<V3ProbeCompletion, String>> + Send>>;

#[derive(Debug)]
enum V3ProbeCompletion {
    Recovered,
    ProviderFailed,
    CapacityUnavailable,
}

fn complete_v3_provider_health_probe(
    cancellation: &V3ProviderProbeCancellationGuard,
    result: Result<(), V3ProviderHealthProbeFailure>,
    now_ms: u64,
) -> Result<V3ProbeCompletion, String> {
    match result {
        Ok(()) => {
            cancellation
                .store
                .complete_provider_cooldown_probe_success_with_permit(&cancellation.permit, now_ms)
                .map_err(|error| error.to_string())?;
            Ok(V3ProbeCompletion::Recovered)
        }
        Err(V3ProviderHealthProbeFailure::ConcurrencyBusy) => {
            Ok(V3ProbeCompletion::CapacityUnavailable)
        }
        Err(error) => {
            cancellation
                .store
                .complete_provider_cooldown_probe_failure_with_permit(&cancellation.permit, now_ms)
                .map_err(|error| error.to_string())?;
            match error {
                V3ProviderHealthProbeFailure::Provider(error) => {
                    eprintln!("provider health probe failed: provider={} interface={} auth_alias={:?} model={:?} error={error}",
                        cancellation.permit.provider_id(), cancellation.permit.interface_id(), cancellation.permit.auth_alias(), cancellation.permit.model_id());
                    Ok(V3ProbeCompletion::ProviderFailed)
                }
                V3ProviderHealthProbeFailure::Internal(error) => Err(error),
                V3ProviderHealthProbeFailure::ConcurrencyBusy => unreachable!(),
            }
        }
    }
}

#[derive(Clone, Debug)]
struct V3ManagedProbeSender {
    sender: tokio::sync::mpsc::Sender<V3ManagedProbe>,
    capacity: std::sync::Arc<tokio::sync::Semaphore>,
}

#[derive(Debug)]
enum V3ProbeInitiation {
    Completed(V3ProbeCompletion),
    Initiated,
    AlreadyOwned,
    CapacityUnavailable,
    OwnerUnavailable,
}

impl V3ProviderFailureRuntimeHealth {
    // Registration is synchronous. The aggregate retains and joins the returned
    // future's task; requests never spawn their own probe tasks.
    pub fn aggregate_provider_probe_lifecycle(
        &self,
        manifest: std::sync::Arc<V3Config05ManifestPublished>,
        mut shutdown: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<impl Future<Output = ()> + Send + 'static, String> {
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel(V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY);
        let capacity = std::sync::Arc::new(tokio::sync::Semaphore::new(
            V3_PROVIDER_HEALTH_PROBE_MAX_CONCURRENCY,
        ));
        let mut owner = self.probe_owner.lock().map_err(|error| error.to_string())?;
        if owner
            .as_ref()
            .is_some_and(|owner| !owner.sender.is_closed())
        {
            return Err("provider probe aggregate owner already registered".into());
        }
        *owner = Some(V3ManagedProbeSender {
            sender,
            capacity: capacity.clone(),
        });
        drop(owner);
        let health = self.clone();
        Ok(async move {
            let mut pending = FuturesUnordered::<V3ManagedProbe>::new();
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            let mut startup = true;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => break,
                    work = receiver.recv() => match work {
                        Some(work) => pending.push(work),
                        None => break,
                    },
                    completion = pending.next(), if !pending.is_empty() => {
                        if let Some(Err(error)) = completion {
                            eprintln!("provider managed probe failed: {error}");
                        }
                    },
                    _ = interval.tick() => {
                        let now_ms = match v3_relay_provider_policy_now_epoch_ms() {
                            Ok(now_ms) => now_ms,
                            Err(error) => { eprintln!("provider probe clock failed: {error}"); continue; }
                        };
                        let keys = match health.store.provider_cooldown_probe_keys_with_interface(now_ms, startup) {
                            Ok(keys) => keys,
                            Err(error) => { eprintln!("provider probe scheduling failed: {error}"); continue; }
                        };
                        startup = false;
                        for (provider_id, interface_id, auth_alias, model_id) in keys {
                            let Ok(slot) = capacity.clone().try_acquire_owned() else { break; };
                            match health.store.acquire_provider_cooldown_probe_for_interface(
                                &provider_id, &interface_id, auth_alias.as_deref(), model_id.as_deref(),
                            ) {
                                Ok(Some(permit)) => pending.push(health.managed_probe(&manifest, permit, slot)),
                                Ok(None) => {},
                                Err(error) => eprintln!("provider probe acquisition failed: {error}"),
                            }
                        }
                    }
                }
            }
            // Close admission before dropping both received and queued work.
            receiver.close();
            drop(pending);
            drop(receiver);
        })
    }

    fn managed_probe(
        &self,
        manifest: &V3Config05ManifestPublished,
        permit: routecodex_v3_provider_responses::V3ProviderHealthProbePermit,
        slot: tokio::sync::OwnedSemaphorePermit,
    ) -> V3ManagedProbe {
        let target = build_v3_provider_global_probe_target(
            manifest,
            permit.provider_id(),
            permit.interface_id(),
            permit.auth_alias(),
            permit.model_id(),
        );
        // The shared execution primitive guards the permit before first poll.
        let execution =
            execute_provider_health_probe(self.store.clone(), permit, move |_, _, _, _| {
                let target = target.clone();
                async move {
                    match target {
                        Ok(target) => probe_v3_provider_global_target(target).await,
                        Err(error) => Err(V3ProviderHealthProbeFailure::Internal(error)),
                    }
                }
            });
        Box::pin(async move {
            let _slot = slot;
            let (cancellation, result) = execution.await;
            let now_ms = v3_relay_provider_policy_now_epoch_ms()?;
            complete_v3_provider_health_probe(&cancellation, result, now_ms)
        })
    }

    async fn initiate_cooldown_rescue_probe(
        &self,
        manifest: &V3Config05ManifestPublished,
        candidate: &V3TargetCandidate,
        now_ms: u64,
    ) -> Result<V3ProbeInitiation, String> {
        let owner = self
            .probe_owner
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let Some(owner) = owner.filter(|owner| !owner.sender.is_closed()) else {
            return Ok(V3ProbeInitiation::OwnerUnavailable);
        };
        let Ok(slot) = owner.capacity.clone().try_acquire_owned() else {
            return Ok(V3ProbeInitiation::CapacityUnavailable);
        };
        let permit = self
            .store
            .acquire_provider_cooldown_rescue_probe_for_interface(
                &candidate.provider_id,
                &candidate.interface_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
            )
            .map_err(|error| error.to_string())?;
        let permit = match permit {
            Some(permit) => Some(permit),
            None => self
                .store
                .acquire_provider_cooldown_probe_if_due_for_interface(
                    &candidate.provider_id,
                    &candidate.interface_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    now_ms,
                )
                .map_err(|error| error.to_string())?,
        };
        let Some(permit) = permit else {
            return Ok(V3ProbeInitiation::AlreadyOwned);
        };
        let mut work = self.managed_probe(manifest, permit, slot);
        // One poll starts admitted transport locally. Pending DNS/headers/body
        // are transferred; no remote observation is an admission prerequisite.
        let completed = futures_util::future::poll_fn(|cx| {
            std::task::Poll::Ready(match work.as_mut().poll(cx) {
                std::task::Poll::Ready(result) => Some(result),
                std::task::Poll::Pending => None,
            })
        })
        .await;
        if let Some(result) = completed {
            return result.map(V3ProbeInitiation::Completed);
        }
        match owner.sender.try_send(work) {
            Ok(()) => Ok(V3ProbeInitiation::Initiated),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                Ok(V3ProbeInitiation::CapacityUnavailable)
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                Ok(V3ProbeInitiation::OwnerUnavailable)
            }
        }
    }
}
