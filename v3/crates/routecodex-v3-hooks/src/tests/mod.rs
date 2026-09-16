use super::*;

#[test]
fn unavailable_reasons_are_explicit() {
    assert_eq!(
        hooks_unavailable(HooksUnavailableReason::Missing),
        "hooks_unavailable:missing"
    );
    assert_eq!(
        hooks_unavailable(HooksUnavailableReason::Timeout),
        "hooks_unavailable:timeout"
    );
    assert_eq!(
        hooks_unavailable(HooksUnavailableReason::Crashed),
        "hooks_unavailable:crashed"
    );
}

#[test]
fn unknown_hook_fails_closed_without_registered_handler() {
    let registry = HookRegistry::default();
    assert_eq!(
        registry.handler_for("stop"),
        Err(HookRegistryError::NoHandler("stop".to_string()))
    );
}

#[test]
fn registered_hook_is_revocable() {
    let mut registry = HookRegistry::default();
    registry.register_handler("stopless-handler", "stop");
    assert_eq!(registry.handler_for("stop"), Ok("stopless-handler"));
    registry.unregister("stop");
    assert_eq!(
        registry.handler_for("stop"),
        Err(HookRegistryError::NoHandler("stop".to_string()))
    );
}

#[test]
fn accepted_queue_receipt_cannot_be_promoted_to_reply() {
    let delivery = DeliveryEvidenceRecord {
        intent_id: "intent-1".to_string(),
        message_id: "message-1".to_string(),
        state: DeliveryState::Accepted,
        cursor: None,
        read_item_id: None,
        start_error: None,
    };
    assert_eq!(
        delivery.advance_to_reply(),
        Err(DeliveryEvidenceError::MissingReplyEvidence(
            "intent-1".to_string(),
            DeliveryState::Accepted
        ))
    );
}

#[test]
fn read_requires_replied_evidence() {
    let delivery = DeliveryEvidenceRecord {
        intent_id: "intent-2".to_string(),
        message_id: "message-2".to_string(),
        state: DeliveryState::Executed,
        cursor: None,
        read_item_id: None,
        start_error: None,
    };
    assert_eq!(
        delivery.mark_read("cursor", "item"),
        Err(DeliveryEvidenceError::MissingReadEvidence(
            "intent-2".to_string(),
            DeliveryState::Executed
        ))
    );
}

#[test]
fn replied_evidence_cannot_be_promoted_to_read_without_a_read_observation() {
    let delivery = DeliveryEvidenceRecord {
        intent_id: "intent-replied".to_string(),
        message_id: "message-replied".to_string(),
        state: DeliveryState::Replied,
        cursor: None,
        read_item_id: None,
        start_error: None,
    };
    assert_eq!(
        delivery.advance_to_reply(),
        Err(DeliveryEvidenceError::MissingReplyEvidence(
            "intent-replied".to_string(),
            DeliveryState::Replied
        ))
    );
}

#[test]
fn timer_returns_to_registrant() {
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:session-a".to_string(),
        session_id: "session-a".to_string(),
        thread_id: "thread-a".to_string(),
    };
    let schedule = ScheduledMessage {
        id: "schedule-1".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant: registrant.clone(),
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    };
    let intent = schedule.return_to_registrant("timer:schedule-1:2026-09-14T09:00:00Z".to_string());
    assert_eq!(intent.target, registrant);
    assert_eq!(intent.source, intent.target);
    assert_eq!(intent.send_mode, SendMode::IdleOnly);
}

#[test]
fn handler_error_is_not_silently_dropped() {
    let message = format!(
        "{}",
        HookRegistryError::HandlerError("stopless-handler".to_string())
    );
    assert!(message.contains("stopless-handler"));
}

#[test]
fn forward_rejects_same_session_and_keeps_distinct_sessions() {
    let session_a = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:a".to_string(),
        session_id: "a".to_string(),
        thread_id: "a".to_string(),
    };
    let session_b = SessionTarget {
        thread_id: "b".to_string(),
        ..session_a.clone()
    };
    assert_eq!(
        forward_intent(
            "forward-1".to_string(),
            session_a.clone(),
            session_a.clone(),
            "body".to_string(),
            SendMode::IdleOnly,
        ),
        Err(ForwardError::SameSession)
    );
    let intent = forward_intent(
        "forward-2".to_string(),
        session_a.clone(),
        session_b.clone(),
        "body".to_string(),
        SendMode::WorkingAllowed,
    )
    .unwrap();
    assert_eq!(intent.source, session_a);
    assert_eq!(intent.target, session_b);
}

#[test]
fn core_forward_sends_through_transport_and_defers_idle_only_while_working() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Working,
            input_active: false,
        },
    });
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "forward-idle".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target: target.clone(),
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    };
    assert_eq!(
        core.forward(intent).unwrap(),
        DispatchOutcome::Deferred {
            target,
            reason: "target working or input-active with idle_only mode".to_string()
        }
    );

    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let intent = MessageIntent {
        intent_id: "forward-send".to_string(),
        source: SessionTarget {
            namespace: Namespace::CodexTui,
            appserver_id: "tui-appserver".to_string(),
            scope_id: "local:a".to_string(),
            session_id: "a".to_string(),
            thread_id: "a".to_string(),
        },
        target: SessionTarget {
            namespace: Namespace::CodexTui,
            appserver_id: "tui-appserver".to_string(),
            scope_id: "local:b".to_string(),
            session_id: "b".to_string(),
            thread_id: "b".to_string(),
        },
        body: "forward".to_string(),
        send_mode: SendMode::IdleOnly,
    };
    let outcome = core.forward(intent).unwrap();
    assert!(matches!(outcome, DispatchOutcome::Sent(_)));
}

#[test]
fn core_forward_fails_closed_on_unknown_target() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Unknown,
            input_active: false,
        },
    });
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "missing-b".to_string(),
        thread_id: "missing-b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "forward-unknown".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    assert!(matches!(
        core.forward(intent),
        Err(SidecarDispatchError::AppServer(
            AppServerError::UnknownSession(_)
        ))
    ));
}

#[test]
fn stopping_idle_only_is_deferred_not_sent() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Stopping,
            input_active: false,
        },
    });
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "forward-stopping".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    };
    assert!(matches!(
        core.forward(intent),
        Ok(DispatchOutcome::Deferred { .. })
    ));
}

#[test]
fn duplicate_intent_reuses_one_send_result() {
    struct CountingTransport {
        sends: usize,
    }
    impl AppServerTransport for CountingTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            self.sends += 1;
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("message:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("message:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }
    }

    let mut core = HooksSidecarCore::new(CountingTransport { sends: 0 });
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "duplicate-intent".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let first = core.forward(intent.clone()).unwrap();
    let second = core.forward(intent).unwrap();
    assert_eq!(first, second);
    assert_eq!(core.transport.sends, 1);
}

#[test]
fn missing_app_server_socket_fails_closed() {
    let mut core = HooksSidecarCore::new(DisabledTransport);
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "missing-socket".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    assert!(matches!(
        core.forward(intent),
        Err(SidecarDispatchError::AppServer(
            AppServerError::SocketMissing(_)
        ))
    ));
}

#[test]
fn transport_timeout_is_unknown_delivery_not_success() {
    struct TimeoutTransport;
    impl AppServerTransport for TimeoutTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            _intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Err(AppServerError::TransportTimeout(
                "send timed out".to_string(),
            ))
        }

        fn delivery_evidence(
            &mut self,
            _intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Err(AppServerError::DeliveryUnresolved(
                "not reconciled".to_string(),
            ))
        }
    }

    let mut core = HooksSidecarCore::new(TimeoutTransport);
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let outcome = core
        .forward(MessageIntent {
            intent_id: "timeout-intent".to_string(),
            source: SessionTarget {
                thread_id: "a".to_string(),
                ..target.clone()
            },
            target,
            body: "wake".to_string(),
            send_mode: SendMode::WorkingAllowed,
        })
        .unwrap();
    assert_eq!(
        outcome,
        DispatchOutcome::UnknownDelivery {
            intent_id: "timeout-intent".to_string(),
            reason: "app server transport timeout: send timed out".to_string(),
        }
    );
}

#[test]
fn restart_recovery_marks_pending_intent_unknown_without_retry() {
    let state_path = std::env::temp_dir().join(format!(
        "rcc-hooks-state-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "pending-before-restart".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let state = SidecarPersistentState {
        schema_version: 1,
        schedules: BTreeMap::new(),
        paused_schedule_ids: BTreeSet::new(),
        handlers: Vec::new(),
        intents: BTreeMap::from([(
            intent.intent_id.clone(),
            PersistedIntentRecord {
                intent: intent.clone(),
                phase: PersistedIntentPhase::Pending,
                baseline: None,
                evidence: Vec::new(),
                outcome: None,
                error: None,
            },
        )]),
    };
    write_sidecar_state(&state_path, &state).unwrap();

    let mut recovered = HooksSidecarCore::with_state_file(
        StubTransport {
            status: SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            },
        },
        &state_path,
    )
    .unwrap();
    let outcome = recovered.forward(intent).unwrap();
    assert!(matches!(outcome, DispatchOutcome::UnknownDelivery { .. }));
    let persisted: SidecarPersistentState =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert_eq!(
        persisted.intents["pending-before-restart"].phase,
        PersistedIntentPhase::UnknownDelivery
    );
    let _ = fs::remove_file(state_path);
}

#[test]
fn delivery_ledger_survives_restart_and_does_not_move_backwards() {
    struct EvidenceTransport {
        state: DeliveryState,
    }

    impl AppServerTransport for EvidenceTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: self.state,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }
    }

    let state_path = std::env::temp_dir().join(format!(
        "rcc-hooks-ledger-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "ledger-intent".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target,
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };

    let mut first = HooksSidecarCore::with_state_file(
        EvidenceTransport {
            state: DeliveryState::Replied,
        },
        &state_path,
    )
    .unwrap();
    first.forward(intent.clone()).unwrap();
    first.delivery_evidence(&intent, &[]).unwrap();
    let before_restart = first.intent_evidence(&intent.intent_id).unwrap();
    assert_eq!(
        before_restart
            .evidence
            .iter()
            .map(|evidence| evidence.state)
            .collect::<Vec<_>>(),
        vec![DeliveryState::Accepted, DeliveryState::Replied,]
    );
    drop(first);

    let mut restarted = HooksSidecarCore::with_state_file(
        EvidenceTransport {
            state: DeliveryState::Delivered,
        },
        &state_path,
    )
    .unwrap();
    let recovered = restarted.intent_evidence(&intent.intent_id).unwrap();
    assert_eq!(recovered.evidence, before_restart.evidence);
    assert_eq!(recovered.phase, PersistedIntentPhase::Sent);
    assert!(restarted.delivery_evidence(&intent, &[]).is_err());
    let after_failed_regression = restarted.intent_evidence(&intent.intent_id).unwrap();
    assert_eq!(after_failed_regression.evidence, before_restart.evidence);
    let _ = fs::remove_file(state_path);
}

#[test]
fn delivery_evidence_rejects_reused_intent_id_with_changed_content() {
    struct CountingEvidenceTransport {
        evidence_calls: usize,
    }

    impl AppServerTransport for CountingEvidenceTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(SessionStatus {
                state: SessionState::Idle,
                input_active: false,
            })
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            self.evidence_calls += 1;
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Replied,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }
    }

    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    let intent = MessageIntent {
        intent_id: "reused-intent".to_string(),
        source: SessionTarget {
            thread_id: "a".to_string(),
            ..target.clone()
        },
        target: target.clone(),
        body: "wake".to_string(),
        send_mode: SendMode::WorkingAllowed,
    };
    let mut core = HooksSidecarCore::new(CountingEvidenceTransport { evidence_calls: 0 });
    core.forward(intent.clone()).unwrap();
    let evidence_before = core.intent_evidence(&intent.intent_id).unwrap();

    // Same intent id, different target/body. The core must reject before
    // querying the transport or mutating the ledger entry.
    let conflicting = MessageIntent {
        target: SessionTarget {
            thread_id: "different-thread".to_string(),
            ..target
        },
        body: "different body".to_string(),
        ..intent.clone()
    };
    assert!(matches!(
        core.delivery_evidence(&conflicting, &[]),
        Err(SidecarDispatchError::IntentConflict(id)) if id == "reused-intent"
    ));
    let evidence_after = core.intent_evidence(&intent.intent_id).unwrap();
    assert_eq!(evidence_after, evidence_before);
}

#[test]
fn core_hook_event_fails_closed_when_handler_missing() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    core.unregister_handler("stop");
    assert_eq!(
        core.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Err(SidecarDispatchError::Hook(HookRegistryError::NoHandler(
            "stop".to_string()
        )))
    );
}

#[test]
fn core_hook_event_fails_closed_when_handler_registered_but_not_mounted() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    core.register_handler("stopless-handler", "stop");
    assert_eq!(
        core.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Err(SidecarDispatchError::Hook(HookRegistryError::NoHandler(
            "stop".to_string()
        )))
    );
}

#[test]
fn core_hook_event_returns_noop_for_mounted_noop_handler() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    core.register_handler("stopless-handler", "stop");
    core.registry
        .mount_handler("stopless-handler", "stop", NoOpHookHandler);
    assert_eq!(
        core.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Ok(DispatchOutcome::NoOp)
    );
}

struct SendBackHandler {
    target: SessionTarget,
}

impl HookHandler for SendBackHandler {
    fn handle(
        &self,
        _event: &HookEvent,
        _state: &HookState,
    ) -> Result<HookDecision, HookRegistryError> {
        Ok(HookDecision::SendMessage(Box::new(MessageIntent {
            intent_id: "hook-send-1".to_string(),
            source: SessionTarget {
                thread_id: "source".to_string(),
                ..self.target.clone()
            },
            target: self.target.clone(),
            body: "hook wake".to_string(),
            send_mode: SendMode::WorkingAllowed,
        })))
    }
}

struct ErroringHandler;

impl HookHandler for ErroringHandler {
    fn handle(
        &self,
        _event: &HookEvent,
        _state: &HookState,
    ) -> Result<HookDecision, HookRegistryError> {
        Err(HookRegistryError::HandlerError(
            "stopless-handler".to_string(),
        ))
    }
}

#[test]
fn mounted_handler_send_decision_flows_through_transport() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let target = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:b".to_string(),
        session_id: "b".to_string(),
        thread_id: "b".to_string(),
    };
    core.register_handler("stopless-handler", "stop");
    core.registry.mount_handler(
        "stopless-handler",
        "stop",
        SendBackHandler {
            target: target.clone(),
        },
    );
    let outcome = core
        .dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        )
        .unwrap();
    match outcome {
        DispatchOutcome::Sent(evidence) => {
            assert_eq!(evidence.intent_id, "hook-send-1");
            assert_eq!(evidence.state, DeliveryState::Accepted);
        }
        other => panic!("expected sent outcome, got {other:?}"),
    }
}

#[test]
fn mounted_handler_error_is_not_swallowed() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    core.register_handler("stopless-handler", "stop");
    core.registry
        .mount_handler("stopless-handler", "stop", ErroringHandler);
    assert_eq!(
        core.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Err(SidecarDispatchError::Hook(HookRegistryError::HandlerError(
            "stopless-handler".to_string()
        )))
    );
}

#[test]
fn run_due_schedules_sends_timer_back_to_registrant() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:session-a".to_string(),
        session_id: "session-a".to_string(),
        thread_id: "thread-a".to_string(),
    };
    core.upsert_schedule(ScheduledMessage {
        id: "timer-1".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant: registrant.clone(),
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    })
    .unwrap();
    let outcomes = core.run_due_schedules("2026-09-14T10:00:00Z");
    assert_eq!(outcomes.len(), 1);
    match outcomes.into_iter().next().unwrap().unwrap() {
        DispatchOutcome::Sent(evidence) => {
            assert_eq!(evidence.intent_id, "timer:timer-1:2026-09-14T09:00:00Z");
        }
        other => panic!("expected timer send, got {other:?}"),
    }
    assert!(core.due_schedules("2026-09-14T10:00:00Z").is_empty());
}

#[test]
fn deferred_timer_resumes_and_sends_when_target_becomes_idle() {
    struct SwitchingTransport {
        status: SessionStatus,
        sends: usize,
    }
    impl AppServerTransport for SwitchingTransport {
        fn session_status(
            &mut self,
            _target: &SessionTarget,
        ) -> Result<SessionStatus, AppServerError> {
            Ok(self.status.clone())
        }

        fn send_message(
            &mut self,
            intent: &MessageIntent,
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            self.sends += 1;
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }

        fn delivery_evidence(
            &mut self,
            intent: &MessageIntent,
            _baseline: &[String],
        ) -> Result<DeliveryEvidenceRecord, AppServerError> {
            Ok(DeliveryEvidenceRecord {
                intent_id: intent.intent_id.clone(),
                message_id: format!("receipt:{}", intent.intent_id),
                state: DeliveryState::Accepted,
                cursor: None,
                read_item_id: None,
                start_error: None,
            })
        }
    }

    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:timer".to_string(),
        session_id: "timer".to_string(),
        thread_id: "timer".to_string(),
    };
    let mut core = HooksSidecarCore::new(SwitchingTransport {
        status: SessionStatus {
            state: SessionState::Working,
            input_active: false,
        },
        sends: 0,
    });
    core.upsert_schedule(ScheduledMessage {
        id: "resume-timer".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant,
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    })
    .unwrap();

    let first = core.run_due_schedules("2026-09-14T10:00:00Z");
    assert!(matches!(first[0], Ok(DispatchOutcome::Deferred { .. })));

    core.transport.status = SessionStatus {
        state: SessionState::Idle,
        input_active: false,
    };
    let second = core.run_due_schedules("2026-09-14T10:01:00Z");
    assert!(matches!(second[0], Ok(DispatchOutcome::Sent(_))));
    assert_eq!(core.transport.sends, 1);

    let third = core.run_due_schedules("2026-09-14T10:02:00Z");
    assert!(third.is_empty());
    assert_eq!(core.transport.sends, 1);
}

#[test]
fn core_timer_due_returns_only_registered_schedules_and_keeps_registrant() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:session-a".to_string(),
        session_id: "session-a".to_string(),
        thread_id: "thread-a".to_string(),
    };
    core.upsert_schedule(ScheduledMessage {
        id: "due-1".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant: registrant.clone(),
        body: "wake due-1".to_string(),
        send_mode: SendMode::IdleOnly,
    })
    .unwrap();
    core.upsert_schedule(ScheduledMessage {
        id: "later".to_string(),
        at_iso8601: "2026-09-15T09:00:00Z".to_string(),
        registrant: registrant.clone(),
        body: "not yet".to_string(),
        send_mode: SendMode::WorkingAllowed,
    })
    .unwrap();
    let due = core.due_schedules("2026-09-14T10:00:00Z");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].intent_id, "timer:due-1:2026-09-14T09:00:00Z");
    assert_eq!(due[0].target, registrant);
}

#[test]
fn timer_compares_iso8601_offsets_chronologically() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:offset-timer".to_string(),
        session_id: "offset-timer".to_string(),
        thread_id: "offset-timer".to_string(),
    };
    core.upsert_schedule(ScheduledMessage {
        id: "offset-timer".to_string(),
        at_iso8601: "2026-09-14T10:00:00-07:00".to_string(),
        registrant,
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    })
    .unwrap();
    assert!(
        core.due_schedules("2026-09-14T16:00:00Z").is_empty(),
        "10:00-07:00 is 17:00Z and must not fire before UTC 17:00"
    );
    assert_eq!(core.due_schedules("2026-09-14T17:00:00Z").len(), 1);
}

#[test]
fn invalid_schedule_timestamp_fails_closed_at_ingress() {
    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:bad-timer".to_string(),
        session_id: "bad-timer".to_string(),
        thread_id: "bad-timer".to_string(),
    };
    for (index, bad) in [
        "not-a-timestamp",
        "2026-02-30T09:00:00Z",
        "2026-02-31T09:00:00Z",
        "2026-04-31T09:00:00Z",
        "2025-02-29T09:00:00Z",
        "9223372036854775807-01-01T00:00:00Z",
        "-999999999999999999-01-01T00:00:00Z",
    ]
    .into_iter()
    .enumerate()
    {
        let error = core
            .upsert_schedule(ScheduledMessage {
                id: format!("bad-timer-{index}"),
                at_iso8601: bad.to_string(),
                registrant: registrant.clone(),
                body: "wake".to_string(),
                send_mode: SendMode::IdleOnly,
            })
            .expect_err("invalid schedule timestamp must fail closed");
        assert!(
            error.contains("invalid ISO-8601"),
            "unexpected error: {error}"
        );
    }
    assert!(core.due_schedules("2026-09-14T10:00:00Z").is_empty());
}

#[test]
fn schedule_pause_resume_remove_are_explicit_and_persisted() {
    let state_path = std::env::temp_dir().join(format!(
        "rcc-hooks-schedules-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registrant = SessionTarget {
        namespace: Namespace::CodexTui,
        appserver_id: "tui-appserver".to_string(),
        scope_id: "local:session-a".to_string(),
        session_id: "session-a".to_string(),
        thread_id: "thread-a".to_string(),
    };
    let schedule = ScheduledMessage {
        id: "pause-timer".to_string(),
        at_iso8601: "2026-09-14T09:00:00Z".to_string(),
        registrant,
        body: "wake".to_string(),
        send_mode: SendMode::IdleOnly,
    };

    let mut core = HooksSidecarCore::with_state_file(DisabledTransport, &state_path).unwrap();
    core.upsert_schedule(schedule).unwrap();
    core.persist_state().unwrap();
    assert!(core.pause_schedule("pause-timer"));
    core.persist_state().unwrap();
    assert!(core.due_schedules("2026-09-14T10:00:00Z").is_empty());

    let mut restarted = HooksSidecarCore::with_state_file(DisabledTransport, &state_path).unwrap();
    assert!(restarted.due_schedules("2026-09-14T10:00:00Z").is_empty());
    assert!(restarted.resume_schedule("pause-timer"));
    restarted.persist_state().unwrap();
    assert_eq!(restarted.due_schedules("2026-09-14T10:00:00Z").len(), 1);
    assert!(restarted.remove_schedule("pause-timer"));
    restarted.persist_state().unwrap();
    assert!(restarted.due_schedules("2026-09-14T10:00:00Z").is_empty());
    assert!(!restarted.pause_schedule("missing-timer"));
    assert!(!restarted.resume_schedule("missing-timer"));
    assert!(!restarted.remove_schedule("missing-timer"));
    let _ = fs::remove_file(state_path);
}

#[test]
fn mounted_handler_registration_survives_restart() {
    let state_path = std::env::temp_dir().join(format!(
        "rcc-hooks-handlers-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut core = HooksSidecarCore::with_state_file(DisabledTransport, &state_path).unwrap();
    core.mount_handler_config(HookHandlerConfig {
        handler_id: "stopless-handler".to_string(),
        hook_kind: "stop".to_string(),
        strategy: HookHandlerStrategy::NoOp,
    });
    core.persist_state().unwrap();
    drop(core);

    let mut restarted = HooksSidecarCore::with_state_file(DisabledTransport, &state_path).unwrap();
    assert_eq!(
        restarted.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Ok(DispatchOutcome::NoOp)
    );
    restarted.unregister_handler("stop");
    restarted.persist_state().unwrap();
    drop(restarted);

    let restarted = HooksSidecarCore::with_state_file(DisabledTransport, &state_path).unwrap();
    assert!(matches!(
        restarted.intent_evidence("missing"),
        Err(SidecarDispatchError::AppServer(
            AppServerError::DeliveryUnresolved(_)
        ))
    ));
    let mut restarted = restarted;
    assert_eq!(
        restarted.dispatch_hook_event(
            &HookEvent {
                event_name: "Stop".to_string(),
                hook_kind: "stop".to_string(),
                source: None,
            },
            &HookState {
                status: "idle".to_string(),
                detail: None,
            },
        ),
        Err(SidecarDispatchError::Hook(HookRegistryError::NoHandler(
            "stop".to_string()
        )))
    );
    let _ = fs::remove_file(state_path);
}

#[test]
fn control_request_serde_and_health_response_are_stable() {
    let request = ControlRequest::Health;
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["method"], "health");
    let decoded: ControlRequest = serde_json::from_value(json).unwrap();
    assert_eq!(request, decoded);

    let mut core = HooksSidecarCore::new(StubTransport {
        status: SessionStatus {
            state: SessionState::Idle,
            input_active: false,
        },
    });
    assert_eq!(
        handle_control_request(&mut core, ControlRequest::Health),
        ControlResponse::ok(serde_json::json!({ "status": "ok" }))
    );
}
