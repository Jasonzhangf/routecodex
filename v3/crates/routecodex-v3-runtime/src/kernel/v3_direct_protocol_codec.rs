//! V3 Direct 执行统一骨架的协议 codec。
//!
//! Jason 2026-08-08：不同协议（responses / openai_chat / anthropic / gemini）
//! 到 relay 与 direct 必须共用同一个执行框架，只有 codec 不同；禁止每个协议
//! 独立写一套 runtime。本 trait 收敛 direct 骨架的协议差异面：
//! - 标准化类型/构建（`Standardized` / `build_standardized`）
//! - 路由事实（`router_facts`）
//! - direct 策略（`Policy` / `run_route`）
//! - 出站 wire 与 transport（`run_request_projection` / `run_provider_transport`）
//! - 协议控制面（续接/stopless 等，responses 实现，chat 等默认无）
//! 骨架执行流程（路由 -> 选择 -> 决策 -> 策略 -> wire -> transport -> 发送 ->
//! 响应投影 -> 客户端帧 + 失败策略循环）在 `crate::kernel::execute_v3_direct_runtime_kernel_core`
//! 中只实现一份。
use crate::nodes::{V3ChatDirect11Policy, V3Req04StandardizedChat};
use crate::{
    hooks::build_v3_provider_error_source,
    nodes::{V3Req04StandardizedResponses, V3ResponsesDirect11Policy},
    shared::project_provider_raw_to_client_payload,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised_internal, V3Error01SourceRaised, V3ErrorSourceKind,
    V3InternalErrorCode,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_12_responses_wire_payload, V3Provider12ResponsesWirePayload,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ProviderResp14Raw,
    V3ResponsesProviderTarget,
};
use routecodex_v3_target::V3Target10ConcreteProviderSelected;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

pub(crate) type V3DirectResponseProjectionFuture = Pin<
    Box<
        dyn Future<
                Output = Result<crate::shared::V3ProviderResponseProjection, V3Error01SourceRaised>,
            > + Send,
    >,
>;

pub trait V3DirectProtocolCodec {
    type Standardized;
    type Policy;
    type Control;

    const ENTRY_PROTOCOL: &'static str;
    const STANDARDIZED_STAGE: &'static str;
    const POLICY_STAGE: &'static str;

    fn build_standardized(
        raw: crate::nodes::V3Server03HttpRequestRaw,
    ) -> Result<Self::Standardized, String>;

    fn server_id(standardized: &Self::Standardized) -> &str;
    fn endpoint(standardized: &Self::Standardized) -> &str;
    fn request_id(standardized: &Self::Standardized) -> &str;
    fn body(standardized: &Self::Standardized) -> &serde_json::Value;
    fn policy_target(policy: &Self::Policy) -> &V3Target10ConcreteProviderSelected;

    fn router_facts(
        standardized: &Self::Standardized,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    ) -> routecodex_v3_virtual_router::V3RouterRequestFacts;

    fn run_route(
        selected: V3Target10ConcreteProviderSelected,
        standardized: &Self::Standardized,
    ) -> Self::Policy;

    fn run_request_projection(
        policy: &Self::Policy,
    ) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised>;

    fn run_provider_transport(
        wire: V3Provider12ResponsesWirePayload,
    ) -> Result<
        routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
        V3Error01SourceRaised,
    >;

    fn run_response_projection(raw: V3ProviderResp14Raw) -> V3DirectResponseProjectionFuture;

    fn run_error(
        source: V3Error01SourceRaised,
        scope: routecodex_v3_error::V3ErrorActionScope,
        candidates_remaining: usize,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
    ) -> routecodex_v3_error::V3Error05ExecutionDecision;

    /// 协议控制面：失败会话作用域（responses 续接作用域；chat 用请求本身）。
    fn failure_session_scope(
        control: &Self::Control,
        standardized: &Self::Standardized,
    ) -> routecodex_v3_error::V3ProviderFailureSessionScope;

    /// 协议控制面：续接精确 pin 目标（responses 实现；chat 无）。
    fn pinned_target(
        control: &mut Self::Control,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        standardized: &Self::Standardized,
        provider_health: &crate::provider_failure_runtime_policy::V3ProviderFailureRuntimeHealth,
        now_epoch_ms: u64,
    ) -> Result<Option<V3Target10ConcreteProviderSelected>, V3Error01SourceRaised> {
        let _ = (
            control,
            manifest,
            standardized,
            provider_health,
            now_epoch_ms,
        );
        Ok(None)
    }

    /// 协议控制面：发送前的控制准备（responses 的 stopless/websearch；
    /// chat 等默认无）。返回 false 表示骨架应跳过控制准备。
    fn prepare_before_send(
        control: &mut Self::Control,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        standardized: &mut Self::Standardized,
        request_id: &str,
        now_epoch_ms: u64,
        trace: &mut Vec<&'static str>,
    ) -> Result<bool, V3Error01SourceRaised> {
        let _ = (
            control,
            manifest,
            server_id,
            standardized,
            request_id,
            now_epoch_ms,
            trace,
        );
        Ok(false)
    }

    /// 协议控制面：响应后的提交/释放（responses 的 continuation commit；
    /// chat 等默认无）。
    fn commit_after_response(
        control: &Self::Control,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        standardized: &Self::Standardized,
        request_id: &str,
        trace: &mut Vec<&'static str>,
    ) -> Result<(), V3Error01SourceRaised> {
        let _ = (
            control,
            manifest,
            server_id,
            standardized,
            request_id,
            trace,
        );
        Ok(())
    }

    /// 协议控制面：错误路径的续接释放（responses 实现；chat 无）。
    fn release_after_error(
        control: &Self::Control,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        standardized: &Self::Standardized,
        request_id: &str,
        trace: &mut Vec<&'static str>,
    ) -> Result<(), V3Error01SourceRaised> {
        let _ = (
            control,
            manifest,
            server_id,
            standardized,
            request_id,
            trace,
        );
        Ok(())
    }
}

/// Responses 协议 codec（同协议 direct wire = responses wire）。
pub struct V3ResponsesDirectCodec;

impl V3DirectProtocolCodec for V3ResponsesDirectCodec {
    type Standardized = V3Req04StandardizedResponses;
    type Policy = V3ResponsesDirect11Policy;
    type Control = ();

    const ENTRY_PROTOCOL: &'static str = "responses";
    const STANDARDIZED_STAGE: &'static str = "V3Req04StandardizedResponses";
    const POLICY_STAGE: &'static str = "V3ResponsesDirect11Policy";

    fn build_standardized(
        raw: crate::nodes::V3Server03HttpRequestRaw,
    ) -> Result<Self::Standardized, String> {
        crate::nodes::build_v3_req_04_standardized_responses_from_v3_server_03(raw)
    }

    fn server_id(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.server_id
    }
    fn endpoint(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.endpoint
    }
    fn request_id(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.request_id
    }
    fn body(standardized: &Self::Standardized) -> &serde_json::Value {
        &standardized.body
    }
    fn policy_target(policy: &Self::Policy) -> &V3Target10ConcreteProviderSelected {
        &policy.target
    }

    fn router_facts(
        standardized: &Self::Standardized,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    ) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
        crate::nodes::build_v3_router_request_facts_from_v3_req_04(standardized, manifest)
    }

    fn run_route(
        selected: V3Target10ConcreteProviderSelected,
        standardized: &Self::Standardized,
    ) -> Self::Policy {
        crate::nodes::build_v3_responses_direct_11_policy_from_v3_target_10(selected, standardized)
    }

    fn run_request_projection(
        policy: &Self::Policy,
    ) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
        crate::hooks::responses_direct_request_projection_hook(policy)
    }

    fn run_provider_transport(
        wire: V3Provider12ResponsesWirePayload,
    ) -> Result<
        routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
        V3Error01SourceRaised,
    > {
        crate::hooks::responses_direct_provider_transport_hook(wire)
    }

    fn run_response_projection(raw: V3ProviderResp14Raw) -> V3DirectResponseProjectionFuture {
        Box::pin(project_provider_raw_to_client_payload(raw))
    }

    fn run_error(
        source: V3Error01SourceRaised,
        scope: routecodex_v3_error::V3ErrorActionScope,
        candidates_remaining: usize,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
    ) -> routecodex_v3_error::V3Error05ExecutionDecision {
        crate::hooks::responses_direct_error_hook(
            source,
            scope,
            candidates_remaining,
            default_pool_available,
            same_provider_retry_available,
            recovery,
        )
    }

    fn failure_session_scope(
        _control: &Self::Control,
        standardized: &Self::Standardized,
    ) -> routecodex_v3_error::V3ProviderFailureSessionScope {
        standardized.protocol_context.failure_session_scope.clone()
    }
}

/// Chat 协议 codec（同协议 direct wire = openai_chat wire）。
pub struct V3ChatDirectCodec;

impl V3DirectProtocolCodec for V3ChatDirectCodec {
    type Standardized = V3Req04StandardizedChat;
    type Policy = V3ChatDirect11Policy;
    type Control = ();

    const ENTRY_PROTOCOL: &'static str = "openai_chat";
    const STANDARDIZED_STAGE: &'static str = "V3Req04StandardizedChat";
    const POLICY_STAGE: &'static str = "V3ChatDirect11Policy";

    fn build_standardized(
        raw: crate::nodes::V3Server03HttpRequestRaw,
    ) -> Result<Self::Standardized, String> {
        crate::nodes::build_v3_chat_req_04_standardized_from_v3_server_03(raw)
    }

    fn server_id(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.server_id
    }
    fn endpoint(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.endpoint
    }
    fn request_id(standardized: &Self::Standardized) -> &str {
        &standardized.protocol_context.request_id
    }
    fn body(standardized: &Self::Standardized) -> &serde_json::Value {
        &standardized.body
    }
    fn policy_target(policy: &Self::Policy) -> &V3Target10ConcreteProviderSelected {
        &policy.target
    }

    fn router_facts(
        standardized: &Self::Standardized,
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    ) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
        crate::nodes::build_v3_router_request_facts_from_v3_req_04_chat(standardized, manifest)
    }

    fn run_route(
        selected: V3Target10ConcreteProviderSelected,
        standardized: &Self::Standardized,
    ) -> Self::Policy {
        crate::nodes::build_v3_chat_direct_11_policy_from_v3_target_10(selected, standardized)
    }

    fn run_request_projection(
        policy: &Self::Policy,
    ) -> Result<V3Provider12ResponsesWirePayload, V3Error01SourceRaised> {
        crate::hooks::chat_direct_request_projection_hook(policy)
    }

    fn run_provider_transport(
        wire: V3Provider12ResponsesWirePayload,
    ) -> Result<
        routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
        V3Error01SourceRaised,
    > {
        crate::hooks::chat_direct_provider_transport_hook(wire)
    }

    fn run_response_projection(raw: V3ProviderResp14Raw) -> V3DirectResponseProjectionFuture {
        Box::pin(project_provider_raw_to_client_payload(raw))
    }

    fn run_error(
        source: V3Error01SourceRaised,
        scope: routecodex_v3_error::V3ErrorActionScope,
        candidates_remaining: usize,
        default_pool_available: bool,
        same_provider_retry_available: bool,
        recovery: Option<routecodex_v3_error::V3Error05RecoveryAdmissionWitness>,
    ) -> routecodex_v3_error::V3Error05ExecutionDecision {
        crate::hooks::responses_direct_error_hook(
            source,
            scope,
            candidates_remaining,
            default_pool_available,
            same_provider_retry_available,
            recovery,
        )
    }

    fn failure_session_scope(
        _control: &Self::Control,
        standardized: &Self::Standardized,
    ) -> routecodex_v3_error::V3ProviderFailureSessionScope {
        standardized.protocol_context.failure_session_scope.clone()
    }
}
