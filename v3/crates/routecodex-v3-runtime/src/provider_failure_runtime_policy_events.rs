struct V3RelayProviderFailurePolicyEventInput {
    candidate: V3TargetCandidate,
    status: u16,
    error_type: Option<String>,
    message: String,
    health_record: V3ProviderFailureRecord,
    action: &'static str,
    next_provider_key: Option<String>,
    wait_ms: Option<u64>,
}

fn build_v3_relay_provider_failure_policy_event(
    input: V3RelayProviderFailurePolicyEventInput,
) -> V3RelayProviderFailurePolicyEvent {
    V3RelayProviderFailurePolicyEvent {
        candidate: input.candidate,
        status: input.status,
        error_type: input.error_type,
        message: input.message,
        health_record: input.health_record,
        action: input.action.to_string(),
        next_provider_key: input.next_provider_key,
        wait_ms: input.wait_ms,
    }
}

pub(crate) fn v3_relay_provider_policy_now_epoch_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("system time precedes Unix epoch: {error}"))
}
