const PROBE_BACKOFF_MS: [u64; 6] = [
    3 * 60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
    5 * 60 * 60_000,
];

pub(crate) fn probe_backoff_ms(failure_count: u8) -> u64 {
    PROBE_BACKOFF_MS[usize::from(failure_count).min(PROBE_BACKOFF_MS.len() - 1)]
}
