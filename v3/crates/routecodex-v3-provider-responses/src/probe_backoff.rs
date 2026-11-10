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

#[cfg(test)]
mod tests {
    use super::{probe_backoff_ms, provider_failure_cooldown_ms};

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
        assert_eq!(provider_failure_cooldown_ms(3, 3, 3), 900_000);
    }
}
