//! Provider failure classification and retry policy – single source of truth.
//! Migrated from TypeScript `provider-failure-policy.ts`.

use serde::{Deserialize, Serialize};

const UNRECOVERABLE_CODES: &[&str] = &[
    "INVALID_API_KEY",
    "INVALID_ACCESS_TOKEN",
    "INSUFFICIENT_QUOTA",
    "MODEL_NOT_SUPPORTED",
    "MODEL_DISABLED",
    "NO_SUCH_MODEL",
    "ACCOUNT_DISABLED",
    "ACCOUNT_SUSPENDED",
    "ACCESS_DENIED",
    "FORBIDDEN",
];

const BLOCKING_RECOVERABLE_CODES: &[&str] = &[
    "PROVIDER_TRAFFIC_SATURATED",
    "HTTP_429",
    "HTTP_500",
    "HTTP_502",
    "HTTP_503",
    "HTTP_504",
    "SSE_TO_JSON_ERROR",
    "SSE_DECODE_ERROR",
    "UPSTREAM_EMPTY_OUTPUT",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    Unrecoverable,
    Recoverable,
    Special400,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryAction {
    RetrySameProvider,
    RerouteExplicitAlternative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackoffScope {
    None,
    Attempt,
    Recoverable,
    Provider,
}

const ERROR_ACTION_BACKOFF_SEQUENCE_MS: [u64; 3] = [1_000, 2_000, 3_000];

pub fn classify_failure(
    status_code: Option<u16>,
    error_code: Option<&str>,
    upstream_code: Option<&str>,
    is_network_error: bool,
) -> FailureClassification {
    let code = error_code.or(upstream_code).unwrap_or("");
    if UNRECOVERABLE_CODES.contains(&code) {
        return FailureClassification::Unrecoverable;
    }
    if is_network_error {
        return FailureClassification::Recoverable;
    }
    if let Some(status) = status_code {
        if matches!(status, 429 | 500 | 502 | 503 | 504) {
            return FailureClassification::Recoverable;
        }
        if status == 400 {
            return FailureClassification::Special400;
        }
        if status >= 500 {
            return FailureClassification::Recoverable;
        }
    }
    if BLOCKING_RECOVERABLE_CODES.contains(&code) {
        return FailureClassification::Recoverable;
    }
    FailureClassification::Recoverable
}

pub fn affects_health(classification: FailureClassification) -> bool {
    matches!(classification, FailureClassification::Unrecoverable)
}

pub fn is_blocking_recoverable(classification: FailureClassification, stage: Option<&str>) -> bool {
    if classification == FailureClassification::Recoverable {
        if stage == Some("host.response_contract") {
            return false;
        }
        return true;
    }
    false
}

pub fn should_retry(
    classification: FailureClassification,
    attempt: u32,
    max_attempts: u32,
) -> bool {
    if classification == FailureClassification::Unrecoverable {
        return false;
    }
    attempt < max_attempts
}

pub fn compute_backoff(classification: FailureClassification, attempt: u32) -> u64 {
    if classification != FailureClassification::Recoverable {
        return 0;
    }
    let step = attempt.saturating_sub(1) as usize;
    ERROR_ACTION_BACKOFF_SEQUENCE_MS[step % ERROR_ACTION_BACKOFF_SEQUENCE_MS.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unrecoverable_codes() {
        let classification = classify_failure(Some(401), Some("INVALID_API_KEY"), None, false);
        assert!(matches!(
            classification,
            FailureClassification::Unrecoverable
        ));
    }

    #[test]
    fn test_recoverable_network() {
        let classification = classify_failure(None, None, None, true);
        assert!(matches!(classification, FailureClassification::Recoverable));
    }

    #[test]
    fn test_blocking_recoverable() {
        let classification = FailureClassification::Recoverable;
        assert!(is_blocking_recoverable(
            classification,
            Some("provider.send")
        ));
        assert!(!is_blocking_recoverable(
            classification,
            Some("host.response_contract")
        ));
    }

    #[test]
    fn test_compute_backoff_uses_fixed_cycle() {
        let classification = FailureClassification::Recoverable;
        assert_eq!(compute_backoff(classification, 1), 1_000);
        assert_eq!(compute_backoff(classification, 2), 2_000);
        assert_eq!(compute_backoff(classification, 3), 3_000);
        assert_eq!(compute_backoff(classification, 4), 1_000);
        assert_eq!(compute_backoff(FailureClassification::Unrecoverable, 1), 0);
    }
}
