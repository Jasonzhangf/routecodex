use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_node_result_semantics::build_processed_request_from_chat_response;
use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
use crate::hub_pipeline_blocks::standardized_request::coerce_standardized_request_from_payload;
use crate::hub_pipeline_types::{
    run_hub_req_chatprocess_03_governed_entrypoint, run_hub_req_inbound_02_standardized_entrypoint,
    run_hub_req_outbound_05_provider_semantic_entrypoint,
};
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
use crate::hub_resp_inbound_format_parse::{parse_resp_format_envelope, RespFormatParseInput};
use crate::hub_resp_outbound_client_semantics::{
    apply_client_passthrough_patch, build_anthropic_response_from_chat_value,
    build_openai_chat_response_from_anthropic_message, build_responses_payload_from_chat_core,
    normalize_openai_chat_reasoning_outbound,
};
use crate::hub_resp_outbound_sse_stream::{process_sse_stream, SseStreamInput};
use crate::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use crate::req_process_stage1_tool_governance::{
    apply_req_process_tool_governance, ToolGovernanceInput,
};
use crate::req_process_stage2_route_select::{apply_route_selection, RouteSelectionApplyInput};
use crate::resp_process_stage1_tool_governance::{
    govern_response, ToolGovernanceInput as RespToolGovernanceInput,
};
use crate::resp_process_stage2_finalize::{finalize_chat_response, FinalizeInput};
use crate::servertool_core_blocks::inspect_stop_gateway_signal;
use crate::servertool_skeleton::finalize_strip::filter_out_executed_servertool_calls;

use super::diagnostics::{HubPipelineDiagnostic, HubPipelineDiagnosticStatus};
use super::effect_plan::{HubPipelineEffect, HubPipelineEffectKind, HubPipelineEffectPlan};
use super::errors::{HubPipelineError, HubPipelineResult};
use super::stage_catalog::HubPipelineStageId;
use super::types::{HubPipelineConfig, HubPipelineExecutionOutput, HubPipelineRequest};

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

    fn select_route(&self, request: &Value, metadata: &Value) -> HubPipelineResult<Value> {
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
        read_preselected_route(metadata).ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_preselected_route",
                "Rust HubPipeline req route stage requires metadata.__routecodexPreselectedRoute for bootstrapped virtual router config",
            )
        })
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
        let mut diagnostics = vec![diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Started,
            None,
        )];
        let input = HubPipelineInput {
            request_id: request_id.clone(),
            endpoint: request.endpoint,
            entry_endpoint: request.entry_endpoint,
            provider_protocol: request.provider_protocol,
            payload: request.payload,
            metadata: request.metadata,
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
        let entry_provider_protocol = normalized_metadata
            .get("providerProtocol")
            .and_then(Value::as_str)
            .unwrap_or("openai-chat")
            .to_string();
        if direction == "response" {
            return self.execute_response_path(
                output,
                normalized_payload,
                normalized_metadata,
                entry_provider_protocol,
                diagnostics,
            );
        }
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
            responses_resume: None,
            session_id: normalized_metadata
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            conversation_id: normalized_metadata
                .get("conversationId")
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
        let standardized = coerce_standardized_request_from_payload(&serde_json::json!({
            "payload": normal_request_payload,
            "normalized": {
                "id": output.request_id,
                "entryEndpoint": entry_endpoint,
                "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false),
                "processMode": normalized_metadata.get("processMode").and_then(Value::as_str).unwrap_or("chat"),
                "routeHint": normalized_metadata.get("routeHint").cloned().unwrap_or(Value::Null),
                "metadata": inline_payload_metadata
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
        let context_snapshot = capture_context_snapshot(
            &entry_provider_protocol,
            &normalized_payload,
            &normalized_metadata,
            &request_id,
        )?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundContextCapture,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "hasContextSnapshot": context_snapshot.is_some(),
            })),
        ));
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessToolGovernance,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "metadataObject": normalized_metadata.is_object() })),
        ));
        let governed = apply_req_process_tool_governance(ToolGovernanceInput {
            request: standardized_payload,
            raw_payload: standardized_raw_payload,
            metadata: normalized_metadata.clone(),
            entry_endpoint: entry_endpoint.clone(),
            request_id: output.request_id.clone(),
            has_active_stop_message_for_continue_execution: Some(true),
        })
        .map_err(|message| HubPipelineError::new("hub_pipeline_tool_governance_failed", message))?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessToolGovernance,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "nodeResult": governed.node_result,
            })),
        ));
        let req_chatprocess_03 = run_hub_req_chatprocess_03_governed_entrypoint(
            req_inbound_02,
            project_normal_request_payload(&governed.processed_request),
        )
        .map_err(|message| {
            HubPipelineError::new("hub_pipeline_req_chatprocess_03_failed", message)
        })?;
        let route_output = self.select_route(&governed.processed_request, &normalized_metadata)?;
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
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "targetObject": target.is_object() })),
        ));
        let mut routed = apply_route_selection(RouteSelectionApplyInput {
            request: governed.processed_request,
            normalized_metadata,
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
            .unwrap_or(entry_provider_protocol);
        attach_context_snapshot_to_metadata(&mut routed.normalized_metadata, context_snapshot)?;
        if let Some(metadata) = routed.normalized_metadata.as_object_mut() {
            if let Some(decision) = route_output.get("decision").cloned() {
                metadata.insert("routingDecision".to_string(), decision);
            }
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
        normalized_metadata: Value,
        provider_protocol: String,
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
        let provider_format = parsed.envelope.format.clone();
        let canonical_payload = canonicalize_provider_response_for_client(
            parsed.envelope.payload,
            provider_format.as_str(),
            &normalized_metadata,
            output.request_id.as_str(),
        )?;
        let governed = govern_response(RespToolGovernanceInput {
            payload: canonical_payload,
            client_protocol: normalized_metadata
                .get("clientProtocol")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    HubPipelineError::new(
                        "hub_pipeline_missing_client_protocol",
                        "Rust HubPipeline resp governance requires metadata.clientProtocol",
                    )
                })?,
            entry_endpoint: normalized_metadata
                .get("entryEndpoint")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    HubPipelineError::new(
                        "hub_pipeline_missing_entry_endpoint",
                        "Rust HubPipeline resp governance requires metadata.entryEndpoint",
                    )
                })?,
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
        diagnostics.push(diagnostic(
            HubPipelineStageId::RespProcessFinalize,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "stream": normalized_metadata.get("stream").and_then(Value::as_bool).unwrap_or(false) })),
        ));
        let finalized_payload = finalize_chat_response(FinalizeInput {
            payload: governed.governed_payload,
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
        let client_payload = build_client_payload_for_protocol(
            finalized_payload,
            &normalized_metadata,
            output.request_id.as_str(),
        )?;
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
        let mut effects = Vec::new();
        let stop_gateway = inspect_stop_gateway_signal(&stream_decision.payload.to_string())
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null);
        if should_plan_servertool_runtime_action(&normalized_metadata) {
            if stop_gateway
                .get("eligible")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                effects.push(HubPipelineEffect {
                    kind: HubPipelineEffectKind::ServertoolRuntimeAction,
                    payload: serde_json::json!({
                        "action": "requireRuntimeExecutor",
                        "reason": "stop_eligible_followup",
                        "requestId": output.request_id,
                        "stopGateway": stop_gateway,
                    }),
                });
            }
            if response_has_tool_calls(&stream_decision.payload)
                || response_requires_submit_tool_outputs(&stream_decision.payload)
            {
                effects.push(HubPipelineEffect {
                    kind: HubPipelineEffectKind::ServertoolRuntimeAction,
                    payload: serde_json::json!({
                        "action": "requireRuntimeExecutor",
                        "reason": "tool_call_dispatch",
                        "requestId": output.request_id,
                        "payload": stream_decision.payload.clone(),
                    }),
                });
            }
        }
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

fn response_has_tool_calls(payload: &Value) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                choice
                    .get("message")
                    .and_then(|message| message.get("tool_calls"))
                    .and_then(Value::as_array)
                    .is_some_and(|tool_calls| !tool_calls.is_empty())
            })
        })
}

fn should_plan_servertool_runtime_action(metadata: &Value) -> bool {
    metadata
        .get("runtimeEffects")
        .and_then(Value::as_object)
        .is_some_and(|runtime| {
            runtime
                .get("providerInvoker")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || runtime
                    .get("reenterPipeline")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || runtime
                    .get("clientInjectDispatch")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
}

fn read_trimmed_metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
        metadata_obj.insert("context".to_string(), snapshot.clone());
    }
    if let Some(tool_outputs) = patch.tool_outputs {
        payload_obj.insert(
            "toolOutputs".to_string(),
            serde_json::to_value(tool_outputs)?,
        );
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

fn build_client_payload_for_protocol(
    finalized_payload: Value,
    metadata: &Value,
    request_id: &str,
) -> HubPipelineResult<Value> {
    let client_protocol = metadata
        .get("clientProtocol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            HubPipelineError::new(
                "hub_pipeline_missing_client_protocol",
                "Rust HubPipeline resp client remap requires metadata.clientProtocol",
            )
        })?;
    let client_payload = match client_protocol {
        "openai-chat" => {
            normalize_openai_chat_reasoning_outbound(&finalized_payload).ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_resp_client_remap_failed",
                    "Rust HubPipeline openai-chat client remap returned no payload",
                )
            })?
        }
        "anthropic-messages" => {
            let alias_map = metadata
                .get("requestSemantics")
                .and_then(|semantics| semantics.get("aliasMap"));
            build_anthropic_response_from_chat_value(&finalized_payload, alias_map)
        }
        "openai-responses" => {
            let context = serde_json::json!({
                "requestId": request_id,
                "metadata": metadata,
                "model": metadata
                    .get("displayModel")
                    .or_else(|| metadata.get("clientModelId"))
                    .or_else(|| metadata.get("originalModelId")),
            });
            build_responses_payload_from_chat_core(&finalized_payload, Some(request_id), &context)
                .map_err(|message| {
                HubPipelineError::new("hub_pipeline_resp_client_remap_failed", message)
            })?
        }
        _ => {
            return Err(HubPipelineError::new(
                "hub_pipeline_unsupported_client_protocol",
                format!(
                    "Rust HubPipeline resp client remap unsupported client protocol: {}",
                    client_protocol
                ),
            ));
        }
    };
    Ok(apply_client_passthrough_patch(
        &client_payload,
        &finalized_payload,
    ))
}

fn canonicalize_provider_response_for_client(
    payload: Value,
    provider_format: &str,
    metadata: &Value,
    request_id: &str,
) -> HubPipelineResult<Value> {
    let client_protocol = metadata
        .get("clientProtocol")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if provider_format == "anthropic-messages"
        && matches!(client_protocol, "openai-chat" | "openai-responses")
    {
        return build_openai_chat_response_from_anthropic_message(&payload, request_id).map_err(
            |message| {
                HubPipelineError::new(
                    "hub_pipeline_resp_anthropic_chat_canonicalize_failed",
                    message,
                )
            },
        );
    }
    Ok(payload)
}

fn build_adapter_context(
    metadata: &Value,
    provider_protocol: &str,
    request_id: &str,
) -> AdapterContext {
    AdapterContext {
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
        session_id: metadata
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        conversation_id: metadata
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..AdapterContext {
            compatibility_profile: None,
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            anthropic_thinking: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        }
    }
}

fn read_preselected_route(metadata: &Value) -> Option<Value> {
    let route = metadata.get("__routecodexPreselectedRoute")?;
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
            request_id,
            success: false,
            payload: None,
            metadata: None,
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

pub fn run_hub_pipeline_stage_json(stage_json: String) -> HubPipelineResult<String> {
    if stage_json.trim().is_empty() {
        return Err(HubPipelineError::new(
            "hub_pipeline_empty_stage_input",
            "Stage input JSON is empty",
        ));
    }

    let raw: Value = serde_json::from_str(&stage_json)?;
    if raw.get("request").is_none()
        && raw.get("stage").and_then(Value::as_str) == Some("normalizeRequest")
    {
        return run_normalize_request_stage(raw);
    }
    if raw.get("request").is_none()
        && raw.get("stage").and_then(Value::as_str) == Some("reqProcessToolGovernance")
    {
        return run_req_process_tool_governance_stage(raw);
    }
    if raw.get("request").is_none()
        && raw.get("stage").and_then(Value::as_str) == Some("respProcessFinalize")
    {
        return run_resp_process_finalize_stage(raw);
    }
    let lib_input = if raw.get("request").is_some() {
        raw
    } else {
        serde_json::json!({ "request": raw })
    };
    execute_hub_pipeline_json(serde_json::to_string(&lib_input).map_err(HubPipelineError::from)?)
}

fn run_normalize_request_stage(raw: Value) -> HubPipelineResult<String> {
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("hub_pipeline_normalize_request")
        .to_string();
    if raw
        .get("metadata")
        .and_then(|metadata| metadata.get("processMode"))
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.trim().eq_ignore_ascii_case("passthrough"))
    {
        return Err(HubPipelineError::new(
            "hub_pipeline_passthrough_process_mode_removed",
            format!(
                "[HubPipeline] processMode='passthrough' is no longer supported. (requestId={})",
                request_id
            ),
        ));
    }
    let output = run_hub_pipeline(HubPipelineInput {
        request_id: request_id.clone(),
        endpoint: raw
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("/v1/chat/completions")
            .to_string(),
        entry_endpoint: raw
            .get("entryEndpoint")
            .and_then(Value::as_str)
            .unwrap_or("/v1/chat/completions")
            .to_string(),
        provider_protocol: raw
            .get("providerProtocol")
            .and_then(Value::as_str)
            .unwrap_or("openai-chat")
            .to_string(),
        payload: raw.get("payload").cloned().unwrap_or(Value::Null),
        metadata: raw.get("metadata").cloned().unwrap_or(Value::Null),
        stream: raw.get("stream").and_then(Value::as_bool).unwrap_or(false),
        process_mode: "chat".to_string(),
        direction: raw
            .get("direction")
            .and_then(Value::as_str)
            .unwrap_or("request")
            .to_string(),
        stage: raw
            .get("metadata")
            .and_then(|metadata| metadata.get("stage"))
            .and_then(Value::as_str)
            .or_else(|| raw.get("stage").and_then(Value::as_str))
            .unwrap_or("inbound")
            .to_string(),
    })
    .map_err(|message| HubPipelineError::new("hub_pipeline_normalize_request_failed", message))?;
    let result = HubPipelineExecutionOutput {
        request_id: output.request_id,
        success: output.success,
        payload: output.payload,
        metadata: output.metadata,
        effect_plan: HubPipelineEffectPlan::empty(),
        diagnostics: vec![diagnostic(
            HubPipelineStageId::NormalizeRequest,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "stageOnly": true })),
        )],
        error: output.error.map(|error| HubPipelineError {
            code: error.code,
            message: error.message,
            details: error.details,
        }),
    };
    serde_json::to_string(&result).map_err(HubPipelineError::from)
}

fn run_req_process_tool_governance_stage(raw: Value) -> HubPipelineResult<String> {
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("hub_pipeline_stage_request")
        .to_string();
    let metadata = raw.get("metadata").cloned().unwrap_or(Value::Null);
    let raw_payload = metadata
        .get("rawPayload")
        .cloned()
        .unwrap_or_else(|| raw.get("payload").cloned().unwrap_or(Value::Null));
    let entry_endpoint = raw
        .get("entryEndpoint")
        .and_then(Value::as_str)
        .or_else(|| raw.get("endpoint").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let has_active_stop_message_for_continue_execution = metadata
        .get("hasActiveStopMessageForContinueExecution")
        .and_then(Value::as_bool);
    let governed = apply_req_process_tool_governance(ToolGovernanceInput {
        request: raw.get("payload").cloned().unwrap_or(Value::Null),
        raw_payload,
        metadata,
        entry_endpoint,
        request_id: request_id.clone(),
        has_active_stop_message_for_continue_execution,
    })
    .map_err(|message| {
        HubPipelineError::new("hub_pipeline_req_process_tool_governance_failed", message)
    })?;

    let output = HubPipelineExecutionOutput {
        request_id,
        success: true,
        payload: Some(governed.processed_request),
        metadata: Some(serde_json::json!({ "nodeResult": governed.node_result })),
        effect_plan: HubPipelineEffectPlan::empty(),
        diagnostics: vec![diagnostic(
            HubPipelineStageId::ReqProcessToolGovernance,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "stageOnly": true })),
        )],
        error: None,
    };
    serde_json::to_string(&output).map_err(HubPipelineError::from)
}

fn run_resp_process_finalize_stage(raw: Value) -> HubPipelineResult<String> {
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("hub_pipeline_stage_response")
        .to_string();
    let metadata = raw.get("metadata").cloned().unwrap_or(Value::Null);
    let wants_stream = raw.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let reasoning_mode = metadata
        .get("reasoningMode")
        .and_then(Value::as_str)
        .map(str::to_string);
    let entry_endpoint = raw
        .get("entryEndpoint")
        .and_then(Value::as_str)
        .or_else(|| raw.get("endpoint").and_then(Value::as_str))
        .map(str::to_string);
    let finalized = finalize_chat_response(FinalizeInput {
        payload: raw.get("payload").cloned().unwrap_or(Value::Null),
        stream: wants_stream,
        reasoning_mode,
        endpoint: entry_endpoint.clone(),
        request_id: Some(request_id.clone()),
    });
    let strip_source = metadata
        .get("originalPayload")
        .cloned()
        .unwrap_or_else(|| raw.get("payload").cloned().unwrap_or(Value::Null));
    let finalized = if strip_source.is_object() {
        filter_out_executed_servertool_calls(&finalized, &strip_source)
    } else {
        finalized
    };
    let processed_request =
        build_processed_request_from_chat_response(finalized.clone(), wants_stream);
    let output = HubPipelineExecutionOutput {
        request_id,
        success: true,
        payload: Some(finalized),
        metadata: Some(serde_json::json!({ "processedRequest": processed_request })),
        effect_plan: HubPipelineEffectPlan::empty(),
        diagnostics: vec![diagnostic(
            HubPipelineStageId::RespProcessFinalize,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({ "stageOnly": true })),
        )],
        error: None,
    };
    serde_json::to_string(&output).map_err(HubPipelineError::from)
}

fn split_normal_payload_and_inline_metadata(payload: Value) -> (Value, Value) {
    let Value::Object(mut object) = payload else {
        return (payload, Value::Null);
    };
    let inline_metadata = object.remove("metadata").unwrap_or(Value::Null);
    (Value::Object(object), inline_metadata)
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
