// feature_id: hub.route_selection_bridge
use napi::Env;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
use crate::hub_pipeline_blocks::protocol::resolve_provider_protocol;
use crate::hub_pipeline_blocks::standardized_request::coerce_standardized_request_from_borrowed_parts;
use crate::hub_pipeline_types::{
    run_hub_req_chatprocess_03_governed_entrypoint, run_hub_req_inbound_02_standardized_entrypoint,
    run_hub_req_outbound_05_provider_semantic_entrypoint,
    run_hub_resp_chatprocess_03_governed_entrypoint, run_hub_resp_inbound_02_parsed_entrypoint,
    run_hub_resp_outbound_04_client_semantic_entrypoint,
    run_vr_route_04_selected_target_entrypoint, ResponseAdjacentTransitionError,
};
use crate::hub_req_chatprocess_03_governance_boundary::apply_hub_req_chatprocess_03_tool_governance;
use crate::hub_req_inbound_context_capture::{
    capture_req_inbound_responses_context_snapshot, ResponsesContextCaptureInput,
};
use crate::hub_req_inbound_format_parse::{
    parse_format_envelope, FormatEnvelope, FormatParseInput,
};
use crate::hub_req_inbound_semantic_lift::{
    apply_req_inbound_semantic_lift, ReqInboundSemanticLiftApplyInput,
};
use crate::hub_req_outbound_context_merge::apply_req_outbound_context_snapshot_from_refs;
use crate::hub_req_outbound_format_build::{build_format_request, FormatBuildInput};
use crate::hub_resp_chatprocess_03_governance_boundary::govern_hub_resp_chatprocess_03_response;
use crate::hub_resp_inbound_format_parse::{parse_resp_format_envelope, RespFormatParseInput};
use crate::hub_resp_outbound_04_client_payload_boundary::build_hub_resp_outbound_04_client_payload_for_protocol;
use crate::hub_resp_outbound_04_finalize_boundary::finalize_hub_resp_outbound_04_client_semantic;
use crate::hub_resp_outbound_sse_stream::{process_sse_stream, SseStreamInput};
use crate::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use crate::req_process_stage1_tool_governance::ToolGovernanceInput;
use crate::req_process_stage2_route_select::RouteSelectionApplyInput;
use crate::resp_process_stage1_tool_governance::ToolGovernanceInput as RespToolGovernanceInput;
use crate::resp_process_stage2_finalize::FinalizeInput;
use crate::servertool_hook_runtime::run_servertool_response_hooks;
use crate::shared_json_utils::read_trimmed_string;
use crate::virtual_router_engine::routing_state_store::with_session_dir_override;
use crate::virtual_router_engine::VirtualRouterEngineCore;
use crate::vr_route_04_selection_boundary::apply_vr_route_04_selection;

use super::diagnostics::{HubPipelineDiagnostic, HubPipelineDiagnosticStatus};
use super::effect_plan::{HubPipelineEffect, HubPipelineEffectKind, HubPipelineEffectPlan};
use super::errors::{HubPipelineError, HubPipelineResult};
use super::stage_catalog::HubPipelineStageId;
use super::types::{
    HubPipelineConfig, HubPipelineExecutionOutput, HubPipelineRequest, RouteRetryExclusionSet,
};

fn read_entry_provider_protocol(metadata_center_snapshot: &Value) -> Option<String> {
    metadata_center_snapshot
        .get("runtimeControl")
        .and_then(|v| v.as_object())
        .and_then(|rt| read_trimmed_string(rt.get("providerProtocol")))
}

fn resolve_request_entry_protocol(explicit_protocol: &str) -> HubPipelineResult<String> {
    if explicit_protocol.trim().is_empty() {
        return Err(HubPipelineError::new(
            "hub_pipeline_missing_client_protocol",
            "Rust HubPipeline request requires an explicit typed client protocol",
        ));
    }
    resolve_provider_protocol(explicit_protocol)
        .map_err(|message| HubPipelineError::new("hub_pipeline_invalid_client_protocol", message))
}

#[derive(Clone)]
pub struct HubPipelineEngine {
    config: HubPipelineConfig,
    virtual_router_core: Option<VirtualRouterEngineCore>,
}

impl HubPipelineEngine {
    pub fn new(config: HubPipelineConfig) -> HubPipelineResult<Self> {
        let virtual_router_core = build_optional_virtual_router_core(&config.virtual_router)?;
        Ok(Self {
            config,
            virtual_router_core,
        })
    }

    pub fn update_virtual_router_config(&mut self, config: Value) -> HubPipelineResult<()> {
        if !config.is_object() {
            return Err(HubPipelineError::new(
                "hub_pipeline_invalid_virtual_router_config",
                "Virtual router config must be a JSON object",
            ));
        }
        self.virtual_router_core = build_optional_virtual_router_core(&config)?;
        self.config.virtual_router = config;
        Ok(())
    }

    pub fn update_runtime_deps(&mut self, deps: Value) -> HubPipelineResult<()> {
        if !deps.is_object() && !deps.is_null() {
            return Err(HubPipelineError::new(
                "hub_pipeline_invalid_runtime_deps",
                "Runtime deps must be a JSON object or null",
            ));
        }
        Ok(())
    }

    pub fn route_virtual_router(
        &mut self,
        request: Value,
        metadata: Value,
    ) -> HubPipelineResult<Value> {
        let metadata_center_snapshot = metadata
            .get("metadataCenterSnapshot")
            .cloned()
            .unwrap_or(Value::Null);
        with_virtual_router_session_dir_value(&metadata_center_snapshot, || {
            let Some(router) = self.virtual_router_core.as_mut() else {
                return Err(HubPipelineError::new(
                    "hub_pipeline_virtual_router_facade_unavailable",
                    "Rust HubPipeline virtual router facade requires routing configuration",
                ));
            };
            router
                .route(
                    unsafe { Env::from_raw(std::ptr::null_mut()) },
                    &request,
                    &metadata,
                )
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_facade_route_failed",
                        format!(
                            "Rust HubPipeline virtual router facade route failed: {}",
                            message
                        ),
                    )
                })
        })
    }

    pub fn diagnose_virtual_router(
        &mut self,
        request: Value,
        metadata: Value,
    ) -> HubPipelineResult<Value> {
        let metadata_center_snapshot = metadata
            .get("metadataCenterSnapshot")
            .cloned()
            .unwrap_or(Value::Null);
        with_virtual_router_session_dir_value(&metadata_center_snapshot, || {
            let Some(router) = self.virtual_router_core.as_mut() else {
                return Err(HubPipelineError::new(
                    "hub_pipeline_virtual_router_facade_unavailable",
                    "Rust HubPipeline virtual router facade requires routing configuration",
                ));
            };
            Ok(router.diagnose_route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            ))
        })
    }

    pub fn virtual_router_status(&mut self) -> HubPipelineResult<Value> {
        let Some(router) = self.virtual_router_core.as_mut() else {
            return Err(HubPipelineError::new(
                "hub_pipeline_virtual_router_facade_unavailable",
                "Rust HubPipeline virtual router facade requires routing configuration",
            ));
        };
        Ok(router.get_status())
    }

    pub(crate) fn owns_provider_runtime_event_for_group(
        &self,
        provider_key: &str,
        routing_policy_group: &str,
    ) -> bool {
        let Some(router) = self.virtual_router_core.as_ref() else {
            return false;
        };
        let Some(expected_group) = self.expected_routing_policy_group() else {
            return false;
        };
        expected_group == routing_policy_group
            && crate::virtual_router_engine::provider_runtime_ingress::runtime_owns_provider_event(
                router,
                provider_key,
            )
    }

    pub(crate) fn owns_provider_runtime_event(&self, provider_key: &str) -> bool {
        self.virtual_router_core.as_ref().is_some_and(|router| {
            crate::virtual_router_engine::provider_runtime_ingress::runtime_owns_provider_event(
                router,
                provider_key,
            )
        })
    }

    pub(crate) fn handle_provider_runtime_error(&mut self, event: &Value) {
        if let Some(router) = self.virtual_router_core.as_mut() {
            router.handle_provider_error(event);
        }
    }

    pub(crate) fn handle_provider_runtime_success(&mut self, event: &Value) {
        if let Some(router) = self.virtual_router_core.as_mut() {
            router.handle_provider_success(event);
        }
    }

    pub fn mark_virtual_router_concurrency_scope_busy(
        &mut self,
        scope_key: &str,
    ) -> HubPipelineResult<()> {
        let Some(router) = self.virtual_router_core.as_mut() else {
            return Err(HubPipelineError::new(
                "hub_pipeline_virtual_router_facade_unavailable",
                "Rust HubPipeline virtual router facade requires routing configuration",
            ));
        };
        router.mark_concurrency_scope_busy(scope_key);
        Ok(())
    }

    pub fn mark_virtual_router_concurrency_scope_idle(
        &mut self,
        scope_key: &str,
    ) -> HubPipelineResult<()> {
        let Some(router) = self.virtual_router_core.as_mut() else {
            return Err(HubPipelineError::new(
                "hub_pipeline_virtual_router_facade_unavailable",
                "Rust HubPipeline virtual router facade requires routing configuration",
            ));
        };
        router.mark_concurrency_scope_idle(scope_key);
        Ok(())
    }

    fn select_route(
        &self,
        request: &Value,
        metadata: &Value,
        metadata_center_snapshot: &Value,
        retry_exclusion_set: &RouteRetryExclusionSet,
    ) -> HubPipelineResult<Value> {
        if let Some(target) = self.config.virtual_router.get("target").cloned() {
            return Ok(serde_json::json!({
                "target": target,
                "decision": {
                    "routeName": self
                        .config
                        .virtual_router
                        .get("routeName")
                        .and_then(Value::as_str)
                        .unwrap_or("default")
                },
                "diagnostics": {}
            }));
        }
        if let Some(route) = read_preselected_route(metadata_center_snapshot, metadata) {
            if !self.preselected_route_target_available(&route, metadata_center_snapshot)? {
                return self.select_virtual_router_route(
                    request,
                    metadata_center_snapshot,
                    retry_exclusion_set,
                );
            }
            return Ok(route);
        }
        self.select_virtual_router_route(request, metadata_center_snapshot, retry_exclusion_set)
    }

    fn select_virtual_router_route(
        &self,
        request: &Value,
        metadata_center_snapshot: &Value,
        retry_exclusion_set: &RouteRetryExclusionSet,
    ) -> HubPipelineResult<Value> {
        let mut metadata_for_router = serde_json::json!({
            "metadataCenterSnapshot": metadata_center_snapshot,
        });
        if !retry_exclusion_set.is_empty() {
            if let Some(row) = metadata_for_router.as_object_mut() {
                row.insert(
                    "excludedProviderKeys".to_string(),
                    serde_json::to_value(retry_exclusion_set.as_slice()).map_err(|error| {
                        HubPipelineError::new(
                            "hub_pipeline_invalid_retry_exclusion_set",
                            format!(
                                "Rust HubPipeline retryExclusionSet failed to serialize: {error}"
                            ),
                        )
                    })?,
                );
            }
        }
        self.with_virtual_router_session_dir(metadata_center_snapshot, || {
            if self.config.runtime_router_required {
                return crate::virtual_router_engine::provider_runtime_ingress::route_with_registered_runtime(
                    unsafe { Env::from_raw(std::ptr::null_mut()) },
                    request,
                    &metadata_for_router,
                    self.expected_routing_policy_group(),
                )
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_runtime_unavailable",
                        format!("Rust HubPipeline virtual router runtime route failed: {}", message),
                    )
                });
            }
            let mut router = VirtualRouterEngineCore::new();
            router
                .initialize(&self.config.virtual_router)
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_retry_init_failed",
                        format!(
                            "Rust HubPipeline explicit provider retry VR init failed: {}",
                            message
                        ),
                    )
                })?;
            router
                .route(
                    unsafe { Env::from_raw(std::ptr::null_mut()) },
                    request,
                    &metadata_for_router,
                )
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_route_failed",
                        format!("Rust HubPipeline virtual router route failed: {}", message),
                    )
                })
        })
    }

    fn preselected_route_target_available(
        &self,
        route: &Value,
        metadata_center_snapshot: &Value,
    ) -> HubPipelineResult<bool> {
        let provider_key = route
            .pointer("/target/providerKey")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_invalid_preselected_route",
                    "Rust HubPipeline preselectedRoute requires target.providerKey",
                )
            })?;
        self.with_virtual_router_session_dir(metadata_center_snapshot, || {
            if self.config.runtime_router_required {
                return crate::virtual_router_engine::provider_runtime_ingress::is_provider_available_with_registered_runtime(
                    provider_key,
                    &serde_json::json!({
                        "metadataCenterSnapshot": metadata_center_snapshot,
                    }),
                    self.expected_routing_policy_group(),
                )
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_runtime_unavailable",
                        format!(
                            "Rust HubPipeline preselected route runtime availability failed: {}",
                            message
                        ),
                    )
                });
            }
            let mut router = VirtualRouterEngineCore::new();
            router
                .initialize(&self.config.virtual_router)
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_virtual_router_preselected_init_failed",
                        format!(
                            "Rust HubPipeline preselected route availability VR init failed: {}",
                            message
                        ),
                    )
                })?;
            Ok(router.is_provider_available(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                provider_key,
            ))
        })
    }

    fn expected_routing_policy_group(&self) -> Option<&str> {
        self.config
            .virtual_router
            .get("routingPolicyGroup")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    fn with_virtual_router_session_dir<T>(
        &self,
        metadata_center_snapshot: &Value,
        callback: impl FnOnce() -> HubPipelineResult<T>,
    ) -> HubPipelineResult<T> {
        let session_dir = read_runtime_control_string(metadata_center_snapshot, "sessionDir")
            .or_else(|| read_runtime_control_string(metadata_center_snapshot, "session_dir"));
        match session_dir.as_deref() {
            Some(value) => with_session_dir_override(Some(value), callback),
            None => callback(),
        }
    }

    pub fn execute(
        &mut self,
        request: HubPipelineRequest,
    ) -> HubPipelineResult<HubPipelineExecutionOutput> {
        let request_id = request.request_id.trim();
        if request_id.is_empty() {
            return Err(HubPipelineError::new(
                "hub_pipeline_missing_request_id",
                "Rust HubPipeline requires a non-empty requestId",
            ));
        }
        let request_id = request_id.to_string();
        let entry_endpoint = request.entry_endpoint.clone();
        let direction = request.direction.clone();
        let metadata_center_snapshot = request.metadata_center_snapshot.clone();
        let entry_protocol = if direction == "response" {
            read_entry_provider_protocol(&metadata_center_snapshot).ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_provider_protocol",
                    "Rust HubPipeline response requires metadataCenterSnapshot.runtimeControl.providerProtocol",
                )
            })?
        } else {
            resolve_request_entry_protocol(&request.provider_protocol)?
        };
        let retry_exclusion_set = request.retry_exclusion_set.normalize()?;
        let mut diagnostics = vec![diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Started,
            None,
        )];
        let input = HubPipelineInput {
            request_id: request_id.clone(),
            endpoint: request.endpoint,
            entry_endpoint: request.entry_endpoint,
            provider_protocol: entry_protocol.clone(),
            payload: request.payload,
            metadata: request.metadata,
            metadata_center_snapshot: metadata_center_snapshot.clone(),
            stream: request.stream,
            process_mode: request.process_mode,
            direction: request.direction,
            stage: request.stage,
        };
        let mut output = run_hub_pipeline(input).map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Completed,
            None,
        ));
        let normalized_payload = output.payload.take().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_normalized_payload",
                "Rust HubPipeline normalize stage returned no payload",
            )
        })?;
        let normalized_metadata = output.metadata.take().unwrap_or(Value::Null);
        if direction == "response" {
            return self.execute_response_path(
                output,
                normalized_payload,
                normalized_metadata,
                entry_protocol,
                metadata_center_snapshot,
                diagnostics,
            );
        }
        let entry_provider_protocol = entry_protocol;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundFormatParse,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let mut parsed = parse_format_envelope(FormatParseInput {
            raw_request: normalized_payload,
            protocol: entry_provider_protocol.clone(),
        })
        .map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundFormatParse,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "format": parsed.envelope.format })),
        ));
        let normalized_payload = std::mem::take(&mut parsed.envelope.payload);
        let original_model = normalized_payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundSemanticLift,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let mut format_envelope =
            apply_req_inbound_semantic_lift(ReqInboundSemanticLiftApplyInput {
                chat_envelope: format_envelope_into_value(parsed.envelope),
                payload: Some(&normalized_payload),
                protocol: Some(entry_provider_protocol.clone()),
                entry_endpoint: normalized_metadata
                    .get("entryEndpoint")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundSemanticLift,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "envelopeObject": format_envelope.is_object() })),
        ));
        if let Some(format_envelope) = format_envelope.as_object_mut() {
            format_envelope.remove("payload");
        }
        let (mut normal_request_payload, inline_payload_metadata) =
            split_normal_payload_and_inline_metadata(normalized_payload);
        let standardizer_metadata =
            merge_standardizer_metadata(&normalized_metadata, inline_payload_metadata.as_ref());
        let mut standardized = coerce_standardized_request_from_borrowed_parts(
            &normal_request_payload,
            serde_json::json!({
                "id": output.request_id,
                "entryEndpoint": entry_endpoint,
                "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false),
                "processMode": normalized_metadata.get("processMode").and_then(Value::as_str).unwrap_or("chat"),
                "routeHint": normalized_metadata.get("routeHint").cloned().unwrap_or(Value::Null),
                "metadata": standardizer_metadata
            }),
        )
        .map_err(HubPipelineError::from)?;
        let standardized_record = standardized.as_object_mut().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_invalid_standardized_output",
                "Rust HubPipeline req inbound returned non-object standardized output",
            )
        })?;
        let mut standardized_payload = standardized_record
            .remove("standardizedRequest")
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_standardized_request",
                    "Rust HubPipeline req inbound returned no standardized request",
                )
            })?;
        let standardized_raw_payload =
            standardized_record.remove("rawPayload").ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_standardized_raw_payload",
                    "Rust HubPipeline req inbound returned no standardized raw payload",
                )
            })?;
        let req_inbound_02 = run_hub_req_inbound_02_standardized_entrypoint(
            standardized_raw_payload,
        )
        .map_err(|message| HubPipelineError::new("hub_pipeline_req_inbound_02_failed", message))?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundContextCapture,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let had_inline_payload_metadata = inline_payload_metadata.is_some();
        if let Some(inline_payload_metadata) = inline_payload_metadata {
            if let Some(payload) = normal_request_payload.as_object_mut() {
                payload.insert("metadata".to_string(), inline_payload_metadata);
            }
        }
        let inbound_context_snapshot_result = capture_context_snapshot(
            &entry_provider_protocol,
            &normal_request_payload,
            &normalized_metadata,
            &request_id,
        );
        if had_inline_payload_metadata {
            if let Some(payload) = normal_request_payload.as_object_mut() {
                payload.remove("metadata");
            }
        }
        let inbound_context_snapshot = inbound_context_snapshot_result?;
        let entry_origin_request = normal_request_payload;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundContextCapture,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "hasContextSnapshot": inbound_context_snapshot.is_some(),
            })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessToolGovernance,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "metadataObject": normalized_metadata.is_object() })),
        ));
        let governed = apply_hub_req_chatprocess_03_tool_governance(ToolGovernanceInput {
            request: standardized_payload.clone(),
            raw_payload: Value::Null,
            metadata: normalized_metadata.clone(),
            entry_endpoint: entry_endpoint.clone(),
            request_id: output.request_id.clone(),
            has_active_stop_message_for_continue_execution: Some(true),
            metadata_center_snapshot: metadata_center_snapshot.clone(),
        })
        .map_err(|message| HubPipelineError::new("hub_pipeline_tool_governance_failed", message))?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessToolGovernance,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "nodeResult": governed.node_result,
            })),
        ));
        let governed_metadata = governed.metadata.clone();
        let req_chatprocess_03 = run_hub_req_chatprocess_03_governed_entrypoint(
            req_inbound_02,
            project_normal_request_payload(&governed.processed_request),
        )
        .map_err(|message| {
            HubPipelineError::new("hub_pipeline_req_chatprocess_03_failed", message)
        })?;
        let mut route_output = self.select_route(
            &governed.processed_request,
            &governed_metadata,
            &metadata_center_snapshot,
            &retry_exclusion_set,
        )?;
        let route_output_record = route_output.as_object_mut().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_invalid_route_output",
                "Rust HubPipeline req route stage returned non-object output",
            )
        })?;
        let target = route_output_record.remove("target").ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_route_target",
                "Rust HubPipeline req route stage returned no target",
            )
        })?;
        let route_decision = route_output_record.remove("decision").ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_route_decision",
                "Rust HubPipeline req route stage returned no decision",
            )
        })?;
        let route_name = route_decision
            .as_object()
            .and_then(|decision| decision.get("routeName"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let routing_diagnostics = route_output_record.remove("diagnostics");
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "targetObject": target.is_object() })),
        ));
        let vr_route_04 =
            run_vr_route_04_selected_target_entrypoint(&req_chatprocess_03, route_decision)
                .map_err(|message| {
                    HubPipelineError::new(
                        "hub_pipeline_vr_route_04_selected_target_failed",
                        message,
                    )
                })?;
        let mut routed = apply_vr_route_04_selection(RouteSelectionApplyInput {
            request: governed.processed_request,
            normalized_metadata: governed_metadata,
            target,
            route_name,
            original_model,
            thinking: None,
        })
        .map_err(HubPipelineError::from)?;
        let provider_protocol = resolve_outbound_provider_protocol(&routed.normalized_metadata)
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_selected_provider_protocol",
                    "Rust HubPipeline request route selection must provide target.outboundProfile",
                )
            })?;
        let outbound_context_snapshot = capture_context_snapshot(
            &entry_provider_protocol,
            &routed.request,
            &routed.normalized_metadata,
            &request_id,
        )?;
        attach_context_snapshot_to_metadata(
            &mut routed.normalized_metadata,
            outbound_context_snapshot.or(inbound_context_snapshot),
        )?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "metadataObject": routed.normalized_metadata.is_object(),
            })),
        ));
        let req_outbound_05 = run_hub_req_outbound_05_provider_semantic_entrypoint(
            req_chatprocess_03,
            &vr_route_04,
            project_normal_request_payload(&routed.request),
        )
        .map_err(|message| HubPipelineError::new("hub_pipeline_req_outbound_05_failed", message))?;
        if let Some(metadata) = routed.normalized_metadata.as_object_mut() {
            metadata.insert("routingDecision".to_string(), vr_route_04.into_decision());
            if let Some(diagnostics_value) = routing_diagnostics {
                metadata.insert("routingDiagnostics".to_string(), diagnostics_value);
            }
        }
        if let Some(envelope) = format_envelope.as_object_mut() {
            envelope.insert("payload".to_string(), req_outbound_05.into_payload());
        }
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundContextMerge,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({
                "hasContextSnapshot": resolve_context_snapshot(&routed.normalized_metadata).is_some(),
            })),
        ));
        apply_context_snapshot_to_format_envelope(
            &mut format_envelope,
            &routed.normalized_metadata,
        )?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundContextMerge,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "payloadObject": format_envelope.get("payload").is_some_and(Value::is_object),
            })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundFormatBuild,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let outbound = build_format_request(FormatBuildInput {
            format_envelope,
            protocol: provider_protocol.clone(),
        })
        .map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundFormatBuild,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "payloadObject": outbound.payload.is_object(),
            })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundCompat,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let compat = run_req_outbound_stage3_compat(ReqOutboundCompatInput {
            payload: outbound.payload,
            adapter_context: build_adapter_context(
                &routed.normalized_metadata,
                &provider_protocol,
                &output.request_id,
            ),
            explicit_profile: self
                .config
                .virtual_router
                .get("compatibilityProfile")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
        .map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqOutboundCompat,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "nativeApplied": compat.native_applied,
                "appliedProfile": compat.applied_profile,
            })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::EffectPlan,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "effects": 0 })),
        ));
        Ok(HubPipelineExecutionOutput {
            request_id: output.request_id,
            success: output.success,
            payload: Some(compat.payload),
            metadata: Some(routed.normalized_metadata),
            standardized_request: Some(standardized_payload),
            entry_origin_request: Some(entry_origin_request),
            effect_plan: HubPipelineEffectPlan::empty(),
            diagnostics,
            error: output.error.map(|error| HubPipelineError {
                code: error.code,
                message: error.message,
                details: error.details,
            }),
        })
    }

    fn execute_response_path(
        &mut self,
        output: crate::hub_pipeline::HubPipelineOutput,
        normalized_payload: Value,
        mut normalized_metadata: Value,
        provider_protocol: String,
        metadata_center_snapshot: Value,
        mut diagnostics: Vec<HubPipelineDiagnostic>,
    ) -> HubPipelineResult<HubPipelineExecutionOutput> {
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespInboundFormatParse,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let parsed = parse_resp_format_envelope(RespFormatParseInput {
            payload: normalized_payload,
            protocol: provider_protocol,
        })
        .map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespInboundFormatParse,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "format": parsed.envelope.format })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespProcessToolGovernance,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": parsed.envelope.format })),
        ));
        let canonical_payload = move_provider_response_metadata_to_carrier(
            parsed.envelope.payload,
            &mut normalized_metadata,
        );
        let resp_inbound_02 = run_hub_resp_inbound_02_parsed_entrypoint(canonical_payload)
            .map_err(|message| {
                HubPipelineError::new("hub_pipeline_resp_inbound_02_failed", message)
            })?;
        let client_protocol = normalized_metadata
            .get("clientProtocol")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_client_protocol",
                    "Rust HubPipeline resp governance requires metadata.clientProtocol",
                )
            })?;
        let entry_endpoint = normalized_metadata
            .get("entryEndpoint")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_entry_endpoint",
                    "Rust HubPipeline resp governance requires metadata.entryEndpoint",
                )
            })?;
        let mut effects = Vec::new();
        let servertool_resp_hook = run_servertool_response_hooks(
            resp_inbound_02.payload(),
            &metadata_center_snapshot,
            output.request_id.as_str(),
        )?;
        let (servertool_payload, servertool_hook_applied) =
            if let Some(servertool_hook) = servertool_resp_hook {
                if let Some(write_plan) = servertool_hook.metadata_write_plan {
                    effects.push(HubPipelineEffect {
                        kind: HubPipelineEffectKind::StoplessMetadataCenterWrite,
                        payload: write_plan,
                    });
                }
                if let Some(alarm) = servertool_hook.alarm {
                    diagnostics.push(diagnostic(
                        HubPipelineStageId::RespProcessToolGovernance,
                        HubPipelineDiagnosticStatus::Skipped,
                        Some(alarm),
                    ));
                }
                diagnostics.push(diagnostic(
                    HubPipelineStageId::RespProcessToolGovernance,
                    HubPipelineDiagnosticStatus::Completed,
                    Some(serde_json::json!({
                        "servertool": "standard_response_hook_skeleton",
                        "flowId": servertool_hook.flow_id,
                    })),
                ));
                (servertool_hook.payload, true)
            } else {
                (None, false)
            };
        let resp_chatprocess_03 = run_hub_resp_chatprocess_03_governed_entrypoint(
            resp_inbound_02,
            |canonical_payload| -> HubPipelineResult<Value> {
                if let Some(payload) = servertool_payload {
                    return Ok(payload);
                }
                let governed = govern_hub_resp_chatprocess_03_response(RespToolGovernanceInput {
                    payload: canonical_payload,
                    client_protocol,
                    entry_endpoint,
                    request_id: output.request_id.clone(),
                })
                .map_err(|message| {
                    HubPipelineError::new("hub_pipeline_resp_tool_governance_failed", message)
                })?;
                if !servertool_hook_applied {
                    diagnostics.push(diagnostic(
                        HubPipelineStageId::RespProcessToolGovernance,
                        HubPipelineDiagnosticStatus::Completed,
                        Some(serde_json::json!({
                            "summary": governed.summary,
                        })),
                    ));
                }
                Ok(governed.governed_payload)
            },
        )
        .map_err(|error| match error {
            ResponseAdjacentTransitionError::Contract(message) => {
                HubPipelineError::new("hub_pipeline_resp_chatprocess_03_failed", message)
            }
            ResponseAdjacentTransitionError::Transform(error) => error,
        })?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespProcessFinalize,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false) })),
        ));
        let resp_outbound_04 = run_hub_resp_outbound_04_client_semantic_entrypoint(
            resp_chatprocess_03,
            |resp_chatprocess_payload| -> HubPipelineResult<Value> {
                let finalized_payload =
                    finalize_hub_resp_outbound_04_client_semantic(FinalizeInput {
                        payload: resp_chatprocess_payload,
                        stream: normalized_metadata
                            .get("stream")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        reasoning_mode: normalized_metadata
                            .get("reasoningMode")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        endpoint: normalized_metadata
                            .get("entryEndpoint")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        request_id: Some(output.request_id.clone()),
                    });
                diagnostics.push(diagnostic(
                    HubPipelineStageId::RespProcessFinalize,
                    HubPipelineDiagnosticStatus::Completed,
                    Some(serde_json::json!({ "payloadObject": finalized_payload.is_object() })),
                ));
                diagnostics.push(diagnostic(
                    HubPipelineStageId::RespOutboundClientRemap,
                    HubPipelineDiagnosticStatus::Started,
                    Some(serde_json::json!({
                        "clientProtocol": normalized_metadata.get("clientProtocol").and_then(Value::as_str),
                    })),
                ));
                build_hub_resp_outbound_04_client_payload_for_protocol(
                    finalized_payload,
                    &normalized_metadata,
                    output.request_id.as_str(),
                )
            },
        )
        .map_err(|error| match error {
            ResponseAdjacentTransitionError::Contract(message) => {
                HubPipelineError::new("hub_pipeline_resp_outbound_04_failed", message)
            }
            ResponseAdjacentTransitionError::Transform(error) => error,
        })?;
        let client_payload = resp_outbound_04.into_payload();
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespOutboundClientRemap,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "payloadObject": client_payload.is_object() })),
        ));
        let client_protocol = normalized_metadata
            .get("clientProtocol")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_client_protocol",
                    "Rust HubPipeline resp SSE stream requires metadata.clientProtocol",
                )
            })?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespOutboundSseStream,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({
                "clientProtocol": client_protocol,
                "wantsStream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false),
            })),
        ));
        let stream_decision = process_sse_stream(SseStreamInput {
            client_payload,
            client_protocol: client_protocol.clone(),
            request_id: output.request_id.clone(),
            wants_stream: normalized_metadata
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
        .map_err(|message| HubPipelineError::new("hub_pipeline_resp_sse_stream_failed", message))?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespOutboundSseStream,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "shouldStream": stream_decision.should_stream,
                "payloadObject": stream_decision.payload.is_object(),
            })),
        ));
        if stream_decision.should_stream {
            effects.push(HubPipelineEffect {
                kind: HubPipelineEffectKind::StreamPipe,
                payload: serde_json::json!({
                    "codec": client_protocol,
                    "requestId": output.request_id,
                }),
            });
        }
        if let Some(runtime_state_write) =
            build_runtime_state_write_payload(&stream_decision.payload)
        {
            effects.push(HubPipelineEffect {
                kind: HubPipelineEffectKind::RuntimeStateWrite,
                payload: runtime_state_write,
            });
        }
        let effect_plan = HubPipelineEffectPlan { effects };
        diagnostics.push(diagnostic(
            HubPipelineStageId::EffectPlan,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "effects": effect_plan.effects.len() })),
        ));
        Ok(HubPipelineExecutionOutput {
            request_id: output.request_id,
            success: output.success,
            payload: Some(stream_decision.payload),
            metadata: Some(normalized_metadata),
            standardized_request: None,
            entry_origin_request: None,
            effect_plan,
            diagnostics,
            error: output.error.map(|error| HubPipelineError {
                code: error.code,
                message: error.message,
                details: error.details,
            }),
        })
    }
}

fn build_virtual_router_core(config: &Value) -> HubPipelineResult<VirtualRouterEngineCore> {
    let mut core = VirtualRouterEngineCore::new();
    core.initialize(config).map_err(|message| {
        HubPipelineError::new(
            "hub_pipeline_virtual_router_facade_init_failed",
            format!(
                "Rust HubPipeline virtual router facade init failed: {}",
                message
            ),
        )
    })?;
    Ok(core)
}

fn build_optional_virtual_router_core(
    config: &Value,
) -> HubPipelineResult<Option<VirtualRouterEngineCore>> {
    let should_initialize = config.as_object().is_some_and(|object| {
        object.contains_key("providers")
            || object.contains_key("routing")
            || object.contains_key("forwarders")
    });
    if !should_initialize {
        return Ok(None);
    }
    build_virtual_router_core(config).map(Some)
}

fn with_virtual_router_session_dir_value<T>(
    metadata_center_snapshot: &Value,
    callback: impl FnOnce() -> HubPipelineResult<T>,
) -> HubPipelineResult<T> {
    let session_dir = read_runtime_control_string(metadata_center_snapshot, "sessionDir")
        .or_else(|| read_runtime_control_string(metadata_center_snapshot, "session_dir"));
    match session_dir.as_deref() {
        Some(value) => with_session_dir_override(Some(value), callback),
        None => callback(),
    }
}

fn response_requires_submit_tool_outputs(payload: &Value) -> bool {
    payload
        .get("required_action")
        .and_then(|required_action| required_action.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "submit_tool_outputs")
}

fn build_runtime_state_write_payload(payload: &Value) -> Option<Value> {
    let mut runtime_state = serde_json::Map::new();
    if let Some(usage) = payload.get("usage").filter(|usage| usage.is_object()) {
        runtime_state.insert("usage".to_string(), usage.clone());
    }
    if response_requires_submit_tool_outputs(payload) {
        runtime_state.insert("keepForSubmitToolOutputs".to_string(), Value::Bool(true));
    }
    if runtime_state.is_empty() {
        None
    } else {
        Some(Value::Object(runtime_state))
    }
}

fn read_metadata_value(metadata: &Value, key: &str) -> Option<Value> {
    metadata.get(key).cloned().or_else(|| {
        metadata
            .get("target")
            .and_then(Value::as_object)?
            .get(key)
            .cloned()
    })
}

fn read_trimmed_metadata_string_with_target_fallback(
    metadata: &Value,
    key: &str,
) -> Option<String> {
    read_trimmed_string(read_metadata_value(metadata, key).as_ref())
}

fn resolve_context_snapshot(metadata: &Value) -> Option<&Value> {
    let metadata_obj = metadata.as_object()?;
    let key = metadata_obj
        .get("contextMetadataKey")
        .and_then(|value| read_trimmed_string(Some(value)))
        .unwrap_or_else(|| "responsesContext".to_string());
    metadata_obj
        .get(&key)
        .or_else(|| metadata_obj.get("responsesContext"))
        .or_else(|| metadata_obj.get("contextSnapshot"))
        .filter(|value| value.is_object())
}

fn capture_context_snapshot(
    provider_protocol: &str,
    normalized_payload: &Value,
    normalized_metadata: &Value,
    request_id: &str,
) -> HubPipelineResult<Option<Value>> {
    if provider_protocol != "openai-responses" {
        return Ok(None);
    }
    let tool_call_id_style = normalized_metadata
        .get("toolCallIdStyle")
        .or_else(|| {
            normalized_metadata
                .get("metadata")
                .and_then(|metadata| metadata.get("toolCallIdStyle"))
        })
        .cloned();
    let snapshot = capture_req_inbound_responses_context_snapshot(ResponsesContextCaptureInput {
        raw_request: normalized_payload.clone(),
        request_id: Some(request_id.to_string()),
        tool_call_id_style,
    })
    .map_err(|message| HubPipelineError::new("hub_pipeline_context_capture_failed", message))?;
    let mut snapshot = snapshot;
    let governed_instructions = normalized_payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(instructions) = governed_instructions {
        if let Some(snapshot_obj) = snapshot.as_object_mut() {
            snapshot_obj.insert("systemInstruction".to_string(), Value::String(instructions));
        }
    }
    Ok(Some(snapshot))
}

fn attach_context_snapshot_to_metadata(
    metadata: &mut Value,
    context_snapshot: Option<Value>,
) -> HubPipelineResult<()> {
    let Some(snapshot) = context_snapshot else {
        return Ok(());
    };
    let metadata_obj = metadata.as_object_mut().ok_or_else(|| {
        HubPipelineError::new(
            "hub_pipeline_invalid_route_metadata",
            "Rust HubPipeline context capture requires route metadata object",
        )
    })?;
    metadata_obj.insert(
        "contextMetadataKey".to_string(),
        Value::String("responsesContext".to_string()),
    );
    metadata_obj.insert("responsesContext".to_string(), snapshot.clone());
    metadata_obj.insert("contextSnapshot".to_string(), snapshot);
    Ok(())
}

fn apply_context_snapshot_to_format_envelope(
    format_envelope: &mut Value,
    metadata: &Value,
) -> HubPipelineResult<()> {
    let Some(snapshot) = resolve_context_snapshot(metadata) else {
        return Ok(());
    };
    let payload = format_envelope.get_mut("payload").ok_or_else(|| {
        HubPipelineError::new(
            "hub_pipeline_missing_format_payload",
            "Rust HubPipeline req outbound context merge requires format envelope payload",
        )
    })?;
    let patch = apply_req_outbound_context_snapshot_from_refs(payload, snapshot);
    let payload_obj = payload.as_object_mut().ok_or_else(|| {
        HubPipelineError::new(
            "hub_pipeline_invalid_format_payload",
            "Rust HubPipeline req outbound context merge requires object payload",
        )
    })?;
    let metadata_value = payload_obj
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !metadata_value.is_object() {
        *metadata_value = Value::Object(serde_json::Map::new());
    }
    if let Some(metadata_obj) = metadata_value.as_object_mut() {
        metadata_obj.insert(
            "contextMetadataKey".to_string(),
            Value::String("responsesContext".to_string()),
        );
        metadata_obj.insert("responsesContext".to_string(), snapshot.clone());
        metadata_obj.insert("contextSnapshot".to_string(), snapshot.clone());
        metadata_obj.insert("context".to_string(), snapshot.clone());
    }
    let payload_has_responses_input = payload_obj.get("input").is_some();
    if !payload_has_responses_input {
        if let Some(tool_outputs) = patch.tool_outputs {
            payload_obj.insert(
                "toolOutputs".to_string(),
                serde_json::to_value(tool_outputs)?,
            );
        }
    }
    let has_existing_tools = payload_obj
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if !has_existing_tools {
        if let Some(tools) = patch.tools {
            if !tools.is_empty() {
                payload_obj.insert("tools".to_string(), Value::Array(tools));
            }
        }
    }
    Ok(())
}

fn move_provider_response_metadata_to_carrier(payload: Value, metadata: &mut Value) -> Value {
    let mut object = match payload {
        Value::Object(object) => object,
        other => return other,
    };
    let Some(provider_metadata) = object.remove("metadata") else {
        return Value::Object(object);
    };
    if !provider_metadata.is_null() {
        if !metadata.is_object() {
            *metadata = serde_json::json!({});
        }
        if let Some(metadata_object) = metadata.as_object_mut() {
            metadata_object.insert("providerResponseMetadata".to_string(), provider_metadata);
        }
    }
    Value::Object(object)
}

fn build_adapter_context(
    metadata: &Value,
    provider_protocol: &str,
    request_id: &str,
) -> AdapterContext {
    let session_id = read_trimmed_string(metadata.get("sessionId"));
    let conversation_id = read_trimmed_string(metadata.get("conversationId"));
    AdapterContext {
        compatibility_profile: read_trimmed_metadata_string_with_target_fallback(
            metadata,
            "compatibilityProfile",
        ),
        provider_protocol: Some(provider_protocol.to_string()),
        request_id: Some(request_id.to_string()),
        entry_endpoint: metadata
            .get("entryEndpoint")
            .and_then(Value::as_str)
            .map(str::to_string),
        route_id: metadata
            .get("routeId")
            .and_then(Value::as_str)
            .map(str::to_string),
        rt: metadata.get("__rt").cloned(),
        anthropic_thinking: read_trimmed_metadata_string_with_target_fallback(
            metadata,
            "anthropicThinking",
        ),
        model_id: metadata
            .get("assignedModelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        client_model_id: metadata
            .get("clientModelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        original_model_id: metadata
            .get("originalModelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_key: metadata
            .get("providerKey")
            .and_then(Value::as_str)
            .map(str::to_string),
        runtime_key: metadata
            .get("runtimeKey")
            .and_then(Value::as_str)
            .map(str::to_string),
        client_request_id: metadata
            .get("clientRequestId")
            .and_then(Value::as_str)
            .map(str::to_string),
        group_request_id: metadata
            .get("groupRequestId")
            .and_then(Value::as_str)
            .map(str::to_string),
        session_id,
        conversation_id,
        captured_chat_request: None,
        deepseek: None,
        estimated_input_tokens: None,
        provider_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::read_preselected_route;
    use serde_json::json;

    #[test]
    fn read_preselected_route_prefers_snapshot_route_pin() {
        let snapshot = json!({
            "runtimeControl": {
                "preselectedRoute": {
                    "target": {
                        "providerKey": "snapshot.provider.gpt-5.5"
                    },
                    "decision": {
                        "routeName": "snapshot-thinking"
                    },
                    "diagnostics": {
                        "source": "metadataCenterSnapshot"
                    }
                }
            }
        });
        let metadata = json!({
            "runtime_control": {
                "preselectedRoute": {
                    "target": {
                        "providerKey": "runtime.provider.gpt-5.5"
                    },
                    "decision": {
                        "routeName": "thinking"
                    },
                    "diagnostics": {
                        "source": "runtime_control"
                    }
                }
            }
        });

        let route = read_preselected_route(&snapshot, &metadata).expect("snapshot route pin");
        assert_eq!(
            route
                .pointer("/target/providerKey")
                .and_then(|value| value.as_str()),
            Some("snapshot.provider.gpt-5.5")
        );
        assert_eq!(
            route
                .pointer("/diagnostics/source")
                .and_then(|value| value.as_str()),
            Some("metadataCenterSnapshot")
        );
    }

    #[test]
    fn read_preselected_route_uses_runtime_control_route_pin() {
        let metadata = json!({
            "runtime_control": {
                "preselectedRoute": {
                    "target": {
                        "providerKey": "runtime.provider.gpt-5.5"
                    },
                    "decision": {
                        "routeName": "thinking"
                    },
                    "diagnostics": {
                        "source": "runtime_control"
                    }
                }
            },
            "__rt": {
                "preselectedRoute": {
                    "target": {
                        "providerKey": "legacy.provider.gpt-5.5"
                    },
                    "decision": {
                        "routeName": "legacy"
                    },
                    "diagnostics": {
                        "source": "__rt"
                    }
                }
            }
        });

        let route =
            read_preselected_route(&json!(null), &metadata).expect("runtime control route pin");
        assert_eq!(
            route
                .pointer("/target/providerKey")
                .and_then(|value| value.as_str()),
            Some("runtime.provider.gpt-5.5")
        );
        assert_eq!(
            route
                .pointer("/diagnostics/source")
                .and_then(|value| value.as_str()),
            Some("runtime_control")
        );
    }

    #[test]
    fn read_preselected_route_ignores_legacy_rt_route_pin_without_runtime_control() {
        let metadata = json!({
            "__rt": {
                "preselectedRoute": {
                    "target": {
                        "providerKey": "legacy.provider.gpt-5.5"
                    },
                    "decision": {
                        "routeName": "legacy"
                    }
                }
            }
        });

        assert!(read_preselected_route(&json!(null), &metadata).is_none());
    }
}

fn read_preselected_route(metadata_center_snapshot: &Value, metadata: &Value) -> Option<Value> {
    let route = metadata_center_snapshot
        .get("runtimeControl")
        .and_then(|runtime| runtime.get("preselectedRoute"))
        .or_else(|| {
            metadata
                .get("runtime_control")
                .and_then(|runtime| runtime.get("preselectedRoute"))
        })?;
    let target = route.get("target")?;
    let decision = route.get("decision")?;
    if !target.is_object() || !decision.is_object() {
        return None;
    }
    Some(serde_json::json!({
        "target": target,
        "decision": decision,
        "diagnostics": route.get("diagnostics").cloned().unwrap_or_else(|| serde_json::json!({}))
    }))
}

fn read_runtime_control_string(metadata_center_snapshot: &Value, key: &str) -> Option<String> {
    metadata_center_snapshot
        .get("runtimeControl")
        .and_then(|runtime| runtime.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_outbound_provider_protocol(metadata: &Value) -> Option<String> {
    let target = metadata.get("target")?.as_object()?;
    target
        .get("outboundProfile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteHubPipelineInput {
    #[serde(default)]
    config: HubPipelineConfig,
    request: HubPipelineRequest,
}

pub fn execute_hub_pipeline_json(input_json: String) -> HubPipelineResult<String> {
    if input_json.trim().is_empty() {
        return Err(HubPipelineError::new(
            "hub_pipeline_empty_input",
            "Input JSON is empty",
        ));
    }
    let input: ExecuteHubPipelineInput = serde_json::from_str(&input_json)?;
    let request_id = input.request.request_id.clone();
    let mut engine = HubPipelineEngine::new(input.config)?;
    let output = match engine.execute(input.request) {
        Ok(output) => output,
        Err(error) => HubPipelineExecutionOutput {
            request_id: request_id.clone(),
            success: false,
            payload: None,
            metadata: None,
            standardized_request: None,
            entry_origin_request: None,
            effect_plan: HubPipelineEffectPlan::empty(),
            diagnostics: Vec::new(),
            error: Some(error),
        },
    };
    serde_json::to_string(&output).map_err(HubPipelineError::from)
}

pub fn run_hub_pipeline_lib_json(input_json: String) -> HubPipelineResult<String> {
    execute_hub_pipeline_json(input_json)
}

fn format_envelope_into_value(envelope: FormatEnvelope) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("format".to_string(), Value::String(envelope.format));
    object.insert("version".to_string(), Value::String(envelope.version));
    object.insert("payload".to_string(), envelope.payload);
    if let Some(metadata) = envelope.metadata {
        object.insert("metadata".to_string(), metadata);
    }
    Value::Object(object)
}

fn split_normal_payload_and_inline_metadata(payload: Value) -> (Value, Option<Value>) {
    let Value::Object(mut object) = payload else {
        return (payload, None);
    };
    let inline_metadata = object.remove("metadata");
    (Value::Object(object), inline_metadata)
}

fn merge_standardizer_metadata(
    normalized_metadata: &Value,
    inline_payload_metadata: Option<&Value>,
) -> Value {
    let mut merged = normalized_metadata.as_object().cloned().unwrap_or_default();
    if let Some(inline) = inline_payload_metadata.and_then(Value::as_object) {
        for (key, value) in inline {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn project_normal_request_payload(request: &Value) -> Value {
    let Some(request_map) = request.as_object() else {
        return Value::Null;
    };
    let mut payload = serde_json::Map::new();
    for key in [
        "model",
        "messages",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "stream",
        "parameters",
        "previous_response_id",
    ] {
        if let Some(value) = request_map.get(key).cloned() {
            payload.insert(key.to_string(), value);
        }
    }
    Value::Object(payload)
}

fn diagnostic(
    stage_id: HubPipelineStageId,
    status: HubPipelineDiagnosticStatus,
    details: Option<Value>,
) -> HubPipelineDiagnostic {
    HubPipelineDiagnostic {
        stage_id: format!("{:?}", stage_id),
        status,
        details,
    }
}
