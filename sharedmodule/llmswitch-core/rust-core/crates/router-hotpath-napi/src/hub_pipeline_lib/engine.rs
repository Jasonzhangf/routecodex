use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
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
use crate::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use crate::req_process_stage1_tool_governance::{
    apply_req_process_tool_governance, ToolGovernanceInput,
};
use crate::req_process_stage2_route_select::{apply_route_selection, RouteSelectionApplyInput};

use super::diagnostics::{HubPipelineDiagnostic, HubPipelineDiagnosticStatus};
use super::effect_plan::HubPipelineEffectPlan;
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
        let provider_protocol = normalized_metadata
            .get("providerProtocol")
            .and_then(Value::as_str)
            .unwrap_or("openai-chat")
            .to_string();
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundFormatParse,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let parsed = parse_format_envelope(FormatParseInput {
            raw_request: normalized_payload.clone(),
            protocol: provider_protocol.clone(),
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
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let lifted_envelope = apply_req_inbound_semantic_lift(ReqInboundSemanticLiftApplyInput {
            chat_envelope: serde_json::to_value(&parsed.envelope)?,
            payload: Some(normalized_payload.clone()),
            protocol: Some(provider_protocol.clone()),
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
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqInboundContextCapture,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "protocol": provider_protocol })),
        ));
        let context_snapshot = capture_context_snapshot(
            &provider_protocol,
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
            request: normalized_payload,
            raw_payload: output.payload.clone().ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_raw_payload",
                    "Rust HubPipeline req governance requires normalized raw payload",
                )
            })?,
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
        let target = self
            .config
            .virtual_router
            .get("target")
            .cloned()
            .ok_or_else(|| {
                HubPipelineError::new(
                    "hub_pipeline_missing_route_target",
                    "Rust HubPipeline req route stage requires config.virtualRouter.target",
                )
            })?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Started,
            Some(serde_json::json!({ "targetObject": target.is_object() })),
        ));
        let mut routed = apply_route_selection(RouteSelectionApplyInput {
            request: governed.processed_request,
            normalized_metadata,
            target,
            route_name: self
                .config
                .virtual_router
                .get("routeName")
                .and_then(Value::as_str)
                .map(str::to_string),
            original_model: lifted_envelope
                .get("payload")
                .and_then(|payload| payload.get("model"))
                .and_then(Value::as_str)
                .map(str::to_string),
            thinking: None,
        })
        .map_err(HubPipelineError::from)?;
        attach_context_snapshot_to_metadata(&mut routed.normalized_metadata, context_snapshot)?;
        diagnostics.push(diagnostic(
            HubPipelineStageId::ReqProcessRouteSelect,
            HubPipelineDiagnosticStatus::Completed,
            Some(serde_json::json!({
                "metadataObject": routed.normalized_metadata.is_object(),
            })),
        ));
        let mut format_envelope = serde_json::to_value(&parsed.envelope)?;
        if let Some(envelope) = format_envelope.as_object_mut() {
            envelope.insert("payload".to_string(), routed.request);
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
        snapshot: Some(snapshot),
    });
    let payload_obj = payload.as_object_mut().ok_or_else(|| {
        HubPipelineError::new(
            "hub_pipeline_invalid_format_payload",
            "Rust HubPipeline req outbound context merge requires object payload",
        )
    })?;
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
    let mut engine = HubPipelineEngine::new(input.config)?;
    let output = engine.execute(input.request)?;
    serde_json::to_string(&output).map_err(HubPipelineError::from)
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
