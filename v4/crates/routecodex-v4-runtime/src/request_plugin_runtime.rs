use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, PlanBindings};
use routecodex_v4_router::SelectedTarget;
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

use crate::RuntimeFault;

#[derive(Debug, Clone)]
pub struct RequestPluginOutput {
    pub provider_wire: Value,
    pub target: SelectedTarget,
    pub stream: bool,
    pub executed_nodes: Vec<String>,
}

/// Compiled Node 01-07 request-chain owner. HTTP handlers provide raw bytes;
/// only typed node plugins may parse, govern, route, replace the model, apply
/// provider compatibility, and validate the wire boundary.
pub struct RequestPluginRuntime {
    nodes: Vec<NodeContainer>,
    registry: StandardHandleRegistry,
    config_manifest: Value,
}

impl RequestPluginRuntime {
    pub fn new(config_manifest: Value) -> Result<Self, RuntimeFault> {
        let specs: [(&str, &str, u32, &[&str]); 9] = [
            (
                "V4ServerReqInbound01ClientRaw",
                "request_inbound",
                1,
                &["v4.std.protocol.server_input"],
            ),
            (
                "V4ServerSseIn02FrameBoundary",
                "request_inbound",
                2,
                &["v4.std.protocol.sse_in"],
            ),
            (
                "V4HubReqInbound03Normalized",
                "request_inbound",
                3,
                &["v4.std.protocol.responses_inbound"],
            ),
            (
                "V4HubReqChatProcess04Governed",
                "request_chat_process",
                4,
                &[
                    "v4.std.chat_process.scope_restore",
                    "v4.std.chat_process.continuation_restore",
                    "v4.std.chat_process.tool_governance",
                ],
            ),
            (
                "V4Router05RequestClassified",
                "request_execution",
                5,
                &[
                    "v4.std.routing.entry_model_admission",
                    "v4.std.routing.candidate_filter",
                ],
            ),
            (
                "V4Router06SelectionPlan",
                "request_execution",
                6,
                &["v4.std.routing.target_selection"],
            ),
            (
                "V4HubReqOutbound05ProviderSemantic",
                "request_outbound",
                5,
                &["v4.std.routing.model_replacement"],
            ),
            (
                "V4ProviderReqCompat06Compat",
                "request_outbound",
                6,
                &["v4.std.provider.compat"],
            ),
            (
                "V4ProviderSseOut07WireBoundary",
                "request_outbound",
                7,
                &[
                    "v4.std.provider.wire_boundary",
                    "v4.std.contract.output_validate",
                ],
            ),
        ];
        let mut nodes = Vec::with_capacity(specs.len());
        for (node_id, role_id, position, plugin_ids) in specs {
            let plan = compile_standard_plan(node_id, role_id, "request", position, plugin_ids)
                .map_err(|error| RuntimeFault::new("request_plugin_compile", error.to_string()))?;
            let binding = PlanBindings {
                graph_hash: plan.hash.clone(),
                manifest_hash: plan.hash.clone(),
                loaded_plan_hash: plan.hash.clone(),
            };
            let mut node = NodeContainer::declare(node_id, plan, binding)
                .map_err(|error| RuntimeFault::new("request_plugin_declare", error.to_string()))?;
            node.context_created()
                .map_err(|error| RuntimeFault::new("request_plugin_context", error.to_string()))?;
            node.plugins_mounted()
                .map_err(|error| RuntimeFault::new("request_plugin_mount", error.to_string()))?;
            node.publish()
                .map_err(|error| RuntimeFault::new("request_plugin_publish", error.to_string()))?;
            nodes.push(node);
        }
        Ok(Self {
            nodes,
            registry: StandardHandleRegistry::new(),
            config_manifest,
        })
    }

    pub fn execute_responses(&self, raw_body: &[u8]) -> Result<RequestPluginOutput, RuntimeFault> {
        let raw = std::str::from_utf8(raw_body)
            .map_err(|error| RuntimeFault::new("request_input_utf8", error.to_string()))?;
        let mut state = NodeExecutionInput {
            data: Value::String(raw.to_string()),
            control: json!({
                "config_manifest": self.config_manifest,
                "metadata_center": {
                    "entry_protocol": "responses"
                }
            }),
        };
        let mut executed_nodes = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            let output = node
                .execute(state, &self.registry)
                .map_err(|error| RuntimeFault::new("request_plugin_execute", error.to_string()))?;
            executed_nodes.push(node.node_id().to_string());
            state = NodeExecutionInput {
                data: output.data,
                control: output.control,
            };
        }
        let target: SelectedTarget =
            serde_json::from_value(state.control.get("target_selection").cloned().ok_or_else(
                || RuntimeFault::new("target_selection_missing", "VR produced no target"),
            )?)
            .map_err(|error| RuntimeFault::new("target_selection_invalid", error.to_string()))?;
        let stream = state
            .data
            .get("stream")
            .map(|value| {
                value.as_bool().ok_or_else(|| {
                    RuntimeFault::new("responses_stream_invalid", "stream must be a boolean")
                })
            })
            .transpose()?
            .unwrap_or(false);
        Ok(RequestPluginOutput {
            provider_wire: state.data,
            target,
            stream,
            executed_nodes,
        })
    }
}
