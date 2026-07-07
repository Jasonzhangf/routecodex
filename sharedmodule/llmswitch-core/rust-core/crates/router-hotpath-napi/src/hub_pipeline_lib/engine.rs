// feature_id: hub.route_selection_bridge
use napi::Env;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
use crate::hub_pipeline_blocks::protocol::resolve_hub_client_protocol;
use crate::hub_pipeline_blocks::standardized_request::coerce_standardized_request_from_payload;
use crate::hub_pipeline_types::{
    run_hub_req_chatprocess_03_governed_entrypoint, run_hub_req_inbound_02_standardized_entrypoint,
    run_hub_req_outbound_05_provider_semantic_entrypoint,
    run_hub_resp_chatprocess_03_governed_entrypoint, run_hub_resp_inbound_02_parsed_entrypoint,
    run_hub_resp_outbound_04_client_semantic_entrypoint,
    run_vr_route_04_selected_target_entrypoint,
};
use crate::hub_req_chatprocess_03_governance_boundary::apply_hub_req_chatprocess_03_tool_governance;
use crate::hub_req_inbound_context_capture::{
    capture_req_inbound_responses_context_snapshot, ResponsesContextCaptureInput,
};
use crate::hub_req_inbound_format_parse::{parse_format_envelope, FormatParseInput};
use crate::hub_req_inbound_semantic_lift::{
    apply_req_inbound_semantic_lift, ReqInboundSemanticLiftApplyInput,
};
use crate::hub_req_outbound_context_merge::{
    apply_req_outbound_context_snapshot, ReqOutboundContextSnapshotApplyInput,
};
use crate::hub_req_outbound_format_build::{build_format_request, FormatBuildInput};
use crate::hub_resp_chatprocess_03_governance_boundary::govern_hub_resp_chatprocess_03_response;
use crate::hub_resp_inbound_format_parse::{parse_resp_format_envelope, RespFormatParseInput};
use crate::hub_resp_outbound_04_client_payload_boundary::build_hub_resp_outbound_04_client_payload_for_protocol;
use crate::hub_resp_outbound_04_finalize_boundary::finalize_hub_resp_outbound_04_client_semantic;
use crate::hub_resp_outbound_sse_stream::{process_sse_stream, SseStreamInput};
use crate::metadata_center::{
    build_metadata_center_from_snapshot, build_stopless_metadata_center_reset_write_plan,
};
use crate::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use crate::req_process_stage1_tool_governance::ToolGovernanceInput;
use crate::req_process_stage2_route_select::RouteSelectionApplyInput;
use crate::resp_process_stage1_tool_governance::ToolGovernanceInput as RespToolGovernanceInput;
use crate::resp_process_stage2_finalize::FinalizeInput;
use crate::servertool_core_blocks::inspect_stop_gateway_signal;
use crate::stopless_auto_handler_bridge::{
    build_stopless_auto_cli_projection_from_engine_json, run_stopless_auto_handler_runtime_json,
};
use crate::virtual_router_engine::routing_state_store::with_session_dir_override;
use crate::virtual_router_engine::VirtualRouterEngineCore;
use crate::vr_route_04_selection_boundary::apply_vr_route_04_selection;

use super::diagnostics::{HubPipelineDiagnostic, HubPipelineDiagnosticStatus};
use super::effect_plan::{HubPipelineEffect, HubPipelineEffectKind, HubPipelineEffectPlan};
use super::errors::{HubPipelineError, HubPipelineResult};
use super::stage_catalog::HubPipelineStageId;
use super::types::{HubPipelineConfig, HubPipelineExecutionOutput, HubPipelineRequest};

fn read_entry_provider_protocol(
    normalized_metadata: &Value,
    metadata_center_snapshot: &Value,
) -> Option<String> {
    metadata_center_snapshot
        .get("runtimeControl")
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("providerProtocol"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            normalized_metadata
                .get("providerProtocol")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn resolve_request_entry_protocol(entry_endpoint: &str, metadata: &Value) -> String {
    metadata
        .get("clientProtocol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| resolve_hub_client_protocol(entry_endpoint))
}

#[derive(Debug, Clone, Default)]
pub struct HubPipelineEngine {
    config: HubPipelineConfig,
}

impl HubPipelineEngine {
    pub fn new(config: HubPipelineConfig) -> HubPipelineResult<Self> {
        Ok(Self { config })
    }

    pub fn update_virtual_router_config(&mut self, config: Value) -> HubPipelineResult<()> {
        if !config.is_object() {
            return Err(HubPipelineError::new(
                "hub_pipeline_invalid_virtual_router_config",
                "Virtual router config must be a JSON object",
            ));
        }
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

    fn select_route(
        &self,
        request: &Value,
        metadata: &Value,
        metadata_center_snapshot: &Value,
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
                    metadata,
                    metadata_center_snapshot,
                );
            }
            return Ok(route);
        }
        self.select_virtual_router_route(request, metadata, metadata_center_snapshot)
    }

    fn select_virtual_router_route(
        &self,
        request: &Value,
        metadata: &Value,
        metadata_center_snapshot: &Value,
    ) -> HubPipelineResult<Value> {
        let mut retry_metadata_center_snapshot = metadata_center_snapshot.clone();
        let mut metadata_for_router = serde_json::json!({
            "metadataCenterSnapshot": retry_metadata_center_snapshot,
        });
        if let Some(excluded_provider_keys) = metadata
            .get("excludedProviderKeys")
            .and_then(|value| value.as_array())
            .cloned()
        {
            if let Some(snapshot) = retry_metadata_center_snapshot.as_object_mut() {
                snapshot.insert(
                    "excludedProviderKeys".to_string(),
                    Value::Array(excluded_provider_keys.clone()),
                );
            }
            if let Some(row) = metadata_for_router.as_object_mut() {
                row.insert(
                    "metadataCenterSnapshot".to_string(),
                    retry_metadata_center_snapshot,
                );
                row.insert(
                    "excludedProviderKeys".to_string(),
                    Value::Array(excluded_provider_keys),
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
        let request_id = if request.request_id.trim().is_empty() {
            "hub_pipeline_rust_lib_request".to_string()
        } else {
            request.request_id.clone()
        };
        let entry_endpoint = request.entry_endpoint.clone();
        let direction = request.direction.clone();
        let metadata_center_snapshot = request.metadata_center_snapshot.clone();
        let initial_provider_protocol = if direction == "response" {
            if request.provider_protocol.trim().is_empty() {
                read_entry_provider_protocol(&request.metadata, &metadata_center_snapshot).ok_or_else(|| {
                    HubPipelineError::new(
                        "hub_pipeline_missing_provider_protocol",
                        "Rust HubPipeline requires providerProtocol in metadataCenterSnapshot.runtimeControl, request.providerProtocol, or metadata.providerProtocol",
                    )
                })?
            } else {
                request.provider_protocol.clone()
            }
        } else if request.provider_protocol.trim().is_empty() {
            resolve_request_entry_protocol(&entry_endpoint, &request.metadata)
        } else {
            request.provider_protocol.clone()
        };
        let mut diagnostics = vec![diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Started,
            None,
        )];
        let input = HubPipelineInput {
            request_id: request_id.clone(),
            endpoint: request.endpoint,
            entry_endpoint: request.entry_endpoint,
            provider_protocol: initial_provider_protocol,
            payload: request.payload,
            metadata: request.metadata,
            metadata_center_snapshot: metadata_center_snapshot.clone(),
            stream: request.stream,
            process_mode: request.process_mode,
            direction: request.direction,
            stage: request.stage,
        };
        let output = run_hub_pipeline(input).map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Completed,
            None,
        ));
        let normalized_payload = output.payload.clone().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_normalized_payload",
                "Rust HubPipeline normalize stage returned no payload",
            )
        })?;
        let normalized_metadata = output.metadata.clone().unwrap_or(Value::Null);
        if direction == "response" {
            let entry_provider_protocol = read_entry_provider_protocol(
                &normalized_metadata,
                &metadata_center_snapshot,
            )
                .ok_or_else(|| {
                    HubPipelineError::new(
                        "hub_pipeline_missing_provider_protocol",
                        "Rust HubPipeline requires providerProtocol in metadataCenterSnapshot.runtimeControl or metadata.providerProtocol",
                    )
                })?;
            return self.execute_response_path(
                output,
                normalized_payload,
                normalized_metadata,
                entry_provider_protocol,
                metadata_center_snapshot,
                diagnostics,
            );
        }
        let entry_provider_protocol =
            resolve_request_entry_protocol(&entry_endpoint, &normalized_metadata);
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundFormatParse,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let parsed = parse_format_envelope(FormatParseInput {
            raw_request: normalized_payload.clone(),
            protocol: entry_provider_protocol.clone(),
        })
        .map_err(HubPipelineError::from)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundFormatParse,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "format": parsed.envelope.format })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundSemanticLift,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let lifted_envelope = apply_req_inbound_semantic_lift(ReqInboundSemanticLiftApplyInput {
            chat_envelope: serde_json::to_value(&parsed.envelope)?,
            payload: Some(normalized_payload.clone()),
            protocol: Some(entry_provider_protocol.clone()),
            entry_endpoint: normalized_metadata
                .get("entryEndpoint")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundSemanticLift,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "envelopeObject": lifted_envelope.is_object() })),
        ));
        let (normal_request_payload, inline_payload_metadata) =
            split_normal_payload_and_inline_metadata(normalized_payload.clone());
        let entry_origin_request = normal_request_payload.clone();
        let standardizer_metadata =
            merge_standardizer_metadata(normalized_metadata.clone(), inline_payload_metadata);
        let standardized = coerce_standardized_request_from_payload(&serde_json::json!({
            "payload": normal_request_payload,
            "normalized": {
                "id": output.request_id,
                "entryEndpoint": entry_endpoint,
                "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false),
                "processMode": normalized_metadata.get("processMode").and_then(Value::as_str).unwrap_or("chat"),
                "routeHint": normalized_metadata.get("routeHint").cloned().unwrap_or(Value::Null),
                "metadata": standardizer_metadata
            }
        }))
        .map_err(HubPipelineError::from)?;
        let standardized_payload = standardized
            .get("standardizedRequest")
            .cloned()
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_standardized_request",
                    "Rust HubPipeline req inbound returned no standardized request",
                )
            })?;
        let standardized_raw_payload =
            standardized.get("rawPayload").cloned().ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_standardized_raw_payload",
                    "Rust HubPipeline req inbound returned no standardized raw payload",
                )
            })?;
        let req_inbound_02 =
            run_hub_req_inbound_02_standardized_entrypoint(standardized_raw_payload.clone())
                .map_err(|message| {
                    HubPipelineError::new("hub_pipeline_req_inbound_02_failed", message)
                })?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundContextCapture,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": entry_provider_protocol })),
        ));
        let inbound_context_snapshot = capture_context_snapshot(
            &entry_provider_protocol,
            &normalized_payload,
            &normalized_metadata,
            &request_id,
        )?;
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
            raw_payload: standardized_raw_payload,
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
        let route_output = self.select_route(
            &governed.processed_request,
            &governed_metadata,
            &metadata_center_snapshot,
        )?;
        let target = route_output.get("target").cloned().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_route_target",
                "Rust HubPipeline req route stage returned no target",
            )
        })?;
        let route_name = route_output
            .get("decision")
            .and_then(|decision| decision.get("routeName"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let route_decision = route_output.get("decision").cloned().ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_route_decision",
                "Rust HubPipeline req route stage returned no decision",
            )
        })?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "targetObject": target.is_object() })),
        ));
        let vr_route_04 = run_vr_route_04_selected_target_entrypoint(
            req_chatprocess_03.clone(),
            route_decision.clone(),
        )
        .map_err(|message| {
            HubPipelineError::new("hub_pipeline_vr_route_04_selected_target_failed", message)
        })?;
        let governed_processed_request = governed.processed_request.clone();
        let mut routed = apply_vr_route_04_selection(RouteSelectionApplyInput {
            request: governed.processed_request,
            normalized_metadata: governed_metadata,
            target,
            route_name,
            original_model: lifted_envelope
                .get("payload")
                .and_then(|payload| payload.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string),
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
            &governed_processed_request,
            &routed.normalized_metadata,
            &request_id,
        )?;
        attach_context_snapshot_to_metadata(
            &mut routed.normalized_metadata,
            outbound_context_snapshot.or(inbound_context_snapshot),
        )?;
        let routing_decision = vr_route_04.clone().into_decision();
        if let Some(metadata) = routed.normalized_metadata.as_object_mut() {
            metadata.insert("routingDecision".to_string(), routing_decision);
            if let Some(diagnostics_value) = route_output.get("diagnostics").cloned() {
                metadata.insert("routingDiagnostics".to_string(), diagnostics_value);
            }
        }
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
        let mut format_envelope = serde_json::to_value(&parsed.envelope)?;
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
        let resp_inbound_02 = run_hub_resp_inbound_02_parsed_entrypoint(canonical_payload.clone())
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
        let stopless_resp_hook = run_servertool_resp_stopless_hook_skeleton(
            &canonical_payload,
            &normalized_metadata,
            &metadata_center_snapshot,
            output.request_id.as_str(),
        )?;
        let stopless_hook_suppresses_runtime_actions = stopless_resp_hook.is_some();
        let governed_payload = if let Some(stopless_hook) = stopless_resp_hook {
            if let Some(write_plan) = stopless_hook.metadata_write_plan {
                effects.push(HubPipelineEffect {
                    kind: HubPipelineEffectKind::StoplessMetadataCenterWrite,
                    payload: write_plan,
                });
            }
            if let Some(alarm) = stopless_hook.alarm {
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
                    "servertool": "stopless_response_hook_skeleton",
                    "flowId": stopless_hook.flow_id,
                })),
            ));
            if let Some(payload) = stopless_hook.payload {
                payload
            } else {
                let governed = govern_hub_resp_chatprocess_03_response(RespToolGovernanceInput {
                    payload: canonical_payload,
                    client_protocol,
                    entry_endpoint,
                    request_id: output.request_id.clone(),
                })
                .map_err(|message| {
                    HubPipelineError::new("hub_pipeline_resp_tool_governance_failed", message)
                })?;
                governed.governed_payload
            }
        } else {
            let governed = govern_hub_resp_chatprocess_03_response(RespToolGovernanceInput {
                payload: canonical_payload,
                client_protocol,
                entry_endpoint,
                request_id: output.request_id.clone(),
            })
            .map_err(|message| {
                HubPipelineError::new("hub_pipeline_resp_tool_governance_failed", message)
            })?;
            diagnostics.push(diagnostic(
                HubPipelineStageId::RespProcessToolGovernance,
                HubPipelineDiagnosticStatus::Completed,
                Some(serde_json::json!({
                    "summary": governed.summary,
                })),
            ));
            governed.governed_payload
        };
        let resp_chatprocess_03 =
            run_hub_resp_chatprocess_03_governed_entrypoint(resp_inbound_02, governed_payload)
                .map_err(|message| {
                    HubPipelineError::new("hub_pipeline_resp_chatprocess_03_failed", message)
                })?;
        let resp_chatprocess_payload = resp_chatprocess_03.payload().clone();
        if !stopless_hook_suppresses_runtime_actions
            && !effects.iter().any(|effect| {
                serde_json::to_value(&effect.kind).ok()
                    == Some(serde_json::json!("stoplessMetadataCenterWrite"))
            })
        {
            plan_resp_chatprocess_03_servertool_runtime_actions(
                &mut effects,
                &normalized_metadata,
                &resp_chatprocess_payload,
                output.request_id.as_str(),
            );
        }
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespProcessFinalize,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false) })),
        ));
        let finalized_payload = finalize_hub_resp_outbound_04_client_semantic(FinalizeInput {
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
        let client_payload = build_hub_resp_outbound_04_client_payload_for_protocol(
            finalized_payload,
            &normalized_metadata,
            output.request_id.as_str(),
        )?;
        let resp_outbound_04 = run_hub_resp_outbound_04_client_semantic_entrypoint(
            resp_chatprocess_03,
            project_normal_response_payload(&client_payload),
        )
        .map_err(|message| {
            HubPipelineError::new("hub_pipeline_resp_outbound_04_failed", message)
        })?;
        drop(resp_outbound_04);
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
                    "payload": stream_decision.payload.clone(),
                    "body": stream_decision.payload.clone(),
                }),
            });
        }
        effects.push(HubPipelineEffect {
            kind: HubPipelineEffectKind::RuntimeStateWrite,
            payload: serde_json::json!({
                "requestId": output.request_id,
                "clientProtocol": client_protocol,
                "payload": stream_decision.payload.clone(),
                "usage": stream_decision.payload.get("usage").cloned().unwrap_or(Value::Null),
                "keepForSubmitToolOutputs": response_requires_submit_tool_outputs(&stream_decision.payload),
                "responseRecord": build_response_record_effect_payload(
                    &normalized_metadata,
                    &stream_decision.payload,
                    output.request_id.as_str(),
                ),
            }),
        });
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

fn response_requires_submit_tool_outputs(payload: &Value) -> bool {
    payload
        .get("required_action")
        .and_then(|required_action| required_action.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "submit_tool_outputs")
}

struct ServertoolRespStoplessHookOutput {
    payload: Option<Value>,
    flow_id: Option<String>,
    metadata_write_plan: Option<Value>,
    alarm: Option<Value>,
}

fn run_servertool_resp_stopless_hook_skeleton(
    chatprocess_payload: &Value,
    metadata: &Value,
    metadata_center_snapshot: &Value,
    request_id: &str,
) -> HubPipelineResult<Option<ServertoolRespStoplessHookOutput>> {
    let runtime_active = is_stopless_runtime_active(metadata, metadata_center_snapshot);
    let response_runtime_enabled = is_stop_message_response_runtime_enabled(metadata);
    let stop_gateway = inspect_stop_gateway_signal(&chatprocess_payload.to_string())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let stop_gateway_eligible = stop_gateway
        .get("eligible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stop_gateway_reason = stop_gateway
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let gateway_internal_stop_tool = stop_gateway_eligible
        && matches!(
            stop_gateway_reason,
            "finish_reason_tool_calls_internal_stop_tool"
                | "responses_required_action_internal_stop_tool"
        );
    let gateway_requires_stopless = stop_gateway_eligible
        && matches!(
            stop_gateway_reason,
            "finish_reason_stop"
                | "finish_reason_tool_calls_internal_stop_tool"
                | "responses_required_action_internal_stop_tool"
                | "status_completed"
                | "responses_output_completed"
        );
    if !runtime_active && !response_runtime_enabled && !gateway_internal_stop_tool {
        return Ok(None);
    }
    let center = build_metadata_center_from_snapshot(metadata_center_snapshot);
    let request_session_id = center
        .request_truth
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if request_session_id.is_none() {
        if !runtime_active && !gateway_requires_stopless {
            return Ok(None);
        }
        return Ok(Some(ServertoolRespStoplessHookOutput {
            payload: None,
            flow_id: Some("stop_message_flow".to_string()),
            metadata_write_plan: None,
            alarm: Some(serde_json::json!({
                "alarm": "stopless_missing_session_id",
                "requestId": request_id,
                "reason": "stopless requires requestTruth.sessionId before interception",
            })),
        }));
    }
    if !gateway_requires_stopless {
        if !runtime_active {
            return Ok(None);
        }
        let reset_plan = build_stopless_metadata_center_reset_write_plan(
            &center,
            request_id,
            current_timestamp_ms(),
            "non_stop_response",
            true,
        );
        return Ok(Some(ServertoolRespStoplessHookOutput {
            payload: None,
            flow_id: Some("stop_message_flow".to_string()),
            metadata_write_plan: Some(serde_json::to_value(reset_plan).map_err(|error| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_reset_plan_invalid",
                    format!("Rust stopless reset write plan failed to serialize: {error}"),
                )
            })?),
            alarm: None,
        }));
    }
    let runtime_input = serde_json::json!({
        "base": chatprocess_payload,
        "requestId": request_id,
        "runtimeMetadata": {
            "metadataCenterSnapshot": sanitize_stopless_metadata_center_snapshot(metadata_center_snapshot, request_session_id)
        }
    });
    let raw_runtime =
        run_stopless_auto_handler_runtime_json(runtime_input.to_string()).map_err(|error| {
            HubPipelineError::new("hub_pipeline_stopless_resp_hook_failed", error.reason)
        })?;
    let runtime_output: Value = serde_json::from_str(&raw_runtime).map_err(|error| {
        HubPipelineError::new(
            "hub_pipeline_stopless_resp_hook_invalid_output",
            format!("Rust stopless response hook runtime returned invalid JSON: {error}"),
        )
    })?;
    let action = runtime_output
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let flow_id = runtime_output
        .get("flowId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let metadata_write_plan = runtime_output.get("metadataWritePlan").cloned();
    match action {
        "return_null" => Ok(None),
        "throw_error" => {
            let message = runtime_output
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Rust stopless inline runtime requested an error");
            Err(HubPipelineError::new(
                "hub_pipeline_stopless_resp_hook_runtime_error",
                message.to_string(),
            ))
        }
        "return_handler_result" => {
            let handler_result = runtime_output.get("handlerResult").ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_resp_hook_missing_handler_result",
                    "Rust stopless response hook runtime missing handlerResult",
                )
            })?;
            let execution = handler_result.get("execution").cloned().ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_stopless_resp_hook_missing_execution",
                    "Rust stopless response hook runtime missing handler execution",
                )
            })?;
            let terminal_final = execution
                .get("context")
                .and_then(|context| context.get("stopMessageTerminalFinal"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let payload = if terminal_final {
                handler_result
                    .get("chatResponse")
                    .cloned()
                    .or_else(|| runtime_output.get("chatResponse").cloned())
                    .unwrap_or_else(|| chatprocess_payload.clone())
            } else {
                let projection_input = serde_json::json!({
                    "metadataCenterSnapshot": metadata_center_snapshot,
                    "execution": execution,
                    "metadataWritePlan": metadata_write_plan,
                    "requestId": request_id
                });
                let raw_projection = build_stopless_auto_cli_projection_from_engine_json(
                    projection_input.to_string(),
                )
                .map_err(|error| {
                    HubPipelineError::new(
                        "hub_pipeline_stopless_resp_hook_projection_failed",
                        error.reason,
                    )
                })?;
                let projection_output: Value =
                    serde_json::from_str(&raw_projection).map_err(|error| {
                        HubPipelineError::new(
                            "hub_pipeline_stopless_resp_hook_projection_invalid_output",
                            format!(
                                "Rust stopless response hook projection returned invalid JSON: {error}"
                            ),
                        )
                    })?;
                projection_output
                    .get("chatResponse")
                    .cloned()
                    .ok_or_else(|| {
                        HubPipelineError::new(
                            "hub_pipeline_stopless_resp_hook_projection_missing_chat_response",
                            "Rust stopless response hook projection missing chatResponse",
                        )
                    })?
            };
            Ok(Some(ServertoolRespStoplessHookOutput {
                payload: Some(payload),
                flow_id,
                metadata_write_plan,
                alarm: None,
            }))
        }
        _ => Err(HubPipelineError::new(
            "hub_pipeline_stopless_resp_hook_unknown_action",
            format!("Rust stopless response hook runtime returned unsupported action: {action}"),
        )),
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_stopless_session_id(stopless: &Value) -> Option<&str> {
    stopless
        .get("sessionId")
        .or_else(|| stopless.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn sanitize_stopless_metadata_center_snapshot(
    metadata_center_snapshot: &Value,
    request_session_id: Option<&str>,
) -> Value {
    let mut snapshot = metadata_center_snapshot.clone();
    let Some(request_session_id) = request_session_id else {
        return snapshot;
    };
    let Some(runtime_control) = snapshot
        .get_mut("runtimeControl")
        .and_then(Value::as_object_mut)
    else {
        return snapshot;
    };
    let should_reset = runtime_control
        .get("stopless")
        .is_some_and(|stopless| read_stopless_session_id(stopless) != Some(request_session_id));
    if should_reset {
        let max_repeats = runtime_control
            .get("stopless")
            .and_then(|stopless| {
                stopless
                    .get("maxRepeats")
                    .or_else(|| stopless.get("max_repeats"))
            })
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(3);
        runtime_control.insert(
            "stopless".to_string(),
            serde_json::json!({
                "flowId": "stop_message_flow",
                "sessionId": request_session_id,
                "repeatCount": 0,
                "maxRepeats": max_repeats,
                "active": true,
                "triggerHint": "session_changed"
            }),
        );
    }
    snapshot
}

fn is_stopless_runtime_active(metadata: &Value, metadata_center_snapshot: &Value) -> bool {
    has_active_stopless_runtime_control(metadata_center_snapshot)
        || metadata_center_snapshot
            .get("requestTruth")
            .is_some_and(has_active_stopless_runtime_control)
        || has_active_stopless_runtime_control(metadata)
        || metadata
            .get("requestTruth")
            .is_some_and(has_active_stopless_runtime_control)
}

fn has_active_stopless_runtime_control(value: &Value) -> bool {
    value
        .get("runtimeControl")
        .and_then(|runtime| runtime.get("stopless"))
        .and_then(|stopless| stopless.get("active"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn plan_resp_chatprocess_03_servertool_runtime_actions(
    effects: &mut Vec<HubPipelineEffect>,
    metadata: &Value,
    chatprocess_payload: &Value,
    request_id: &str,
) {
    if !is_stop_message_response_runtime_enabled(metadata) {
        return;
    }
    let stop_gateway = inspect_stop_gateway_signal(&chatprocess_payload.to_string())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let stop_gateway_eligible = stop_gateway
        .get("eligible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if stop_gateway_eligible {
        effects.push(HubPipelineEffect {
            kind: HubPipelineEffectKind::ServertoolRuntimeAction,
            payload: serde_json::json!({
                "action": "requireResponseHookRuntime",
                "reason": "stop_eligible_followup",
                "requestId": request_id,
                "stopGateway": stop_gateway,
                "payload": chatprocess_payload.clone(),
            }),
        });
    }
}

fn is_stop_message_response_runtime_enabled(metadata: &Value) -> bool {
    metadata
        .get("stopMessageEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || metadata
            .get("routecodexPortStopMessageEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || metadata
            .get("__rt")
            .and_then(|rt| rt.get("stopMessageEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || metadata
            .get("__rt")
            .and_then(|rt| rt.get("routecodexPortStopMessageEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || metadata
            .get("runtimeControl")
            .and_then(|runtime| runtime.get("stopless"))
            .and_then(|stopless| stopless.get("active"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn read_trimmed_metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
    read_metadata_value(metadata, key)
        .and_then(|value| value.as_str().map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_response_record_effect_payload(
    metadata: &Value,
    payload: &Value,
    request_id: &str,
) -> Value {
    if metadata.get("clientProtocol").and_then(Value::as_str) != Some("openai-responses") {
        return Value::Null;
    }
    serde_json::json!({
        "requestId": request_id,
        "response": payload,
        "sessionId": read_trimmed_metadata_string(metadata, "sessionId"),
        "conversationId": read_trimmed_metadata_string(metadata, "conversationId"),
        "providerKey": read_trimmed_metadata_string(metadata, "providerKey")
            .or_else(|| read_trimmed_metadata_string(metadata, "targetProviderKey")),
        "matchedPort": metadata.get("matchedPort").and_then(Value::as_i64),
        "routingPolicyGroup": read_trimmed_metadata_string(metadata, "routingPolicyGroup"),
    })
}

fn resolve_context_snapshot(metadata: &Value) -> Option<Value> {
    let metadata_obj = metadata.as_object()?;
    let key = metadata_obj
        .get("contextMetadataKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("responsesContext");
    metadata_obj
        .get(key)
        .or_else(|| metadata_obj.get("responsesContext"))
        .or_else(|| metadata_obj.get("contextSnapshot"))
        .filter(|value| value.is_object())
        .cloned()
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
    let patch = apply_req_outbound_context_snapshot(&ReqOutboundContextSnapshotApplyInput {
        chat_envelope: Some(payload.clone()),
        snapshot: Some(snapshot.clone()),
    });
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
    let session_id = metadata
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let conversation_id = metadata
        .get("conversationId")
        .and_then(Value::as_str)
        .map(str::to_string);
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

fn split_normal_payload_and_inline_metadata(payload: Value) -> (Value, Value) {
    let Value::Object(mut object) = payload else {
        return (payload, Value::Null);
    };
    let inline_metadata = object.remove("metadata").unwrap_or(Value::Null);
    (Value::Object(object), inline_metadata)
}

fn merge_standardizer_metadata(
    normalized_metadata: Value,
    inline_payload_metadata: Value,
) -> Value {
    let mut merged = normalized_metadata.as_object().cloned().unwrap_or_default();
    if let Some(inline) = inline_payload_metadata.as_object() {
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

fn project_normal_response_payload(response: &Value) -> Value {
    let Value::Object(mut object) = response.clone() else {
        return Value::Null;
    };
    object.remove("metadata");
    object.remove("processingMetadata");
    Value::Object(object)
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
