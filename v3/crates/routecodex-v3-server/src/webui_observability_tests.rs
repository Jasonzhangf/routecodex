use super::*;

fn record(
    observability: &V3WebuiObservability,
    event_type: V3ObsEventType,
    key: &str,
    scope: V3ObsScope,
    meta: V3ObsRequestMeta,
) -> Result<u64, String> {
    record_v3_observability_event(
        observability,
        event_type,
        key,
        scope,
        meta,
        &crate::V3RuntimeObservability::default(),
    )
}

fn record_observed(
    observability: &V3WebuiObservability,
    event_type: V3ObsEventType,
    key: &str,
    scope: V3ObsScope,
    meta: V3ObsRequestMeta,
    observed: &crate::V3RuntimeObservability,
) -> Result<u64, String> {
    record_v3_observability_event(observability, event_type, key, scope, meta, observed)
}

fn scope(port: u16) -> V3ObsScope {
    V3ObsScope {
        port,
        workdir: Some("/w".to_string()),
        session: Some("s1".to_string()),
    }
}

fn meta_with_full(req: &str) -> V3ObsRequestMeta {
    V3ObsRequestMeta {
        request_id: req.to_string(),
        endpoint: "/v1/chat/completions".to_string(),
        model: Some("gpt-test".to_string()),
        route: Some("grp.pool".to_string()),
        provider: Some("prov".to_string()),
        entry_protocol: Some("openai-chat".to_string()),
        execution_mode: Some("direct".to_string()),
        transport: Some("sse".to_string()),
        provider_status: Some(200),
        response_status: Some("completed".to_string()),
        finish_reason: Some("stop".to_string()),
        ..Default::default()
    }
}

#[test]
fn terminal_persists_and_reloads_terminal_records() {
    let dir = std::env::temp_dir().join(format!(
        "v3-webui-records-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("records.jsonl");
    let key = build_v3_obs_request_key(5555, "r-persist");
    let first = V3WebuiObservability::with_persistence_path(Some(path.clone()));
    record(
        &first,
        V3ObsEventType::Started,
        &key,
        scope(5555),
        meta_with_full("r-persist"),
    )
    .unwrap();
    record(
        &first,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-persist"),
    )
    .unwrap();
    first
        .flush_persistence()
        .expect("terminal persistence flush receipt");
    assert!(path.exists(), "terminal record must be persisted");
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(
        body.contains("r-persist"),
        "persisted body must contain request id"
    );

    let second = V3WebuiObservability::load_persisted(&path);
    let rows = second.rows().unwrap();
    assert_eq!(rows.len(), 1, "persisted record must reload");
    let row = rows.get(&key).expect("reloaded row");
    assert_eq!(row.result.as_deref(), Some("success"));
    assert!(row.duration_ms.is_some());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn load_persisted_survives_legacy_rows_and_undecodable_lines() {
    let dir = std::env::temp_dir().join(format!(
        "v3-webui-records-legacy-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("records.jsonl");
    let legacy_key = build_v3_obs_request_key(5555, "r-legacy");
    let legacy_row = serde_json::json!({
        "request_key": legacy_key,
        "event_type": "request.completed",
        "started_epoch_ms": 1u64,
        "updated_epoch_ms": 2u64,
        "finished_epoch_ms": 2u64,
        "duration_ms": 1u64,
        "meta": {
            "request_id": "r-legacy",
            "endpoint": "/v1/chat/completions"
        },
        "scope": { "port": 5555 },
        "result": "success",
        "attempts": 1u64,
        "failed_attempts": 0u64,
        "switches": 0u64
    });
    let legacy_envelope = serde_json::json!({
        "schema_version": 1u64,
        "row": legacy_row
    });
    let newer_envelope = serde_json::json!({
        "schema_version": 1u64,
        "row": {
            "request_key": "k2",
            "event_type": "request.started",
            "started_epoch_ms": 3u64,
            "updated_epoch_ms": 3u64
        }
    });
    // One legacy row predating stopless/servertool, one torn line, one
    // row without request_key, and one newer row missing whole sections.
    std::fs::write(
        &path,
        format!(
            "{legacy_envelope}\n{{\"torn\": \n{{\"no_request_key\": true}}\n{newer_envelope}\n"
        ),
    )
    .unwrap();

    let loaded = V3WebuiObservability::load_persisted(&path);
    let rows = loaded.rows().unwrap();
    let row = rows.get(legacy_key.as_str()).expect("legacy row must load");
    assert!(
        !row.servertool,
        "legacy row without servertool must default to false"
    );
    assert!(rows.contains_key("k2"), "valid later rows must still load");
    let alarm = loaded.alarm();
    assert!(
        alarm
            .as_deref()
            .map(|message| message.contains("skipped"))
            .unwrap_or(false),
        "undecodable lines must surface as alarm, got {alarm:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn persistence_failure_does_not_change_request_projection_truth() {
    let path = std::env::temp_dir().join(format!(
        "v3-webui-records-invalid-target-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).expect("create directory where JSONL file is expected");
    let observability = V3WebuiObservability::with_persistence_path(Some(path.clone()));
    let key = build_v3_obs_request_key(5555, "r-persistence-failure");

    assert_eq!(
        record(
            &observability,
            V3ObsEventType::Completed,
            &key,
            scope(5555),
            meta_with_full("r-persistence-failure"),
        )
        .expect("request projection must commit independently of persistence"),
        1
    );
    assert_eq!(
        observability
            .rows()
            .expect("in-memory rows")
            .get(&key)
            .and_then(|row| row.result.as_deref()),
        Some("success")
    );
    assert!(observability.flush_persistence().is_err());
    assert!(observability
        .alarm()
        .expect("persistence alarm")
        .contains("persistence write failed"));

    std::fs::remove_dir_all(&path).expect("remove isolated invalid target");
}

#[test]
fn legacy_row_missing_stopless_still_loads() {
    let dir = std::env::temp_dir().join(format!(
        "v3-webui-legacy-stopless-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("records.jsonl");
    let key = build_v3_obs_request_key(5555, "r-legacy-stopless");
    let first = V3WebuiObservability::with_persistence_path(Some(path.clone()));
    record(
        &first,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-legacy-stopless"),
    )
    .unwrap();
    first
        .flush_persistence()
        .expect("persistence flush receipt");

    let body = std::fs::read_to_string(&path).unwrap();
    let rewritten = body
        .lines()
        .map(|line| {
            let mut envelope: Value = serde_json::from_str(line).unwrap();
            if let Some(row) = envelope.get_mut("row") {
                if let Some(object) = row.as_object_mut() {
                    object.remove("stopless");
                }
            }
            serde_json::to_string(&envelope).unwrap()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&path, rewritten).unwrap();

    let second = V3WebuiObservability::load_persisted(&path);
    let rows = second.rows().unwrap();
    let row = rows.get(&key).expect("legacy row must reload");
    assert!(!row.stopless, "missing stopless must decode as false");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn history_byte_limit_is_explicit_and_does_not_change_request_projection_truth() {
    let observability = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-history-limit");
    record(
        &observability,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-history-limit"),
    )
    .expect("request projection");
    let row = observability.rows().expect("rows")[&key].clone();
    let path = std::env::temp_dir().join(format!(
        "v3-webui-history-limit-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));

    let error = V3WebuiObservability::append_persisted_row_with_limit(&path, &row, 1)
        .expect_err("history limit must reject before append");
    assert!(error.contains("record exceeds configured 1 byte limit"));
    assert!(!path.exists());
    assert_eq!(
        observability
            .rows()
            .expect("in-memory rows")
            .get(&key)
            .and_then(|row| row.result.as_deref()),
        Some("success")
    );
}

#[test]
fn completed_zero_usage_is_marked_as_issue() {
    let observability = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-zero-usage");
    let runtime = crate::V3RuntimeObservability {
        usage: Some(crate::V3RuntimeUsageSummary {
            input_tokens: Some(0),
            output_tokens: Some(0),
            total_tokens: Some(0),
            cached_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
        }),
        ..Default::default()
    };
    record_observed(
        &observability,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-zero-usage"),
        &runtime,
    )
    .unwrap();
    assert_eq!(
        observability.rows().unwrap()[&key].result.as_deref(),
        Some("issue")
    );
}

#[test]
fn completed_usage_projects_split_cache_fields() {
    let observability = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-split-cache");
    let runtime = crate::V3RuntimeObservability {
        usage: Some(crate::V3RuntimeUsageSummary {
            input_tokens: Some(1_000),
            output_tokens: Some(20),
            total_tokens: Some(1_020),
            cached_tokens: None,
            cache_read_input_tokens: Some(700),
            cache_creation_input_tokens: Some(200),
        }),
        ..Default::default()
    };

    record_observed(
        &observability,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-split-cache"),
        &runtime,
    )
    .unwrap();

    let rows = observability.rows().unwrap();
    let usage = rows
        .get(&key)
        .and_then(|row| row.usage.as_ref())
        .expect("projected usage");
    assert_eq!(usage.input_tokens, Some(1_000));
    assert_eq!(usage.cache_read_input_tokens, Some(700));
    assert_eq!(usage.cache_creation_input_tokens, Some(200));
    assert_eq!(usage.cached_tokens, None);
}

#[test]
fn provider_attempt_failure_survives_completed_meta_rebuild() {
    let o = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-failure-then-success");
    record(
        &o,
        V3ObsEventType::Started,
        &key,
        scope(5555),
        meta_with_full("r-failure-then-success"),
    )
    .unwrap();

    let mut failure_event = crate::V3RuntimeProviderFailureObservation::default();
    failure_event.error_type = Some("provider_http_502".to_string());
    failure_event.message = "provider returned HTTP 502".to_string();
    let mut obs = crate::V3RuntimeObservability::default();
    obs.provider_failure_events = vec![failure_event];

    let mut failed_meta = meta_with_full("r-failure-then-success");
    failed_meta.error_category = Some("provider_http_502".to_string());
    failed_meta.error_detail = Some("provider returned HTTP 502".to_string());
    record_observed(
        &o,
        V3ObsEventType::ProviderAttemptFailed,
        &key,
        scope(5555),
        failed_meta,
        &obs,
    )
    .unwrap();

    // Completed rebuilds meta from the fresh payload; the category must survive.
    record_observed(
        &o,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-failure-then-success"),
        &obs,
    )
    .unwrap();
    let rows = o.rows().unwrap();
    let row = rows.get(&key).expect("row");
    assert_eq!(
        row.meta.error_category.as_deref(),
        Some("provider_http_502"),
        "error_category must survive Completed meta rebuild"
    );
    assert!(row.failed_attempts >= 1);
}

#[test]
fn terminal_provider_attempt_failure_is_persisted_in_row() {
    let o = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-failure-terminal");
    record(
        &o,
        V3ObsEventType::Started,
        &key,
        scope(5555),
        meta_with_full("r-failure-terminal"),
    )
    .unwrap();

    let mut failure_event = crate::V3RuntimeProviderFailureObservation::default();
    failure_event.error_type = Some("provider_http_503".to_string());
    failure_event.message = "provider returned HTTP 503".to_string();
    let mut obs = crate::V3RuntimeObservability::default();
    obs.provider_failure_events = vec![failure_event];

    let mut failed_meta = meta_with_full("r-failure-terminal");
    failed_meta.error_category = Some("provider_http_503".to_string());
    failed_meta.error_detail = Some("provider returned HTTP 503".to_string());
    record_observed(
        &o,
        V3ObsEventType::ProviderAttemptFailed,
        &key,
        scope(5555),
        failed_meta.clone(),
        &obs,
    )
    .unwrap();
    record_observed(
        &o,
        V3ObsEventType::Failed,
        &key,
        scope(5555),
        failed_meta,
        &obs,
    )
    .unwrap();

    let rows = o.rows().unwrap();
    let row = rows.get(&key).expect("failed row");
    assert_eq!(row.result.as_deref(), Some("error"));
    assert_eq!(row.failed_attempts, 1);
    assert_eq!(
        row.meta.error_category.as_deref(),
        Some("provider_http_503")
    );
}

fn meta(req: &str) -> V3ObsRequestMeta {
    V3ObsRequestMeta {
        request_id: req.to_string(),
        endpoint: "/v1/chat/completions".to_string(),
        model: Some("m".to_string()),
        route: Some("grp.pool".to_string()),
        provider: Some("p1".to_string()),
        ..Default::default()
    }
}

#[test]
fn request_key_is_port_plus_rid() {
    assert_eq!(build_v3_obs_request_key(5555, "abc"), "5555:abc");
}

#[test]
fn lifecycle_upserts_same_row() {
    let o = V3WebuiObservability::new();
    let k = build_v3_obs_request_key(5555, "r1");
    let s = record(&o, V3ObsEventType::Started, &k, scope(5555), meta("r1")).unwrap();
    assert!(s >= 1);
    // route + provider attempt update the same row
    record(
        &o,
        V3ObsEventType::RouteSelected,
        &k,
        scope(5555),
        meta("r1"),
    )
    .unwrap();
    record(
        &o,
        V3ObsEventType::ProviderAttemptStarted,
        &k,
        scope(5555),
        meta("r1"),
    )
    .unwrap();
    let rows = o.rows().unwrap();
    assert_eq!(rows.len(), 1, "one request key => one row");
    let row = rows.get(&k).unwrap();
    assert_eq!(row.attempts, 1);
}

#[test]
fn failed_never_becomes_success() {
    let o = V3WebuiObservability::new();
    let k = build_v3_obs_request_key(5555, "r3");
    record(&o, V3ObsEventType::Started, &k, scope(5555), meta("r3")).unwrap();
    record(&o, V3ObsEventType::Failed, &k, scope(5555), meta("r3")).unwrap();
    let rows = o.rows().unwrap();
    let row = rows.get(&k).unwrap();
    assert_eq!(row.result.as_deref(), Some("error"));
}

#[test]
fn failed_terminal_cannot_become_completed_or_cancelled() {
    let o = V3WebuiObservability::new();
    let key = build_v3_obs_request_key(5555, "r-error-terminal");
    let mut failed_meta = meta_with_full("r-error-terminal");
    failed_meta.error_category = Some("provider_http_429".to_string());
    failed_meta.error_detail = Some("rate limited".to_string());

    record(
        &o,
        V3ObsEventType::Started,
        &key,
        scope(5555),
        failed_meta.clone(),
    )
    .unwrap();
    record(&o, V3ObsEventType::Failed, &key, scope(5555), failed_meta).unwrap();
    record(
        &o,
        V3ObsEventType::Completed,
        &key,
        scope(5555),
        meta_with_full("r-error-terminal"),
    )
    .unwrap();
    record(
        &o,
        V3ObsEventType::Cancelled,
        &key,
        scope(5555),
        meta_with_full("r-error-terminal"),
    )
    .unwrap();

    let rows = o.rows().unwrap();
    let row = rows.get(&key).expect("failed row");
    assert_eq!(row.event_type, "request.failed");
    assert_eq!(row.result.as_deref(), Some("error"));
    assert_eq!(
        row.meta.error_category.as_deref(),
        Some("provider_http_429")
    );
}

/// `raw_artifact_ref` is real only when the debug sample directory exists:
/// it is never fabricated, and it must not resolve for a different port,
/// a different protocol directory, or a blank request id.
#[test]
fn raw_artifact_ref_resolves_only_for_an_existing_sample_dir() {
    let root = std::env::temp_dir().join(format!(
        "v3-obs-artifact-ref-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();

    // Absent directory: an honest `None`, not a fabricated path.
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(
            &root,
            5555,
            Some("responses"),
            Some("/v1/responses"),
            "req-absent"
        ),
        None
    );

    let dir = routecodex_v3_debug::v3_codex_sample_request_dir_in(
        &root,
        5555,
        "responses",
        "/v1/responses",
        "req-present",
    );
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(
            &root,
            5555,
            Some("responses"),
            Some("/v1/responses"),
            "req-present"
        ),
        Some(dir.display().to_string())
    );

    // Same request id, but a different port, a different entry protocol
    // directory, or an unusable request id must not resolve.
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(
            &root,
            4444,
            Some("responses"),
            Some("/v1/responses"),
            "req-present"
        ),
        None
    );
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(
            &root,
            5555,
            Some("openai_chat"),
            Some("/v1/chat/completions"),
            "req-present"
        ),
        None
    );
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(
            &root,
            5555,
            Some("responses"),
            Some("/v1/responses"),
            "   "
        ),
        None
    );
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(&root, 5555, None, Some("/v1/responses"), "req-present"),
        None
    );
    assert_eq!(
        resolve_v3_obs_raw_artifact_ref_in(&root, 5555, Some("responses"), None, "req-present"),
        None
    );

    std::fs::remove_dir_all(&root).unwrap();
}

/// The six-node chain the terminal Error06 projection records, built through the
/// store's own projection so the fixtures carry the same shape as production.
fn typed_v3_error_chain(status: u16, error_class: Option<&str>) -> Vec<V3ObsErrorChainNode> {
    build_v3_obs_error_chain(
        &routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS,
        error_class,
        status,
    )
}

fn v3_obs_truth(source: &str, chain: Vec<V3ObsErrorChainNode>) -> V3ObsErrorTruth {
    V3ObsErrorTruth {
        source: source.to_string(),
        chain,
        ..Default::default()
    }
}

fn assert_v3_obs_truth_is_real_typed(actual: &V3ObsErrorTruth) {
    assert_eq!(
        actual.source, "error06_projection",
        "typed truth must win over the not_exposed absence marker"
    );
    assert!(
        actual.chain.len() == 6 && !actual.chain.is_empty(),
        "the real six-node chain must survive, got: {:?}",
        actual
            .chain
            .iter()
            .map(|node| (&node.node, &node.state, &node.code))
            .collect::<Vec<_>>()
    );
    assert_eq!(actual.chain[0].node, "V3Error01SourceRaised");
    assert_eq!(actual.chain[5].node, "V3Error06ClientProjected");
    assert_eq!(actual.chain[5].code.as_deref(), Some("502"));
}

/// Precedence is monotonic and order-independent: a real typed observation beats
/// the `error06_projection_not_exposed` absence marker whichever is merged first.
#[test]
fn observed_error_precedence_is_order_independent_marker_then_real_and_real_then_marker() {
    let real = || typed_v3_error_chain(502, Some("runtime_failure"));
    let marker = || V3ObsErrorTruth {
        source: "error06_projection_not_exposed".to_string(),
        ..Default::default()
    };

    // Marker arrives first, real typed truth arrives later.
    let merged = merge_v3_obs_error_truth(
        Some(v3_obs_truth("error06_projection_not_exposed", vec![])),
        Some(v3_obs_truth("error06_projection", real())),
    );
    assert_v3_obs_truth_is_real_typed(merged.as_ref().expect("merge produced a truth"));

    // Real typed truth arrives first, marker arrives later: the marker must not
    // clear the recorded real chain.
    let merged = merge_v3_obs_error_truth(
        Some(v3_obs_truth("error06_projection", real())),
        Some(marker()),
    );
    assert_v3_obs_truth_is_real_typed(merged.as_ref().expect("merge produced a truth"));

    // A later marker against the non-terminal attempt snapshot still wins the
    // source (terminal beats attempt) without fabricating a chain.
    let merged = merge_v3_obs_error_truth(
        Some(V3ObsErrorTruth {
            source: "provider_attempt_failure".to_string(),
            ..Default::default()
        }),
        Some(marker()),
    )
    .expect("truth");
    assert_eq!(merged.source, "error06_projection_not_exposed");
    assert!(merged.chain.is_empty());
}

/// The absence marker is a statement about the carrier, not about the request, so
/// merging it with itself (or with nothing) is idempotent: it never becomes a
/// real chain on its own.
#[test]
fn observed_error_not_exposed_marker_is_idempotent_and_never_fabricates_a_chain() {
    let marker = || V3ObsErrorTruth {
        source: "error06_projection_not_exposed".to_string(),
        ..Default::default()
    };

    let merged = merge_v3_obs_error_truth(None, Some(marker())).expect("truth");
    assert_eq!(merged.source, "error06_projection_not_exposed");
    assert!(merged.chain.is_empty());

    let merged = merge_v3_obs_error_truth(Some(marker()), Some(marker())).expect("truth");
    assert_eq!(merged.source, "error06_projection_not_exposed");
    assert!(
        merged.chain.is_empty(),
        "an absence marker must never turn into a chain"
    );

    let merged = merge_v3_obs_error_truth(Some(marker()), None).expect("truth");
    assert_eq!(merged.source, "error06_projection_not_exposed");
    assert!(merged.chain.is_empty());
}

/// The non-terminal provider-attempt snapshot is diagnostic and never outranks a
/// terminal Error06 observation, in either arrival order.
#[test]
fn observed_error_attempt_snapshot_never_outranks_terminal_projection() {
    let attempt = || V3ObsErrorTruth {
        source: "provider_attempt_failure".to_string(),
        internal_code: Some("V3Error01SourceRaised".to_string()),
        external_error_status: Some(503),
        failure_count: Some(1),
        ..Default::default()
    };

    let merged = merge_v3_obs_error_truth(
        Some(v3_obs_truth(
            "error06_projection",
            typed_v3_error_chain(502, Some("runtime_failure")),
        )),
        Some(attempt()),
    );
    let merged = merged.expect("merge produced a truth");
    assert_eq!(merged.source, "error06_projection");
    assert_eq!(merged.chain.len(), 6);
    assert_eq!(
        merged.failure_count,
        Some(1),
        "attempt fields must still survive the merge"
    );

    let merged = merge_v3_obs_error_truth(
        Some(attempt()),
        Some(v3_obs_truth(
            "error06_projection",
            typed_v3_error_chain(502, Some("runtime_failure")),
        )),
    );
    assert_v3_obs_truth_is_real_typed(merged.as_ref().expect("merge produced a truth"));
}

/// The row-level rule and the merge rule agree: a second terminal event for an
/// already-terminal request merges its observed_error (precedence wins) without
/// restarting the outcome, duration or counters. Whichever lane projects first —
/// relay absence marker or direct typed chain — the row ends with real typed
/// truth, and a later marker can never clear it.
#[test]
fn terminal_error_truth_merges_across_any_lane_order() {
    let marker = || v3_obs_truth("error06_projection_not_exposed", vec![]);
    let real = || {
        v3_obs_truth(
            "error06_projection",
            typed_v3_error_chain(502, Some("runtime_failure")),
        )
    };

    for (first, second) in [(marker(), real()), (real(), marker())] {
        let observability = V3WebuiObservability::new();
        let key = build_v3_obs_request_key(6000, "req-merge-order");
        let meta = |observed: V3ObsErrorTruth| V3ObsRequestMeta {
            request_id: "req-merge-order".to_string(),
            endpoint: "/v1/responses".to_string(),
            observed_error: Some(observed),
            ..Default::default()
        };
        let scope = V3ObsScope {
            port: 6000,
            workdir: Some("/w".to_string()),
            session: Some("s1".to_string()),
        };
        observability
            .record_observed(
                V3ObsEventType::Failed,
                &key,
                scope.clone(),
                meta(first),
                &crate::V3RuntimeObservability::default(),
            )
            .unwrap();
        let rows_before = observability.rows().unwrap();
        let finished_before = rows_before.get("6000:req-merge-order").map(|row| {
            (
                row.finished_epoch_ms,
                row.duration_ms,
                row.failed_attempts,
                row.result.clone(),
            )
        });
        observability
            .record_observed(
                V3ObsEventType::Failed,
                &key,
                scope,
                meta(second),
                &crate::V3RuntimeObservability::default(),
            )
            .unwrap();

        let rows = observability.rows().unwrap();
        let row = rows.get("6000:req-merge-order").expect("the request row");
        assert_eq!(
            row.meta
                .observed_error
                .as_ref()
                .map(|truth| truth.source.as_str()),
            Some("error06_projection"),
            "real typed truth must win in both arrival orders"
        );
        assert_eq!(row.meta.observed_error.as_ref().unwrap().chain.len(), 6);
        assert_eq!(row.result.as_deref(), Some("error"));
        let (finished_before, duration_before, attempts_before, result_before) =
            finished_before.unwrap();
        assert_eq!(
            row.finished_epoch_ms, finished_before,
            "a second terminal event must not restart the request outcome"
        );
        assert_eq!(row.duration_ms, duration_before);
        assert_eq!(row.failed_attempts, attempts_before);
        assert_eq!(row.result, result_before);
    }
}

/// The relay lane cannot carry the typed `V3Error06ClientProjected`, so its
/// absence marker must survive verbatim: there is no real chain here to replace
/// it with, and inventing one would be a lie.
#[test]
fn relay_lane_absence_marker_survives_when_no_typed_projection_exists() {
    let observability = V3WebuiObservability::new();
    record_v3_webui_error_projection(
        &observability,
        6000,
        "req-relay-unexposed",
        "/v1/responses",
        "responses",
        None,
        Some("s1"),
        502,
        Some(
            &serde_json::json!({"error":{"code":"provider_pool_exhausted","message":"exhausted"}}),
        ),
        V3ObsErrorProjection::default(),
    )
    .unwrap();

    let rows = observability.rows().unwrap();
    let row = rows
        .get("6000:req-relay-unexposed")
        .expect("the relay lane row");
    let observed = row
        .meta
        .observed_error
        .as_ref()
        .expect("the relay lane must record an observed_error");
    assert_eq!(
        observed.source, "error06_projection_not_exposed",
        "the relay lane marker is the honest answer and must not be dropped"
    );
    assert!(
        observed.chain.is_empty(),
        "an empty chain is honest here: no typed projection exists to record"
    );

    // A later marker for the same request must stay a marker, not become a real
    // chain (the marker is idempotent because it carries no facts to win).
    let observed_after_second_marker = merge_v3_obs_error_truth(
        row.meta.observed_error.clone(),
        Some(v3_obs_truth("error06_projection_not_exposed", vec![])),
    )
    .expect("merge produced a truth");
    assert_eq!(
        observed_after_second_marker.source,
        "error06_projection_not_exposed"
    );
    assert!(observed_after_second_marker.chain.is_empty());
}

#[test]
fn persistence_writer_start_failure_raises_alarm_instead_of_panicking() {
    // A failed spawn drops the receive side; the writer must degrade to the
    // persistence alarm instead of unwrapping the thread at listener startup.
    let (sender, receiver) = mpsc::sync_channel(V3_WEBUI_PERSISTENCE_QUEUE_CAPACITY);
    drop(receiver);
    let alarm = Arc::new(RwLock::new(None));
    let writer = V3WebuiObservabilityPersistenceWriter::after_spawn(
        sender,
        Arc::clone(&alarm),
        Err(std::io::Error::other("injected writer start failure")),
    );

    let failure = alarm
        .read()
        .expect("observability alarm lock")
        .clone()
        .expect("a failed writer start must raise the persistence alarm");
    assert!(
        failure.contains("observability persistence writer start failed"),
        "{failure}"
    );

    // The listener keeps serving: append and flush fail loudly instead of
    // unwrapping the writer thread.
    writer.enqueue(V3ObsRequestRow::default());
    assert!(writer.flush().is_err());
}
