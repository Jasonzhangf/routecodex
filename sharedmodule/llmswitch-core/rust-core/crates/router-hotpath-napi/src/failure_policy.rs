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

// ---------------------------------------------------------------------------
// Error classification hint tables — migrated from TS
// provider-response-shared-pure-blocks.ts & request-retry-helpers.ts
// ---------------------------------------------------------------------------

/// Substrings that indicate a context-length-exceeded error.
const CONTEXT_LENGTH_MESSAGE_HINTS: &[&str] = &[
    "context_length_exceeded",
    "context_window_exceeded",
    "model_context_window_exceeded",
    "context length exceeded",
    "context window exceeded",
    "model's maximum context length",
    "maximum context length",
    "max context length",
    "input_exceeds_limit",
    "input exceeds limit",
    "input tokens exceeds",
    "input tokens exceed",
    "内容超长",
    "请删减后再试",
    "对话长度上限",
    "达到对话长度上限",
];

/// Upstream error code hints indicating rate limit.
const RATE_LIMIT_ERROR_CODE_HINTS: &[&str] = &[
    "429",
    "1302",
    "rate_limit",
    "rate-limit",
    "too_many_requests",
    "too-many-requests",
    "too many requests",
];

/// Substrings in error message indicating rate limit.
const RATE_LIMIT_MESSAGE_HINTS: &[&str] = &[
    "rate limit",
    "too many requests",
    "request limit",
    "rate limited",
    "quota exceeded",
    "slow down",
    "访问量过大",
    "速率限制",
    "请求频率",
    "请求过于频繁",
    "频率限制",
];

/// Substrings in error message indicating retryable network failure.
const RETRYABLE_NETWORK_MESSAGE_HINTS: &[&str] = &[
    "internal network failure",
    "network failure",
    "network error",
    "api connection error",
    "service unavailable",
    "temporarily unavailable",
    "temporarily unreachable",
    "connection reset",
    "connection closed",
    "timed out",
    "timeout",
];

/// Upstream error code hints indicating retryable network failure.
const RETRYABLE_NETWORK_CODE_HINTS: &[&str] = &[
    "internal_network_failure",
    "network_error",
    "api_connection_error",
    "service_unavailable",
    "request_timeout",
    "timeout",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    Unrecoverable,
    Recoverable,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetryExecutionPolicyInput {
    pub classification: FailureClassification,
    #[serde(default)]
    pub is_streaming_request: bool,
    #[serde(default)]
    pub host_contract_failure: bool,
    #[serde(default)]
    pub force_exclude_current_provider_on_retry: bool,
    #[serde(default)]
    pub prompt_too_long: bool,
    #[serde(default)]
    pub existing_exclusion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetryExecutionPolicyDecision {
    pub exclude_current_provider: bool,
    pub reason: &'static str,
}

/// ErrorErr02 host-captured error envelope consumed by the Rust ErrorErr03 owner.
/// Keep protocol/error fields explicit; do not pass an opaque provider payload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr02HostCapturedInput {
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub upstream_code: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub error_name: Option<String>,
    #[serde(default)]
    pub detail_reason: Option<String>,
    #[serde(default)]
    pub detail_upstream_code: Option<String>,
    #[serde(default)]
    pub detail_upstream_message: Option<String>,
    #[serde(default)]
    pub response_error_message: Option<String>,
    #[serde(default)]
    pub response_error_code: Option<String>,
    #[serde(default)]
    pub response_error_type: Option<String>,
    #[serde(default)]
    pub response_error_param: Option<String>,
    #[serde(default)]
    pub provider_status_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr03RuntimeClassifiedDecision {
    #[serde(default)]
    pub classification: Option<FailureClassification>,
    pub client_disconnect: bool,
    pub network_transport_like: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05ExecutionDecisionInput {
    pub classification: FailureClassification,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub upstream_code: Option<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub route_pool: Vec<String>,
    #[serde(default)]
    pub excluded_provider_keys: Vec<String>,
    #[serde(default)]
    pub route_pool_is_authoritative: bool,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub max_attempts: u32,
    #[serde(default)]
    pub default_pool_available: bool,
    #[serde(default)]
    pub prompt_too_long: bool,
    #[serde(default)]
    pub provider_owned_continuation: bool,
    #[serde(default)]
    pub protocol_boundary_failure: bool,
    #[serde(default)]
    pub host_contract_failure: bool,
    #[serde(default)]
    pub force_exclude_current_provider_on_retry: bool,
    #[serde(default)]
    pub is_streaming_request: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05RetrySwitchPlan {
    pub switch_action: &'static str,
    pub decision_label: &'static str,
    pub runtime_scope_excluded: Vec<String>,
    pub runtime_scope_excluded_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorErr05ExecutionDecision {
    pub should_retry: bool,
    pub excluded_current_provider: bool,
    pub allow_retry_beyond_attempt_budget: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_switch_plan: Option<ErrorErr05RetrySwitchPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_execution_policy_reason: Option<&'static str>,
    pub route_pool_remaining_after_exclusion: Vec<String>,
    pub default_pool_available: bool,
    pub policy_exhausted: bool,
    pub may_project: bool,
    pub excluded_provider_keys: Vec<String>,
}

fn normalized_unique(values: &[String]) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !output.iter().any(|current| current == trimmed) {
            output.push(trimmed.to_string());
        }
    }
    output
}

fn error_err05_switch_plan() -> ErrorErr05RetrySwitchPlan {
    ErrorErr05RetrySwitchPlan {
        switch_action: "exclude_and_reroute",
        decision_label: "exclude_and_reroute",
        runtime_scope_excluded: Vec::new(),
        runtime_scope_excluded_count: 0,
    }
}

pub fn resolve_error_err05_execution_decision(
    input: ErrorErr05ExecutionDecisionInput,
) -> ErrorErr05ExecutionDecision {
    let provider_key = input
        .provider_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let route_pool = normalized_unique(&input.route_pool);
    let mut excluded = normalized_unique(&input.excluded_provider_keys);
    let remaining = |excluded_values: &[String]| {
        route_pool
            .iter()
            .filter(|candidate| !excluded_values.iter().any(|value| value == *candidate))
            .cloned()
            .collect::<Vec<_>>()
    };
    if input.protocol_boundary_failure {
        return ErrorErr05ExecutionDecision {
            should_retry: false,
            excluded_current_provider: false,
            allow_retry_beyond_attempt_budget: false,
            retry_switch_plan: None,
            retry_execution_policy_reason: None,
            route_pool_remaining_after_exclusion: remaining(&excluded),
            default_pool_available: input.default_pool_available,
            policy_exhausted: false,
            may_project: true,
            excluded_provider_keys: excluded,
        };
    }
    let retryable = input.classification == FailureClassification::Recoverable;
    let has_alternative_before_exclusion = route_pool.iter().any(|candidate| {
        Some(candidate.as_str()) != provider_key
            && !excluded.iter().any(|value| value == candidate)
    });
    let only_current_provider = provider_key.is_some()
        && !route_pool.is_empty()
        && route_pool.iter().all(|candidate| Some(candidate.as_str()) == provider_key);
    let eligible_last_provider_stage = matches!(
        input.stage.as_deref(),
        Some("provider.send" | "provider.http" | "provider.sse_decode")
    );
    let may_retry_verified_last_provider = input.route_pool_is_authoritative
        && only_current_provider
        && !input.default_pool_available
        && !input.prompt_too_long
        && !input.provider_owned_continuation
        && excluded.is_empty()
        && input.attempt < input.max_attempts
        && eligible_last_provider_stage
        && retryable;
    let unproven_last_provider = !input.route_pool_is_authoritative
        && provider_key.is_some()
        && retryable
        && (input.stage.as_deref() == Some("provider.runtime_resolve")
            || !route_pool.is_empty()
            || normalize_code(input.error_code.as_deref()).as_deref() == Some("ERR_PROVIDER_NOT_FOUND")
            || normalize_code(input.upstream_code.as_deref()).as_deref() == Some("ERR_PROVIDER_NOT_FOUND"))
        && !has_alternative_before_exclusion;
    let native_policy = resolve_retry_execution_policy(ProviderRetryExecutionPolicyInput {
        classification: input.classification,
        is_streaming_request: input.is_streaming_request,
        host_contract_failure: input.host_contract_failure,
        force_exclude_current_provider_on_retry: input.force_exclude_current_provider_on_retry,
        prompt_too_long: input.prompt_too_long,
        existing_exclusion: has_alternative_before_exclusion && !input.host_contract_failure,
    });
    let should_exclude = !input.host_contract_failure
        && !may_retry_verified_last_provider
        && provider_key.is_some()
        && (has_alternative_before_exclusion
            || unproven_last_provider
            || input.default_pool_available)
        && (native_policy.exclude_current_provider || retryable || input.prompt_too_long);
    if should_exclude {
        let key = provider_key.expect("provider key checked");
        if !excluded.iter().any(|value| value == key) {
            excluded.push(key.to_string());
        }
    }
    let remaining_after_exclusion = remaining(&excluded);
    let policy_exhausted = remaining_after_exclusion.is_empty() && !input.default_pool_available;
    let has_reroute_target = !remaining_after_exclusion.is_empty() || input.default_pool_available;
    if input.provider_owned_continuation && should_exclude {
        return ErrorErr05ExecutionDecision {
            should_retry: false,
            excluded_current_provider: true,
            allow_retry_beyond_attempt_budget: false,
            retry_switch_plan: None,
            retry_execution_policy_reason: None,
            route_pool_remaining_after_exclusion: remaining_after_exclusion,
            default_pool_available: input.default_pool_available,
            policy_exhausted,
            may_project: policy_exhausted,
            excluded_provider_keys: excluded,
        };
    }
    let should_retry = may_retry_verified_last_provider
        || (should_exclude && (has_reroute_target || unproven_last_provider));
    ErrorErr05ExecutionDecision {
        should_retry,
        excluded_current_provider: should_exclude,
        allow_retry_beyond_attempt_budget: should_exclude && has_reroute_target,
        retry_switch_plan: should_retry.then(error_err05_switch_plan),
        retry_execution_policy_reason: should_retry.then_some(native_policy.reason),
        route_pool_remaining_after_exclusion: remaining_after_exclusion,
        default_pool_available: input.default_pool_available,
        policy_exhausted,
        may_project: !should_retry && policy_exhausted,
        excluded_provider_keys: excluded,
    }
}

fn normalize_code(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase())
}

fn contains_client_disconnect_hint(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.contains("client_disconnected")
        || lowered.contains("client disconnected")
        || lowered.contains("client abort request")
        || lowered.contains("client closed request")
}

fn is_error_err02_client_disconnect(input: &ErrorErr02HostCapturedInput) -> bool {
    let code = normalize_code(input.error_code.as_deref());
    if code.as_deref() == Some("CLIENT_DISCONNECTED") {
        return true;
    }
    let message = input.error_message.as_deref().unwrap_or_default();
    let status_looks_like_499 = input.status_code == Some(499)
        || code.as_deref() == Some("HTTP_499")
        || message.to_ascii_lowercase().contains("http 499");
    if status_looks_like_499
        && [
            message,
            input.detail_upstream_message.as_deref().unwrap_or_default(),
            input.response_error_message.as_deref().unwrap_or_default(),
        ]
        .iter()
        .any(|value| contains_client_disconnect_hint(value))
    {
        return true;
    }
    if contains_client_disconnect_hint(message) {
        return true;
    }
    input.error_name.as_deref() == Some("AbortError")
        && {
            let lowered = message.to_ascii_lowercase();
            lowered.contains("client_request_aborted")
                || lowered.contains("client_response_closed")
                || lowered.contains("client_timeout_hint_expired")
        }
}

fn is_error_err02_network_transport_like(input: &ErrorErr02HostCapturedInput) -> bool {
    if is_error_err02_client_disconnect(input) {
        return false;
    }
    let code = normalize_code(input.error_code.as_deref());
    if code
        .as_deref()
        .map(|code| RETRYABLE_NETWORK_CODE_HINTS.contains(&code.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
    {
        return true;
    }
    let message = input.error_message.as_deref().unwrap_or_default().to_ascii_lowercase();
    input.error_name.as_deref() == Some("AbortError")
        || message.contains("operation was aborted")
        || [
            "fetch failed",
            "network timeout",
            "socket hang up",
            "client network socket disconnected",
            "tls handshake timeout",
            "unable to verify the first certificate",
            "network error",
            "temporarily unreachable",
        ]
        .iter()
        .any(|hint| message.contains(hint))
}

/// First Rust-owned raw ErrorErr02 -> ErrorErr03 classifier slice.
/// Missing categories remain explicit in parity tests before the TS owner is removed.
pub fn classify_error_err02_host_captured(
    input: ErrorErr02HostCapturedInput,
) -> ErrorErr03RuntimeClassifiedDecision {
    let error_code = normalize_code(input.error_code.as_deref());
    let upstream_code = normalize_code(input.upstream_code.as_deref());
    let nested_code = normalize_code(input.response_error_code.as_deref());
    let nested_type = normalize_code(input.response_error_type.as_deref());
    let protocol_upstream_code = normalize_code(input.detail_upstream_code.as_deref());
    if input.stage.as_deref() == Some("provider.followup") {
        return ErrorErr03RuntimeClassifiedDecision {
            classification: None,
            client_disconnect: false,
            network_transport_like: false,
        };
    }
    if input.stage.as_deref() == Some("host.response_contract") {
        let recoverable = [error_code.as_deref(), upstream_code.as_deref()]
            .into_iter()
            .flatten()
            .any(|code| matches!(code, "EMPTY_ASSISTANT_RESPONSE" | "MISSING_REQUIRED_TOOL_CALL"));
        return ErrorErr03RuntimeClassifiedDecision {
            classification: recoverable.then_some(FailureClassification::Recoverable),
            client_disconnect: false,
            network_transport_like: false,
        };
    }
    let client_disconnect = is_error_err02_client_disconnect(&input);
    let network_transport_like = is_error_err02_network_transport_like(&input);
    let reason = input
        .reason
        .as_deref()
        .or(input.error_message.as_deref())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let code_matches = |expected: &str| {
        error_code.as_deref() == Some(expected)
            || upstream_code.as_deref() == Some(expected)
            || nested_code.as_deref() == Some(expected)
    };
    let protocol_code_matches = |expected: &str| {
        code_matches(expected) || protocol_upstream_code.as_deref() == Some(expected)
    };
    let malformed_response = code_matches("MALFORMED_RESPONSE");
    let has_2013_signal = input.provider_status_code == Some(2013)
        || [
            error_code.as_deref(),
            upstream_code.as_deref(),
            nested_code.as_deref(),
            protocol_upstream_code.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|code| code == "2013" || code.contains("_2013"));
    let protocol_reason = input
        .detail_reason
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let nested_message = input
        .response_error_message
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let prompt_too_long = code_matches("CONTEXT_LENGTH_EXCEEDED")
        || [
            "prompt is too long",
            "maximum context",
            "max context",
            "context_length",
            "context length",
            "context window",
            "input tokens exceeds",
            "request entity too large",
            "payload too large",
            "body too large",
        ]
        .iter()
        .any(|hint| reason.contains(hint));
    let local_response_contract = [
        "[mimoweb] upstream assistant response was empty",
        "[mimoweb] upstream emitted tool markers but no tool calls could be harvested",
        "[mimoweb] upstream repeated prior tool call after tool_result",
        "[mimoweb] serialized query exceeds empty-safe limit",
    ]
    .iter()
    .any(|hint| reason.contains(hint));
    let provider_runtime_request_contract = [
        "provider-runtime-error: responses payload missing \"input\" or \"instructions\"",
        "provider-runtime-error: responses provider received chat-style \"messages\"",
        "provider-runtime-error: responses payload must be an object",
        "provider-runtime-error: missing model from direct passthrough responses payload",
    ]
    .iter()
    .any(|hint| reason.contains(hint));
    let nested_param = input
        .response_error_param
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let local_request_contract = nested_param.starts_with("tools.")
        || nested_param.starts_with("messages.")
        || nested_param.starts_with("input.")
        || nested_type.as_deref() == Some("INVALID_REQUEST_ERROR")
        || nested_type.as_deref().map(|value| value.starts_with("INVALID_")).unwrap_or(false)
        || nested_code.as_deref().map(|value| value.starts_with("INVALID_")).unwrap_or(false)
        || code_matches("INVALID_REQUEST_ERROR")
        || reason.contains("invalid request payload")
        || reason.contains("\"message\":\"bad request\"")
        || reason.contains("signature-invalid");
    let auth_or_account_text = [
        "invalid api key",
        "invalid access token",
        "token expired",
        "insufficient_quota",
        "quota exceeded",
        "model is not supported",
        "model not supported",
        "access denied",
        "account suspended",
        "account disabled",
        "blocked due to unauthorized requests",
    ]
    .iter()
    .any(|hint| reason.contains(hint));
    let classification = if client_disconnect {
        Some(FailureClassification::Unrecoverable)
    } else if prompt_too_long
        || code_matches("ERR_HTTP2_STREAM_CANCEL")
        || code_matches("514")
        || (input.status_code == Some(520)
            && (code_matches("PROVIDER_STATUS_1000") || reason.contains("unknown error, 520")))
        || (has_2013_signal
            && (protocol_reason == "context_length_exceeded"
                || reason.contains("context_length_exceeded")
                || nested_message.contains("context_length_exceeded")))
        || (input.status_code == Some(429) && has_2013_signal)
        || (has_2013_signal
            && [
                "当前请求量较高",
                "请稍后重试",
                "traffic saturation",
                "rate limited",
                "too many requests",
                "token plan",
            ]
            .iter()
            .any(|hint| reason.contains(hint)))
        || (malformed_response
            && (protocol_code_matches("PROVIDER_STATUS_2056")
                || reason.contains("usage limit exceeded")))
        || (malformed_response
            && (protocol_code_matches("SERVER_ERROR")
                || nested_type.as_deref() == Some("SERVER_ERROR")))
        || (malformed_response && has_2013_signal)
        || (input.status_code == Some(200)
            && malformed_response
            && (reason.contains("instead of sse")
                || nested_message.contains("instead of sse")
                || protocol_reason.contains("instead of sse")))
    {
        Some(FailureClassification::Recoverable)
    } else if code_matches("MALFORMED_REQUEST")
        || code_matches("CLIENT_TOOL_ARGS_INVALID")
        || provider_runtime_request_contract
        || local_response_contract
        || (local_request_contract && !prompt_too_long)
        || matches!(input.status_code, Some(401 | 402 | 403 | 404))
        || (input.status_code == Some(434)
            && (reason.contains("blocked due to unauthorized requests")
                || reason.contains("access to the current ak has been blocked")))
        || auth_or_account_text
        || (malformed_response
            && !reason.contains("context_length_exceeded")
            && !reason.contains("instead of sse")
            && !reason.contains("usage limit exceeded"))
    {
        Some(FailureClassification::Unrecoverable)
    } else {
        Some(classify_failure(
            input.status_code,
            error_code.as_deref(),
            upstream_code.as_deref(),
            network_transport_like,
        ))
    };
    ErrorErr03RuntimeClassifiedDecision {
        classification,
        client_disconnect,
        network_transport_like,
    }
}

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
    let _ = classification;
    let _ = attempt;
    0
}

pub fn resolve_retry_execution_policy(
    input: ProviderRetryExecutionPolicyInput,
) -> ProviderRetryExecutionPolicyDecision {
    if input.host_contract_failure {
        return ProviderRetryExecutionPolicyDecision {
            exclude_current_provider: false,
            reason: "host_contract_failure",
        };
    }
    if input.force_exclude_current_provider_on_retry {
        return ProviderRetryExecutionPolicyDecision {
            exclude_current_provider: true,
            reason: "forced_exclusion",
        };
    }
    if input.existing_exclusion {
        return ProviderRetryExecutionPolicyDecision {
            exclude_current_provider: true,
            reason: "existing_exclusion",
        };
    }
    if input.is_streaming_request
        && input.classification == FailureClassification::Recoverable
        && !input.prompt_too_long
    {
        return ProviderRetryExecutionPolicyDecision {
            exclude_current_provider: true,
            reason: "streaming_recoverable_pre_response",
        };
    }
    ProviderRetryExecutionPolicyDecision {
        exclude_current_provider: false,
        reason: "preserve_existing_policy",
    }
}

// ---------------------------------------------------------------------------
// Error classification pure functions — migrated from TS batch #2
// ---------------------------------------------------------------------------

/// Check whether the error indicators suggest a context-length-exceeded error.
/// Mirrors TS `isContextLengthExceededError`.
pub fn is_context_length_exceeded_error(
    message: &str,
    upstream_code: Option<&str>,
    detail_reason: Option<&str>,
) -> bool {
    let lowered_message = message.to_lowercase();
    if let Some(code) = upstream_code {
        let normalized = code.trim().to_lowercase();
        if normalized.contains("context_length_exceeded")
            || normalized.contains("context_window_exceeded")
            || normalized.contains("model_context_window_exceeded")
            || normalized.contains("input_exceeds_limit")
        {
            return true;
        }
    }
    if let Some(reason) = detail_reason {
        let normalized = reason.trim().to_lowercase();
        if normalized == "context_length_exceeded"
            || normalized == "context_window_exceeded"
            || normalized == "model_context_window_exceeded"
            || normalized == "input_exceeds_limit"
        {
            return true;
        }
    }
    CONTEXT_LENGTH_MESSAGE_HINTS
        .iter()
        .any(|hint| lowered_message.contains(hint))
}

/// Check whether the error indicators suggest a rate-limit error.
/// Mirrors TS `isRateLimitLikeError`.
pub fn is_rate_limit_like_error(message: &str, codes: &[&str]) -> bool {
    let lowered_message = message.to_lowercase();
    for code in codes {
        let normalized = code.trim().to_lowercase();
        if !normalized.is_empty()
            && RATE_LIMIT_ERROR_CODE_HINTS
                .iter()
                .any(|hint| normalized.contains(hint))
        {
            return true;
        }
    }
    RATE_LIMIT_MESSAGE_HINTS
        .iter()
        .any(|hint| lowered_message.contains(hint))
}

/// Check whether the SSE wrapper error is retryable (network-level).
/// Mirrors TS `isRetryableNetworkSseWrapperError` (pure string-matching subset).
pub fn is_retryable_network_sse_wrapper_error(
    message: &str,
    upstream_code: Option<&str>,
    status_code: Option<u16>,
) -> bool {
    // Status-based shortcuts
    if let Some(status) = status_code {
        if matches!(status, 408 | 425 | 502 | 503 | 504) {
            return true;
        }
    }
    let lowered_message = message.to_lowercase();
    if let Some(code) = upstream_code {
        let normalized = code.trim().to_lowercase();
        if !normalized.is_empty()
            && RETRYABLE_NETWORK_CODE_HINTS
                .iter()
                .any(|hint| normalized.contains(hint))
        {
            return true;
        }
    }
    RETRYABLE_NETWORK_MESSAGE_HINTS
        .iter()
        .any(|hint| lowered_message.contains(hint))
}

/// Check whether an SSE-decoded error is a rate-limit error.
/// Mirrors TS `isSseDecodeRateLimitError` (pure string-matching subset).
pub fn is_sse_decode_rate_limit_error(
    error_message: &str,
    error_code: &str,
    upstream_code: &str,
    status: Option<u16>,
) -> bool {
    if status != Some(429) {
        return false;
    }
    let lowered_message = error_message.to_lowercase();
    let lowered_name = ""; // name field not available in this simplified version
    let sse_like = error_code == "SSE_DECODE_ERROR"
        || lowered_name == "providerprotocolerror"
        || lowered_message.contains("sse");
    sse_like && is_rate_limit_like_error(error_message, &[error_code, upstream_code])
}

/// Check whether an SSE-decoded error is a retryable network error.
/// Mirrors TS `isSseDecodeRetryableNetworkError` (pure string-matching subset).
pub fn is_sse_decode_retryable_network_error(
    error_message: &str,
    error_code: &str,
    upstream_code: &str,
    status: Option<u16>,
) -> bool {
    if status != Some(502) {
        return false;
    }
    let lowered_message = error_message.to_lowercase();
    let lowered_upstream = upstream_code.to_lowercase();
    let sse_like = error_code == "HTTP_502"
        || error_code == "SSE_DECODE_ERROR"
        || lowered_message.contains("upstream sse error event")
        || lowered_message.contains("anthropic sse error event");
    if !sse_like {
        return false;
    }
    lowered_upstream.contains("internal_network_failure")
        || lowered_message.contains("internal network failure")
        || lowered_message.contains("network failure")
        || lowered_message.contains("network error")
        || lowered_message.contains("service unavailable")
        || lowered_message.contains("temporarily unavailable")
        || lowered_message.contains("connection reset")
        || lowered_message.contains("timeout")
        || lowered_upstream.contains("upstream_stream_no_content_timeout")
        || lowered_upstream.contains("upstream_stream_content_idle_timeout")
}

/// Check whether the error looks like a client disconnect (499 / CLIENT_DISCONNECTED).
/// Mirrors TS `isClientDisconnectLikeError`.
pub fn is_client_disconnect_like_error(
    code: &str,
    message: &str,
    status: Option<u16>,
    upstream_message: &str,
) -> bool {
    let upper_code = code.trim().to_uppercase();
    let lower_message = message.to_lowercase();
    let lower_upstream = upstream_message.to_lowercase();

    if upper_code == "CLIENT_DISCONNECTED" {
        return true;
    }
    if lower_message.contains("client_disconnected")
        || lower_message.contains("client disconnected")
    {
        return true;
    }
    if status == Some(499) || upper_code == "HTTP_499" || lower_message.contains("http 499") {
        if lower_message.contains("client abort request")
            || lower_message.contains("client closed request")
        {
            return true;
        }
        if lower_upstream.contains("client abort request")
            || lower_upstream.contains("client closed request")
        {
            return true;
        }
    }
    if lower_message.contains("client abort request")
        || lower_message.contains("client closed request")
    {
        return true;
    }
    if lower_message.contains("client_request_aborted")
        || lower_message.contains("client_response_closed")
    {
        return true;
    }
    false
}

/// Check whether the error is a generic bridge response contract error.
/// Mirrors TS `isGenericBridgeResponseContractError`.
pub fn is_generic_bridge_response_contract_error(
    error_code: &str,
    error_name: &str,
    message: &str,
) -> bool {
    if error_name.trim() != "ProviderProtocolError" {
        return false;
    }
    if error_code.trim() != "MALFORMED_RESPONSE" {
        return false;
    }
    let lowered = message.trim().to_lowercase();
    lowered.contains("[hub_response] non-canonical response payload")
        || lowered.contains("[hub_response] failed to canonicalize response payload")
}

// ---------------------------------------------------------------------------
// NAPI JSON-boundary entry points for batch #2
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsErrorClassificationOutput {
    pub result: bool,
}

pub fn is_context_length_exceeded_error_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        message: String,
        #[serde(default)]
        upstream_code: Option<String>,
        #[serde(default)]
        detail_reason: Option<String>,
    }
    let input: Input =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let result = is_context_length_exceeded_error(
        &input.message,
        input.upstream_code.as_deref(),
        input.detail_reason.as_deref(),
    );
    serde_json::to_string(&IsErrorClassificationOutput { result })
        .map_err(|e| format!("serialize: {}", e))
}

pub fn is_rate_limit_like_error_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        message: String,
        #[serde(default)]
        codes: Vec<String>,
    }
    let input: Input =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let codes: Vec<&str> = input.codes.iter().map(|s| s.as_str()).collect();
    let result = is_rate_limit_like_error(&input.message, &codes);
    serde_json::to_string(&IsErrorClassificationOutput { result })
        .map_err(|e| format!("serialize: {}", e))
}

pub fn is_retryable_network_sse_wrapper_error_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        message: String,
        #[serde(default)]
        upstream_code: Option<String>,
        #[serde(default)]
        status_code: Option<u16>,
    }
    let input: Input =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let result = is_retryable_network_sse_wrapper_error(
        &input.message,
        input.upstream_code.as_deref(),
        input.status_code,
    );
    serde_json::to_string(&IsErrorClassificationOutput { result })
        .map_err(|e| format!("serialize: {}", e))
}

pub fn is_client_disconnect_like_error_json(input_json: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        status: Option<u16>,
        #[serde(default)]
        upstream_message: String,
    }
    let input: Input =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let result = is_client_disconnect_like_error(
        &input.code,
        &input.message,
        input.status,
        &input.upstream_message,
    );
    serde_json::to_string(&IsErrorClassificationOutput { result })
        .map_err(|e| format!("serialize: {}", e))
}

pub fn is_generic_bridge_response_contract_error_json(
    input_json: String,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        error_code: String,
        #[serde(default)]
        error_name: String,
        #[serde(default)]
        message: String,
    }
    let input: Input =
        serde_json::from_str(&input_json).map_err(|e| format!("parse input: {}", e))?;
    let result = is_generic_bridge_response_contract_error(
        &input.error_code,
        &input.error_name,
        &input.message,
    );
    serde_json::to_string(&IsErrorClassificationOutput { result })
        .map_err(|e| format!("serialize: {}", e))
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
    fn test_compute_backoff_is_always_zero() {
        let classification = FailureClassification::Recoverable;
        assert_eq!(compute_backoff(classification, 1), 0);
        assert_eq!(compute_backoff(classification, 2), 0);
        assert_eq!(compute_backoff(classification, 3), 0);
        assert_eq!(compute_backoff(classification, 4), 0);
        assert_eq!(compute_backoff(FailureClassification::Unrecoverable, 1), 0);
    }

    #[test]
    fn test_streaming_recoverable_pre_response_excludes_current_provider() {
        let decision = resolve_retry_execution_policy(ProviderRetryExecutionPolicyInput {
            classification: FailureClassification::Recoverable,
            is_streaming_request: true,
            host_contract_failure: false,
            force_exclude_current_provider_on_retry: false,
            prompt_too_long: false,
            existing_exclusion: false,
        });
        assert!(decision.exclude_current_provider);
        assert_eq!(decision.reason, "streaming_recoverable_pre_response");
    }

    #[test]
    fn test_non_streaming_recoverable_preserves_existing_policy() {
        let decision = resolve_retry_execution_policy(ProviderRetryExecutionPolicyInput {
            classification: FailureClassification::Recoverable,
            is_streaming_request: false,
            host_contract_failure: false,
            force_exclude_current_provider_on_retry: false,
            prompt_too_long: false,
            existing_exclusion: false,
        });
        assert!(!decision.exclude_current_provider);
        assert_eq!(decision.reason, "preserve_existing_policy");
    }

    #[test]
    fn test_host_contract_failure_does_not_exclude_streaming_recoverable() {
        let decision = resolve_retry_execution_policy(ProviderRetryExecutionPolicyInput {
            classification: FailureClassification::Recoverable,
            is_streaming_request: true,
            host_contract_failure: true,
            force_exclude_current_provider_on_retry: false,
            prompt_too_long: false,
            existing_exclusion: false,
        });
        assert!(!decision.exclude_current_provider);
        assert_eq!(decision.reason, "host_contract_failure");
    }

    // -----------------------------------------------------------------------
    // Batch #2: Error classification pure functions
    // -----------------------------------------------------------------------

    // -- is_context_length_exceeded_error --

    #[test]
    fn context_exceeded_via_upstream_code() {
        assert!(is_context_length_exceeded_error(
            "some msg",
            Some("context_length_exceeded"),
            None
        ));
    }

    #[test]
    fn context_exceeded_via_message() {
        assert!(is_context_length_exceeded_error(
            "Context length exceeded for model gpt-4",
            None,
            None
        ));
    }

    #[test]
    fn context_exceeded_false_for_normal() {
        assert!(!is_context_length_exceeded_error(
            "normal error",
            None,
            None
        ));
    }

    #[test]
    fn context_exceeded_via_detail_reason() {
        assert!(is_context_length_exceeded_error(
            "msg",
            None,
            Some("context_window_exceeded")
        ));
    }

    #[test]
    fn context_exceeded_chinese_hint() {
        assert!(is_context_length_exceeded_error("请删减后再试", None, None));
    }

    // -- is_rate_limit_like_error --

    #[test]
    fn rate_limit_via_code() {
        assert!(is_rate_limit_like_error("some error", &["429"]));
    }

    #[test]
    fn rate_limit_via_message() {
        assert!(is_rate_limit_like_error("Rate limit exceeded", &[]));
    }

    #[test]
    fn rate_limit_via_upstream_code() {
        assert!(is_rate_limit_like_error("msg", &["too_many_requests"]));
    }

    #[test]
    fn rate_limit_false_for_normal() {
        assert!(!is_rate_limit_like_error("normal error", &["ok"]));
    }

    #[test]
    fn rate_limit_chinese_hint() {
        assert!(is_rate_limit_like_error("请求频率过高", &[]));
    }

    // -- is_retryable_network_sse_wrapper_error --

    #[test]
    fn retryable_network_via_status_502() {
        assert!(is_retryable_network_sse_wrapper_error(
            "msg",
            None,
            Some(502)
        ));
    }

    #[test]
    fn retryable_network_via_status_503() {
        assert!(is_retryable_network_sse_wrapper_error(
            "msg",
            None,
            Some(503)
        ));
    }

    #[test]
    fn retryable_network_via_message_timeout() {
        assert!(is_retryable_network_sse_wrapper_error(
            "request timed out",
            None,
            None
        ));
    }

    #[test]
    fn retryable_network_via_upstream_code() {
        assert!(is_retryable_network_sse_wrapper_error(
            "msg",
            Some("network_error"),
            None
        ));
    }

    #[test]
    fn retryable_network_false_for_normal() {
        assert!(!is_retryable_network_sse_wrapper_error(
            "normal",
            None,
            Some(200)
        ));
    }

    // -- is_client_disconnect_like_error --

    #[test]
    fn client_disconnect_via_code() {
        assert!(is_client_disconnect_like_error(
            "CLIENT_DISCONNECTED",
            "",
            None,
            ""
        ));
    }

    #[test]
    fn client_disconnect_via_499_with_abort() {
        assert!(is_client_disconnect_like_error(
            "HTTP_499",
            "client abort request",
            None,
            ""
        ));
    }

    #[test]
    fn client_disconnect_via_message() {
        assert!(is_client_disconnect_like_error(
            "",
            "client disconnected",
            None,
            ""
        ));
    }

    #[test]
    fn client_disconnect_499_no_abort_returns_false() {
        assert!(!is_client_disconnect_like_error(
            "HTTP_499",
            "some other error",
            None,
            ""
        ));
    }

    #[test]
    fn client_disconnect_upstream_message() {
        assert!(is_client_disconnect_like_error(
            "",
            "",
            Some(499),
            "client closed request"
        ));
    }

    #[test]
    fn client_disconnect_false_for_normal() {
        assert!(!is_client_disconnect_like_error(
            "",
            "normal error",
            None,
            ""
        ));
    }

    // -- is_generic_bridge_response_contract_error --

    #[test]
    fn bridge_contract_error_matches_non_canonical() {
        assert!(is_generic_bridge_response_contract_error(
            "MALFORMED_RESPONSE",
            "ProviderProtocolError",
            "[hub_response] non-canonical response payload"
        ));
    }

    #[test]
    fn bridge_contract_error_wrong_name_returns_false() {
        assert!(!is_generic_bridge_response_contract_error(
            "MALFORMED_RESPONSE",
            "OtherError",
            "[hub_response] non-canonical response payload"
        ));
    }

    #[test]
    fn bridge_contract_error_wrong_code_returns_false() {
        assert!(!is_generic_bridge_response_contract_error(
            "OTHER_CODE",
            "ProviderProtocolError",
            "[hub_response] non-canonical response payload"
        ));
    }

    #[test]
    fn error_err02_499_client_abort_is_health_neutral_disconnect_class() {
        let decision = classify_error_err02_host_captured(ErrorErr02HostCapturedInput {
            stage: Some("provider.send".to_string()),
            status_code: Some(499),
            error_code: Some("HTTP_499".to_string()),
            error_message: Some("HTTP 499".to_string()),
            detail_upstream_message: Some("client abort request".to_string()),
            ..Default::default()
        });
        assert_eq!(decision.classification, Some(FailureClassification::Unrecoverable));
        assert!(decision.client_disconnect);
        assert!(!decision.network_transport_like);
    }

    #[test]
    fn error_err02_stream_incomplete_is_recoverable_provider_failure() {
        let decision = classify_error_err02_host_captured(ErrorErr02HostCapturedInput {
            stage: Some("provider.send".to_string()),
            status_code: Some(502),
            error_code: Some("UPSTREAM_STREAM_INCOMPLETE".to_string()),
            upstream_code: Some("UPSTREAM_STREAM_INCOMPLETE".to_string()),
            error_message: Some("stream closed before response.completed".to_string()),
            ..Default::default()
        });
        assert_eq!(decision.classification, Some(FailureClassification::Recoverable));
        assert!(!decision.client_disconnect);
    }

    #[test]
    fn error_err02_followup_stays_outside_provider_availability_classification() {
        let decision = classify_error_err02_host_captured(ErrorErr02HostCapturedInput {
            stage: Some("provider.followup".to_string()),
            status_code: Some(502),
            error_code: Some("HTTP_502".to_string()),
            ..Default::default()
        });
        assert_eq!(decision.classification, None);
        assert!(!decision.client_disconnect);
    }

    #[test]
    fn error_err02_host_contract_only_allows_named_recoverable_contract_errors() {
        let recoverable = classify_error_err02_host_captured(ErrorErr02HostCapturedInput {
            stage: Some("host.response_contract".to_string()),
            error_code: Some("EMPTY_ASSISTANT_RESPONSE".to_string()),
            ..Default::default()
        });
        assert_eq!(recoverable.classification, Some(FailureClassification::Recoverable));

        let rejected = classify_error_err02_host_captured(ErrorErr02HostCapturedInput {
            stage: Some("host.response_contract".to_string()),
            error_code: Some("MALFORMED_RESPONSE".to_string()),
            ..Default::default()
        });
        assert_eq!(rejected.classification, None);
    }

    fn error_err05_input() -> ErrorErr05ExecutionDecisionInput {
        ErrorErr05ExecutionDecisionInput {
            classification: FailureClassification::Recoverable,
            stage: Some("provider.send".to_string()),
            error_code: Some("HTTP_503".to_string()),
            upstream_code: Some("HTTP_503".to_string()),
            provider_key: Some("p1.model".to_string()),
            route_pool: vec!["p1.model".to_string(), "p2.model".to_string()],
            excluded_provider_keys: Vec::new(),
            route_pool_is_authoritative: true,
            attempt: 1,
            max_attempts: 6,
            default_pool_available: false,
            prompt_too_long: false,
            provider_owned_continuation: false,
            protocol_boundary_failure: false,
            host_contract_failure: false,
            force_exclude_current_provider_on_retry: false,
            is_streaming_request: false,
        }
    }

    #[test]
    fn error_err05_explicit_alternative_excludes_and_reroutes() {
        let decision = resolve_error_err05_execution_decision(error_err05_input());
        assert!(decision.should_retry);
        assert!(decision.excluded_current_provider);
        assert_eq!(decision.route_pool_remaining_after_exclusion, vec!["p2.model"]);
        assert!(!decision.may_project);
    }

    #[test]
    fn error_err05_default_pool_prevents_premature_projection() {
        let mut input = error_err05_input();
        input.route_pool = vec!["p1.model".to_string()];
        input.default_pool_available = true;
        let decision = resolve_error_err05_execution_decision(input);
        assert!(decision.should_retry);
        assert!(!decision.policy_exhausted);
        assert!(!decision.may_project);
    }

    #[test]
    fn error_err05_verified_last_provider_retries_inside_budget() {
        let mut input = error_err05_input();
        input.route_pool = vec!["p1.model".to_string()];
        let decision = resolve_error_err05_execution_decision(input);
        assert!(decision.should_retry);
        assert!(!decision.excluded_current_provider);
        assert!(!decision.may_project);
    }

    #[test]
    fn error_err05_protocol_boundary_fails_fast_without_exclusion() {
        let mut input = error_err05_input();
        input.protocol_boundary_failure = true;
        let decision = resolve_error_err05_execution_decision(input);
        assert!(!decision.should_retry);
        assert!(!decision.excluded_current_provider);
        assert!(decision.may_project);
    }

    #[test]
    fn error_err05_terminal_only_after_route_and_default_empty() {
        let mut input = error_err05_input();
        input.classification = FailureClassification::Unrecoverable;
        input.route_pool.clear();
        input.route_pool_is_authoritative = true;
        let decision = resolve_error_err05_execution_decision(input);
        assert!(!decision.should_retry);
        assert!(decision.policy_exhausted);
        assert!(decision.may_project);
    }
}
