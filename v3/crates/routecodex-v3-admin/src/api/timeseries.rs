// feature_id: v3.admin_observability_aggregation
// Daily/Hourly timeseries projection for the admin observability records endpoint.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TimeseriesBucket {
    /// YYYY-MM-DD for day buckets, YYYY-MM-DD HH:00 for hour buckets.
    pub date: String,
    pub count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub total_tokens: u64,
    /// Cache hit rate within this bucket. None when raw input is zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate_percent: Option<f64>,
}

pub(crate) struct TimeseriesRow<'a> {
    pub started_epoch_ms: u64,
    pub usage: Option<&'a Value>,
    pub result: Option<&'a str>,
}

pub(crate) fn usage_is_countable(result: Option<&str>) -> bool {
    result == Some("success")
}

pub(crate) fn system_epoch_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("system clock is before unix epoch: {error}"))
}

fn floor_div(value: i64, divisor: i64) -> i64 {
    value.div_euclid(divisor)
}

/// Returns the epoch-ms of the local calendar-day start (00:00 in the given
/// timezone) for the given instant.
pub(crate) fn local_day_start(epoch_ms: u64, timezone_offset_minutes: i32) -> u64 {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_ms = epoch_ms as i64 - offset_ms;
    (floor_div(local_ms, 86_400_000) * 86_400_000 + offset_ms) as u64
}

/// Returns the epoch-ms of the local calendar-hour start for the given instant.
fn local_hour_start(epoch_ms: u64, timezone_offset_minutes: i32) -> u64 {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_ms = epoch_ms as i64 - offset_ms;
    (floor_div(local_ms, 3_600_000) * 3_600_000 + offset_ms) as u64
}

/// Returns the epoch-ms of the local week start (Monday 00:00) for the given
/// instant. The Unix epoch (1970-01-01) is a Thursday, so Monday is 3 days
/// earlier in that week.
fn local_monday_start(epoch_ms: u64, timezone_offset_minutes: i32) -> u64 {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_ms = epoch_ms as i64 - offset_ms;
    let local_day = floor_div(local_ms, 86_400_000);
    let weekday = (local_day + 3).rem_euclid(7);
    ((local_day - weekday) * 86_400_000 + offset_ms) as u64
}

/// Formats a UTC date string "YYYY-MM-DD".
fn utc_date_for_local_day(epoch_ms: u64, timezone_offset_minutes: i32) -> String {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let days = floor_div((epoch_ms as i64 - offset_ms) / 1_000, 86_400);
    let shifted = days + 719_468;
    let era = floor_div(shifted, 146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_period = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_period + 2) / 5 + 1;
    let month = if month_period < 10 {
        month_period + 3
    } else {
        month_period - 9
    };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}")
}

/// Formats an hour-bucket label "YYYY-MM-DD HH:00".
fn utc_hour_label(epoch_ms: u64, timezone_offset_minutes: i32) -> String {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_ms = epoch_ms as i64 - offset_ms;
    let total_minutes = floor_div(local_ms, 60_000);
    let hour = ((total_minutes % 1_440) / 60) as i32;
    let date_part = utc_date_for_local_day(epoch_ms, timezone_offset_minutes);
    format!("{date_part} {hour:02}:00")
}

pub(crate) fn build_timeseries(
    rows: &[TimeseriesRow<'_>],
    range: &str,
    timezone_offset_minutes: i32,
) -> Result<Vec<TimeseriesBucket>, String> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let is_today = range == "today";
    let is_month = range == "month";
    let hour_ms = 3_600_000_u64;
    let day_ms = 86_400_000_u64;

    let mut buckets: BTreeMap<String, TimeseriesBucket> = BTreeMap::new();

    for row in rows {
        let key = if is_today {
            let hour = local_hour_start(row.started_epoch_ms, timezone_offset_minutes);
            utc_hour_label(hour, timezone_offset_minutes)
        } else if is_month {
            utc_date_for_local_day(
                local_monday_start(row.started_epoch_ms, timezone_offset_minutes),
                timezone_offset_minutes,
            )
        } else {
            utc_date_for_local_day(row.started_epoch_ms, timezone_offset_minutes)
        };

        let bucket = buckets
            .entry(key.clone())
            .or_insert_with(|| TimeseriesBucket {
                date: key,
                count: 0,
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                total_tokens: 0,
                cache_hit_rate_percent: None,
            });
        bucket.count += 1;
        // Token sums follow the same aggregate rule as the records stats: only
        // successful terminal responses have billable/cacheable usage.
        if usage_is_countable(row.result) {
            let usage = row.usage;
            let token = |name: &str| {
                usage
                    .and_then(|usage| usage.get(name))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            let row_input = token("input_tokens");
            let row_output = token("output_tokens");
            let row_cached = token("cached_tokens");
            let row_cache_read = usage
                .and_then(|usage| usage.get("cache_read_input_tokens"))
                .and_then(Value::as_u64)
                .or_else(|| usage.and_then(|usage| usage.get("cached_tokens")).and_then(Value::as_u64))
                .unwrap_or(0);
            let row_cache_creation = token("cache_creation_input_tokens");
            bucket.input_tokens += row_input;
            bucket.output_tokens += row_output;
            bucket.cached_tokens += row_cached;
            bucket.cache_read_input_tokens += row_cache_read;
            bucket.cache_creation_input_tokens += row_cache_creation;
            bucket.total_tokens += token("total_tokens");
        }
    }

    // Fill in empty buckets so the chart shows a continuous axis.
    if range != "all" {
        let now_ms = system_epoch_ms()?;
        if is_today {
            let today_start = local_day_start(now_ms, timezone_offset_minutes);
            // Always emit all 24 hours of the current local day.
            for hour in 0..24 {
                let hour_ms_val = today_start + (hour as u64) * hour_ms;
                let key = utc_hour_label(hour_ms_val, timezone_offset_minutes);
                buckets
                    .entry(key.clone())
                    .or_insert_with(|| TimeseriesBucket {
                        date: key,
                        count: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cached_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        total_tokens: 0,
                        cache_hit_rate_percent: None,
                    });
            }
        } else if is_month {
            let now_ms = system_epoch_ms()?;
            let range_start = local_day_start(now_ms, timezone_offset_minutes)
                .saturating_sub(29 * 24 * 60 * 60 * 1000);
            let mut week_start = local_monday_start(range_start, timezone_offset_minutes);
            let today_start = local_day_start(now_ms, timezone_offset_minutes);
            while week_start <= today_start {
                let key = utc_date_for_local_day(week_start, timezone_offset_minutes);
                buckets
                    .entry(key.clone())
                    .or_insert_with(|| TimeseriesBucket {
                        date: key,
                        count: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cached_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        total_tokens: 0,
                        cache_hit_rate_percent: None,
                    });
                week_start += 7 * day_ms;
            }
        } else {
            // "week": fill every day from first data to today.
            let first = local_day_start(
                rows.iter()
                    .map(|r| r.started_epoch_ms)
                    .min()
                    .unwrap_or(now_ms),
                timezone_offset_minutes,
            );
            let today_start = local_day_start(now_ms, timezone_offset_minutes);
            let mut day = first;
            while day <= today_start {
                let key = utc_date_for_local_day(day, timezone_offset_minutes);
                buckets
                    .entry(key.clone())
                    .or_insert_with(|| TimeseriesBucket {
                        date: key,
                        count: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cached_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        total_tokens: 0,
                        cache_hit_rate_percent: None,
                    });
                day += day_ms;
            }
        }
    }

    Ok(buckets
        .into_iter()
        .map(|(date, mut bucket)| {
            bucket.date = date;
            bucket.cache_hit_rate_percent = if bucket.input_tokens > 0 {
                Some((bucket.cache_read_input_tokens as f64 / bucket.input_tokens as f64) * 100.0)
            } else {
                None
            };
            bucket
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_day_uses_browser_offset() {
        assert_eq!(utc_date_for_local_day(0, 0), "1970-01-01");
        assert_eq!(utc_date_for_local_day(3_600_000, -60), "1970-01-01");
        assert_eq!(utc_date_for_local_day(0, 60), "1969-12-31");
    }

    #[test]
    fn hourly_buckets_sum_typed_usage_from_filtered_rows() {
        let tz = 0; // UTC
        let hour_ms = 3_600_000_u64;
        let now_ms = system_epoch_ms().unwrap();
        let day_start = local_day_start(now_ms, tz);
        let h2 = day_start + 2 * hour_ms;
        let h5 = day_start + 5 * hour_ms;
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 102,
            "cached_tokens": 50,
            "total_tokens": 202
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: h2,
                usage: Some(&usage),
                result: Some("success"),
            },
            TimeseriesRow {
                started_epoch_ms: h2,
                usage: Some(&usage),
                result: Some("success"),
            },
            TimeseriesRow {
                started_epoch_ms: h5,
                usage: Some(&usage),
                result: Some("success"),
            },
        ];
        let buckets = build_timeseries(&rows, "today", tz).unwrap();
        // 24 hours should be present; only 02:00 and 05:00 have data.
        assert_eq!(buckets.len(), 24);
        let h2_bucket = buckets.iter().find(|b| b.date.contains(" 02:00")).unwrap();
        assert_eq!(h2_bucket.count, 2);
        assert_eq!(h2_bucket.input_tokens, 200);
        let h5_bucket = buckets.iter().find(|b| b.date.contains(" 05:00")).unwrap();
        assert_eq!(h5_bucket.count, 1);
        assert_eq!(h5_bucket.total_tokens, 202);
        // Empty buckets have zero usage.
        let h0_bucket = buckets.iter().find(|b| b.date.contains(" 00:00")).unwrap();
        assert_eq!(h0_bucket.count, 0);
        assert_eq!(h0_bucket.input_tokens, 0);
    }

    #[test]
    fn monthly_buckets_aggregate_by_local_monday() {
        let tz = 0;
        let now_ms = system_epoch_ms().unwrap();
        let today_start = local_day_start(now_ms, tz);
        // Anchor one row on the current Monday and one six days later so both
        // stay in the same calendar week and must share one bucket.
        let monday = local_monday_start(today_start, tz);
        let saturday = monday + 6 * 86_400_000_u64;
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cached_tokens": 30,
            "total_tokens": 150
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: monday + 1000,
                usage: Some(&usage),
                result: Some("success"),
            },
            TimeseriesRow {
                started_epoch_ms: saturday + 1000,
                usage: Some(&usage),
                result: Some("success"),
            },
        ];
        let buckets = build_timeseries(&rows, "month", tz).unwrap();
        let monday_label = utc_date_for_local_day(monday, tz);
        assert!(buckets.iter().any(|b| b.date == monday_label));
        let monday_bucket = buckets.iter().find(|b| b.date == monday_label).unwrap();
        assert_eq!(monday_bucket.count, 2);
        assert_eq!(monday_bucket.input_tokens, 200);
        assert_eq!(monday_bucket.output_tokens, 100);
        assert_eq!(monday_bucket.cached_tokens, 60);
        assert_eq!(monday_bucket.total_tokens, 300);
    }

    #[test]
    fn timeseries_only_success_rows_contribute_usage() {
        let now_ms = system_epoch_ms().unwrap();
        let day_start = local_day_start(now_ms, 0);
        let success_usage = json!({
            "input_tokens": 100,
            "output_tokens": 50,
            "cached_tokens": 30,
            "total_tokens": 150
        });
        let error_usage = json!({
            "input_tokens": 999,
            "output_tokens": 999,
            "cached_tokens": 999,
            "total_tokens": 999
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: day_start + 1000,
                usage: Some(&success_usage),
                result: Some("success"),
            },
            TimeseriesRow {
                started_epoch_ms: day_start + 2000,
                usage: Some(&error_usage),
                result: Some("error"),
            },
            TimeseriesRow {
                started_epoch_ms: day_start + 3000,
                usage: Some(&error_usage),
                result: None,
            },
        ];

        let buckets = build_timeseries(&rows, "week", 0).unwrap();
        assert_eq!(buckets.len(), 1);
        let bucket = &buckets[0];
        assert_eq!(bucket.count, 3);
        assert_eq!(bucket.input_tokens, 100);
        assert_eq!(bucket.output_tokens, 50);
        assert_eq!(bucket.cached_tokens, 30);
        assert_eq!(bucket.total_tokens, 150);
    }

    #[test]
    fn timeseries_cancelled_rows_do_not_contribute_usage() {
        let now_ms = system_epoch_ms().unwrap();
        let day_start = local_day_start(now_ms, 0);
        let usage = json!({
            "input_tokens": 1,
            "output_tokens": 1,
            "cached_tokens": 1,
            "total_tokens": 2
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: day_start + 1000,
                usage: Some(&usage),
                result: Some("cancelled"),
            },
            TimeseriesRow {
                started_epoch_ms: day_start + 2000,
                usage: Some(&usage),
                result: None,
            },
        ];

        let buckets = build_timeseries(&rows, "week", 0).unwrap();
        assert_eq!(buckets.len(), 1);
        let bucket = &buckets[0];
        assert_eq!(bucket.count, 2);
        assert_eq!(bucket.input_tokens, 0);
        assert_eq!(bucket.output_tokens, 0);
        assert_eq!(bucket.cached_tokens, 0);
        assert_eq!(bucket.total_tokens, 0);
    }

    #[test]
    fn timeseries_cache_hit_uses_read_tokens_over_raw_input() {
        let now_ms = system_epoch_ms().unwrap();
        let today_start = local_day_start(now_ms, 0);
        let yesterday_start = today_start - 86_400_000;
        let hit_usage = json!({
            "input_tokens": 1_000,
            "output_tokens": 20,
            "cache_read_input_tokens": 700,
            "cache_creation_input_tokens": 200,
            "total_tokens": 1_020
        });
        let creation_only_usage = json!({
            "input_tokens": 1_000,
            "output_tokens": 20,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 200,
            "total_tokens": 1_020
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: today_start + 1_000,
                usage: Some(&hit_usage),
                result: Some("success"),
            },
            TimeseriesRow {
                started_epoch_ms: yesterday_start + 1_000,
                usage: Some(&creation_only_usage),
                result: Some("success"),
            },
        ];

        let buckets = build_timeseries(&rows, "all", 0).unwrap();
        let today = buckets
            .iter()
            .find(|bucket| bucket.date == utc_date_for_local_day(today_start, 0))
            .expect("today bucket");
        assert_eq!(today.cache_read_input_tokens, 700);
        assert_eq!(today.cache_creation_input_tokens, 200);
        assert_eq!(today.cache_hit_rate_percent, Some(70.0));

        let yesterday = buckets
            .iter()
            .find(|bucket| bucket.date == utc_date_for_local_day(yesterday_start, 0))
            .expect("yesterday bucket");
        assert_eq!(yesterday.cache_read_input_tokens, 0);
        assert_eq!(yesterday.cache_creation_input_tokens, 200);
        assert_eq!(yesterday.cache_hit_rate_percent, Some(0.0));
    }
}
