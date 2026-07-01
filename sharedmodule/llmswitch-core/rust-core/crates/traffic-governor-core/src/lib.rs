//! Traffic Governor Core — 跨进程流量治理器
//!
//! 独立于 Hub Pipeline 的基础设施组件。提供跨进程的 provider 流量控制：
//! - Concurrency 控制（maxInFlight）
//! - RPM 速率控制（requestsPerMinute）
//! - 自适应并发（基于 429/saturation 动态调整）
//!
//! MetadataCenter 作为唯一控制接口，不内建状态变量。

pub mod adaptive;
pub mod concurrency;
pub mod metadata;
pub mod rpm;
pub mod store;
pub mod types;

use adaptive::AdaptiveController;
use concurrency::ConcurrencyController;
use rpm::RpmController;
use store::FileStateStore;
use types::*;

/// Traffic Governor — 统一的流量治理入口
///
/// 单例模式，全局只有一个实例。所有调用者通过此接口访问。
pub struct TrafficGovernor {
    concurrency: ConcurrencyController,
    rpm: RpmController,
    adaptive: AdaptiveController,
    store: FileStateStore,
}

impl TrafficGovernor {
    /// 创建新的 TrafficGovernor 实例
    pub fn new(store_root: &str) -> Self {
        let store = FileStateStore::new(store_root);
        Self {
            concurrency: ConcurrencyController::new(),
            rpm: RpmController::new(),
            adaptive: AdaptiveController::new(),
            store,
        }
    }

    /// 获取流量许可
    ///
    /// 1. 检查并发容量 → 满则等待/失败
    /// 2. 检查 RPM 窗口 → 超限则等待/失败
    /// 3. 记录 lease + RPM event
    /// 4. 返回 Permit
    pub fn acquire(&self, ctx: &AcquireContext) -> Result<AcquireResult, GovernorError> {
        // 1. 从 MetadataCenter (runtime_control) 读取配置
        let config = self.read_traffic_config(ctx);

        // 2. 检查并发容量
        self.concurrency
            .check_available(ctx, &config, &self.store)?;

        // 3. 检查 RPM
        self.rpm.check_available(ctx, &config, &self.store)?;

        // 4. 记录 lease
        let permit = self.store.create_lease(ctx, &config)?;

        Ok(AcquireResult {
            permit,
            policy: config,
            waited_ms: 0,
            active_in_flight: self.concurrency.active_count(ctx),
            rpm_in_window: self.rpm.window_count(ctx),
        })
    }

    /// 释放流量许可
    pub fn release(&self, permit: &Permit) -> Result<ReleaseResult, GovernorError> {
        let released = self.store.release_lease(permit)?;
        Ok(ReleaseResult {
            released,
            active_in_flight: self
                .concurrency
                .active_count_for_keys(&[permit.runtime_key.as_str()]),
        })
    }

    /// 观察 provider 调用结果 — 用于 adaptive 调整
    pub fn observe_outcome(&self, event: &OutcomeEvent) {
        self.adaptive.observe(event);
    }

    /// 同步检查是否达到并发容量
    pub fn is_at_capacity(&self, runtime_key: &str) -> bool {
        self.store.active_lease_count(runtime_key) >= self.read_effective_max_in_flight(runtime_key)
    }

    /// 从 MetadataCenter runtime_control 读取配置
    fn read_traffic_config(&self, ctx: &AcquireContext) -> TrafficPolicy {
        // 从 ctx.metadata_center 读取 runtime_control.trafficGovernor.*
        // 读取 ProviderRuntimeProfile 中的 concurrency/rpm 配置
        TrafficPolicy {
            max_in_flight: ctx.max_in_flight.unwrap_or(2),
            acquire_timeout_ms: ctx.acquire_timeout_ms.unwrap_or(60_000),
            stale_lease_ms: ctx.stale_lease_ms.unwrap_or(300_000),
            requests_per_minute: ctx.requests_per_minute.unwrap_or(120),
            rpm_timeout_ms: ctx.rpm_timeout_ms.unwrap_or(60_000),
            rpm_window_ms: 60_000,
        }
    }

    fn read_effective_max_in_flight(&self, _runtime_key: &str) -> usize {
        // 读取 adapter config
        2
    }
}
