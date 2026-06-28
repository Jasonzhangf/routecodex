//! MetadataCenter 集成 — 通过 MetadataCenter runtime_control 读写配置
//!
//! Traffic Governor 不内建状态变量，所有配置通过 MetadataCenter 传递：
//!
//! 读取: runtime_control.trafficGovernor.*
//! 写入: metadata.trafficPermit[requestId] (lease 信息)

use crate::types::{AcquireContext, TrafficPolicy};

/// 从 MetadataCenter 读取流量治理配置
///
/// 读取优先级（从高到低）：
/// 1. AcquireContext 中的显式值（由调用者从 runtime_control 投影）
/// 2. traffic-governor-core 默认值
pub fn resolve_traffic_policy_from_context(ctx: &AcquireContext) -> TrafficPolicy {
    TrafficPolicy {
        max_in_flight: ctx.max_in_flight.unwrap_or(2) as usize,
        acquire_timeout_ms: ctx.acquire_timeout_ms.unwrap_or(60_000),
        stale_lease_ms: ctx.stale_lease_ms.unwrap_or(300_000),
        requests_per_minute: ctx.requests_per_minute.unwrap_or(120),
        rpm_timeout_ms: ctx.rpm_timeout_ms.unwrap_or(60_000),
        rpm_window_ms: 60_000,
    }
}

/// 将 Permit 信息写入 MetadataCenter
///
/// 写入 key: `metadata.trafficPermit[requestId] = { ... }`
pub fn format_permit_metadata(permit: &crate::types::Permit) -> serde_json::Value {
    serde_json::json!({
        "leaseId": permit.lease_id,
        "runtimeKey": permit.runtime_key,
        "stateKey": permit.state_key,
        "startedAt": permit.started_at,
        "expiresAt": permit.expires_at,
        "pid": permit.pid,
        "serverId": permit.server_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_policy_from_context_defaults() {
        let ctx = AcquireContext::new("openai", "req-1");
        let policy = resolve_traffic_policy_from_context(&ctx);
        assert_eq!(policy.max_in_flight, 2);
        assert_eq!(policy.requests_per_minute, 120);
    }

    #[test]
    fn resolve_policy_from_context_overrides() {
        let mut ctx = AcquireContext::new("deepseek", "req-1");
        ctx.max_in_flight = Some(1);
        ctx.requests_per_minute = Some(30);
        let policy = resolve_traffic_policy_from_context(&ctx);
        assert_eq!(policy.max_in_flight, 1);
        assert_eq!(policy.requests_per_minute, 30);
    }
}
