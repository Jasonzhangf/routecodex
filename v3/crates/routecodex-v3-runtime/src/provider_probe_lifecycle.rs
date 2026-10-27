type V3ManagedProbe =
    std::pin::Pin<Box<dyn Future<Output = Result<V3ProbeCompletion, String>> + Send>>;

#[cfg(test)]
#[path = "provider_probe_fairness_tests.rs"]
mod provider_probe_fairness_tests;

#[derive(Debug)]
enum V3ProbeCompletion {
    Superseded,
    Recovered,
    ProviderFailed,
    CapacityUnavailable,
}

// A probe is an observation, never a business attempt. Keep its real HTTP
// head separate from transport failures and classify through the same Error
// operators before the health owner consumes the observation.
fn classify_provider_probe_failure(
    error: V3ProviderError,
) -> Result<(Option<u16>, V3ProviderFailureAction), String> {
    let http = match &error {
        V3ProviderError::HttpStatus { response } => {
            Some((response.status, response.provider_id.clone()))
        }
        V3ProviderError::UnexpectedContentType {
            status,
            provider_id,
            ..
        }
        | V3ProviderError::ResponseBodyUnreadable {
            status,
            provider_id,
            ..
        } => Some((*status, provider_id.clone())),
        _ => None,
    };
    let status = http.as_ref().map(|(status, _)| *status);
    let probe_provider_id = http
        .as_ref()
        .map(|(_, provider_id)| provider_id.clone())
        .unwrap_or_else(|| "n/a".to_string());
    let source = if let Some((status, provider_id)) = http {
        let code = crate::hooks::source_code_for_external_provider_error(&error);
        let message = format!("{error:?}");
        raise_v3_source_via_err01(
            V3ErrorSourceKind::ProviderFailure,
            "V3ProviderResp14Raw",
            code.clone(),
            message.clone(),
            V3Err01SourceInput::External(V3ExternalErrorLink {
                kind: V3ExternalErrorKind::Provider,
                status: Some(status),
                code: Some(code),
                provider_id: Some(provider_id),
                upstream_request_id: None,
                message: Some(message),
            }),
        )
        .map(|(_, source)| source)
    } else {
        crate::hooks::build_v3_provider_error_source("V3ProviderResp14Raw", error)
    }
    .map_err(|error| format!("provider probe Error01 failed: {error:?}"))?;
    let projection = serde_json::to_value(&source).map_err(|error| error.to_string())?;
    let classified = classify_v3_provider_health_source_via_err02(projection, source)
        .map_err(|error| format!("provider probe Error02 failed: {error:?}"))?;
    eprintln!(
        "provider health probe error: provider={} status={} class={}",
        probe_provider_id,
        status.map_or(0, |value| value),
        classified.class,
    );
    let action = apply_v3_internal_provider_failure_policy(
        build_v3_provider_failure_action_from_v3_error_02(&classified),
        "V3ProviderResp14Raw",
        status.unwrap_or(502),
        "provider_probe_failure",
    );
    Ok((status, action))
}

#[cfg(test)]
mod probe_error_chain_tests {
    use super::*;

    #[test]
    fn probe_without_http_head_cannot_supply_non429_recovery_observation() {
        let (status, _) = classify_provider_probe_failure(V3ProviderError::Transport {
            request_id: "probe-no-head".into(),
            provider_id: "p".into(),
            reason: "connection closed before response head".into(),
        }).unwrap();
        assert_eq!(status, None, "a transport classification is not an upstream HTTP status");
    }

    #[test]
    fn probe_unreadable_error_body_retains_real429_head_in_error_chain() {
        let (status, action) = classify_provider_probe_failure(V3ProviderError::ResponseBodyUnreadable {
            request_id: "probe-unfinished-429".into(),
            provider_id: "p".into(),
            status: 429,
            headers: Vec::new(),
            reason: "body disconnected after real429 head".into(),
        }).unwrap();
        assert_eq!(status, Some(429));
        assert_eq!(action.failure_fingerprint.unwrap().http_status, 429,
            "a real error head cannot be rewritten as transport502 or a non429 recovery");
    }
}

fn complete_v3_provider_health_probe(
    cancellation: &V3ProviderProbeCancellationGuard,
    action_gate: &V3ProviderActionGate,
    result: Result<(), V3ProviderHealthProbeFailure>,
    now_ms: u64,
) -> Result<V3ProbeCompletion, String> {
    match result {
        Ok(()) => {
            let recovered = cancellation
                .store
                .complete_provider_cooldown_probe_success_if_current_with_permit(
                    &cancellation.permit,
                    now_ms,
                )
                .map_err(|error| error.to_string())?;
            let permit = &cancellation.permit;
            if let (Some(auth), Some(model)) = (permit.auth_alias(), permit.model_id()) {
                if recovered {
                    action_gate.record_provider_success(
                        &V3ProviderActionProviderScope::rate_limit_identity(
                            v3_relay_provider_candidate_key_parts(
                                permit.provider_id(),
                                Some(permit.interface_id()),
                                Some(auth),
                                Some(model),
                            ),
                        ),
                    )?;
                    return Ok(V3ProbeCompletion::Recovered);
                }
            }
            // A real2xx can still be inside the committed quota minimum or
            // superseded by a newer failure. It must not reopen admission.
            Ok(V3ProbeCompletion::Superseded)
        }
        Err(V3ProviderHealthProbeFailure::ConcurrencyBusy) => {
            Ok(V3ProbeCompletion::CapacityUnavailable)
        }
        Err(error) => {
            if let V3ProviderHealthProbeFailure::Provider(error) = error {
                let (status, action) = classify_provider_probe_failure(error)?;
                if let Some(status) = status {
                    let disposition = cancellation
                        .store
                        .record_provider_rate_limit_probe_status_with_permit(
                            &cancellation.permit,
                            status,
                            &action,
                            now_ms,
                        )?;
                    if disposition == routecodex_v3_provider_responses::V3ProviderRateLimitProbeDisposition::Superseded {
                        return Ok(V3ProbeCompletion::Superseded);
                    }
                }
                cancellation
                    .store
                    .complete_provider_cooldown_probe_failure_with_permit(
                        &cancellation.permit,
                        now_ms,
                    )
                    .map_err(|error| error.to_string())?;
                return Ok(V3ProbeCompletion::ProviderFailed);
            }
            cancellation
                .store
                .complete_provider_cooldown_probe_failure_with_permit(&cancellation.permit, now_ms)
                .map_err(|error| error.to_string())?;
            match error {
                V3ProviderHealthProbeFailure::Provider(_) => unreachable!(),
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
        shutdown: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<impl Future<Output = ()> + Send + 'static, String> {
        self.aggregate_provider_probe_scheduler(manifest, shutdown, true)
    }

    // A retained aggregate resumes the stored schedule, not the startup sweep.
    pub fn aggregate_provider_probe_lifecycle_resume(
        &self,
        manifest: std::sync::Arc<V3Config05ManifestPublished>,
        shutdown: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<impl Future<Output = ()> + Send + 'static, String> {
        self.aggregate_provider_probe_scheduler(manifest, shutdown, false)
    }

    fn aggregate_provider_probe_scheduler(
        &self,
        manifest: std::sync::Arc<V3Config05ManifestPublished>,
        mut shutdown: tokio::sync::oneshot::Receiver<()>,
        mut startup: bool,
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
            let mut last_considered = None;
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
                        let now_ms = health.observation_now_ms(now_ms);
                        let mut keys = match health.store.provider_cooldown_probe_keys_with_interface(now_ms, startup) {
                            Ok(keys) => keys,
                            Err(error) => { eprintln!("provider probe scheduling failed: {error}"); continue; }
                        };
                        match health.precool_probe_keys() {
                            Ok(observations) => keys.extend(observations),
                            Err(error) => eprintln!("provider observation scheduling failed: {error}"),
                        }
                        keys.sort();
                        keys.dedup();
                        startup = false;
                        if let Some(last) = &last_considered {
                            let next = keys.partition_point(|key| key <= last);
                            keys.rotate_left(next);
                        }
                        for key in keys {
                            let Ok(slot) = capacity.clone().try_acquire_owned() else { break; };
                            // Advance even if acquisition is denied or fails. Full
                            // capacity leaves this cursor at the last considered key.
                            last_considered = Some(key.clone());
                            let (provider_id, interface_id, auth_alias, model_id) = key;
                            let identity = precool_identity(&provider_id, &interface_id, auth_alias.as_deref(), model_id.as_deref());
                            let observing = match health.precool.lock() {
                                Ok(actions) => actions.contains_key(&identity),
                                Err(error) => { eprintln!("provider observation state failed: {error}"); continue; }
                            };
                            if observing {
                                match health.managed_precool_probe(&manifest, identity, slot) {
                                    Ok(Some(probe)) => pending.push(probe),
                                    Ok(None) => {},
                                    Err(error) => eprintln!("provider observation acquisition failed: {error}"),
                                }
                                continue;
                            }
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
        let health = self.clone();
        Box::pin(async move {
            let _slot = slot;
            let (cancellation, result) = execution.await;
            let now_ms = health.observation_now_ms(v3_relay_provider_policy_now_epoch_ms()?);
            complete_v3_provider_health_probe(&cancellation, &health.action_gate, result, now_ms)
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
