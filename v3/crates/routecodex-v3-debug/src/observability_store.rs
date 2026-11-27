// Shared JSONL envelope owner for the per-listener WebUI request-records store.
// Server writes lifecycle rows and Admin reads them through this module; the
// row is a typed serde_json::Value so each crate can decode its own typed row
// without owning a second file format. Reads fold lifecycle rows by
// request_key so each request is projected once at its latest lifecycle state.
//
// Store mutation contract: normal writes append one complete newline-terminated
// row; retention compaction writes a replacement file and atomically renames it
// over the store path. The path is never rewritten in place.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION: u64 = 1;
pub const V3_PROVIDER_USAGE_FACTS_SCHEMA_VERSION: u64 = 1;
const PROVIDER_USAGE_LATEST_FACT_RECOVERY_GAP: &str =
    "provider_usage_fact_capacity_latest_recovered";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum V3ProviderUsageFactResult {
    Success,
    Error,
    Cancelled,
    Active,
    FailedAttempt,
    Issue,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderUsageFact {
    pub listener_id: u16,
    pub request_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_ordinal: Option<u64>,
    pub request_started_epoch_ms: u64,
    pub result: V3ProviderUsageFactResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gaps: Vec<String>,
}

impl V3ProviderUsageFact {
    pub fn target_identity(&self) -> Result<String, V3WebuiObservabilityStoreError> {
        if !self
            .request_key
            .starts_with(&format!("{}:", self.listener_id))
        {
            return Err(V3WebuiObservabilityStoreError::Decode(format!(
                "provider usage fact listener {} does not own request key {}",
                self.listener_id, self.request_key
            )));
        }
        if self.result == V3ProviderUsageFactResult::FailedAttempt && self.attempt_ordinal.is_none()
        {
            return Ok(format!(
                "ambiguous-attempt:{}:{}",
                self.listener_id, self.request_key
            ));
        }
        let kind = if self.attempt_ordinal.is_some() {
            "attempt"
        } else {
            "request"
        };
        Ok(format!(
            "{kind}:{}:{}:{}",
            self.listener_id,
            self.request_key,
            self.attempt_ordinal
                .map(|value| value.to_string())
                .unwrap_or_default()
        ))
    }

    fn merge_gaps(&mut self, gaps: impl IntoIterator<Item = String>) {
        let mut merged = std::mem::take(&mut self.gaps)
            .into_iter()
            .collect::<BTreeSet<_>>();
        merged.extend(gaps);
        self.gaps = merged.into_iter().collect();
        self.gaps.sort();
    }

    pub fn from_row(
        row: &Value,
        ordinal: Option<u64>,
        gaps: impl IntoIterator<Item = String>,
    ) -> Result<Option<Self>, V3WebuiObservabilityStoreError> {
        let listener_id = row
            .get("scope")
            .and_then(|scope| scope.get("port"))
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());
        let request_key = row.get("request_key").and_then(Value::as_str);
        let request_started_epoch_ms = row
            .get("started_epoch_ms")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let Some((listener_id, request_key)) = listener_id.zip(request_key) else {
            return Ok(None);
        };
        let event_type = row
            .get("event_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let failed_attempt = event_type == "request.provider_attempt_failed";
        let result = match row.get("result").and_then(Value::as_str) {
            Some("success") => V3ProviderUsageFactResult::Success,
            Some("error") => V3ProviderUsageFactResult::Error,
            Some("cancelled") => V3ProviderUsageFactResult::Cancelled,
            Some("issue") => V3ProviderUsageFactResult::Issue,
            Some(_) => V3ProviderUsageFactResult::Unknown,
            None if failed_attempt => V3ProviderUsageFactResult::FailedAttempt,
            None if row.get("finished_epoch_ms").is_none() => V3ProviderUsageFactResult::Active,
            None => V3ProviderUsageFactResult::Unknown,
        };
        let provider_id = row
            .get("meta")
            .and_then(|meta| meta.get("provider_id").or_else(|| meta.get("provider")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let usage = (result == V3ProviderUsageFactResult::Success)
            .then(|| row.get("usage").filter(|value| !value.is_null()).cloned())
            .flatten();
        let mut gaps = gaps.into_iter().collect::<Vec<_>>();
        if row
            .get("started_epoch_ms")
            .and_then(Value::as_u64)
            .is_none()
        {
            gaps.push("missing_request_started".to_string());
        }
        if failed_attempt && ordinal.is_none() {
            gaps.push("missing_attempt_ordinal".to_string());
        }
        if result == V3ProviderUsageFactResult::Success && usage.is_none() {
            gaps.push("missing_usage".to_string());
        }
        if provider_id.is_none() {
            gaps.push("missing_provider_id".to_string());
        }
        let mut fact = Self {
            listener_id,
            request_key: request_key.to_string(),
            attempt_ordinal: ordinal,
            request_started_epoch_ms,
            result,
            provider_id,
            usage,
            gaps,
        };
        fact.merge_gaps(std::iter::empty());
        Ok(Some(fact))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct V3ProviderUsageCoverage {
    pub listener_id: u16,
    pub statistics_started_epoch_ms: Option<u64>,
    pub detail_started_epoch_ms: Option<u64>,
    pub detail_incomplete: bool,
    pub gaps: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct V3ProviderUsageGenerationState {
    pub open: bool,
    pub opened_epoch_ms: Option<u64>,
    pub last_normal_end_epoch_ms: Option<u64>,
    pub abnormal_generation_count: u64,
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderUsageRead {
    pub facts: Vec<V3ProviderUsageFact>,
    pub coverage: Vec<V3ProviderUsageCoverage>,
}

/// Resource budget for one provider-usage fact store. Production opens use the
/// fixed defaults; explicit values allow deterministic owner tests without a
/// runtime configuration path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ProviderUsagePersistenceLimits {
    pub latest_encoded_fact_bytes: u64,
    pub max_facts: usize,
    pub physical_fact_log_bytes: u64,
    pub complete_fact_bytes: u64,
    pub companion_state_bytes: u64,
}

impl Default for V3ProviderUsagePersistenceLimits {
    fn default() -> Self {
        Self {
            latest_encoded_fact_bytes: 32 * 1024 * 1024,
            max_facts: 100_000,
            physical_fact_log_bytes: 64 * 1024 * 1024,
            complete_fact_bytes: 64 * 1024,
            companion_state_bytes: 64 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderUsageCapacityReason {
    LatestFactBytes,
    FactKeys,
    CompleteFactBytes,
    PhysicalFactLogBytes,
    CompanionStateBytes,
    LegacyStoreOverLimit,
}

impl V3ProviderUsageCapacityReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LatestFactBytes => "latest",
            Self::FactKeys => "keys",
            Self::CompleteFactBytes => "record",
            Self::PhysicalFactLogBytes => "physical",
            Self::CompanionStateBytes => "companion",
            Self::LegacyStoreOverLimit => "legacy_store_over_limit",
        }
    }
}

impl V3ProviderUsageRead {
    pub fn latest_facts(&self) -> BTreeMap<String, &V3ProviderUsageFact> {
        self.facts
            .iter()
            .filter_map(|fact| fact.target_identity().ok().map(|identity| (identity, fact)))
            .collect()
    }

    pub fn coverage_for(&self, listener_id: u16) -> Option<&V3ProviderUsageCoverage> {
        self.coverage
            .iter()
            .find(|coverage| coverage.listener_id == listener_id)
    }
}

fn record_provider_usage_latest_fact_recovery(
    coverage: &mut BTreeMap<u16, V3ProviderUsageCoverage>,
    listener_ids: impl IntoIterator<Item = u16>,
    latest_encoded_bytes: u64,
    limits: V3ProviderUsagePersistenceLimits,
) {
    if latest_encoded_bytes <= limits.latest_encoded_fact_bytes {
        return;
    }
    for listener_id in listener_ids.into_iter().collect::<BTreeSet<_>>() {
        let coverage = coverage
            .entry(listener_id)
            .or_insert_with(|| V3ProviderUsageCoverage {
                listener_id,
                ..Default::default()
            });
        coverage.detail_incomplete = true;
        coverage
            .gaps
            .push(PROVIDER_USAGE_LATEST_FACT_RECOVERY_GAP.to_string());
        normalize_coverage(coverage);
    }
}

/// Incremental owner for one observability store path.
///
/// The server keeps one instance for the lifetime of its single writer thread.
/// It loads existing facts once, then appends new fact revisions without
/// rescanning the accumulated fact log. Coverage is written only when its
/// content changes.
pub struct V3ProviderUsagePersistenceStore {
    observability_path: PathBuf,
    facts_path: PathBuf,
    coverage_path: PathBuf,
    generation_path: PathBuf,
    facts: BTreeMap<String, V3ProviderUsageFact>,
    coverage: BTreeMap<u16, V3ProviderUsageCoverage>,
    pending_repair_gaps: Vec<String>,
    generation: V3ProviderUsageGenerationState,
    limits: V3ProviderUsagePersistenceLimits,
    latest_encoded_bytes: u64,
    encoded_fact_bytes: BTreeMap<String, u64>,
}

impl V3ProviderUsagePersistenceStore {
    pub fn open(observability_path: &Path) -> Result<Self, V3WebuiObservabilityStoreError> {
        Self::open_with_limits(
            observability_path,
            V3ProviderUsagePersistenceLimits::default(),
        )
    }

    pub fn open_with_limits(
        observability_path: &Path,
        limits: V3ProviderUsagePersistenceLimits,
    ) -> Result<Self, V3WebuiObservabilityStoreError> {
        if let Some(parent) = observability_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let facts_path = v3_provider_usage_facts_path(observability_path);
        let coverage_path = v3_provider_usage_coverage_path(observability_path);
        let generation_path = v3_provider_usage_generation_path(observability_path);
        remove_provider_usage_facts_temp_file(&facts_path);
        ensure_provider_usage_file_within_limit(&facts_path, limits.physical_fact_log_bytes)?;
        let mut generation = read_provider_usage_generation(&generation_path, limits)?;
        let previous_generation_abnormal = generation.open;
        generation.open = true;
        generation.opened_epoch_ms = Some(now_epoch_ms());
        if previous_generation_abnormal {
            generation.abnormal_generation_count =
                generation.abnormal_generation_count.saturating_add(1);
        }
        let replay = read_provider_usage_facts_path(&facts_path, limits)?;
        let fact_tail_repaired =
            truncate_incomplete_jsonl_tail(&facts_path, limits.physical_fact_log_bytes)?;
        let detail_tail_repaired = truncate_incomplete_jsonl_tail(observability_path, u64::MAX)?;
        let facts = replay.facts;
        let encoded_fact_bytes = facts
            .iter()
            .map(|(identity, fact)| {
                provider_usage_fact_line(fact)
                    .map(|line| {
                        (
                            identity.clone(),
                            encoded_provider_usage_fact_line_len(&line),
                        )
                    })
                    .map_err(|error| {
                        V3WebuiObservabilityStoreError::ProviderUsageFact(error.to_string())
                    })
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let latest_encoded_bytes = encoded_fact_bytes.values().copied().sum();
        let mut coverage = read_provider_usage_coverage(&coverage_path, limits)?;
        record_provider_usage_latest_fact_recovery(
            &mut coverage,
            facts.values().map(|fact| fact.listener_id),
            latest_encoded_bytes,
            limits,
        );
        let mut store = Self {
            observability_path: observability_path.to_path_buf(),
            facts_path,
            coverage_path,
            generation_path,
            facts,
            coverage,
            pending_repair_gaps: Vec::new(),
            generation,
            limits,
            latest_encoded_bytes,
            encoded_fact_bytes,
        };
        if fact_tail_repaired {
            store
                .pending_repair_gaps
                .push("incomplete_fact_tail".to_string());
        }
        if detail_tail_repaired {
            store
                .pending_repair_gaps
                .push("incomplete_detail_tail".to_string());
        }
        if previous_generation_abnormal {
            store
                .pending_repair_gaps
                .push("abnormal_previous_generation".to_string());
        }
        if !store.pending_repair_gaps.is_empty() && !store.coverage.is_empty() {
            for gap in store.pending_repair_gaps.clone() {
                for coverage in store.coverage.values_mut() {
                    coverage.detail_incomplete = true;
                    coverage.gaps.push(gap.clone());
                    normalize_coverage(coverage);
                }
            }
            store.pending_repair_gaps.clear();
        }
        store.write_generation_if_changed()?;
        store.write_coverage_if_changed()?;
        Ok(store)
    }

    pub fn observability_path(&self) -> &Path {
        &self.observability_path
    }

    pub fn append_fact(
        &mut self,
        mut fact: V3ProviderUsageFact,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        let identity = fact.target_identity()?;
        if let Some(previous) = self.facts.get(&identity) {
            merge_provider_usage_fact(previous, &mut fact);
            if *previous == fact {
                return Ok(());
            }
        }

        let line = provider_usage_fact_line(&fact)?;
        let encoded_line_bytes = encoded_provider_usage_fact_line_len(&line);
        if line.len() as u64 > self.limits.complete_fact_bytes {
            return self.reject_fact_capacity(
                fact.listener_id,
                fact.request_started_epoch_ms,
                V3ProviderUsageCapacityReason::CompleteFactBytes,
            );
        }

        let old_encoded_bytes = self.encoded_fact_bytes.get(&identity).copied().unwrap_or(0);
        let next_fact_count = self.facts.len() + usize::from(old_encoded_bytes == 0);
        if next_fact_count > self.limits.max_facts {
            return self.reject_fact_capacity(
                fact.listener_id,
                fact.request_started_epoch_ms,
                V3ProviderUsageCapacityReason::FactKeys,
            );
        }

        let next_latest_bytes = self
            .latest_encoded_bytes
            .saturating_sub(old_encoded_bytes)
            .saturating_add(encoded_line_bytes);
        let latest_capacity_exceeded =
            self.latest_encoded_bytes > self.limits.latest_encoded_fact_bytes;
        if next_latest_bytes > self.limits.latest_encoded_fact_bytes
            && (!latest_capacity_exceeded || next_latest_bytes > self.latest_encoded_bytes)
        {
            return self.reject_fact_capacity(
                fact.listener_id,
                fact.request_started_epoch_ms,
                V3ProviderUsageCapacityReason::LatestFactBytes,
            );
        }

        let current_fact_bytes = fs::metadata(&self.facts_path)
            .map(|metadata| metadata.len())
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(0)
                } else {
                    Err(error)
                }
            })?;
        let mut stable_set_written = false;
        if current_fact_bytes.saturating_add(encoded_line_bytes)
            > self.limits.physical_fact_log_bytes
        {
            if self.latest_encoded_bytes.saturating_add(encoded_line_bytes)
                <= self.limits.physical_fact_log_bytes
            {
                self.compact_provider_usage_facts()?;
            } else if next_latest_bytes <= self.limits.physical_fact_log_bytes {
                self.compact_provider_usage_facts_with_replacement(&identity, &fact)?;
                stable_set_written = true;
            } else {
                return self.reject_fact_capacity(
                    fact.listener_id,
                    fact.request_started_epoch_ms,
                    V3ProviderUsageCapacityReason::PhysicalFactLogBytes,
                );
            }
        }

        if !stable_set_written {
            append_provider_usage_fact_line(&self.facts_path, &line)?;
        }
        self.apply_pending_repair_gaps_for(fact.listener_id);
        self.ensure_statistics_started(fact.listener_id, fact.request_started_epoch_ms);
        if old_encoded_bytes == 0 {
            self.latest_encoded_bytes =
                self.latest_encoded_bytes.saturating_add(encoded_line_bytes);
        } else {
            self.latest_encoded_bytes = self
                .latest_encoded_bytes
                .saturating_sub(old_encoded_bytes)
                .saturating_add(encoded_line_bytes);
        }
        self.encoded_fact_bytes
            .insert(identity.clone(), encoded_line_bytes);
        self.facts.insert(identity, fact);
        Ok(())
    }

    pub fn persist_row_before_detail(
        &mut self,
        row: &Value,
        ordinal: Option<u64>,
        attempt_inserted: bool,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        let mut gaps = Vec::new();
        let listener_id = row
            .get("scope")
            .and_then(|scope| scope.get("port"))
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());
        let started = row
            .get("started_epoch_ms")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let event_type = row
            .get("event_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "request.provider_attempt_failed" && !attempt_inserted {
            gaps.push("attempt_identity_ambiguous".to_string());
        }
        if let Some(fact) = V3ProviderUsageFact::from_row(row, ordinal, gaps)? {
            let fact_gaps = fact.gaps.clone();
            let fact_listener = fact.listener_id;
            self.append_fact(fact)?;
            for gap in fact_gaps {
                self.mark_coverage_gap(fact_listener, &gap, true);
            }
        }
        if let Some(listener_id) = listener_id {
            self.apply_pending_repair_gaps_for(listener_id);
            self.ensure_statistics_started(listener_id, started);
        }
        self.write_coverage_if_changed()
    }

    pub fn ensure_statistics_coverage(
        &mut self,
        listener_id: u16,
        started_epoch_ms: u64,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        self.ensure_statistics_started(listener_id, started_epoch_ms);
        self.write_coverage_if_changed()
    }

    pub fn mark_detail_started(
        &mut self,
        listener_id: u16,
        started_epoch_ms: u64,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        let entry = self.ensure_coverage_entry(listener_id);
        entry.detail_started_epoch_ms = Some(
            entry
                .detail_started_epoch_ms
                .map_or(started_epoch_ms, |current| current.min(started_epoch_ms)),
        );
        normalize_coverage(entry);
        self.write_coverage_if_changed()
    }

    pub fn persist_queue_gap(
        &mut self,
        listener_id: u16,
        request_key: &str,
        started_epoch_ms: u64,
        gap: &str,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        self.ensure_statistics_started(listener_id, started_epoch_ms);
        self.mark_gap(listener_id, request_key, None, gap)?;
        self.write_coverage_if_changed()
    }

    pub fn mark_gap(
        &mut self,
        listener_id: u16,
        request_key: &str,
        attempt_ordinal: Option<u64>,
        gap: &str,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        let mut fact = V3ProviderUsageFact {
            listener_id,
            request_key: request_key.to_string(),
            attempt_ordinal,
            request_started_epoch_ms: 0,
            result: V3ProviderUsageFactResult::Unknown,
            provider_id: None,
            usage: None,
            gaps: vec![gap.to_string()],
        };
        if let Some(previous) = self.facts.get(&fact.target_identity()?) {
            fact = (*previous).clone();
            fact.merge_gaps([gap.to_string()]);
        }
        self.append_fact(fact)?;
        self.mark_coverage_gap(listener_id, gap, true);
        self.write_coverage_if_changed()
    }

    pub fn mark_coverage_gap_only(
        &mut self,
        listener_id: u16,
        gap: &str,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        self.mark_coverage_gap(listener_id, gap, true);
        self.write_coverage_if_changed()
    }

    pub fn mark_fact_write_failure(
        &mut self,
        listener_id: u16,
        started_epoch_ms: u64,
        detail_overflowed: bool,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        self.apply_pending_repair_gaps_for(listener_id);
        self.ensure_statistics_started(listener_id, started_epoch_ms);
        self.mark_coverage_gap(listener_id, "provider_usage_fact_write_failed", true);
        if detail_overflowed {
            self.mark_coverage_gap(
                listener_id,
                "provider_usage_fact_write_failed_detail_overflow",
                true,
            );
        }
        self.write_coverage_if_changed()
    }

    pub fn backfill_detail(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let lenient =
            v3_webui_observability_read_rows_bounded_lenient(&self.observability_path, usize::MAX);
        let detail_listeners = lenient
            .raw_rows
            .iter()
            .filter_map(provider_usage_row_listener)
            .collect::<BTreeSet<_>>();
        if !detail_listeners.is_empty() {
            let repair_gaps = std::mem::take(&mut self.pending_repair_gaps);
            for listener_id in detail_listeners {
                for gap in &repair_gaps {
                    self.mark_coverage_gap(listener_id, gap, true);
                }
            }
        }
        let mut appended = false;
        let mut earliest_detail = BTreeMap::<u16, u64>::new();
        for (identity, mut fact) in provider_usage_backfill_candidates(&lenient.raw_rows)? {
            if let Some(existing) = self.facts.get(&identity) {
                // Durable terminal facts are newer than the retained detail.
                // In particular, a later terminal correction must not be
                // replaced by an older row still present in the detail file.
                if provider_usage_fact_result_is_terminal(existing.result) {
                    continue;
                }
                merge_provider_usage_fact(existing, &mut fact);
                if existing == &fact {
                    continue;
                }
            }
            self.append_fact(fact)?;
            appended = true;
        }
        for row in &lenient.rows {
            if let Some((listener_id, started)) = provider_usage_row_listener_and_start(row) {
                earliest_detail
                    .entry(listener_id)
                    .and_modify(|value| *value = (*value).min(started))
                    .or_insert(started);
            }
        }
        for (listener_id, started) in earliest_detail {
            self.apply_pending_repair_gaps_for(listener_id);
            self.ensure_statistics_started(listener_id, started);
            let entry = self.ensure_coverage_entry(listener_id);
            entry.detail_started_epoch_ms = Some(
                entry
                    .detail_started_epoch_ms
                    .map_or(started, |current| current.min(started)),
            );
            normalize_coverage(entry);
        }
        if !lenient.skipped.is_empty() {
            let listeners = self.coverage.keys().copied().collect::<Vec<_>>();
            for listener_id in listeners {
                self.mark_coverage_gap(listener_id, "incomplete_detail_tail", true);
            }
        }
        if appended || !lenient.rows.is_empty() {
            for (listener_id, coverage) in &mut self.coverage {
                if !earliest_detail_contains(*listener_id, &lenient.rows) {
                    coverage.detail_incomplete = true;
                    coverage.gaps.push("detail_unavailable".to_string());
                    normalize_coverage(coverage);
                }
            }
        }
        self.write_coverage_if_changed()
    }

    pub fn flush(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        self.write_generation_if_changed()?;
        self.write_coverage_if_changed()
    }

    pub fn close_generation(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let listeners = self.coverage.keys().copied().collect::<Vec<_>>();
        for listener_id in listeners {
            self.apply_pending_repair_gaps_for(listener_id);
        }
        self.generation.open = false;
        self.generation.last_normal_end_epoch_ms = Some(now_epoch_ms());
        self.write_generation_if_changed()?;
        self.write_coverage_if_changed()
    }

    fn ensure_coverage_entry(&mut self, listener_id: u16) -> &mut V3ProviderUsageCoverage {
        self.coverage
            .entry(listener_id)
            .or_insert_with(|| V3ProviderUsageCoverage {
                listener_id,
                ..Default::default()
            })
    }

    fn ensure_statistics_started(&mut self, listener_id: u16, started_epoch_ms: u64) {
        self.apply_pending_repair_gaps_for(listener_id);
        let entry = self.ensure_coverage_entry(listener_id);
        entry.statistics_started_epoch_ms = Some(
            entry
                .statistics_started_epoch_ms
                .map_or(started_epoch_ms, |current| current.min(started_epoch_ms)),
        );
        normalize_coverage(entry);
    }

    fn mark_coverage_gap(&mut self, listener_id: u16, gap: &str, detail_incomplete: bool) {
        let entry = self.ensure_coverage_entry(listener_id);
        entry.gaps.push(gap.to_string());
        entry.detail_incomplete |= detail_incomplete;
        normalize_coverage(entry);
    }

    fn reject_fact_capacity(
        &mut self,
        listener_id: u16,
        started_epoch_ms: u64,
        reason: V3ProviderUsageCapacityReason,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        let gap = format!("provider_usage_fact_capacity_{}", reason.as_str());
        self.ensure_statistics_started(listener_id, started_epoch_ms);
        self.mark_coverage_gap(listener_id, &gap, true);
        self.pending_repair_gaps.clear();
        self.write_coverage_if_changed()?;
        Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity { reason })
    }

    fn compact_provider_usage_facts(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let mut bytes = Vec::new();
        for fact in self.facts.values() {
            append_provider_usage_fact_to_bytes(&mut bytes, fact, self.limits.complete_fact_bytes)?;
        }
        self.write_compacted_provider_usage_facts(&bytes)
    }

    fn compact_provider_usage_facts_with_replacement(
        &mut self,
        identity: &str,
        replacement: &V3ProviderUsageFact,
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        let mut bytes = Vec::new();
        let mut replacement_written = false;
        for (stored_identity, fact) in &self.facts {
            if !replacement_written && identity < stored_identity.as_str() {
                append_provider_usage_fact_to_bytes(
                    &mut bytes,
                    replacement,
                    self.limits.complete_fact_bytes,
                )?;
                replacement_written = true;
            }
            if stored_identity == identity {
                append_provider_usage_fact_to_bytes(
                    &mut bytes,
                    replacement,
                    self.limits.complete_fact_bytes,
                )?;
                replacement_written = true;
            } else {
                append_provider_usage_fact_to_bytes(
                    &mut bytes,
                    fact,
                    self.limits.complete_fact_bytes,
                )?;
            }
        }
        if !replacement_written {
            append_provider_usage_fact_to_bytes(
                &mut bytes,
                replacement,
                self.limits.complete_fact_bytes,
            )?;
        }
        self.write_compacted_provider_usage_facts(&bytes)
    }

    fn write_compacted_provider_usage_facts(
        &mut self,
        bytes: &[u8],
    ) -> Result<(), V3WebuiObservabilityStoreError> {
        if bytes.len() as u64 > self.limits.physical_fact_log_bytes {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::PhysicalFactLogBytes,
            });
        }
        if let Err(error) = write_provider_usage_facts_atomically(&self.facts_path, &bytes) {
            self.reopen_facts_after_write_error()?;
            return Err(error);
        }
        Ok(())
    }

    fn reopen_facts_after_write_error(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let replay = read_provider_usage_facts_path(&self.facts_path, self.limits)?;
        self.encoded_fact_bytes = replay
            .facts
            .iter()
            .map(|(identity, fact)| {
                provider_usage_fact_line(fact)
                    .map(|line| {
                        (
                            identity.clone(),
                            encoded_provider_usage_fact_line_len(&line),
                        )
                    })
                    .map_err(|error| {
                        V3WebuiObservabilityStoreError::ProviderUsageFact(error.to_string())
                    })
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        self.latest_encoded_bytes = self.encoded_fact_bytes.values().copied().sum();
        self.facts = replay.facts;
        record_provider_usage_latest_fact_recovery(
            &mut self.coverage,
            self.facts.values().map(|fact| fact.listener_id),
            self.latest_encoded_bytes,
            self.limits,
        );
        if replay.fact_tail_incomplete {
            self.pending_repair_gaps
                .push("incomplete_fact_tail".to_string());
        }
        Ok(())
    }

    fn apply_pending_repair_gaps_for(&mut self, listener_id: u16) {
        if self.pending_repair_gaps.is_empty() {
            return;
        }
        for gap in self.pending_repair_gaps.clone() {
            self.mark_coverage_gap(listener_id, &gap, true);
        }
        self.pending_repair_gaps.clear();
    }

    fn write_coverage_if_changed(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let coverage = self
            .coverage
            .values()
            .cloned()
            .map(|mut entry| {
                normalize_coverage(&mut entry);
                entry
            })
            .collect::<Vec<_>>();
        let next_bytes = serde_json::to_vec_pretty(&coverage)
            .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
        ensure_companion_state_bytes(next_bytes.len() as u64, self.limits)?;
        let current_bytes =
            read_bounded_file(&self.coverage_path, self.limits.companion_state_bytes)
                .ok()
                .flatten();
        if current_bytes.as_deref() == Some(next_bytes.as_slice()) {
            return Ok(());
        }
        write_encoded_file_atomically(&self.coverage_path, &next_bytes)?;
        Ok(())
    }

    fn write_generation_if_changed(&mut self) -> Result<(), V3WebuiObservabilityStoreError> {
        let next_bytes = serde_json::to_vec_pretty(&self.generation)
            .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
        ensure_companion_state_bytes(next_bytes.len() as u64, self.limits)?;
        let current_bytes =
            read_bounded_file(&self.generation_path, self.limits.companion_state_bytes)
                .ok()
                .flatten();
        if current_bytes.as_deref() == Some(next_bytes.as_slice()) {
            return Ok(());
        }
        write_encoded_file_atomically(&self.generation_path, &next_bytes)
    }
}

fn provider_usage_backfill_candidates(
    rows: &[Value],
) -> Result<BTreeMap<String, V3ProviderUsageFact>, V3WebuiObservabilityStoreError> {
    let mut candidates = BTreeMap::<String, V3ProviderUsageFact>::new();
    for row in rows {
        let Some(event_type) = row.get("event_type").and_then(Value::as_str) else {
            continue;
        };
        if !provider_usage_row_is_fact_event(event_type, row) {
            continue;
        }
        let failed_attempt = event_type == "request.provider_attempt_failed";
        let ordinal = failed_attempt
            .then(|| {
                row.get("meta")
                    .and_then(|meta| meta.get("observed_error"))
                    .and_then(|error| error.get("attempt_index"))
                    .and_then(Value::as_u64)
            })
            .flatten();
        let gaps = if failed_attempt && ordinal.is_none() {
            vec!["missing_attempt_ordinal".to_string()]
        } else {
            Vec::new()
        };
        let Some(mut fact) = V3ProviderUsageFact::from_row(row, ordinal, gaps)? else {
            continue;
        };
        let identity = fact.target_identity()?;
        if let Some(previous) = candidates.get(&identity) {
            merge_provider_usage_fact(previous, &mut fact);
        }
        candidates.insert(identity, fact);
    }
    Ok(candidates)
}

fn provider_usage_fact_result_is_terminal(result: V3ProviderUsageFactResult) -> bool {
    matches!(
        result,
        V3ProviderUsageFactResult::Success
            | V3ProviderUsageFactResult::Error
            | V3ProviderUsageFactResult::Cancelled
            | V3ProviderUsageFactResult::Issue
            | V3ProviderUsageFactResult::FailedAttempt
    )
}

fn provider_usage_row_is_fact_event(event_type: &str, row: &Value) -> bool {
    event_type == "request.provider_attempt_failed"
        || event_type == "request.completed"
        || event_type == "request.failed"
        || event_type == "request.cancelled"
        || (event_type == "request.started"
            && row.get("finished_epoch_ms").is_none()
            && row.get("result").and_then(Value::as_str).is_none())
}

fn provider_usage_row_listener_and_start(row: &Value) -> Option<(u16, u64)> {
    let listener_id = provider_usage_row_listener(row)?;
    let started = row.get("started_epoch_ms").and_then(Value::as_u64)?;
    Some((listener_id, started))
}

fn provider_usage_row_listener(row: &Value) -> Option<u16> {
    row.get("scope")
        .and_then(|scope| scope.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
}

fn earliest_detail_contains(listener_id: u16, rows: &[Value]) -> bool {
    rows.iter().any(|row| {
        provider_usage_row_listener_and_start(row).is_some_and(|(id, _)| id == listener_id)
    })
}

fn merge_provider_usage_fact(previous: &V3ProviderUsageFact, incoming: &mut V3ProviderUsageFact) {
    let mut gaps = previous.gaps.clone();
    gaps.extend(incoming.gaps.iter().cloned());
    let gap_only = incoming.result == V3ProviderUsageFactResult::Unknown;
    if gap_only {
        let request_started_epoch_ms = incoming.request_started_epoch_ms;
        *incoming = previous.clone();
        if request_started_epoch_ms > 0 {
            incoming.request_started_epoch_ms = if incoming.request_started_epoch_ms == 0 {
                request_started_epoch_ms
            } else {
                incoming
                    .request_started_epoch_ms
                    .min(request_started_epoch_ms)
            };
        }
        incoming.merge_gaps(gaps);
        return;
    }
    incoming.request_started_epoch_ms = incoming
        .request_started_epoch_ms
        .min(previous.request_started_epoch_ms);
    if incoming.request_started_epoch_ms == 0 {
        incoming.request_started_epoch_ms = previous.request_started_epoch_ms;
    }
    if incoming.provider_id.is_none() {
        incoming.provider_id = previous.provider_id.clone();
    }
    if incoming.usage.is_none() {
        incoming.usage = previous.usage.clone();
    }
    if incoming.result == V3ProviderUsageFactResult::Active
        && previous.result != V3ProviderUsageFactResult::Unknown
        && previous.result != V3ProviderUsageFactResult::Active
    {
        incoming.result = previous.result;
    }
    incoming.merge_gaps(gaps);
}

fn normalize_coverage(coverage: &mut V3ProviderUsageCoverage) {
    coverage.gaps.sort();
    coverage.gaps.dedup();
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn truncate_incomplete_jsonl_tail(
    path: &Path,
    max_bytes: u64,
) -> Result<bool, V3WebuiObservabilityStoreError> {
    let mut file = match fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    if length > max_bytes {
        return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
            reason: V3ProviderUsageCapacityReason::LegacyStoreOverLimit,
        });
    }
    if length == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(false);
    }
    let mut complete_length = None;
    let mut chunk_end = length;
    let mut buffer = vec![0u8; 64 * 1024];
    while chunk_end > 0 {
        let chunk_start = chunk_end.saturating_sub(buffer.len() as u64);
        let chunk_len = (chunk_end - chunk_start) as usize;
        file.seek(SeekFrom::Start(chunk_start))?;
        file.read_exact(&mut buffer[..chunk_len])?;
        if let Some(position) = buffer[..chunk_len].iter().rposition(|byte| *byte == b'\n') {
            complete_length = Some(chunk_start + position as u64 + 1);
            break;
        }
        chunk_end = chunk_start;
    }
    let complete_length = complete_length.unwrap_or(0);
    file.set_len(complete_length)?;
    file.seek(SeekFrom::Start(complete_length))?;
    file.sync_all()?;
    Ok(true)
}

fn ensure_provider_usage_file_within_limit(
    path: &Path,
    max_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > max_bytes => {
            Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LegacyStoreOverLimit,
            })
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_companion_state_bytes(
    encoded_bytes: u64,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<(), V3WebuiObservabilityStoreError> {
    if encoded_bytes > limits.companion_state_bytes {
        return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
            reason: V3ProviderUsageCapacityReason::CompanionStateBytes,
        });
    }
    Ok(())
}

fn provider_usage_fact_line(
    fact: &V3ProviderUsageFact,
) -> Result<Vec<u8>, V3WebuiObservabilityStoreError> {
    serde_json::to_vec(&serde_json::json!({
        "schema_version": V3_PROVIDER_USAGE_FACTS_SCHEMA_VERSION,
        "fact": fact,
    }))
    .map_err(|error| V3WebuiObservabilityStoreError::ProviderUsageFact(error.to_string()))
}

fn append_provider_usage_fact_to_bytes(
    bytes: &mut Vec<u8>,
    fact: &V3ProviderUsageFact,
    complete_fact_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let line = provider_usage_fact_line(fact)?;
    if line.len() as u64 > complete_fact_bytes {
        return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
            reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
        });
    }
    bytes.extend_from_slice(&line);
    bytes.push(b'\n');
    Ok(())
}

fn encoded_provider_usage_fact_line_len(line_bytes: &[u8]) -> u64 {
    (line_bytes.len() as u64).saturating_add(1)
}

fn append_provider_usage_fact_line(
    path: &Path,
    line_bytes: &[u8],
) -> Result<(), V3WebuiObservabilityStoreError> {
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let mut writer = BufWriter::new(file);
    writer.write_all(line_bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

fn write_encoded_file_atomically(
    path: &Path,
    bytes: &[u8],
) -> Result<(), V3WebuiObservabilityStoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos()
    ));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(bytes)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        fs::rename(&temp_path, path)?;
        if let Some(parent) = path.parent() {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn provider_usage_facts_temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("provider-usage.facts.jsonl");
    path.with_file_name(format!(".{file_name}.tmp"))
}

fn remove_provider_usage_facts_temp_file(path: &Path) {
    let _ = fs::remove_file(provider_usage_facts_temp_path(path));
}

fn write_provider_usage_facts_atomically(
    path: &Path,
    bytes: &[u8],
) -> Result<(), V3WebuiObservabilityStoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp_path = provider_usage_facts_temp_path(path);
    let result = (|| {
        let _ = fs::remove_file(&temp_path);
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(bytes)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        fs::rename(&temp_path, path)?;
        #[cfg(test)]
        if take_provider_usage_facts_post_rename_failure() {
            return Err(
                std::io::Error::other("injected provider usage fact post-rename failure").into(),
            );
        }
        if let Some(parent) = path.parent() {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

#[cfg(test)]
thread_local! {
    static V3_PROVIDER_USAGE_FACTS_POST_RENAME_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn set_provider_usage_facts_post_rename_failure() {
    V3_PROVIDER_USAGE_FACTS_POST_RENAME_FAILURE.with(|flag| flag.set(true));
}

#[cfg(test)]
fn take_provider_usage_facts_post_rename_failure() -> bool {
    V3_PROVIDER_USAGE_FACTS_POST_RENAME_FAILURE.with(|flag| flag.replace(false))
}

#[derive(Debug, thiserror::Error)]
pub enum V3WebuiObservabilityStoreError {
    #[error("observability store record exceeds configured {limit} byte limit")]
    RecordTooLarge { limit: u64 },
    #[error("observability store io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("observability store encode failed: {0}")]
    Encode(String),
    #[error("observability store decode failed: {0}")]
    Decode(String),
    #[error("observability store record {path}:{line} has unsupported schema {schema}")]
    UnsupportedSchema {
        path: String,
        line: u64,
        schema: u64,
    },
    #[error("provider usage fact write failed: {0}")]
    ProviderUsageFact(String),
    #[error("provider usage fact capacity exceeded: {reason:?}")]
    ProviderUsageCapacity {
        reason: V3ProviderUsageCapacityReason,
    },
}

pub fn v3_provider_usage_facts_path(observability_path: &Path) -> PathBuf {
    observability_path.with_extension("provider-usage.facts.jsonl")
}

pub fn v3_provider_usage_coverage_path(observability_path: &Path) -> PathBuf {
    observability_path.with_extension("provider-usage.coverage.json")
}

pub fn v3_provider_usage_generation_path(observability_path: &Path) -> PathBuf {
    observability_path.with_extension("provider-usage.generation.json")
}

pub fn v3_provider_usage_read_generation(
    observability_path: &Path,
) -> Result<V3ProviderUsageGenerationState, V3WebuiObservabilityStoreError> {
    read_provider_usage_generation(
        &v3_provider_usage_generation_path(observability_path),
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_provider_usage_read_generation_with_limits(
    observability_path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<V3ProviderUsageGenerationState, V3WebuiObservabilityStoreError> {
    read_provider_usage_generation(
        &v3_provider_usage_generation_path(observability_path),
        limits,
    )
}

fn read_provider_usage_generation(
    path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<V3ProviderUsageGenerationState, V3WebuiObservabilityStoreError> {
    match read_bounded_file(path, limits.companion_state_bytes)? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| V3WebuiObservabilityStoreError::Decode(error.to_string())),
        None => Ok(Default::default()),
    }
}

fn read_provider_usage_coverage(
    path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<BTreeMap<u16, V3ProviderUsageCoverage>, V3WebuiObservabilityStoreError> {
    let Some(bytes) = read_bounded_file(path, limits.companion_state_bytes)? else {
        return Ok(BTreeMap::new());
    };
    let coverage: Vec<V3ProviderUsageCoverage> = serde_json::from_slice(&bytes)
        .map_err(|error| V3WebuiObservabilityStoreError::Decode(error.to_string()))?;
    Ok(coverage
        .into_iter()
        .map(|entry| (entry.listener_id, entry))
        .collect())
}

fn read_bounded_file(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, V3WebuiObservabilityStoreError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > max_bytes {
        return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
            reason: V3ProviderUsageCapacityReason::CompanionStateBytes,
        });
    }
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
            reason: V3ProviderUsageCapacityReason::CompanionStateBytes,
        });
    }
    Ok(Some(bytes))
}

pub fn v3_webui_observability_read_provider_usage(
    observability_path: &Path,
) -> Result<V3ProviderUsageRead, V3WebuiObservabilityStoreError> {
    v3_webui_observability_read_provider_usage_with_limits(
        observability_path,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_webui_observability_read_provider_usage_with_limits(
    observability_path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<V3ProviderUsageRead, V3WebuiObservabilityStoreError> {
    let facts_path = v3_provider_usage_facts_path(observability_path);
    let coverage_path = v3_provider_usage_coverage_path(observability_path);
    let mut read = V3ProviderUsageRead::default();
    let replay = read_provider_usage_facts_path(&facts_path, limits)?;
    let latest = replay.facts;
    let coverage = read_provider_usage_coverage(&coverage_path, limits)?;
    read.coverage = coverage.into_values().collect();
    read.facts = latest.into_values().collect();
    if read.coverage.is_empty() && !read.facts.is_empty() {
        let mut listeners = BTreeMap::<u16, u64>::new();
        for fact in &read.facts {
            listeners
                .entry(fact.listener_id)
                .and_modify(|started| *started = (*started).min(fact.request_started_epoch_ms))
                .or_insert(fact.request_started_epoch_ms);
        }
        read.coverage = listeners
            .into_iter()
            .map(
                |(listener_id, statistics_started_epoch_ms)| V3ProviderUsageCoverage {
                    listener_id,
                    statistics_started_epoch_ms: Some(statistics_started_epoch_ms),
                    detail_started_epoch_ms: None,
                    detail_incomplete: true,
                    gaps: vec!["coverage_unavailable".to_string()],
                },
            )
            .collect();
    }
    if replay.latest_encoded_bytes > limits.latest_encoded_fact_bytes {
        let mut coverage = read
            .coverage
            .iter()
            .map(|entry| (entry.listener_id, entry.clone()))
            .collect::<BTreeMap<_, _>>();
        record_provider_usage_latest_fact_recovery(
            &mut coverage,
            read.facts.iter().map(|fact| fact.listener_id),
            replay.latest_encoded_bytes,
            limits,
        );
        read.coverage = coverage.into_values().collect();
    }
    if replay.fact_tail_incomplete {
        if read.coverage.is_empty() {
            let listener_ids = read
                .facts
                .iter()
                .map(|fact| fact.listener_id)
                .collect::<BTreeSet<_>>();
            read.coverage = listener_ids
                .into_iter()
                .map(|listener_id| V3ProviderUsageCoverage {
                    listener_id,
                    statistics_started_epoch_ms: None,
                    detail_started_epoch_ms: None,
                    detail_incomplete: true,
                    gaps: vec!["coverage_unavailable".to_string()],
                })
                .collect();
        }
        for coverage in &mut read.coverage {
            coverage.detail_incomplete = true;
            coverage.gaps.push("incomplete_fact_tail".to_string());
            coverage.gaps.sort();
            coverage.gaps.dedup();
        }
    }
    Ok(read)
}

pub fn v3_provider_usage_read_coverage_with_limits(
    observability_path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<Vec<V3ProviderUsageCoverage>, V3WebuiObservabilityStoreError> {
    Ok(
        read_provider_usage_coverage(&v3_provider_usage_coverage_path(observability_path), limits)?
            .into_values()
            .collect(),
    )
}

#[derive(Debug)]
struct ProviderUsageFactsReplay {
    facts: BTreeMap<String, V3ProviderUsageFact>,
    fact_tail_incomplete: bool,
    latest_encoded_bytes: u64,
}

fn read_provider_usage_facts_path(
    path: &Path,
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<ProviderUsageFactsReplay, V3WebuiObservabilityStoreError> {
    ensure_provider_usage_file_within_limit(path, limits.physical_fact_log_bytes)?;
    let mut latest = BTreeMap::<String, V3ProviderUsageFact>::new();
    let mut latest_encoded_bytes = 0u64;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProviderUsageFactsReplay {
                facts: latest,
                fact_tail_incomplete: false,
                latest_encoded_bytes: 0,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let mut reader = BufReader::new(file);
    let mut line_number = 0usize;
    let mut physical_bytes = 0u64;
    loop {
        let line_result =
            read_bounded_jsonl_line(&mut reader, limits.complete_fact_bytes.saturating_add(1));
        let line_bytes = match line_result {
            Ok(Some(line)) => line,
            Ok(None) => {
                validate_provider_usage_replay_facts(&latest, limits.complete_fact_bytes)?;
                return Ok(ProviderUsageFactsReplay {
                    facts: latest,
                    fact_tail_incomplete: false,
                    latest_encoded_bytes,
                });
            }
            Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }) => {
                return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                    reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
                });
            }
            Err(error) => return Err(error),
        };
        let had_newline = line_bytes.ends_with(b"\n");
        physical_bytes = physical_bytes.saturating_add(line_bytes.len() as u64);
        if physical_bytes > limits.physical_fact_log_bytes {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LegacyStoreOverLimit,
            });
        }
        let line_bytes = if had_newline {
            &line_bytes[..line_bytes.len() - 1]
        } else {
            &line_bytes[..]
        };
        if line_bytes.len() as u64 > limits.complete_fact_bytes {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            });
        }
        if !had_newline {
            validate_provider_usage_replay_facts(&latest, limits.complete_fact_bytes)?;
            return Ok(ProviderUsageFactsReplay {
                facts: latest,
                fact_tail_incomplete: !line_bytes.trim_ascii().is_empty(),
                latest_encoded_bytes,
            });
        }
        if line_bytes.is_empty() {
            continue;
        }
        line_number += 1;
        if line_bytes.trim_ascii().is_empty() {
            continue;
        }
        let line = String::from_utf8(line_bytes.to_vec()).map_err(|error| {
            V3WebuiObservabilityStoreError::Decode(format!(
                "invalid provider usage fact UTF-8 {}:{line_number}: {error}",
                path.display()
            ))
        })?;
        let mut fact = decode_provider_usage_fact_line(path, line_number - 1, line)?;
        let identity = fact.target_identity()?;
        if let Some(previous) = latest.remove(&identity) {
            latest_encoded_bytes -=
                encoded_provider_usage_fact_line_len(&provider_usage_fact_line(&previous)?);
            merge_provider_usage_fact(&previous, &mut fact);
        }
        if latest.len() + 1 > limits.max_facts {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::FactKeys,
            });
        }
        let line = provider_usage_fact_line(&fact)?;
        let encoded_bytes = encoded_provider_usage_fact_line_len(&line);
        latest_encoded_bytes = latest_encoded_bytes.saturating_add(encoded_bytes);
        latest.insert(identity, fact);
    }
}

fn validate_provider_usage_replay_facts(
    facts: &BTreeMap<String, V3ProviderUsageFact>,
    complete_fact_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    for fact in facts.values() {
        let line = provider_usage_fact_line(fact)?;
        if line.len() as u64 > complete_fact_bytes {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            });
        }
    }
    Ok(())
}

fn read_bounded_jsonl_line<R: BufRead>(
    reader: &mut R,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, V3WebuiObservabilityStoreError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Ok(Some(line));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let (slice, complete) = match newline {
            Some(position) => (&available[..=position], true),
            None => (available, false),
        };
        if line.len() as u64 + slice.len() as u64 > max_bytes {
            return Err(V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            });
        }
        line.extend_from_slice(slice);
        let consumed = slice.len();
        reader.consume(consumed);
        if complete {
            return Ok(Some(line));
        }
    }
}

pub fn v3_provider_usage_append_fact(
    observability_path: &Path,
    fact: V3ProviderUsageFact,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let mut store = V3ProviderUsagePersistenceStore::open(observability_path)?;
    store.append_fact(fact)
}

pub fn v3_provider_usage_ensure_statistics_coverage(
    observability_path: &Path,
    listener_id: u16,
    started_epoch_ms: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let mut coverage = v3_webui_observability_read_provider_usage(observability_path)?.coverage;
    let entry = match coverage
        .iter_mut()
        .find(|entry| entry.listener_id == listener_id)
    {
        Some(entry) => entry,
        None => {
            coverage.push(V3ProviderUsageCoverage {
                listener_id,
                ..Default::default()
            });
            coverage.last_mut().expect("just inserted coverage")
        }
    };
    entry
        .statistics_started_epoch_ms
        .get_or_insert(started_epoch_ms);
    write_provider_usage_coverage_with_limits(
        &v3_provider_usage_coverage_path(observability_path),
        &coverage,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_provider_usage_mark_detail_started(
    observability_path: &Path,
    listener_id: u16,
    started_epoch_ms: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let mut coverage = v3_webui_observability_read_provider_usage(observability_path)?.coverage;
    let entry = match coverage
        .iter_mut()
        .find(|entry| entry.listener_id == listener_id)
    {
        Some(entry) => entry,
        None => {
            coverage.push(V3ProviderUsageCoverage {
                listener_id,
                detail_started_epoch_ms: Some(started_epoch_ms),
                ..Default::default()
            });
            coverage.last_mut().expect("just inserted coverage")
        }
    };
    entry
        .detail_started_epoch_ms
        .get_or_insert(started_epoch_ms);
    write_provider_usage_coverage_with_limits(
        &v3_provider_usage_coverage_path(observability_path),
        &coverage,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_provider_usage_backfill_detail(
    observability_path: &Path,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let lenient = v3_webui_observability_read_rows_bounded_lenient(observability_path, usize::MAX);
    let existing = v3_webui_observability_read_provider_usage(observability_path)?;
    let mut append = false;
    let existing_facts = existing
        .latest_facts()
        .into_iter()
        .map(|(identity, fact)| (identity, fact.clone()))
        .collect::<BTreeMap<_, _>>();
    for (identity, mut fact) in provider_usage_backfill_candidates(&lenient.raw_rows)? {
        if let Some(previous) = existing_facts.get(&identity) {
            if provider_usage_fact_result_is_terminal(previous.result) {
                continue;
            }
            merge_provider_usage_fact(previous, &mut fact);
            if previous == &fact {
                continue;
            }
        }
        v3_provider_usage_append_fact(observability_path, fact)?;
        append = true;
    }
    if append || existing.coverage.is_empty() && !lenient.rows.is_empty() {
        reconcile_v3_provider_usage_coverage(
            observability_path,
            existing.coverage,
            &lenient,
            true,
        )?;
    }
    Ok(())
}

fn write_provider_usage_coverage_with_limits(
    path: &Path,
    coverage: &[V3ProviderUsageCoverage],
    limits: V3ProviderUsagePersistenceLimits,
) -> Result<(), V3WebuiObservabilityStoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(coverage)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
    ensure_companion_state_bytes(bytes.len() as u64, limits)?;
    let temp_path = path.with_extension(format!(
        "coverage.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos()
    ));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(&bytes)?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        fs::rename(&temp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// Persist the durable facts and coverage for one row before any detail append.
///
/// The file order is fact first, coverage second. A crash between the two is
/// safe: the row exists, and the remaining detail becomes an observable gap.
pub fn v3_provider_usage_persist_before_detail(
    observability_path: &Path,
    row: &Value,
    ordinal: Option<u64>,
    attempt_inserted: bool,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let existing = v3_webui_observability_read_provider_usage(observability_path)?;
    let mut gaps = Vec::new();
    let started = row
        .get("started_epoch_ms")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let listener_id = row
        .get("scope")
        .and_then(|scope| scope.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok());
    let event_type = row
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type == "request.provider_attempt_failed" && !attempt_inserted {
        gaps.push("attempt_identity_ambiguous".to_string());
    }
    let fact = V3ProviderUsageFact::from_row(row, ordinal, gaps)?;
    if let Some(fact) = fact {
        // Write the fact before coverage. A missing coverage file is visible
        // as missing statistics coverage and never turns into a success claim.
        v3_provider_usage_append_fact(observability_path, fact)?;
    }
    let Some(listener_id) = listener_id else {
        return Ok(());
    };
    let mut coverage = existing.coverage;
    let entry = match coverage
        .iter_mut()
        .find(|entry| entry.listener_id == listener_id)
    {
        Some(entry) => entry,
        None => {
            coverage.push(V3ProviderUsageCoverage {
                listener_id,
                ..Default::default()
            });
            coverage.last_mut().expect("just inserted coverage")
        }
    };
    entry.statistics_started_epoch_ms.get_or_insert(started);
    entry.gaps.sort();
    entry.gaps.dedup();
    write_provider_usage_coverage_with_limits(
        &v3_provider_usage_coverage_path(observability_path),
        &coverage,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_provider_usage_mark_gap(
    observability_path: &Path,
    listener_id: u16,
    request_key: &str,
    attempt_ordinal: Option<u64>,
    gap: &str,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let read = v3_webui_observability_read_provider_usage(observability_path)?;
    let mut fact = V3ProviderUsageFact {
        listener_id,
        request_key: request_key.to_string(),
        attempt_ordinal,
        request_started_epoch_ms: 0,
        result: V3ProviderUsageFactResult::Unknown,
        provider_id: None,
        usage: None,
        gaps: vec![gap.to_string()],
    };
    if let Some(previous) = read.latest_facts().get(&fact.target_identity()?) {
        fact = (*previous).clone();
        fact.merge_gaps([gap.to_string()]);
    }
    v3_provider_usage_append_fact(observability_path, fact)?;
    let mut coverage = read.coverage;
    let entry = match coverage
        .iter_mut()
        .find(|entry| entry.listener_id == listener_id)
    {
        Some(entry) => entry,
        None => {
            coverage.push(V3ProviderUsageCoverage {
                listener_id,
                ..Default::default()
            });
            coverage.last_mut().expect("just inserted coverage")
        }
    };
    entry.gaps.push(gap.to_string());
    entry.gaps.sort();
    entry.gaps.dedup();
    write_provider_usage_coverage_with_limits(
        &v3_provider_usage_coverage_path(observability_path),
        &coverage,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

pub fn v3_provider_usage_reconcile_detail(
    observability_path: &Path,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let lenient = v3_webui_observability_read_rows_bounded_lenient(observability_path, usize::MAX);
    let coverage = v3_webui_observability_read_provider_usage(observability_path)?.coverage;
    reconcile_v3_provider_usage_coverage(observability_path, coverage, &lenient, false)
}

fn reconcile_v3_provider_usage_coverage(
    observability_path: &Path,
    mut coverage: Vec<V3ProviderUsageCoverage>,
    lenient: &V3WebuiObservabilityLenientRead,
    backfill: bool,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let mut detail_started = BTreeMap::<u16, u64>::new();
    for row in &lenient.rows {
        if let Some(listener_id) = row
            .get("scope")
            .and_then(|scope| scope.get("port"))
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
        {
            let started = row
                .get("started_epoch_ms")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            detail_started
                .entry(listener_id)
                .and_modify(|value| *value = (*value).min(started))
                .or_insert(started);
            if !coverage
                .iter()
                .any(|entry| entry.listener_id == listener_id)
            {
                coverage.push(V3ProviderUsageCoverage {
                    listener_id,
                    statistics_started_epoch_ms: None,
                    detail_started_epoch_ms: Some(started),
                    detail_incomplete: false,
                    gaps: Vec::new(),
                });
            }
        }
    }
    for entry in &mut coverage {
        if let Some(started) = detail_started.get(&entry.listener_id) {
            if backfill {
                entry.detail_started_epoch_ms.get_or_insert(*started);
                entry.statistics_started_epoch_ms.get_or_insert(*started);
            }
        } else {
            entry.detail_incomplete = true;
            entry.gaps.push("detail_unavailable".to_string());
        }
    }
    if !lenient.skipped.is_empty() {
        // The shared store path is per-listener in production, so the
        // undecodable tail belongs to the listener whose complete rows or
        // facts identified this same file. Never assign it to another listener.
        let mut listener_ids = coverage
            .iter()
            .map(|entry| entry.listener_id)
            .collect::<Vec<_>>();
        listener_ids.sort();
        listener_ids.dedup();
        for listener_id in listener_ids {
            if let Some(entry) = coverage
                .iter_mut()
                .find(|entry| entry.listener_id == listener_id)
            {
                entry.detail_incomplete = true;
                entry.gaps.push("incomplete_detail_tail".to_string());
            }
        }
    }
    for entry in &mut coverage {
        entry.gaps.sort();
        entry.gaps.dedup();
    }
    write_provider_usage_coverage_with_limits(
        &v3_provider_usage_coverage_path(observability_path),
        &coverage,
        V3ProviderUsagePersistenceLimits::default(),
    )
}

fn decode_provider_usage_fact_line(
    path: &Path,
    line_number: usize,
    line: String,
) -> Result<V3ProviderUsageFact, V3WebuiObservabilityStoreError> {
    let envelope: Value = serde_json::from_str(&line).map_err(|error| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "invalid provider usage fact {}:{}: {error}",
            path.display(),
            line_number + 1
        ))
    })?;
    let schema = envelope
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            V3WebuiObservabilityStoreError::Decode(format!(
                "provider usage fact {}:{} has no schema_version",
                path.display(),
                line_number + 1
            ))
        })?;
    if schema != V3_PROVIDER_USAGE_FACTS_SCHEMA_VERSION {
        return Err(V3WebuiObservabilityStoreError::UnsupportedSchema {
            path: path.display().to_string(),
            line: line_number as u64 + 1,
            schema,
        });
    }
    serde_json::from_value(envelope.get("fact").cloned().ok_or_else(|| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "provider usage fact {}:{} has no fact",
            path.display(),
            line_number + 1
        ))
    })?)
    .map_err(|error| V3WebuiObservabilityStoreError::Decode(error.to_string()))
}

pub fn v3_webui_observability_append_row(
    path: &Path,
    row: &Value,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let line_bytes = encode_observability_line(row)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    append_encoded_line(path, &line_bytes)
}

pub fn v3_webui_observability_append_row_with_retention(
    path: &Path,
    row: &Value,
    max_history_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let line_bytes = encode_observability_line(row)?;
    if line_bytes.len() as u64 > max_history_bytes {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge {
            limit: max_history_bytes,
        });
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let current_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(0)
            } else {
                Err(error)
            }
        })?;
    if current_bytes.saturating_add(line_bytes.len() as u64) <= max_history_bytes {
        return append_encoded_line(path, &line_bytes);
    }

    let existing_rows = v3_webui_observability_read_raw_rows(path)?;
    let retention_target = max_history_bytes
        .saturating_div(2)
        .max(line_bytes.len() as u64);
    let mut retained = Vec::new();
    let mut retained_bytes = line_bytes.len() as u64;
    for existing_row in existing_rows.into_iter().rev() {
        let existing_line = encode_observability_line(&existing_row)?;
        let next_bytes = retained_bytes.saturating_add(existing_line.len() as u64);
        if next_bytes > retention_target {
            break;
        }
        retained.push(existing_line);
        retained_bytes = next_bytes;
    }
    retained.reverse();
    retained.push(line_bytes);

    let temp_path = path.with_extension(format!(
        "jsonl.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| V3WebuiObservabilityStoreError::Io(std::io::Error::other(error)))?
            .as_nanos()
    ));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        for line in &retained {
            writer.write_all(line)?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        fs::rename(&temp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub fn v3_webui_observability_append_row_without_retention_hard_cap(
    path: &Path,
    row: &Value,
    max_history_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let line_bytes = encode_observability_line(row)?;
    let required_bytes = (line_bytes.len() as u64).saturating_add(1);
    if required_bytes > max_history_bytes {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge {
            limit: max_history_bytes,
        });
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let current_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(0)
            } else {
                Err(error)
            }
        })?;
    if current_bytes.saturating_add(required_bytes) > max_history_bytes {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge {
            limit: max_history_bytes,
        });
    }
    append_encoded_line(path, &line_bytes)
}

fn encode_observability_line(row: &Value) -> Result<Vec<u8>, V3WebuiObservabilityStoreError> {
    let row_bytes = serde_json::to_vec(row)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
    let limit = routecodex_v3_config::internal::v3_observability_max_record_bytes();
    if row_bytes.len() as u64 > limit {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge { limit });
    }
    let envelope = serde_json::json!({
        "schema_version": V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION,
        "row": row,
    });
    serde_json::to_vec(&envelope)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))
}

fn append_encoded_line(
    path: &Path,
    line_bytes: &[u8],
) -> Result<(), V3WebuiObservabilityStoreError> {
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(line_bytes)
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer
        .write_all(b"\n")
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("v3-obs-retention-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bounded_append_reclaims_old_raw_rows_and_keeps_new_row() {
        let dir = std::env::temp_dir().join(format!(
            "v3-obs-retention-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        let limit = 300;
        for key in ["old", "middle", "recent"] {
            v3_webui_observability_append_row(
                &path,
                &json!({
                    "request_key": key,
                    "event_type": "request.completed",
                    "padding": "x".repeat(70)
                }),
            )
            .unwrap();
        }
        #[cfg(unix)]
        let inode_before = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(&path).unwrap().ino()
        };
        let new_row = json!({"request_key": "new", "event_type": "request.completed"});
        v3_webui_observability_append_row_with_retention(&path, &new_row, limit).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                inode_before,
                fs::metadata(&path).unwrap().ino(),
                "retention compaction must atomically replace the store path"
            );
        }

        let rows = v3_webui_observability_read_raw_rows(&path).unwrap();
        assert!(rows.len() < 4);
        assert_eq!(
            rows.last()
                .and_then(|row| row.get("request_key"))
                .and_then(Value::as_str),
            Some("new")
        );
        assert!(fs::metadata(&path).unwrap().len() <= limit);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_append_rejects_a_single_row_larger_than_history_limit() {
        let dir = temp_dir("retention-too-large");
        let path = dir.join("records.jsonl");
        let error = v3_webui_observability_append_row_with_retention(
            &path,
            &json!({"request_key": "large", "padding": "x".repeat(400)}),
            100,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::RecordTooLarge { limit: 100 }
        ));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_append_rejects_corrupt_history_instead_of_overwriting_it() {
        let dir = temp_dir("retention-corrupt");
        let path = dir.join("records.jsonl");
        let corrupt = format!("{}\n", "not-json".repeat(101));
        fs::write(&path, &corrupt).unwrap();
        let error = v3_webui_observability_append_row_with_retention(
            &path,
            &json!({"request_key": "new"}),
            100,
        )
        .unwrap_err();
        assert!(matches!(error, V3WebuiObservabilityStoreError::Decode(_)));
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn incremental_raw_read_decodes_only_appended_lines_and_holds_back_partial_tail() {
        use std::io::Write;
        let dir = temp_dir("incremental-read");
        let path = dir.join("records.jsonl");
        v3_webui_observability_append_row(&path, &json!({"request_key": "a"})).unwrap();

        let first = v3_webui_observability_read_raw_rows_from(&path, 0, 0).unwrap();
        assert_eq!(first.rows.len(), 1);
        assert_eq!(first.next_line_number, 1);

        // No new bytes: resuming from the returned offset yields no rows.
        let idle = v3_webui_observability_read_raw_rows_from(
            &path,
            first.next_offset,
            first.next_line_number,
        )
        .unwrap();
        assert!(idle.rows.is_empty());
        assert_eq!(idle.next_offset, first.next_offset);

        // A writer's unterminated trailing fragment is left for the next read...
        {
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(br#"{"schema_version":1,"row":{"request_key":"b""#)
                .unwrap();
        }
        let partial = v3_webui_observability_read_raw_rows_from(
            &path,
            first.next_offset,
            first.next_line_number,
        )
        .unwrap();
        assert!(partial.rows.is_empty());
        assert_eq!(partial.next_offset, first.next_offset);

        // ...and decoded once the writer terminates it.
        {
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(b"}}\n").unwrap();
        }
        let completed = v3_webui_observability_read_raw_rows_from(
            &path,
            partial.next_offset,
            partial.next_line_number,
        )
        .unwrap();
        assert_eq!(completed.rows.len(), 1);
        assert_eq!(
            completed.rows[0].get("request_key").and_then(Value::as_str),
            Some("b")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}

pub fn v3_webui_observability_read_rows(
    path: &Path,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    v3_webui_observability_read_rows_bounded(path, usize::MAX)
}

pub fn v3_webui_observability_read_rows_bounded(
    path: &Path,
    max_rows: usize,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    if max_rows == 0 {
        return Ok(Vec::new());
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let mut latest_by_key = BTreeMap::<String, Value>::new();
    let mut order = VecDeque::<String>::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let row = decode_observability_row(path, line_number, line?)?;
        let key = row
            .get("request_key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                V3WebuiObservabilityStoreError::Decode(format!(
                    "observability record {}:{} has no request_key",
                    path.display(),
                    line_number + 1
                ))
            })?;
        if latest_by_key.contains_key(key) {
            order.retain(|existing| existing != key);
        } else if latest_by_key.len() >= max_rows {
            if let Some(oldest) = order.pop_front() {
                latest_by_key.remove(&oldest);
            }
        }
        order.push_back(key.to_string());
        latest_by_key.insert(key.to_string(), row);
    }
    Ok(order
        .into_iter()
        .filter_map(|key| latest_by_key.remove(&key))
        .collect())
}

/// Rows plus per-line records that a strict read would have rejected. The
/// store is Debug surface, never business truth, so a torn append or a legacy
/// row must degrade into `skipped` evidence instead of failing the reader.
#[derive(Debug, Default, Clone)]
pub struct V3WebuiObservabilityLenientRead {
    pub rows: Vec<Value>,
    pub raw_rows: Vec<Value>,
    pub skipped: Vec<String>,
}

/// Lenient sibling of `v3_webui_observability_read_rows_bounded`: identical
/// request_key folding and bounding, but undecodable lines and rows without a
/// request_key are skipped and reported instead of aborting the whole read.
/// This read never fails; even an unreadable file yields an empty report with
/// a skipped note so observability loading cannot block listener startup.
pub fn v3_webui_observability_read_rows_bounded_lenient(
    path: &Path,
    max_rows: usize,
) -> V3WebuiObservabilityLenientRead {
    let mut report = V3WebuiObservabilityLenientRead::default();
    if max_rows == 0 {
        return report;
    }
    if !path.exists() {
        return report;
    }
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            report.skipped.push(format!(
                "open observability store {}: {error}",
                path.display()
            ));
            return report;
        }
    };
    let mut latest_by_key = BTreeMap::<String, Value>::new();
    let mut order = VecDeque::<String>::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let skipped_note = |reason: String| {
            format!(
                "observability record {}:{} skipped: {reason}",
                path.display(),
                line_number + 1
            )
        };
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                report.skipped.push(skipped_note(error.to_string()));
                continue;
            }
        };
        let row = match decode_observability_row(path, line_number, line) {
            Ok(row) => row,
            Err(error) => {
                report.skipped.push(skipped_note(error.to_string()));
                continue;
            }
        };
        let Some(key) = row.get("request_key").and_then(Value::as_str) else {
            report
                .skipped
                .push(skipped_note("has no request_key".to_string()));
            continue;
        };
        report.raw_rows.push(row.clone());
        if latest_by_key.contains_key(key) {
            order.retain(|existing| existing != key);
        } else if latest_by_key.len() >= max_rows {
            if let Some(oldest) = order.pop_front() {
                latest_by_key.remove(&oldest);
            }
        }
        order.push_back(key.to_string());
        latest_by_key.insert(key.to_string(), row);
    }
    report.rows = order
        .into_iter()
        .filter_map(|key| latest_by_key.remove(&key))
        .collect();
    report
}

/// Reads the store in file order without folding lifecycle rows by request_key.
/// Admin uses this raw view so every failed provider attempt remains visible
/// even when a later retry or completion succeeds.
pub fn v3_webui_observability_read_raw_rows(
    path: &Path,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let mut rows = Vec::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        rows.push(decode_observability_row(path, line_number, line)?);
    }
    Ok(rows)
}

/// Incremental result of a raw read starting at a byte offset.
///
/// `next_offset` is the byte position after the last newline-terminated record,
/// so a caller can resume from it without re-decoding what it already read. A
/// writer's in-progress trailing fragment (no terminating newline yet) is left
/// unconsumed and decoded on the next call once it is complete.
#[derive(Debug, Default, Clone)]
pub struct V3WebuiObservabilityRawRead {
    pub rows: Vec<Value>,
    pub next_offset: u64,
    pub next_line_number: usize,
}

/// Incremental sibling of `v3_webui_observability_read_raw_rows`: decodes only
/// the complete lines appended since `offset`, returning the new rows and the
/// resume offset. Admin's polling cache uses this to stop re-reading and
/// re-decoding the whole append-only store on every request.
pub fn v3_webui_observability_read_raw_rows_from(
    path: &Path,
    offset: u64,
    line_number: usize,
) -> Result<V3WebuiObservabilityRawRead, V3WebuiObservabilityStoreError> {
    if !path.exists() {
        return Ok(V3WebuiObservabilityRawRead {
            rows: Vec::new(),
            next_offset: offset,
            next_line_number: line_number,
        });
    }
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = offset.min(length);
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;

    let mut rows = Vec::new();
    let mut cursor = 0usize;
    let mut consumed = 0usize;
    let mut next_line_number = line_number;
    while let Some(position) = buffer[cursor..].iter().position(|byte| *byte == b'\n') {
        let end = cursor + position;
        let line = &buffer[cursor..end];
        cursor = end + 1;
        consumed = cursor;
        if line.iter().all(u8::is_ascii_whitespace) {
            next_line_number += 1;
            continue;
        }
        let text = std::str::from_utf8(line)
            .map_err(|error| {
                V3WebuiObservabilityStoreError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error,
                ))
            })?
            .to_string();
        rows.push(decode_observability_row(path, next_line_number, text)?);
        next_line_number += 1;
    }
    Ok(V3WebuiObservabilityRawRead {
        rows,
        next_offset: start + consumed as u64,
        next_line_number,
    })
}

fn decode_observability_row(
    path: &Path,
    line_number: usize,
    line: String,
) -> Result<Value, V3WebuiObservabilityStoreError> {
    if line.trim().is_empty() {
        return Err(V3WebuiObservabilityStoreError::Decode(format!(
            "observability record {}:{} is empty",
            path.display(),
            line_number + 1
        )));
    }
    let envelope: Value = serde_json::from_str(&line).map_err(|error| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "invalid observability record {}:{}: {error}",
            path.display(),
            line_number + 1
        ))
    })?;
    let schema = envelope
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            V3WebuiObservabilityStoreError::Decode(format!(
                "observability record {}:{} has no schema_version",
                path.display(),
                line_number + 1
            ))
        })?;
    if schema != V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION {
        return Err(V3WebuiObservabilityStoreError::UnsupportedSchema {
            path: path.display().to_string(),
            line: line_number as u64 + 1,
            schema,
        });
    }
    envelope.get("row").cloned().ok_or_else(|| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "observability record {}:{} has no row",
            path.display(),
            line_number + 1
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_config::internal::v3_observability_max_record_bytes;
    use serde_json::json;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("v3-obs-io-test-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_then_read_roundtrip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("records.jsonl");
        let row1 = json!({"request_key": "4444:r1", "event_type": "request.started"});
        let row2 = json!({"request_key": "4444:r2", "event_type": "request.completed"});
        v3_webui_observability_append_row(&path, &row1).unwrap();
        v3_webui_observability_append_row(&path, &row2).unwrap();
        let rows = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("4444:r1")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("4444:r2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_missing_file_ok() {
        let path = std::path::Path::new("/nonexistent/this/file/does/not/exist.jsonl");
        assert!(v3_webui_observability_read_rows(path).unwrap().is_empty());
        assert!(v3_webui_observability_read_raw_rows(path)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unsupported_schema_rejected() {
        let dir = temp_dir("unsupported");
        let path = dir.join("records-bad.jsonl");
        std::fs::write(&path, "{\"schema_version\":99,\"row\":{}}\n").unwrap();
        let error = v3_webui_observability_read_rows(&path).unwrap_err();
        assert!(format!("{error}").contains("unsupported schema"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_row_field_rejected() {
        let dir = temp_dir("missing-row");
        let path = dir.join("records-norow.jsonl");
        std::fs::write(&path, "{\"schema_version\":1}\n").unwrap();
        let error = v3_webui_observability_read_rows(&path).unwrap_err();
        assert!(format!("{error}").contains("no row"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_folds_lifecycle_rows_by_request_key() {
        let dir = temp_dir("fold");
        let path = dir.join("records-fold.jsonl");
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.started", "attempts": 0}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.provider_attempt_failed", "attempts": 1}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.completed", "attempts": 1, "result": "success"}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r2", "event_type": "request.started", "attempts": 0}),
        )
        .unwrap();
        let rows = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("r1")
        );
        assert_eq!(
            rows[0].get("event_type").and_then(Value::as_str),
            Some("request.completed")
        );
        assert_eq!(
            rows[0].get("result").and_then(Value::as_str),
            Some("success")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("r2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn raw_reader_preserves_provider_attempt_failure_rows() {
        let dir = temp_dir("raw-attempt");
        let path = dir.join("records-attempt.jsonl");
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.started",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 1
            }),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.provider_attempt_failed",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 2,
                "meta": {"provider_status": 502}
            }),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.completed",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 3,
                "result": "success"
            }),
        )
        .unwrap();

        let folded = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(folded.len(), 1);
        assert_eq!(
            folded[0].get("event_type").and_then(Value::as_str),
            Some("request.completed")
        );

        let raw = v3_webui_observability_read_raw_rows(&path).unwrap();
        assert_eq!(raw.len(), 3);
        assert_eq!(
            raw[1].get("event_type").and_then(Value::as_str),
            Some("request.provider_attempt_failed")
        );
        assert_eq!(
            raw[1]
                .get("meta")
                .and_then(|meta| meta.get("provider_status"))
                .and_then(Value::as_u64),
            Some(502)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_rejects_record_over_internal_limit() {
        let dir = temp_dir("too-large");
        let path = dir.join("records-too-large.jsonl");
        let row = json!({
            "request_key": "r1",
            "payload": "x".repeat((v3_observability_max_record_bytes() as usize) + 1),
        });
        let error = v3_webui_observability_append_row(&path, &row).unwrap_err();
        assert!(format!("{error}").contains("limit"));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_startup_read_keeps_only_the_most_recent_request_rows() {
        let dir = temp_dir("bounded-startup");
        let path = dir.join("records-bounded.jsonl");
        for request_key in ["r1", "r2", "r3"] {
            v3_webui_observability_append_row(
                &path,
                &json!({
                    "request_key": request_key,
                    "event_type": "request.completed",
                    "result": "success"
                }),
            )
            .unwrap();
        }

        let rows = v3_webui_observability_read_rows_bounded(&path, 2).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("r2")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("r3")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn usage_fact(
        request_key: &str,
        started_epoch_ms: u64,
        result: V3ProviderUsageFactResult,
        provider_id: Option<&str>,
        gaps: Vec<&str>,
    ) -> V3ProviderUsageFact {
        V3ProviderUsageFact {
            listener_id: 4444,
            request_key: request_key.to_string(),
            attempt_ordinal: None,
            request_started_epoch_ms: started_epoch_ms,
            result,
            provider_id: provider_id.map(str::to_string),
            usage: (result == V3ProviderUsageFactResult::Success)
                .then(|| json!({"input_tokens": started_epoch_ms, "output_tokens": 1})),
            gaps: gaps.into_iter().map(str::to_string).collect(),
        }
    }

    fn usage_request_fact(
        request_key: &str,
        started_epoch_ms: u64,
        result: V3ProviderUsageFactResult,
        provider_id: Option<&str>,
        gaps: Vec<&str>,
    ) -> V3ProviderUsageFact {
        V3ProviderUsageFact {
            listener_id: 4444,
            request_key: request_key.to_string(),
            attempt_ordinal: None,
            request_started_epoch_ms: started_epoch_ms,
            result,
            provider_id: provider_id.map(str::to_string),
            usage: (result == V3ProviderUsageFactResult::Success)
                .then(|| json!({"input_tokens": started_epoch_ms, "output_tokens": 1})),
            gaps: gaps.into_iter().map(str::to_string).collect(),
        }
    }

    fn bounded_limits(
        latest_encoded_fact_bytes: u64,
        max_facts: usize,
        physical_fact_log_bytes: u64,
        complete_fact_bytes: u64,
    ) -> V3ProviderUsagePersistenceLimits {
        V3ProviderUsagePersistenceLimits {
            latest_encoded_fact_bytes,
            max_facts,
            physical_fact_log_bytes,
            complete_fact_bytes,
            companion_state_bytes: 64 * 1024,
        }
    }

    fn jsonl_line_count(path: &Path) -> usize {
        fs::read(path)
            .unwrap()
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .count()
    }

    #[test]
    fn gap_only_update_preserves_the_terminal_fact() {
        let dir = temp_dir("usage-gap-only");
        let path = dir.join("records.jsonl");
        v3_provider_usage_append_fact(
            &path,
            usage_fact(
                "4444:r-gap",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p-terminal"),
                Vec::new(),
            ),
        )
        .unwrap();
        v3_provider_usage_append_fact(
            &path,
            usage_fact(
                "4444:r-gap",
                0,
                V3ProviderUsageFactResult::Unknown,
                None,
                vec!["queue_rejected"],
            ),
        )
        .unwrap();

        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-gap")
            .unwrap();
        assert_eq!(fact.result, V3ProviderUsageFactResult::Success);
        assert_eq!(fact.provider_id.as_deref(), Some("p-terminal"));
        assert!(fact.gaps.iter().any(|gap| gap == "queue_rejected"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn new_terminal_fact_corrects_provider_and_usage() {
        let dir = temp_dir("usage-corrected");
        let path = dir.join("records.jsonl");
        v3_provider_usage_append_fact(
            &path,
            usage_fact(
                "4444:r-corrected",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p-old"),
                Vec::new(),
            ),
        )
        .unwrap();
        let mut corrected = usage_fact(
            "4444:r-corrected",
            20,
            V3ProviderUsageFactResult::Success,
            Some("p-new"),
            Vec::new(),
        );
        corrected.usage = Some(json!({"input_tokens": 50, "output_tokens": 5}));
        v3_provider_usage_append_fact(&path, corrected).unwrap();

        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-corrected")
            .unwrap();
        assert_eq!(fact.provider_id.as_deref(), Some("p-new"));
        assert_eq!(
            fact.usage
                .as_ref()
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(Value::as_u64),
            Some(50)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_detail_backfill_cannot_replace_a_durable_terminal_fact() {
        let dir = temp_dir("usage-stale-detail");
        let path = dir.join("records.jsonl");
        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-durable",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p-durable"),
                Vec::new(),
            ))
            .unwrap();
        store.close_generation().unwrap();
        drop(store);
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "4444:r-durable",
                "event_type": "request.completed",
                "started_epoch_ms": 1,
                "scope": {"port": 4444},
                "result": "success",
                "meta": {"provider_id": "p-stale"},
                "usage": {"input_tokens": 999, "output_tokens": 999}
            }),
        )
        .unwrap();
        let mut restarted = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        restarted.backfill_detail().unwrap();

        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-durable")
            .unwrap();
        assert_eq!(fact.provider_id.as_deref(), Some("p-durable"));
        assert_eq!(
            fact.usage
                .as_ref()
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(Value::as_u64),
            Some(10)
        );
        restarted.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn append_uses_in_memory_facts_without_rescanning_accumulated_history() {
        let dir = temp_dir("usage-incremental");
        let path = dir.join("records.jsonl");
        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-incremental",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p-old"),
                vec!["historical_gap"],
            ))
            .unwrap();
        fs::write(v3_provider_usage_facts_path(&path), []).unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-incremental",
                20,
                V3ProviderUsageFactResult::Success,
                Some("p-new"),
                Vec::new(),
            ))
            .unwrap();

        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-incremental")
            .unwrap();
        assert_eq!(fact.provider_id.as_deref(), Some("p-new"));
        assert!(fact.gaps.iter().any(|gap| gap == "historical_gap"));
        store.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_repeat_revision_bound() {
        use std::os::unix::fs::MetadataExt;

        let dir = temp_dir("usage-repeat-bound");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store
            .append_fact(usage_request_fact(
                "4444:r-repeat",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p1"),
                Vec::new(),
            ))
            .unwrap();
        store.close_generation().unwrap();
        drop(store);
        let replay_length = fs::metadata(&facts_path).unwrap().len();

        let limits = bounded_limits(4_096, 64, 8_192, 8_192);
        let mut store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        let replay_inode = fs::metadata(&facts_path).unwrap().ino();
        store
            .append_fact(usage_request_fact(
                "4444:r-repeat",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p1"),
                Vec::new(),
            ))
            .unwrap();
        assert_eq!(fs::metadata(&facts_path).unwrap().len(), replay_length);
        assert_eq!(fs::metadata(&facts_path).unwrap().ino(), replay_inode);

        let inode = fs::metadata(&facts_path).unwrap().ino();
        for index in 0..2 {
            store
                .append_fact(usage_request_fact(
                    &format!("4444:r-insert-{index}"),
                    20 + index,
                    V3ProviderUsageFactResult::Success,
                    Some("p-insert"),
                    Vec::new(),
                ))
                .unwrap();
            assert_eq!(
                fs::metadata(&facts_path).unwrap().ino(),
                inode,
                "ordinary unique inserts must not replace the fact log"
            );
        }

        store
            .append_fact(usage_request_fact(
                "4444:r-repeat",
                11,
                V3ProviderUsageFactResult::Success,
                Some("p2"),
                Vec::new(),
            ))
            .unwrap();
        for index in 0..8 {
            store
                .append_fact(usage_request_fact(
                    "4444:r-repeat",
                    11 + index,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("p3-{index}")),
                    Vec::new(),
                ))
                .unwrap();
        }
        store
            .append_fact(usage_request_fact(
                "4444:r-repeat",
                12,
                V3ProviderUsageFactResult::Success,
                Some("p3"),
                Vec::new(),
            ))
            .unwrap();
        store
            .append_fact(usage_request_fact(
                "4444:r-repeat",
                0,
                V3ProviderUsageFactResult::Unknown,
                None,
                vec!["queue_rejected"],
            ))
            .unwrap();
        let read_before_restart =
            v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert!(read_before_restart
            .latest_facts()
            .get("request:4444:4444:r-repeat:")
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "queue_rejected"));
        assert!(
            jsonl_line_count(&facts_path) <= 16,
            "replayed and revised facts must remain within the bounded test log"
        );
        assert!(
            fs::metadata(&facts_path).unwrap().len() <= limits.physical_fact_log_bytes,
            "the fact log must remain within its physical limit"
        );
        store.close_generation().unwrap();
        drop(store);

        let restarted = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts.len(), 3);
        let fact = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-repeat")
            .unwrap();
        assert_eq!(fact.provider_id.as_deref(), Some("p3"));
        assert_eq!(fact.request_started_epoch_ms, 10);
        assert!(fact.gaps.iter().any(|gap| gap == "queue_rejected"));
        drop(restarted);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn provider_usage_changed_revision_appends_until_physical_cap_then_compacts_atomically() {
        use std::os::unix::fs::MetadataExt;

        let dir = temp_dir("usage-changed-revision-cap");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let limits = bounded_limits(32_768, 64, 4_096, 1_024);
        let mut store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-stable",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p-stable"),
                Vec::new(),
            ))
            .unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-changing",
                20,
                V3ProviderUsageFactResult::Success,
                Some("p-v0"),
                Vec::new(),
            ))
            .unwrap();
        let inode_before_changes = fs::metadata(&facts_path).unwrap().ino();

        store
            .append_fact(usage_fact(
                "4444:r-changing",
                21,
                V3ProviderUsageFactResult::Success,
                Some("p-v1"),
                Vec::new(),
            ))
            .unwrap();
        assert_eq!(
            fs::metadata(&facts_path).unwrap().ino(),
            inode_before_changes,
            "a changed revision below the physical cap must append without replacement"
        );

        let mut compacted_lines = None;
        for index in 2..32 {
            store
                .append_fact(usage_fact(
                    "4444:r-changing",
                    20 + index,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("p-v{index}-{}", "x".repeat(64))),
                    Vec::new(),
                ))
                .unwrap();
            if fs::metadata(&facts_path).unwrap().ino() != inode_before_changes {
                compacted_lines = Some(jsonl_line_count(&facts_path));
                break;
            }
        }
        assert!(
            compacted_lines.is_some(),
            "crossing the physical cap must replace the log"
        );
        assert_eq!(
            compacted_lines,
            Some(3),
            "compaction retains current stable keys and then appends the accepted revision"
        );
        assert!(fs::metadata(&facts_path).unwrap().len() <= limits.physical_fact_log_bytes);
        assert!(
            !provider_usage_facts_temp_path(&facts_path).exists(),
            "atomic compaction leaves no temporary replacement file"
        );

        store.close_generation().unwrap();
        drop(store);
        let restarted = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts.len(), 2);
        let changed = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-changing")
            .expect("latest changed fact");
        assert!(changed
            .provider_id
            .as_deref()
            .is_some_and(|provider_id| provider_id.starts_with("p-v")));
        let stable = read
            .facts
            .iter()
            .find(|fact| fact.request_key == "4444:r-stable")
            .expect("unrelated stable fact");
        assert_eq!(stable.provider_id.as_deref(), Some("p-stable"));
        drop(restarted);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn provider_usage_facts_reload_after_post_rename_sync_failure_and_clean_orphan_temp() {
        use std::os::unix::fs::MetadataExt;

        let dir = temp_dir("usage-post-rename");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let temp_path = provider_usage_facts_temp_path(&facts_path);
        fs::write(&temp_path, b"orphan").unwrap();
        let limits = bounded_limits(8_192, 64, 2_048, 1_024);
        let mut store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        assert!(
            !temp_path.exists(),
            "open cleans only its own fact temp file"
        );

        for index in 0..2 {
            store
                .append_fact(usage_fact(
                    &format!("4444:r-post-rename-{index}"),
                    10 + index,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("p-old-{}", "x".repeat(64))),
                    Vec::new(),
                ))
                .unwrap();
        }
        let original_log = fs::read(&facts_path).unwrap();
        let inode_before = fs::metadata(&facts_path).unwrap().ino();
        set_provider_usage_facts_post_rename_failure();
        let error = store.compact_provider_usage_facts().unwrap_err();
        assert!(format!("{error}").contains("post-rename"));
        store
            .append_fact(usage_fact(
                "4444:r-post-rename-0",
                20,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-new-{}", "x".repeat(64))),
                Vec::new(),
            ))
            .unwrap();
        assert_ne!(
            fs::metadata(&facts_path).unwrap().ino(),
            inode_before,
            "rename commits the compacted file before the injected sync failure"
        );
        assert_ne!(
            fs::read(&facts_path).unwrap(),
            original_log,
            "the reopened store must continue from the renamed compacted facts"
        );
        assert!(!temp_path.exists());

        store
            .append_fact(usage_fact(
                "4444:r-post-rename-after",
                30,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-after-{}", "x".repeat(64))),
                Vec::new(),
            ))
            .unwrap();
        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts.len(), 3);
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == "4444:r-post-rename-0"
                && fact
                    .provider_id
                    .as_deref()
                    .is_some_and(|provider_id| provider_id.starts_with("p-new-"))
        }));
        store.close_generation().unwrap();
        drop(store);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_unique_fact_cap_is_explicit() {
        let dir = temp_dir("usage-unique-cap");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let limits = bounded_limits(8_192, 1, 8_192, 8_192);
        let mut store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        store
            .append_fact(usage_fact(
                "4444:r-first",
                10,
                V3ProviderUsageFactResult::Success,
                Some("p1"),
                Vec::new(),
            ))
            .unwrap();
        let one_line_length = fs::metadata(&facts_path).unwrap().len();

        let error = store
            .append_fact(usage_fact(
                "4444:r-second",
                20,
                V3ProviderUsageFactResult::Success,
                Some("p2"),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::FactKeys,
            }
        ));
        assert_eq!(fs::metadata(&facts_path).unwrap().len(), one_line_length);
        assert_eq!(jsonl_line_count(&facts_path), 1);
        assert!(
            v3_webui_observability_read_provider_usage_with_limits(&path, limits)
                .unwrap()
                .coverage_for(4444)
                .unwrap()
                .gaps
                .iter()
                .any(|gap| gap == "provider_usage_fact_capacity_keys")
        );
        store.close_generation().unwrap();
        drop(store);

        let mut restarted =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        let error = restarted
            .append_fact(usage_fact(
                "4444:r-third",
                30,
                V3ProviderUsageFactResult::Success,
                Some("p3"),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::FactKeys,
            }
        ));
        restarted
            .append_fact(usage_fact(
                "4444:r-first",
                40,
                V3ProviderUsageFactResult::Success,
                Some("p1-corrected"),
                Vec::new(),
            ))
            .unwrap();
        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts.len(), 1);
        assert_eq!(read.facts[0].provider_id.as_deref(), Some("p1-corrected"));
        assert!(read
            .coverage_for(4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_keys"));
        restarted.close_generation().unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_store_open_recovers_oversubscribed_latest_facts_losslessly() {
        let dir = temp_dir("usage-latest-recovery");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let roomy_limits = bounded_limits(65_536, 64, 8_192, 4_096);
        let mut store =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, roomy_limits).unwrap();
        store.ensure_statistics_coverage(4444, 10).unwrap();
        for (request_key, provider_id) in [
            ("4444:r-latest-over-a", "p-latest-over-a"),
            ("4444:r-latest-over-b", "p-latest-over-b"),
        ] {
            store
                .append_fact(usage_fact(
                    request_key,
                    10,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("{provider_id}-{}", "x".repeat(256))),
                    Vec::new(),
                ))
                .unwrap();
        }
        store.close_generation().unwrap();
        drop(store);

        let encoded_latest_bytes = fs::read(&facts_path).unwrap().len() as u64;
        assert!(encoded_latest_bytes < roomy_limits.physical_fact_log_bytes);
        let constrained_limits = bounded_limits(
            encoded_latest_bytes - 1,
            64,
            roomy_limits.physical_fact_log_bytes,
            4_096,
        );
        let mut recovered =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, constrained_limits)
                .expect("an existing lossless latest-fact set must remain replayable");
        assert_eq!(recovered.facts.len(), 2);
        for (request_key, provider_id) in [
            ("4444:r-latest-over-a", "p-latest-over-a"),
            ("4444:r-latest-over-b", "p-latest-over-b"),
        ] {
            assert!(
                recovered.facts[format!("request:4444:{request_key}:").as_str()]
                    .provider_id
                    .as_deref()
                    .is_some_and(|value| value.starts_with(provider_id))
            );
        }
        assert!(recovered.latest_encoded_bytes > constrained_limits.latest_encoded_fact_bytes);
        let coverage = recovered.coverage.get(&4444).expect("listener coverage");
        assert!(coverage.detail_incomplete);
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_latest_recovered"));

        recovered
            .append_fact(usage_fact(
                "4444:r-latest-over-a",
                11,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-latest-over-b-{}", "x".repeat(256))),
                Vec::new(),
            ))
            .expect("an equal-size correction must remain writable while over capacity");
        assert_eq!(
            recovered.facts["request:4444:4444:r-latest-over-a:"]
                .provider_id
                .as_deref(),
            Some(format!("p-latest-over-b-{}", "x".repeat(256)).as_str())
        );
        assert!(recovered.latest_encoded_bytes > constrained_limits.latest_encoded_fact_bytes);

        let error = recovered
            .append_fact(usage_fact(
                "4444:r-latest-over-a",
                11,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-latest-over-growth-{}", "x".repeat(512))),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LatestFactBytes,
            }
        ));
        assert_eq!(
            recovered.facts["request:4444:4444:r-latest-over-a:"]
                .provider_id
                .as_deref(),
            Some(format!("p-latest-over-b-{}", "x".repeat(256)).as_str())
        );

        let error = recovered
            .append_fact(usage_fact(
                "4444:r-latest-over-c",
                12,
                V3ProviderUsageFactResult::Success,
                Some("p-new"),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LatestFactBytes,
            }
        ));
        assert!(!recovered
            .facts
            .contains_key("request:4444:4444:r-latest-over-c:"));
        assert!(recovered
            .coverage
            .get(&4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_latest"));

        recovered
            .append_fact(usage_fact(
                "4444:r-latest-over-a",
                11,
                V3ProviderUsageFactResult::Success,
                Some("p-a-short"),
                Vec::new(),
            ))
            .expect("a reducing correction must restore normal admission");
        assert!(recovered.latest_encoded_bytes <= constrained_limits.latest_encoded_fact_bytes);
        recovered
            .append_fact(usage_fact(
                "4444:r-latest-over-c",
                12,
                V3ProviderUsageFactResult::Success,
                Some("p-new"),
                Vec::new(),
            ))
            .expect("new growth must be admitted after the snapshot returns below capacity");
        recovered.close_generation().unwrap();
        drop(recovered);

        let reopened =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, constrained_limits).unwrap();
        assert_eq!(reopened.facts.len(), 3);
        assert_eq!(
            reopened.facts["request:4444:4444:r-latest-over-a:"]
                .provider_id
                .as_deref(),
            Some("p-a-short")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_recovery_accepts_non_growing_replacement_at_physical_cap() {
        let dir = temp_dir("usage-latest-physical-cap");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let roomy_limits = bounded_limits(65_536, 64, 65_536, 4_096);
        let mut store =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, roomy_limits).unwrap();
        for (request_key, provider_id) in [
            ("4444:r-physical-a", "p-physical-a"),
            ("4444:r-physical-b", "p-physical-b"),
        ] {
            store
                .append_fact(usage_fact(
                    request_key,
                    10,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("{provider_id}-{}", "x".repeat(256))),
                    Vec::new(),
                ))
                .unwrap();
        }
        store.close_generation().unwrap();
        drop(store);

        let encoded_latest_bytes = fs::metadata(&facts_path).unwrap().len();
        let limits = bounded_limits(encoded_latest_bytes - 1, 64, encoded_latest_bytes, 4_096);
        let mut recovered =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        recovered
            .append_fact(usage_fact(
                "4444:r-physical-a",
                11,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-physical-c-{}", "x".repeat(256))),
                Vec::new(),
            ))
            .expect("a non-growing replacement must fit the compacted stable set");
        assert_eq!(
            recovered.facts["request:4444:4444:r-physical-a:"]
                .provider_id
                .as_deref(),
            Some(format!("p-physical-c-{}", "x".repeat(256)).as_str())
        );
        assert_eq!(
            fs::metadata(&facts_path).unwrap().len(),
            encoded_latest_bytes
        );
        assert_eq!(jsonl_line_count(&facts_path), 2);
        assert!(!provider_usage_facts_temp_path(&facts_path).exists());
        recovered.close_generation().unwrap();
        drop(recovered);

        let restarted = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        assert_eq!(restarted.facts.len(), 2);
        assert_eq!(
            restarted.facts["request:4444:4444:r-physical-a:"]
                .provider_id
                .as_deref(),
            Some(format!("p-physical-c-{}", "x".repeat(256)).as_str())
        );
        drop(restarted);

        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts.len(), 2);
        assert_eq!(
            read.facts
                .iter()
                .find(|fact| fact.request_key == "4444:r-physical-a")
                .and_then(|fact| fact.provider_id.as_deref()),
            Some(format!("p-physical-c-{}", "x".repeat(256)).as_str())
        );
        assert!(read
            .coverage_for(4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_latest_recovered"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_recovery_rejects_unrepresentable_stable_set() {
        let dir = temp_dir("usage-unrepresentable-stable-set");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let roomy_limits = bounded_limits(65_536, 64, 65_536, 4_096);
        let mut store =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, roomy_limits).unwrap();
        for (request_key, provider_id) in [
            ("4444:r-unrepresentable-a", "p-unrepresentable-a"),
            ("4444:r-unrepresentable-b", "p-unrepresentable-b"),
        ] {
            store
                .append_fact(usage_fact(
                    request_key,
                    10,
                    V3ProviderUsageFactResult::Success,
                    Some(&format!("{provider_id}-{}", "x".repeat(256))),
                    Vec::new(),
                ))
                .unwrap();
        }
        store.close_generation().unwrap();
        drop(store);

        let encoded_latest_bytes = fs::metadata(&facts_path).unwrap().len();
        let before_log = fs::read(&facts_path).unwrap();
        let limits = bounded_limits(65_536, 64, encoded_latest_bytes, 4_096);
        let mut recovered =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        let before = recovered.facts["request:4444:4444:r-unrepresentable-a:"].clone();
        let error = recovered
            .append_fact(usage_fact(
                "4444:r-unrepresentable-a",
                11,
                V3ProviderUsageFactResult::Success,
                Some(&format!("p-unrepresentable-c-{}", "x".repeat(512))),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::PhysicalFactLogBytes,
            }
        ));
        assert_eq!(
            recovered.facts["request:4444:4444:r-unrepresentable-a:"],
            before
        );
        assert_eq!(fs::read(&facts_path).unwrap(), before_log);
        assert!(recovered
            .coverage
            .get(&4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "provider_usage_fact_capacity_physical"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_replay_rejects_merged_record_above_complete_fact_cap() {
        let dir = temp_dir("usage-merged-complete-cap");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let gap_a = "a".repeat(256);
        let gap_b = "b".repeat(256);
        let first = usage_fact(
            "4444:r-merged-complete",
            10,
            V3ProviderUsageFactResult::Unknown,
            None,
            vec![gap_a.as_str()],
        );
        let mut second = usage_fact(
            "4444:r-merged-complete",
            11,
            V3ProviderUsageFactResult::Unknown,
            None,
            vec![gap_b.as_str()],
        );
        let first_line = provider_usage_fact_line(&first).unwrap();
        let second_line = provider_usage_fact_line(&second).unwrap();
        let complete_fact_bytes = first_line.len().max(second_line.len()) as u64;
        let previous = first.clone();
        merge_provider_usage_fact(&previous, &mut second);
        let merged_line = provider_usage_fact_line(&second).unwrap();
        assert!(
            merged_line.len() as u64 > complete_fact_bytes,
            "merged={} first={} second={}",
            merged_line.len(),
            complete_fact_bytes,
            second_line.len()
        );

        let mut journal = first_line;
        journal.push(b'\n');
        journal.extend_from_slice(&second_line);
        journal.push(b'\n');
        fs::write(&facts_path, &journal).unwrap();
        let before = fs::read(&facts_path).unwrap();
        let limits = bounded_limits(65_536, 64, journal.len() as u64, complete_fact_bytes);
        let error = match V3ProviderUsagePersistenceStore::open_with_limits(&path, limits) {
            Ok(_) => panic!("a merged fact over the complete-fact cap must fail store open"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }
        ));
        assert_eq!(fs::read(&facts_path).unwrap(), before);

        let error = match v3_webui_observability_read_provider_usage_with_limits(&path, limits) {
            Ok(_) => panic!("a merged fact over the complete-fact cap must fail public read"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }
        ));
        assert_eq!(fs::read(&facts_path).unwrap(), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_replay_accepts_final_merge_after_bounded_intermediate_exceeds_cap() {
        let dir = temp_dir("usage-merged-complete-cap-recovers");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let gap_a = "a".repeat(256);
        let gap_b = "b".repeat(256);
        let long_provider = format!("p-long-{}", "x".repeat(512));
        let first = usage_fact(
            "4444:r-merged-recovers",
            10,
            V3ProviderUsageFactResult::Unknown,
            Some(&long_provider),
            vec![gap_a.as_str()],
        );
        let second = usage_fact(
            "4444:r-merged-recovers",
            11,
            V3ProviderUsageFactResult::Unknown,
            None,
            vec![gap_b.as_str()],
        );
        let third = usage_fact(
            "4444:r-merged-recovers",
            12,
            V3ProviderUsageFactResult::Success,
            Some("p-short"),
            Vec::new(),
        );
        let first_line = provider_usage_fact_line(&first).unwrap();
        let second_line = provider_usage_fact_line(&second).unwrap();
        let third_line = provider_usage_fact_line(&third).unwrap();
        let complete_fact_bytes = first_line
            .len()
            .max(second_line.len())
            .max(third_line.len()) as u64;

        let mut intermediate = second.clone();
        merge_provider_usage_fact(&first, &mut intermediate);
        assert!(
            provider_usage_fact_line(&intermediate).unwrap().len() as u64 > complete_fact_bytes,
            "the intermediate merged revision must exceed the record cap"
        );
        let mut final_fact = third.clone();
        merge_provider_usage_fact(&intermediate, &mut final_fact);
        assert!(
            provider_usage_fact_line(&final_fact).unwrap().len() as u64 <= complete_fact_bytes,
            "the final stable revision must fit the record cap"
        );

        let mut journal = first_line;
        journal.push(b'\n');
        journal.extend_from_slice(&second_line);
        journal.push(b'\n');
        journal.extend_from_slice(&third_line);
        journal.push(b'\n');
        fs::write(&facts_path, &journal).unwrap();
        let limits = bounded_limits(65_536, 64, journal.len() as u64, complete_fact_bytes);
        let store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        assert_eq!(store.facts.len(), 1);
        assert_eq!(store.facts.values().next().unwrap(), &final_fact);
        drop(store);

        let store = V3ProviderUsagePersistenceStore::open_with_limits(&path, limits).unwrap();
        assert_eq!(store.facts.values().next().unwrap(), &final_fact);
        drop(store);
        let read = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap();
        assert_eq!(read.facts, vec![final_fact]);
        assert_eq!(fs::read(&facts_path).unwrap(), journal);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_replay_rejection_preserves_incomplete_tail() {
        let dir = temp_dir("usage-merged-complete-cap-incomplete-tail");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let gap_a = "a".repeat(256);
        let gap_b = "b".repeat(256);
        let first = usage_fact(
            "4444:r-merged-tail",
            10,
            V3ProviderUsageFactResult::Unknown,
            None,
            vec![gap_a.as_str()],
        );
        let second = usage_fact(
            "4444:r-merged-tail",
            11,
            V3ProviderUsageFactResult::Unknown,
            None,
            vec![gap_b.as_str()],
        );
        let first_line = provider_usage_fact_line(&first).unwrap();
        let second_line = provider_usage_fact_line(&second).unwrap();
        let complete_fact_bytes = first_line.len().max(second_line.len()) as u64;
        let mut merged = second.clone();
        merge_provider_usage_fact(&first, &mut merged);
        assert!(
            provider_usage_fact_line(&merged).unwrap().len() as u64 > complete_fact_bytes,
            "the final stable revision must exceed the record cap"
        );

        let mut journal = first_line;
        journal.push(b'\n');
        journal.extend_from_slice(&second_line);
        journal.push(b'\n');
        journal.extend_from_slice(b"{\"schema\":");
        fs::write(&facts_path, &journal).unwrap();
        let before = fs::read(&facts_path).unwrap();
        let limits = bounded_limits(65_536, 64, journal.len() as u64, complete_fact_bytes);
        let error = match V3ProviderUsagePersistenceStore::open_with_limits(&path, limits) {
            Ok(_) => panic!("a merged fact over the complete-fact cap must fail store open"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }
        ));
        assert_eq!(fs::read(&facts_path).unwrap(), before);
        let error =
            v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }
        ));
        assert_eq!(fs::read(&facts_path).unwrap(), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_usage_bounded_read_and_replace() {
        let dir = temp_dir("usage-bounded-read");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let limits = bounded_limits(512, 64, 512, 100);
        let mut oversized_record = "x".repeat(200);
        oversized_record.push('\n');
        fs::write(&facts_path, oversized_record).unwrap();
        let error =
            v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::CompleteFactBytes,
            }
        ));
        assert_eq!(fs::metadata(&facts_path).unwrap().len(), 201);

        let oversized_log_bytes = limits.physical_fact_log_bytes.checked_add(1).unwrap();
        fs::write(&facts_path, vec![b'x'; oversized_log_bytes as usize]).unwrap();
        let error =
            v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LegacyStoreOverLimit,
            }
        ));
        assert_eq!(
            fs::metadata(&facts_path).unwrap().len(),
            oversized_log_bytes
        );

        let coverage_path = v3_provider_usage_coverage_path(&path);
        fs::write(&coverage_path, "x".repeat(200)).unwrap();
        let _ = v3_webui_observability_read_provider_usage_with_limits(&path, limits).unwrap_err();
        assert_eq!(fs::metadata(&coverage_path).unwrap().len(), 200);

        fs::remove_file(&coverage_path).unwrap();
        fs::remove_file(&facts_path).unwrap();
        let too_many_keys = bounded_limits(8_192, 1, 8_192, 8_192);
        for request_key in ["4444:r-key-a", "4444:r-key-b"] {
            append_provider_usage_fact_line(
                &facts_path,
                &provider_usage_fact_line(&usage_fact(
                    request_key,
                    10,
                    V3ProviderUsageFactResult::Success,
                    Some("p1"),
                    Vec::new(),
                ))
                .unwrap(),
            )
            .unwrap();
        }
        let error = v3_webui_observability_read_provider_usage_with_limits(&path, too_many_keys)
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::FactKeys,
            }
        ));

        fs::write(&facts_path, []).unwrap();
        let first_line = provider_usage_fact_line(&usage_fact(
            "4444:r-latest-a",
            10,
            V3ProviderUsageFactResult::Success,
            Some("p1"),
            Vec::new(),
        ))
        .unwrap();
        append_provider_usage_fact_line(&facts_path, &first_line).unwrap();
        let aggregate_limit = bounded_limits(first_line.len() as u64 + 1, 64, 8_192, 8_192);
        append_provider_usage_fact_line(
            &facts_path,
            &provider_usage_fact_line(&usage_fact(
                "4444:r-latest-b",
                20,
                V3ProviderUsageFactResult::Success,
                Some("p2"),
                Vec::new(),
            ))
            .unwrap(),
        )
        .unwrap();
        append_provider_usage_fact_line(
            &facts_path,
            &provider_usage_fact_line(&V3ProviderUsageFact {
                listener_id: 7777,
                request_key: "7777:r-latest-other".to_string(),
                attempt_ordinal: None,
                request_started_epoch_ms: 30,
                result: V3ProviderUsageFactResult::Success,
                provider_id: Some("p3".to_string()),
                usage: Some(json!({"input_tokens": 30, "output_tokens": 1})),
                gaps: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        let read =
            v3_webui_observability_read_provider_usage_with_limits(&path, aggregate_limit).unwrap();
        assert_eq!(read.facts.len(), 3);
        for listener_id in [4444, 7777] {
            let coverage = read.coverage_for(listener_id).expect("recovered coverage");
            assert!(coverage.detail_incomplete);
            assert!(coverage
                .gaps
                .iter()
                .any(|gap| gap == PROVIDER_USAGE_LATEST_FACT_RECOVERY_GAP));
        }
        let mut store =
            V3ProviderUsagePersistenceStore::open_with_limits(&path, aggregate_limit).unwrap();
        let error = store
            .append_fact(usage_fact(
                "4444:r-latest-c",
                30,
                V3ProviderUsageFactResult::Success,
                Some("p3"),
                Vec::new(),
            ))
            .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::ProviderUsageCapacity {
                reason: V3ProviderUsageCapacityReason::LatestFactBytes,
            }
        ));
        assert_eq!(jsonl_line_count(&facts_path), 3);
        store.close_generation().unwrap();
        drop(store);
        let persisted =
            v3_webui_observability_read_provider_usage_with_limits(&path, aggregate_limit).unwrap();
        for listener_id in [4444, 7777] {
            assert!(persisted
                .coverage_for(listener_id)
                .unwrap()
                .gaps
                .iter()
                .any(|gap| gap == PROVIDER_USAGE_LATEST_FACT_RECOVERY_GAP));
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn unchanged_coverage_does_not_replace_the_file() {
        use std::os::unix::fs::MetadataExt;

        let dir = temp_dir("usage-coverage-stable");
        let path = dir.join("records.jsonl");
        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store.ensure_statistics_coverage(4444, 100).unwrap();
        let coverage_path = v3_provider_usage_coverage_path(&path);
        let inode = fs::metadata(&coverage_path).unwrap().ino();
        store
            .append_fact(usage_fact(
                "4444:r-coverage",
                200,
                V3ProviderUsageFactResult::Success,
                Some("p1"),
                Vec::new(),
            ))
            .unwrap();
        store.flush().unwrap();
        assert_eq!(fs::metadata(&coverage_path).unwrap().ino(), inode);
        store.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn usage_fact_ledger_reopens_within_restart_flush_budget() {
        let dir = temp_dir("usage-reopen-restart-budget");
        let path = dir.join("records.jsonl");
        let facts_path = v3_provider_usage_facts_path(&path);
        let mut file = BufWriter::new(fs::File::create(&facts_path).unwrap());
        for index in 0..2048 {
            let fact = usage_fact(
                &format!("4444:restart-{index}"),
                10,
                V3ProviderUsageFactResult::Success,
                Some("p1"),
                Vec::new(),
            );
            file.write_all(&provider_usage_fact_line(&fact).unwrap())
                .unwrap();
            file.write_all(b"\n").unwrap();
        }
        file.flush().unwrap();
        let start = std::time::Instant::now();
        let store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        let elapsed = start.elapsed();
        std::fs::remove_dir_all(dir).unwrap();
        eprintln!("usage ledger reopen took {elapsed:?}");
        assert_eq!(store.facts.len(), 2048);
        assert!(elapsed < std::time::Duration::from_secs(1));
    }

    #[test]
    fn half_fact_and_detail_tails_are_repaired_with_sticky_gaps() {
        let dir = temp_dir("usage-half-tail");
        let path = dir.join("records.jsonl");
        let fact = usage_fact(
            "4444:r-half",
            10,
            V3ProviderUsageFactResult::Success,
            Some("p1"),
            Vec::new(),
        );
        append_provider_usage_fact_line(
            &v3_provider_usage_facts_path(&path),
            &provider_usage_fact_line(&fact).unwrap(),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "4444:r-half",
                "event_type": "request.completed",
                "started_epoch_ms": 10,
                "scope": {"port": 4444},
                "result": "success",
                "meta": {"provider_id": "p1"},
                "usage": {"input_tokens": 10, "output_tokens": 1}
            }),
        )
        .unwrap();
        let mut facts = fs::OpenOptions::new()
            .append(true)
            .open(v3_provider_usage_facts_path(&path))
            .unwrap();
        facts.write_all(b"{\"schema_version\":1").unwrap();
        let mut detail = fs::OpenOptions::new().append(true).open(&path).unwrap();
        detail.write_all(b"{\"schema_version\":1").unwrap();

        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store.backfill_detail().unwrap();
        let coverage = v3_webui_observability_read_provider_usage(&path)
            .unwrap()
            .coverage_for(4444)
            .cloned()
            .unwrap();
        assert!(coverage.detail_incomplete);
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "incomplete_fact_tail"));
        assert!(coverage
            .gaps
            .iter()
            .any(|gap| gap == "incomplete_detail_tail"));

        store
            .append_fact(usage_fact(
                "4444:r-after-tail",
                20,
                V3ProviderUsageFactResult::Success,
                Some("p2"),
                Vec::new(),
            ))
            .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "4444:r-after-tail",
                "event_type": "request.completed",
                "started_epoch_ms": 20,
                "scope": {"port": 4444},
                "result": "success"
            }),
        )
        .unwrap();
        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        assert!(read.facts.iter().any(|fact| {
            fact.request_key == "4444:r-after-tail"
                && fact.result == V3ProviderUsageFactResult::Success
        }));
        assert_eq!(
            v3_webui_observability_read_raw_rows(&path).unwrap().len(),
            2
        );
        store.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn half_fact_tail_marks_every_listener_discovered_from_detail() {
        let dir = temp_dir("usage-half-tail-listeners");
        let path = dir.join("records.jsonl");
        for (listener_id, request_key) in [(4444, "4444:r-a"), (7777, "7777:r-b")] {
            v3_webui_observability_append_row(
                &path,
                &json!({
                    "request_key": request_key,
                    "event_type": "request.completed",
                    "started_epoch_ms": 10,
                    "scope": {"port": listener_id},
                    "result": "success",
                    "meta": {"provider_id": "p1"},
                    "usage": {"input_tokens": 1, "output_tokens": 1}
                }),
            )
            .unwrap();
        }
        fs::write(
            v3_provider_usage_facts_path(&path),
            b"{\"schema_version\":1",
        )
        .unwrap();

        let mut store = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        store.backfill_detail().unwrap();
        let read = v3_webui_observability_read_provider_usage(&path).unwrap();
        for listener_id in [4444, 7777] {
            let coverage = read.coverage_for(listener_id).expect("listener coverage");
            assert!(coverage.detail_incomplete);
            assert!(coverage
                .gaps
                .iter()
                .any(|gap| gap == "incomplete_fact_tail"));
        }
        store.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn generation_boundary_distinguishes_abnormal_and_normal_end() {
        let dir = temp_dir("usage-generation");
        let path = dir.join("records.jsonl");
        let mut abandoned = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        abandoned.ensure_statistics_coverage(4444, 10).unwrap();
        drop(abandoned);
        assert!(v3_provider_usage_read_generation(&path).unwrap().open);

        let mut restarted = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        let after_abnormal = v3_webui_observability_read_provider_usage(&path).unwrap();
        assert!(after_abnormal
            .coverage_for(4444)
            .unwrap()
            .gaps
            .iter()
            .any(|gap| gap == "abnormal_previous_generation"));
        restarted.close_generation().unwrap();
        let closed = v3_provider_usage_read_generation(&path).unwrap();
        assert!(!closed.open);
        assert!(closed.last_normal_end_epoch_ms.is_some());
        assert_eq!(closed.abnormal_generation_count, 1);
        drop(restarted);

        let mut reopened = V3ProviderUsagePersistenceStore::open(&path).unwrap();
        let opened_again = v3_provider_usage_read_generation(&path).unwrap();
        assert!(opened_again.open);
        assert_eq!(opened_again.abnormal_generation_count, 1);
        reopened.close_generation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
