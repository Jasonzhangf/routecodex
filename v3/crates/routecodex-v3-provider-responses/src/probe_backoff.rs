/// Shared provider failure cooldown and recovery-probe ladder, in milliseconds.
/// Every provider starts at 5s; only continuous failure or failed probes move it
/// toward the 30m ceiling. A successful probe resets the provider to the first
/// step.
pub(crate) const PROVIDER_FAILURE_LADDER_MS: [u64; 7] =
    [5_000, 10_000, 30_000, 60_000, 120_000, 900_000, 1_800_000];

pub(crate) const MAX_PROBE_INTERVAL_MS: u64 =
    PROVIDER_FAILURE_LADDER_MS[PROVIDER_FAILURE_LADDER_MS.len() - 1];

pub(crate) fn probe_backoff_ms(failure_count: u8) -> u64 {
    PROVIDER_FAILURE_LADDER_MS[usize::from(failure_count).min(PROVIDER_FAILURE_LADDER_MS.len() - 1)]
}

pub(crate) fn long_probe_backoff_ms(failure_count: u8) -> u64 {
    probe_backoff_ms(failure_count)
}

/// Select the cooldown step from the exact provider key's continuous failures
/// and observed failure rate. Small samples stay at the aggressive first step;
/// a sustained high failure rate can advance a provider independently of its
/// sibling keys.
pub(crate) fn provider_failure_cooldown_ms(
    failure_streak: u32,
    observed_attempts: u32,
    observed_failures: u32,
) -> u64 {
    let streak_step = failure_streak.saturating_sub(1) as usize;
    let rate_step = if observed_attempts < 3 {
        0
    } else {
        let failure_rate_milli = u64::from(observed_failures)
            .saturating_mul(1_000)
            .checked_div(u64::from(observed_attempts))
            .unwrap_or(0)
            .min(1_000);
        match failure_rate_milli {
            0..=499 => 0,
            500..=699 => 1,
            700..=849 => 2,
            850..=949 => 3,
            950..=999 => 4,
            _ => 5,
        }
    };
    PROVIDER_FAILURE_LADDER_MS[streak_step
        .max(rate_step)
        .min(PROVIDER_FAILURE_LADDER_MS.len() - 1)]
}

pub(crate) fn adaptive_probe_interval_ms(
    observed_attempts: u32,
    observed_failures: u32,
    recovery_ewma_ms: Option<u64>,
    probe_failure_count: u8,
) -> u64 {
    if recovery_ewma_ms.is_none() && probe_failure_count == 0 {
        return PROVIDER_FAILURE_LADDER_MS[0];
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
    use super::{adaptive_probe_interval_ms, probe_backoff_ms, provider_failure_cooldown_ms};

    #[test]
    fn adaptive_probe_starts_fast_and_stretches_for_non_recovery() {
        assert_eq!(adaptive_probe_interval_ms(3, 3, None, 0), 5_000);
        assert!(adaptive_probe_interval_ms(10, 10, None, 1) <= 15 * 60_000);
    }

    #[test]
    fn provider_probe_backoff_uses_the_aggressive_shared_ladder() {
        assert_eq!(probe_backoff_ms(0), 5_000);
        assert_eq!(probe_backoff_ms(1), 10_000);
        assert_eq!(probe_backoff_ms(2), 30_000);
        assert_eq!(probe_backoff_ms(3), 60_000);
        assert_eq!(probe_backoff_ms(4), 120_000);
        assert_eq!(probe_backoff_ms(5), 900_000);
        assert_eq!(probe_backoff_ms(6), 1_800_000);
        assert_eq!(probe_backoff_ms(255), 1_800_000);
    }

    #[test]
    fn failure_rate_advances_only_after_a_meaningful_sample() {
        assert_eq!(provider_failure_cooldown_ms(1, 1, 1), 5_000);
        assert_eq!(provider_failure_cooldown_ms(1, 10, 10), 900_000);
        assert_eq!(provider_failure_cooldown_ms(3, 3, 3), 30_000);
    }

    #[test]
    fn recovery_history_shortens_probe_interval_at_equal_error_rate() {
        let slow = adaptive_probe_interval_ms(10, 8, Some(30 * 60_000), 0);
        let fast = adaptive_probe_interval_ms(10, 8, Some(5_000), 0);
        assert!(fast < slow);
    }
}
