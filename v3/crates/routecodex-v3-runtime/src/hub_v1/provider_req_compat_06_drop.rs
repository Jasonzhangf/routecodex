//! ProviderReqCompat06 的 stage-3 投影结果载体与节点方法。
//!
//! 与 `provider_req_compat_06_provider_compat` 分离，使该 owner 模块保持在文件
//! 尺寸上限内（见 docs/architecture/wiki/v3-module-decomposition-sop.md）。
//! `ProviderReqCompat06Projected` 把「投影节点 + 本次丢弃记录」一起带出投影，
//! 由请求作用域用 `restamp_and_emit` 补全丢弃身份并落盘：丢弃是非错误通道，
//! 兼容优先，确实无表示时才 DROP + RECORD + PRINT 并继续。

use super::provider_req_compat_06_provider_compat::ProviderReqCompat06ProviderCompat;
use super::V3ProviderCompatProfileId;
use crate::projection_drop_log::{V3ProjectionDropContext, V3ProjectionDropRecord};
use serde_json::Value;

/// stage-3 投影结果载体：ProviderReqCompat06 节点 + 本次投影的丢弃记录。
///
/// `Deref` 到节点，因此只关心节点本身的调用点与测试无需改动；请求作用域在
/// 拿到载体后用 `restamp_and_emit` 补全丢弃身份并落盘。
#[derive(Debug)]
pub struct ProviderReqCompat06Projected {
    pub node: ProviderReqCompat06ProviderCompat,
    pub drops: Vec<V3ProjectionDropRecord>,
}

impl std::ops::Deref for ProviderReqCompat06Projected {
    type Target = ProviderReqCompat06ProviderCompat;
    fn deref(&self) -> &Self::Target {
        &self.node
    }
}

/// 请求作用域收口：补全丢弃身份并落盘，返回投影节点。
///
/// 三个 relay 入口都必须走这里，避免「算出丢弃但不落盘」的静默缺口。
pub fn record_projected_drops(
    drop_context: &V3ProjectionDropContext,
    mut projected: ProviderReqCompat06Projected,
) -> ProviderReqCompat06ProviderCompat {
    drop_context.restamp_and_emit(&mut projected.drops);
    projected.node
}

impl ProviderReqCompat06ProviderCompat {
    pub fn profile(&self) -> &V3ProviderCompatProfileId {
        &self.profile
    }
    pub(crate) fn provider_semantic_payload(&self) -> &Value {
        &self.payload.0
    }
}
