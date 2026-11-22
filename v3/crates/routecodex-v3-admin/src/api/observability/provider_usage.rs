// feature_id: v3.admin_observability_aggregation
// Provider usage query and aggregation for the observability records endpoint.

use super::QueryRow;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use routecodex_v3_debug::{
    V3ProviderUsageCoverage, V3ProviderUsageFact, V3ProviderUsageFactResult, V3ProviderUsageRead,
};
use routecodex_v3_runtime::hub_v1::usage_normalization::{
    read_v3_canonical_usage_cache_fields, split_v3_canonical_usage_cache,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UsageView {
    Requests,
    Attempts,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CalendarPeriod {
    Day,
    Week,
    Month,
    All,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UsageGrain {
    Day,
    Week,
    Month,
    Hour,
}

#[derive(Debug, Clone)]
pub(super) struct ProviderUsageQuery {
    pub view: UsageView,
    pub calendar_period: CalendarPeriod,
    pub timezone: String,
    pub anchor_date: Option<String>,
    pub grain: UsageGrain,
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    pub resolved_from_ms: Option<u64>,
    pub resolved_to_ms: Option<u64>,
}

impl ProviderUsageQuery {
    pub(super) fn from_params(params: &HashMap<String, String>) -> Result<Option<Self>, String> {
        let has_new_params = [
            "view",
            "calendar_period",
            "timezone",
            "anchor_date",
            "grain",
        ]
        .iter()
        .any(|key| {
            params
                .get(*key)
                .is_some_and(|value| !value.trim().is_empty())
        });
        if !has_new_params {
            return Ok(None);
        }
        let view = match params.get("view").map(String::as_str).unwrap_or_default() {
            "" | "requests" => UsageView::Requests,
            "attempts" => UsageView::Attempts,
            "all" => UsageView::All,
            value => return Err(format!("invalid view: {value}")),
        };
        let calendar_period = match params
            .get("calendar_period")
            .map(String::as_str)
            .unwrap_or_default()
        {
            "" | "day" => CalendarPeriod::Day,
            "week" => CalendarPeriod::Week,
            "month" => CalendarPeriod::Month,
            "all" => CalendarPeriod::All,
            "custom" => CalendarPeriod::Custom,
            value => return Err(format!("invalid calendar_period: {value}")),
        };
        let timezone = params
            .get("timezone")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("UTC")
            .to_string();
        timezone
            .parse::<Tz>()
            .map_err(|_| format!("invalid timezone: {timezone}"))?;
        let anchor_date = params
            .get("anchor_date")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(anchor_date) = &anchor_date {
            NaiveDate::parse_from_str(anchor_date, "%Y-%m-%d")
                .map_err(|_| format!("invalid anchor_date: {anchor_date}"))?;
        }
        let grain = match params.get("grain").map(String::as_str).unwrap_or_default() {
            "" => match calendar_period {
                CalendarPeriod::Day => UsageGrain::Hour,
                CalendarPeriod::Week | CalendarPeriod::Month => UsageGrain::Day,
                CalendarPeriod::All | CalendarPeriod::Custom => UsageGrain::Day,
            },
            "day" => UsageGrain::Day,
            "week" => UsageGrain::Week,
            "month" => UsageGrain::Month,
            "hour" => UsageGrain::Hour,
            value => return Err(format!("invalid grain: {value}")),
        };
        Ok(Some(Self {
            view,
            calendar_period,
            timezone,
            anchor_date,
            grain,
            from_ms: None,
            to_ms: None,
            resolved_from_ms: None,
            resolved_to_ms: None,
        }))
    }

    pub(super) fn resolve_range(&mut self, now_ms: u64) -> Result<(), String> {
        let timezone = self
            .timezone
            .parse::<Tz>()
            .map_err(|_| format!("invalid timezone: {}", self.timezone))?;
        let anchor_epoch_ms = match &self.anchor_date {
            Some(date) => date_epoch_ms(date, timezone)?,
            None => now_ms,
        };
        let Some(anchor_epoch_ms) = i64::try_from(anchor_epoch_ms).ok() else {
            return Err("calendar anchor is outside the supported time range".to_string());
        };
        let anchor = DateTime::<Utc>::from_timestamp_millis(anchor_epoch_ms)
            .ok_or_else(|| "calendar anchor is outside the supported time range".to_string())?;
        let local = anchor.with_timezone(&timezone);
        let local_date = local.date_naive();
        let (from_ms, to_ms) = match self.calendar_period {
            CalendarPeriod::Day => {
                let from = timezone
                    .with_ymd_and_hms(local.year(), local.month(), local.day(), 0, 0, 0)
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar day".to_string())?;
                let next_date = local_date
                    .checked_add_signed(Duration::days(1))
                    .ok_or_else(|| "calendar day is outside the supported range".to_string())?;
                let to = timezone
                    .with_ymd_and_hms(
                        next_date.year(),
                        next_date.month(),
                        next_date.day(),
                        0,
                        0,
                        0,
                    )
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar day".to_string())?;
                (
                    Some(from.timestamp_millis() as u64),
                    Some(to.timestamp_millis() as u64),
                )
            }
            CalendarPeriod::Week => {
                let weekday = local.weekday().num_days_from_monday();
                let monday = local_date
                    .checked_sub_signed(Duration::days(i64::from(weekday)))
                    .ok_or_else(|| "calendar week is outside the supported range".to_string())?;
                let from = timezone
                    .with_ymd_and_hms(monday.year(), monday.month(), monday.day(), 0, 0, 0)
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar week".to_string())?;
                let next_monday = monday
                    .checked_add_signed(Duration::days(7))
                    .ok_or_else(|| "calendar week is outside the supported range".to_string())?;
                let to = timezone
                    .with_ymd_and_hms(
                        next_monday.year(),
                        next_monday.month(),
                        next_monday.day(),
                        0,
                        0,
                        0,
                    )
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar week".to_string())?;
                (
                    Some(from.timestamp_millis() as u64),
                    Some(to.timestamp_millis() as u64),
                )
            }
            CalendarPeriod::Month => {
                let first = timezone
                    .with_ymd_and_hms(local.year(), local.month(), 1, 0, 0, 0)
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar month".to_string())?;
                let (next_year, next_month) = if local.month() == 12 {
                    (local.year() + 1, 1)
                } else {
                    (local.year(), local.month() + 1)
                };
                let to = timezone
                    .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
                    .single()
                    .ok_or_else(|| "timezone cannot resolve calendar month".to_string())?;
                (
                    Some(first.timestamp_millis() as u64),
                    Some(to.timestamp_millis() as u64),
                )
            }
            CalendarPeriod::All => (None, None),
            CalendarPeriod::Custom => (self.from_ms, self.to_ms),
        };
        self.resolved_from_ms = from_ms;
        self.resolved_to_ms = to_ms;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct UsageAccumulator {
    request_count: u64,
    failed_attempt_count: u64,
    success_count: u64,
    error_count: u64,
    cancelled_count: u64,
    active_count: u64,
    unattributed_request_count: u64,
    effective_input_tokens: u64,
    reported_effective_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reported_total_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    usage_record_count: u64,
    cache_read_missing_count: u64,
    cache_read_explicit_zero_count: u64,
    effective_input_missing_count: u64,
    cache_comparable_count: u64,
    cache_comparable_read_tokens: u64,
    cache_comparable_effective_input_tokens: u64,
}

impl UsageAccumulator {
    fn add_request(&mut self, fact: &V3ProviderUsageFact) {
        if fact.result == V3ProviderUsageFactResult::Active {
            self.active_count += 1;
            return;
        }
        self.request_count += 1;
        match fact.result {
            V3ProviderUsageFactResult::Success => self.success_count += 1,
            V3ProviderUsageFactResult::Cancelled => self.cancelled_count += 1,
            V3ProviderUsageFactResult::Error
            | V3ProviderUsageFactResult::Issue
            | V3ProviderUsageFactResult::Unknown => self.error_count += 1,
            V3ProviderUsageFactResult::Active => unreachable!(),
            V3ProviderUsageFactResult::FailedAttempt => unreachable!(),
        }
        if fact
            .provider_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            self.unattributed_request_count += 1;
        }
    }

    fn add_success(&mut self, fact: &V3ProviderUsageFact) {
        self.add_usage(fact);
    }

    fn add_attempt(&mut self) {
        self.failed_attempt_count += 1;
    }

    fn add_usage(&mut self, fact: &V3ProviderUsageFact) {
        let Some(usage) = fact.usage.as_ref().and_then(Value::as_object) else {
            return;
        };
        let (input, cached_subcount, cache_read, cache_creation) =
            read_v3_canonical_usage_cache_fields(usage);
        let output_tokens = usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))
            .or_else(|| usage.get("candidatesTokenCount"))
            .and_then(Value::as_u64);
        let reported_total = usage.get("total_tokens").and_then(Value::as_u64);
        if input.is_none()
            && cached_subcount.is_none()
            && cache_read.is_none()
            && cache_creation.is_none()
            && output_tokens.is_none()
            && reported_total.is_none()
        {
            return;
        }
        let split =
            split_v3_canonical_usage_cache(input, cached_subcount, cache_read, cache_creation);
        self.usage_record_count += 1;
        let reported_effective_input =
            (input.is_some() || cache_creation.is_some()).then_some(split.effective_input_tokens);
        if let Some(effective_input) = reported_effective_input {
            self.effective_input_tokens =
                self.effective_input_tokens.saturating_add(effective_input);
            self.reported_effective_input_tokens = Some(
                self.reported_effective_input_tokens
                    .unwrap_or(0)
                    .saturating_add(effective_input),
            );
        }
        if let Some(cache_read) = split.cached_tokens {
            self.cache_read_tokens = Some(self.cache_read_tokens.unwrap_or(0) + cache_read);
            if cache_read == 0 {
                self.cache_read_explicit_zero_count += 1;
            }
        } else {
            self.cache_read_missing_count += 1;
        }
        if let Some(cache_write) = split.cache_creation_input_tokens {
            self.cache_write_tokens = Some(self.cache_write_tokens.unwrap_or(0) + cache_write);
        }
        if let Some(output) = output_tokens {
            self.output_tokens = Some(self.output_tokens.unwrap_or(0) + output);
        }
        if let Some(total) = reported_total {
            self.reported_total_tokens = Some(
                self.reported_total_tokens
                    .unwrap_or(0)
                    .saturating_add(total),
            );
        }
        if reported_effective_input.is_none() {
            self.effective_input_missing_count += 1;
        }
        if reported_effective_input.is_some() && split.cached_tokens.is_some() {
            self.cache_comparable_count += 1;
            self.cache_comparable_read_tokens = self.cache_comparable_read_tokens.saturating_add(
                split
                    .cached_tokens
                    .unwrap_or(0)
                    .min(split.effective_input_tokens),
            );
            self.cache_comparable_effective_input_tokens = self
                .cache_comparable_effective_input_tokens
                .saturating_add(split.effective_input_tokens);
        }
    }

    fn finish(&self) -> Value {
        json!({
            "request_count": self.request_count,
            "failed_attempt_count": self.failed_attempt_count,
            "success_count": self.success_count,
            "error_count": self.error_count,
            "cancelled_count": self.cancelled_count,
            "active_count": self.active_count,
            "unattributed_request_count": self.unattributed_request_count,
            "effective_input_tokens": self.effective_input_tokens,
            "reported_effective_input_tokens": self.reported_effective_input_tokens,
            "output_tokens": self.output_tokens,
            "reported_total_tokens": self.reported_total_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cache_hit_rate_percent": if self.cache_comparable_count > 0
                && self.cache_comparable_effective_input_tokens > 0
            {
                Value::from(
                    (self.cache_comparable_read_tokens as f64
                        / self.cache_comparable_effective_input_tokens as f64)
                        * 100.0,
                )
            } else {
                Value::Null
            },
            "usage_record_count": self.usage_record_count,
            "cache_read_missing_count": self.cache_read_missing_count,
            "cache_read_explicit_zero_count": self.cache_read_explicit_zero_count,
            "effective_input_missing_count": self.effective_input_missing_count,
            "cache_comparable_count": self.cache_comparable_count,
            "cache_comparable_read_tokens": self.cache_comparable_read_tokens,
            "cache_comparable_effective_input_tokens": self
                .cache_comparable_effective_input_tokens,
        })
    }
}

#[derive(Debug, Clone)]
struct ProviderUsageEntry {
    provider_id: Option<String>,
    bucket: UsageAccumulator,
}

fn bucket_label(started_epoch_ms: u64, grain: UsageGrain, timezone: Tz) -> String {
    let millis = i64::try_from(started_epoch_ms).unwrap_or_default();
    let Some(timestamp) = DateTime::<Utc>::from_timestamp_millis(millis) else {
        return String::new();
    };
    let local = timestamp.with_timezone(&timezone);
    match grain {
        UsageGrain::Hour => local.format("%Y-%m-%d %H:00").to_string(),
        UsageGrain::Day => local.format("%Y-%m-%d").to_string(),
        UsageGrain::Week => {
            let weekday = local.weekday().num_days_from_monday();
            let monday = local
                .date_naive()
                .checked_sub_signed(Duration::days(i64::from(weekday)))
                .unwrap_or(local.date_naive());
            monday.format("%Y-%m-%d").to_string()
        }
        UsageGrain::Month => local.format("%Y-%m").to_string(),
    }
}

fn bucket_value(entry: ProviderUsageEntry) -> Value {
    let mut value = entry.bucket.finish();
    value["provider_id"] = entry.provider_id.map(Value::from).unwrap_or(Value::Null);
    value
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ProviderUsageResponse {
    /// JSON contract for the `provider_usage` response field.
    ///
    /// `summary` contains:
    /// - `request_count`: terminal logical requests; failed provider attempts
    ///   and active requests are excluded.
    /// - `failed_attempt_count`: failed provider attempts, tracked separately
    ///   from logical requests.
    /// - `success_count`, `error_count`, `cancelled_count`, `active_count`,
    ///   and `unattributed_request_count`: mutually meaningful terminal and
    ///   active classifications. Unattributed requests remain in
    ///   `request_count`.
    /// - `usage_record_count`: successful requests with at least one
    ///   recognized token field.
    /// - `effective_input_tokens` and `reported_effective_input_tokens`:
    ///   canonical input totals from successful requests. The reported field is
    ///   null until at least one successful request reports effective input.
    /// - `output_tokens` and `reported_total_tokens`: sums from successful
    ///   requests; null until at least one successful request reports them.
    /// - `cache_read_tokens` and `cache_write_tokens`: sums from successful
    ///   requests; null until at least one successful request reports them.
    /// - `cache_hit_rate_percent`: comparable cache reads divided by comparable
    ///   effective input; null when no comparable record exists.
    /// - `cache_read_missing_count`, `cache_read_explicit_zero_count`, and
    ///   `effective_input_missing_count`: non-comparable record diagnostics.
    /// - `cache_comparable_count`, `cache_comparable_read_tokens`, and
    ///   `cache_comparable_effective_input_tokens`: the exact numerator,
    ///   denominator, and record count used by the hit-rate calculation.
    ///
    /// `by_provider` contains the same fields plus `provider_id`; null groups
    /// unattributed requests. `timeseries` contains the same fields plus a
    /// calendar `date` label. `range` contains `timezone`, `grain`,
    /// `as_of_ms`, `resolved_from_ms`, and `resolved_to_ms`; the resolved range
    /// is half-open.
    ///
    /// `coverage` contains `source`, `complete`, `partial`,
    /// `statistics_started_epoch_ms`, `detail_started_epoch_ms`,
    /// `retained_from_ms`, and `listeners`. Each listener entry contains
    /// `listener_id`, `statistics_started_epoch_ms`, `detail_started_epoch_ms`,
    /// `detail_incomplete`, and `gaps`.
    pub summary: Value,
    /// The same statistics grouped by exact provider ID.
    pub by_provider: Vec<Value>,
    /// Calendar-grain statistics from the selected statistics source.
    pub timeseries: Vec<Value>,
    /// Resolved timezone, grain, as-of time, and half-open range bounds.
    pub range: Value,
    /// Statistics/detail boundaries, completeness, and per-listener gaps.
    pub coverage: Value,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ProviderUsageSourceFilters {
    ports: Option<HashSet<u16>>,
    provider_ids: Option<HashSet<Option<String>>>,
    uses_retained_scope: bool,
    detail_only: bool,
}

impl ProviderUsageSourceFilters {
    pub(super) fn new(
        port: Option<u16>,
        ports: &[u16],
        provider: Option<&str>,
        provider_id: Option<&str>,
        provider_ids: &[String],
        detail_only: bool,
    ) -> Self {
        let mut selected_ports = HashSet::new();
        if let Some(port) = port {
            selected_ports.insert(port);
        }
        selected_ports.extend(ports);
        let mut selected_providers = HashSet::new();
        if let Some(provider) = provider_id.map(str::trim).filter(|value| !value.is_empty()) {
            selected_providers.insert(Some(provider.to_string()));
        }
        for provider in provider_ids.iter().map(String::as_str) {
            selected_providers.insert(Some(provider.to_string()));
        }
        Self {
            ports: (!selected_ports.is_empty()).then_some(selected_ports),
            provider_ids: (!selected_providers.is_empty()).then_some(selected_providers),
            uses_retained_scope: provider.is_some_and(|value| !value.trim().is_empty()),
            detail_only,
        }
    }

    pub(super) fn matches(&self, fact: &V3ProviderUsageFact) -> bool {
        self.ports
            .as_ref()
            .is_none_or(|ports| ports.contains(&fact.listener_id))
            && self.provider_ids.as_ref().is_none_or(|providers| {
                providers.contains(&fact.provider_id.as_deref().map(str::to_string))
            })
    }

    pub(super) fn uses_retained_scope(&self) -> bool {
        self.uses_retained_scope || self.detail_only
    }

    pub(super) fn selected_ports(&self) -> Option<&HashSet<u16>> {
        self.ports.as_ref()
    }

    fn has_provider_filter(&self) -> bool {
        self.uses_retained_scope || self.provider_ids.is_some()
    }

    fn matches_listener(&self, listener_id: u16) -> bool {
        self.ports
            .as_ref()
            .is_none_or(|ports| ports.contains(&listener_id))
    }
}

/// Normalizes one retained usage object for the detail API.
///
/// Provider usage statistics use the same accumulator, but this projection is
/// row-local and cannot decide report-level comparability. It therefore keeps
/// the canonical token fields and exposes `cache_comparable` as a row fact.
pub(super) fn normalize_retained_usage(usage: &Value) -> Value {
    let source = usage.as_object();
    let (input, cached_subcount, cache_read, cache_creation) = source
        .map(read_v3_canonical_usage_cache_fields)
        .unwrap_or((None, None, None, None));
    let split = split_v3_canonical_usage_cache(input, cached_subcount, cache_read, cache_creation);
    let output_tokens = source
        .and_then(|usage| {
            usage
                .get("output_tokens")
                .or_else(|| usage.get("completion_tokens"))
                .or_else(|| usage.get("candidatesTokenCount"))
        })
        .and_then(Value::as_u64);
    let reported_total = source
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(Value::as_u64);
    let cache_input_present = input.is_some() || cache_creation.is_some();
    let cache_reported = cached_subcount.is_some() || cache_read.is_some();
    json!({
        "effective_input_tokens": if cache_input_present {
            Value::from(split.effective_input_tokens)
        } else {
            Value::Null
        },
        "output_tokens": output_tokens,
        "reported_total_tokens": reported_total,
        "cache_read_tokens": split.cached_tokens,
        "cache_write_tokens": split.cache_creation_input_tokens,
        "cache_hit_rate_percent": if cache_reported
            && cache_input_present
            && split.effective_input_tokens > 0
        {
            Value::from(
                (split.cached_tokens.unwrap_or(0) as f64
                    / split.effective_input_tokens as f64)
                    * 100.0,
            )
        } else {
            Value::Null
        },
    })
}

fn fact_from_retained_row(row: &QueryRow) -> V3ProviderUsageFact {
    let result = match row.result.as_deref() {
        Some("success") => V3ProviderUsageFactResult::Success,
        Some("error") => V3ProviderUsageFactResult::Error,
        Some("cancelled") => V3ProviderUsageFactResult::Cancelled,
        Some("issue") => V3ProviderUsageFactResult::Issue,
        Some("failed-attempt") => V3ProviderUsageFactResult::FailedAttempt,
        None if row.finished_epoch_ms.is_none() => V3ProviderUsageFactResult::Active,
        Some(_) | None => V3ProviderUsageFactResult::Unknown,
    };
    let mut gaps = Vec::new();
    if result == V3ProviderUsageFactResult::Success && row.usage.is_none() {
        gaps.push("missing_usage".to_string());
    }
    if row.result.as_deref() == Some("failed-attempt") {
        gaps.push("retained_attempt_ordinal_unavailable".to_string());
    }
    V3ProviderUsageFact {
        listener_id: row.scope.port,
        request_key: row.request_key.clone(),
        attempt_ordinal: row
            .meta
            .get("observed_error")
            .and_then(|error| error.get("attempt_index"))
            .and_then(Value::as_u64),
        request_started_epoch_ms: row.started_epoch_ms,
        result,
        provider_id: row
            .meta
            .get("provider_id")
            .or_else(|| row.meta.get("provider"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        usage: (result == V3ProviderUsageFactResult::Success)
            .then(|| row.usage.clone())
            .flatten(),
        gaps,
    }
}

fn coverage_for_retained_rows(rows: &[QueryRow]) -> Vec<V3ProviderUsageCoverage> {
    let mut listeners = BTreeMap::<u16, u64>::new();
    for row in rows {
        listeners
            .entry(row.scope.port)
            .and_modify(|started| *started = (*started).min(row.started_epoch_ms))
            .or_insert(row.started_epoch_ms);
    }
    listeners
        .into_iter()
        .map(|(listener_id, started)| V3ProviderUsageCoverage {
            listener_id,
            statistics_started_epoch_ms: Some(started),
            detail_started_epoch_ms: Some(started),
            detail_incomplete: false,
            gaps: vec!["retained_scope_only".to_string()],
        })
        .collect()
}

pub(super) fn build_provider_usage(
    query: &ProviderUsageQuery,
    source_filters: &ProviderUsageSourceFilters,
    facts: &V3ProviderUsageRead,
    rows: &[QueryRow],
    matching_detail_from_ms: Option<u64>,
    now_ms: u64,
) -> Result<ProviderUsageResponse, String> {
    let from_ms = query.resolved_from_ms;
    let to_ms = query.resolved_to_ms;
    let timezone = query
        .timezone
        .parse::<Tz>()
        .map_err(|_| format!("invalid timezone: {}", query.timezone))?;
    let mut summary = (UsageAccumulator::default(), HashSet::<(u16, String)>::new());
    let mut providers: BTreeMap<Option<String>, (UsageAccumulator, HashSet<(u16, String)>)> =
        BTreeMap::new();
    let mut buckets: BTreeMap<String, UsageAccumulator> = BTreeMap::new();

    // A retained-scope filter cannot be applied to durable facts that do not
    // carry the filtered detail fields. In that case the complete report uses
    // the same retained rows as the detail list and declares that source.
    let use_retained = facts.facts.is_empty() || source_filters.uses_retained_scope();

    let retained_facts =
        use_retained.then(|| rows.iter().map(fact_from_retained_row).collect::<Vec<_>>());
    for fact in facts
        .facts
        .iter()
        .filter(|_| !use_retained)
        .chain(retained_facts.iter().flatten())
    {
        let started = fact.request_started_epoch_ms;
        if from_ms.is_some_and(|from| started < from) || to_ms.is_some_and(|to| started >= to) {
            continue;
        }
        if !source_filters.matches(fact) {
            continue;
        }
        let provider = fact
            .provider_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (provider_entry, provider_logical_requests) = providers
            .entry(provider.clone())
            .or_insert_with(|| (UsageAccumulator::default(), HashSet::<(u16, String)>::new()));
        let bucket_key = bucket_label(fact.request_started_epoch_ms, query.grain, timezone);
        let bucket = buckets.entry(bucket_key).or_default();
        if fact.result == V3ProviderUsageFactResult::FailedAttempt {
            summary.0.add_attempt();
            provider_entry.add_attempt();
            bucket.add_attempt();
        } else if fact.attempt_ordinal.is_none()
            && provider_logical_requests.insert((fact.listener_id, fact.request_key.clone()))
        {
            summary
                .1
                .insert((fact.listener_id, fact.request_key.clone()));
            summary.0.add_request(fact);
            provider_entry.add_request(fact);
            bucket.add_request(fact);
            if fact.result == V3ProviderUsageFactResult::Success {
                summary.0.add_success(fact);
                provider_entry.add_success(fact);
                bucket.add_success(fact);
            }
        }
    }

    let mut by_provider = providers
        .into_iter()
        .map(|(provider_id, accumulator)| ProviderUsageEntry {
            provider_id,
            bucket: accumulator.0,
        })
        .map(bucket_value)
        .collect::<Vec<_>>();
    by_provider.sort_by(|left, right| {
        left["provider_id"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["provider_id"].as_str().unwrap_or_default())
    });

    let timeseries = buckets
        .into_iter()
        .map(|(date, accumulator)| {
            let mut value = accumulator.finish();
            value["date"] = Value::from(date);
            value
        })
        .collect::<Vec<_>>();

    let mut coverage_entries = if use_retained {
        coverage_for_retained_rows(rows)
    } else {
        facts.coverage.clone()
    };
    for entry in coverage_entries.iter_mut() {
        if entry.statistics_started_epoch_ms.is_none() {
            entry.gaps.push("statistics_start_unknown".to_string());
        }
        if entry.detail_started_epoch_ms.is_none() {
            entry.gaps.push("detail_start_unknown".to_string());
        }
        entry.gaps.sort();
        entry.gaps.dedup();
    }
    coverage_entries.sort_by_key(|entry| entry.listener_id);
    let listener_detail_from_ms = coverage_entries
        .iter()
        .filter(|entry| source_filters.matches_listener(entry.listener_id))
        .filter_map(|entry| entry.detail_started_epoch_ms)
        .min();
    // Durable coverage is listener-scoped. When a Provider filter is active,
    // only matching retained detail can prove that Provider's detail start.
    let detail_from_ms = if source_filters.has_provider_filter() {
        matching_detail_from_ms
    } else {
        listener_detail_from_ms.or(matching_detail_from_ms)
    };
    let statistics_from_coverage_ms = coverage_entries
        .iter()
        .filter_map(|entry| entry.statistics_started_epoch_ms)
        .min();
    let facts_started = facts
        .facts
        .iter()
        .map(|fact| fact.request_started_epoch_ms)
        .min();
    let statistics_from_ms = statistics_from_coverage_ms.or(facts_started);
    let facts_unavailable = facts.facts.is_empty();
    let source = if use_retained {
        "retained_detail"
    } else {
        "durable_facts"
    };
    let partial = facts_unavailable
        || coverage_entries.iter().any(|entry| {
            entry.detail_incomplete
                || from_ms.is_some_and(|from| {
                    entry
                        .statistics_started_epoch_ms
                        .is_some_and(|started| started > from)
                })
        });
    Ok(ProviderUsageResponse {
        summary: summary.0.finish(),
        by_provider,
        timeseries,
        range: json!({
            "timezone": query.timezone,
            "grain": match query.grain {
                UsageGrain::Day => "day",
                UsageGrain::Week => "week",
                UsageGrain::Month => "month",
                UsageGrain::Hour => "hour",
            },
            "as_of_ms": now_ms,
            "resolved_from_ms": from_ms,
            "resolved_to_ms": to_ms,
        }),
        coverage: json!({
            "source": source,
            "complete": !partial,
            "statistics_started_epoch_ms": statistics_from_ms,
            "detail_started_epoch_ms": detail_from_ms,
            "retained_from_ms": detail_from_ms,
            "partial": partial,
            "listeners": coverage_entries,
        }),
    })
}

fn date_epoch_ms(date: &str, timezone: Tz) -> Result<u64, String> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| format!("invalid anchor_date: {date}"))?;
    let local = timezone
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
        .single()
        .ok_or_else(|| format!("timezone cannot resolve anchor_date: {date}"))?;
    let millis = local.timestamp_millis();
    if millis < 0 {
        return Err(format!("anchor_date is before the unix epoch: {date}"));
    }
    Ok(millis as u64)
}
