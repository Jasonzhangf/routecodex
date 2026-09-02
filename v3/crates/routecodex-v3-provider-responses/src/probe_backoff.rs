/// Fixed probe retry cadence, in milliseconds:
/// 30s / 1m / 3m / 15m / 1h / 3h. The ladder loops: after the 3h step the
/// next probe failure returns to 30s. Index 0 is the first probe scheduled
/// when a key enters cooldown; index N is scheduled after probe failure N.
const PROBE_BACKOFF_MS: [u64; 6] = [
    30_000,
    60_000,
    3 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
];

pub(crate) fn probe_backoff_ms(failure_count: u8) -> u64 {
    PROBE_BACKOFF_MS[usize::from(failure_count) % PROBE_BACKOFF_MS.len()]
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
    use super::{adaptive_probe_interval_ms, probe_backoff_ms};

    #[test]
    fn adaptive_probe_starts_fast_and_stretches_for_non_recovery() {
        assert_eq!(adaptive_probe_interval_ms(3, 3, None, 0), 30_000);
        assert!(adaptive_probe_interval_ms(10, 10, None, 1) >= 15 * 60_000);
    }

    #[test]
    fn probe_backoff_ladder_is_30s_1m_3m_15m_1h_3h_and_loops() {
        assert_eq!(probe_backoff_ms(0), 30_000);
        assert_eq!(probe_backoff_ms(1), 60_000);
        assert_eq!(probe_backoff_ms(2), 3 * 60_000);
        assert_eq!(probe_backoff_ms(3), 15 * 60_000);
        assert_eq!(probe_backoff_ms(4), 60 * 60_000);
        assert_eq!(probe_backoff_ms(5), 3 * 60 * 60_000);
        // The ladder loops back to 30s after the 3h step.
        assert_eq!(probe_backoff_ms(6), 30_000);
        assert_eq!(probe_backoff_ms(7), 60_000);
        assert_eq!(probe_backoff_ms(12), 30_000);
    }

    #[test]
    fn recovery_history_shortens_probe_interval_at_equal_error_rate() {
        let slow = adaptive_probe_interval_ms(10, 8, Some(30 * 60_000), 0);
        let fast = adaptive_probe_interval_ms(10, 8, Some(5_000), 0);
        assert!(fast < slow);
    }
}
