/// Shared recovery-probe backoff ladder, in milliseconds. Every provider
/// starts at 5s; only continuous failure or failed probes move it toward the
/// 30m ceiling. A successful probe resets the provider to the first step.
/// This ladder owns PROBE cadence only; the business cooldown duration is the
/// separate v29 consecutive-failure mapping below.
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

/// v29 unified consecutive-failure cooldown ladder for a complete
/// provider/interface/auth-key/model identity: 3 consecutive failures commit
/// a 10s cooldown-pool entry, 5 consecutive commit 30s, and 10 consecutive
/// commit one hour. The mapping is driven purely by the consecutive count of
/// the same typed fingerprint; the observed failure rate no longer advances
/// a cooldown, and probe cadence uses the plain `probe_backoff_ms` ladder.
/// Callers that commit a cooldown without waiting for the count (post-commit
/// stream breaks, typed irrecoverable boundaries, explicit lower-threshold
/// policies) land on the first v29 step.
pub(crate) fn provider_failure_cooldown_ms(failure_streak: u32) -> u64 {
    if failure_streak >= 10 {
        3_600_000
    } else if failure_streak >= 5 {
        30_000
    } else {
        10_000
    }
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
    fn consecutive_failure_cooldown_ladder_matches_the_v29_mapping() {
        // Threshold-bypass signals (stream breaks, irrecoverable typed
        // boundaries, explicit lower-threshold policies) land on the first
        // step; the ordinary countable path enters at 3 consecutive.
        assert_eq!(provider_failure_cooldown_ms(1), 10_000);
        assert_eq!(provider_failure_cooldown_ms(2), 10_000);
        assert_eq!(provider_failure_cooldown_ms(3), 10_000);
        assert_eq!(provider_failure_cooldown_ms(4), 10_000);
        assert_eq!(provider_failure_cooldown_ms(5), 30_000);
        assert_eq!(provider_failure_cooldown_ms(9), 30_000);
        assert_eq!(provider_failure_cooldown_ms(10), 3_600_000);
        assert_eq!(provider_failure_cooldown_ms(1_000), 3_600_000);
        // The observed failure rate no longer advances a cooldown; only the
        // consecutive count of the same typed fingerprint does.
        assert_eq!(provider_failure_cooldown_ms(3), 10_000);
    }
}
