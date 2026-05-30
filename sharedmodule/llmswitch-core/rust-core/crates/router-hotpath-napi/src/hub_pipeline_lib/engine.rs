use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub_pipeline::{run_hub_pipeline, HubPipelineInput};
use crate::hub_req_inbound_format_parse::{parse_format_envelope, FormatParseInput};
use crate::hub_req_inbound_semantic_lift::{
    apply_req_inbound_semantic_lift, ReqInboundSemanticLiftApplyInput,
};
use crate::hub_req_outbound_format_build::{build_format_request, FormatBuildInput};
use crate::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
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
        let routed = apply_route_selection(RouteSelectionApplyInput {
            request: normalized_payload,
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
