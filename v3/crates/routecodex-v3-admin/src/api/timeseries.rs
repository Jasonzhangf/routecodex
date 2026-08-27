// feature_id: v3.admin_observability_aggregation
// Daily timeseries projection for the admin observability records endpoint.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct TimeseriesBucket {
    pub date: String,
    pub count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
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

pub(crate) fn local_day_start(epoch_ms: u64, timezone_offset_minutes: i32) -> u64 {
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_ms = epoch_ms as i64 - offset_ms;
    (floor_div(local_ms, 86_400_000) * 86_400_000 + offset_ms) as u64
}

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

pub(crate) fn build_timeseries(
    rows: &[TimeseriesRow<'_>],
    range: &str,
    timezone_offset_minutes: i32,
) -> Result<Vec<TimeseriesBucket>, String> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut buckets = BTreeMap::new();
    for row in rows {
        let date = utc_date_for_local_day(row.started_epoch_ms, timezone_offset_minutes);
        let bucket = buckets.entry(date).or_insert(TimeseriesBucket {
            date: String::new(),
            count: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            total_tokens: 0,
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
            bucket.input_tokens += token("input_tokens");
            bucket.output_tokens += token("output_tokens");
            bucket.cached_tokens += token("cached_tokens");
            bucket.total_tokens += token("total_tokens");
        }
    }
    if range != "all" {
        let now_ms = system_epoch_ms()?;
        let today_start = local_day_start(now_ms, timezone_offset_minutes);
        let day_ms = 86_400_000_u64;
        let first_day = local_day_start(
            rows.iter()
                .map(|row| row.started_epoch_ms)
                .min()
                .unwrap_or(now_ms),
            timezone_offset_minutes,
        );
        let mut day = first_day;
        while day <= today_start {
            buckets
                .entry(utc_date_for_local_day(day, timezone_offset_minutes))
                .or_insert_with(|| TimeseriesBucket {
                    date: utc_date_for_local_day(day, timezone_offset_minutes),
                    count: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cached_tokens: 0,
                    total_tokens: 0,
                });
            day += day_ms;
        }
    }
    Ok(buckets
        .into_iter()
        .map(|(date, mut bucket)| {
            bucket.date = date;
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
    fn daily_buckets_sum_typed_usage_from_filtered_rows() {
        let timezone_offset_minutes = 420;
        let now_ms = system_epoch_ms().unwrap();
        let morning = local_day_start(now_ms, timezone_offset_minutes) + 3_600_000;
        let evening = morning + 7 * 3_600_000;
        let usage = json!({
            "input_tokens": 100,
            "output_tokens": 102,
            "cached_tokens": 50,
            "total_tokens": 202
        });
        let rows = vec![
            TimeseriesRow {
                started_epoch_ms: morning,
                usage: Some(&usage),
            },
            TimeseriesRow {
                started_epoch_ms: evening,
                usage: Some(&usage),
            },
        ];
        let buckets = build_timeseries(&rows, "today", timezone_offset_minutes).unwrap();
        assert_eq!(buckets.len(), 1);
        let bucket = &buckets[0];
        assert_eq!(bucket.count, 2);
        assert_eq!(bucket.input_tokens, 200);
        assert_eq!(bucket.output_tokens, 204);
        assert_eq!(bucket.cached_tokens, 100);
        assert_eq!(bucket.total_tokens, 404);
        assert!(bucket.date.matches('-').count() == 2);
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

        let buckets = build_timeseries(&rows, "today", 0).unwrap();
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

        let buckets = build_timeseries(&rows, "today", 0).unwrap();
        assert_eq!(buckets.len(), 1);
        let bucket = &buckets[0];
        assert_eq!(bucket.count, 2);
        assert_eq!(bucket.input_tokens, 0);
        assert_eq!(bucket.output_tokens, 0);
        assert_eq!(bucket.cached_tokens, 0);
        assert_eq!(bucket.total_tokens, 0);
    }
}
