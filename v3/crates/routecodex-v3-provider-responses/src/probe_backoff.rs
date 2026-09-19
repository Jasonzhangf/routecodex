/// Normal provider probe retry cadence, in milliseconds. 15 minutes is the
/// maximum wait for ordinary failures.
const PROBE_BACKOFF_MS: [u64; 5] = [5_000, 30_000, 60_000, 3 * 60_000, 15 * 60_000];

pub(crate) const MAX_PROBE_INTERVAL_MS: u64 = 30 * 60_000;

/// Authentication and persistent service failures retain the extended cadence.
const LONG_PROBE_BACKOFF_MS: [u64; 6] = [
    5_000,
    30_000,
    60_000,
    3 * 60_000,
    15 * 60_000,
    MAX_PROBE_INTERVAL_MS,
];

pub(crate) fn probe_backoff_ms(failure_count: u8) -> u64 {
    PROBE_BACKOFF_MS[usize::from(failure_count).min(PROBE_BACKOFF_MS.len() - 1)]
}

pub(crate) fn long_probe_backoff_ms(failure_count: u8) -> u64 {
    LONG_PROBE_BACKOFF_MS[usize::from(failure_count).min(LONG_PROBE_BACKOFF_MS.len() - 1)]
}

pub(crate) fn adaptive_probe_interval_ms(
    observed_attempts: u32,
    observed_failures: u32,
    recovery_ewma_ms: Option<u64>,
    probe_failure_count: u8,
) -> u64 {
    if recovery_ewma_ms.is_none() && probe_failure_count == 0 {
        return PROBE_BACKOFF_MS[0];
    }
    let failure_rate_milli: u64 = if observed_attempts == 0 {
        0
    } else {
        u64::from(observed_failures)
            .saturating_mul(1_000)
            .checked_div(u64::from(observed_attempts))
            .unwrap_or(1_000)
            .min(1_000)
    };
    let recovery_factor_milli = recovery_ewma_ms
        .map(|duration| {
            duration
                .saturating_mul(1_000)
                .checked_div(5 * 60_000)
                .unwrap_or(1_000)
        })
        .unwrap_or(0)
        .min(1_000);
    let score_milli = (failure_rate_milli.saturating_mul(600)
        + recovery_factor_milli.saturating_mul(400))
        / 1_000;
    let band = match score_milli {
        0..=199 => 0,
        200..=399 => 1,
        400..=599 => 2,
        600..=799 => 3,
        800..=949 => 4,
        _ => 5,
    };
    probe_backoff_ms(probe_failure_count.max(band as u8))
}

#[cfg(test)]
mod tests {
    use super::{adaptive_probe_interval_ms, long_probe_backoff_ms, probe_backoff_ms};

    #[test]
    fn adaptive_probe_starts_fast_and_stretches_for_non_recovery() {
        assert_eq!(adaptive_probe_interval_ms(3, 3, None, 0), 5_000);
        assert!(adaptive_probe_interval_ms(10, 10, None, 1) <= 15 * 60_000);
    }

    #[test]
    fn normal_probe_backoff_is_capped_at_fifteen_minutes() {
        assert_eq!(probe_backoff_ms(0), 5_000);
        assert_eq!(probe_backoff_ms(1), 30_000);
        assert_eq!(probe_backoff_ms(2), 60_000);
        assert_eq!(probe_backoff_ms(3), 3 * 60_000);
        assert_eq!(probe_backoff_ms(4), 15 * 60_000);
        assert_eq!(probe_backoff_ms(5), 15 * 60_000);
        assert_eq!(probe_backoff_ms(255), 15 * 60_000);
    }

    #[test]
    fn long_probe_backoff_is_capped_at_thirty_minutes() {
        assert_eq!(long_probe_backoff_ms(5), 30 * 60_000);
        assert_eq!(long_probe_backoff_ms(6), 30 * 60_000);
        assert_eq!(long_probe_backoff_ms(7), 30 * 60_000);
        assert_eq!(long_probe_backoff_ms(255), 30 * 60_000);
    }

    #[test]
    fn recovery_history_shortens_probe_interval_at_equal_error_rate() {
        let slow = adaptive_probe_interval_ms(10, 8, Some(30 * 60_000), 0);
        let fast = adaptive_probe_interval_ms(10, 8, Some(5_000), 0);
        assert!(fast < slow);
    }
}
