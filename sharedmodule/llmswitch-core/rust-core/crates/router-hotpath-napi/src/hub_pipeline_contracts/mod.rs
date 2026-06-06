use serde::Serialize;
use serde_json::{json, Value};

const CONTRACT_VERSION: &str = "2026-06-03.hub-vr-node-contract.v1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContractShape {
    type_name: &'static str,
    required_fields: &'static [&'static str],
    forbidden_fields: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeContract {
    node_id: &'static str,
    version: &'static str,
    phase: &'static str,
    owner_builder: &'static str,
    data_in: ContractShape,
    data_out: ContractShape,
    meta_read: &'static [&'static str],
    meta_write: &'static [&'static str],
    effects: &'static [&'static str],
    forbidden_paths: &'static [&'static str],
    help: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetaCarrierContract {
    carrier_id: &'static str,
    version: &'static str,
    scope_fields: &'static [&'static str],
    allowed_fields: &'static [&'static str],
    forbidden_destinations: &'static [&'static str],
    release_rule: &'static str,
    help: &'static str,
}

pub(crate) fn describe_hub_pipeline_contracts() -> Value {
    json!({
        "contractVersion": CONTRACT_VERSION,
        "nodes": all_hub_pipeline_contracts(),
        "metaCarriers": meta_carrier_contracts(),
    })
}

/// All Hub pipeline nodes (request + response + provider wire).
/// Excludes VrRoute04SelectedTarget which lives in virtual_router_contracts().
fn all_hub_pipeline_contracts() -> Vec<NodeContract> {
    let mut req = hub_pipeline_contracts();
    req.extend(response_pipeline_contracts());
    req
}

pub(crate) fn describe_virtual_router_contracts() -> Value {
    json!({
        "contractVersion": CONTRACT_VERSION,
        "nodes": virtual_router_contracts(),
        "metaCarriers": meta_carrier_contracts()
            .into_iter()
            .filter(|contract| contract.carrier_id == "MetaRoute03RouteCarrier")
            .collect::<Vec<_>>(),
    })
}

pub(crate) fn describe_meta_carrier_contracts() -> Value {
    json!({
        "contractVersion": CONTRACT_VERSION,
        "metaCarriers": meta_carrier_contracts(),
    })
}

pub(crate) fn describe_pipeline_contract(node_id: &str) -> Option<Value> {
    all_node_contracts()
        .into_iter()
        .find(|contract| contract.node_id == node_id)
        .map(|contract| {
            json!({
                "contractVersion": CONTRACT_VERSION,
                "node": contract,
            })
        })
}

pub(crate) fn validate_pipeline_node_contract_boundary(
    node_id: &str,
    before: &Value,
    after: &Value,
) -> Result<Value, String> {
    let contract = all_node_contracts()
        .into_iter()
        .find(|contract| contract.node_id == node_id)
        .ok_or_else(|| format!("unknown pipeline node contract: {node_id}"))?;

    let mut violations = Vec::new();
    for path in contract.forbidden_paths {
        if json_path_exists(before, path) {
            violations.push(format!("before.{path}"));
        }
        if json_path_exists(after, path) {
            violations.push(format!("after.{path}"));
        }
    }
    for field in contract.data_out.forbidden_fields {
        if top_level_field_exists(after, field) {
            violations.push(format!("after.{field}"));
        }
    }

    if !violations.is_empty() {
        return Err(format!(
            "{node_id} contract violation: forbidden paths present: {}",
            violations.join(", ")
        ));
    }

    Ok(json!({
        "contractVersion": CONTRACT_VERSION,
        "nodeId": node_id,
        "valid": true,
    }))
}

fn all_node_contracts() -> Vec<NodeContract> {
    let mut contracts = hub_pipeline_contracts();
    contracts.extend(response_pipeline_contracts());
    contracts.extend(virtual_router_contracts());
    contracts
}

fn hub_pipeline_contracts() -> Vec<NodeContract> {
    vec![
        NodeContract {
            node_id: "HubReqInbound02Standardized",
            version: CONTRACT_VERSION,
            phase: "req_inbound",
            owner_builder: "build_hub_req_inbound_02_from_payload",
            data_in: shape("ServerReqInbound01ClientRaw", &["body"], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubReqInbound02Standardized", &["model"], COMMON_DATA_FORBIDDEN),
            meta_read: &[
                "requestId",
                "pipelineId",
                "entryEndpoint",
                "providerProtocol",
                "clientStream",
                "inboundStream",
                "outboundStream",
            ],
            meta_write: &["entryEndpoint", "providerProtocol", "clientProtocol"],
            effects: &[
                "standardize_request_shape",
                "preserve_client_payload_semantics",
                "tool_surface_validate",
            ],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Request inbound standardization only; no routing, provider wire build, or metadata injection into data payload.",
        },
        NodeContract {
            node_id: "HubReqChatProcess03Governed",
            version: CONTRACT_VERSION,
            phase: "req_chatprocess",
            owner_builder: "run_hub_req_chatprocess_03_governed_entrypoint",
            data_in: shape("HubReqInbound02Standardized", &["model"], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubReqChatProcess03Governed", &["model"], COMMON_DATA_FORBIDDEN),
            meta_read: &[
                "routeHint",
                "serverToolRequired",
                "hasImageAttachment",
                "processMode",
                "responsesResume",
                "webSearchIntent",
            ],
            meta_write: &[
                "serverToolRuntimeAction",
                "estimatedInputTokens",
                "processMode",
                "hasImageAttachment",
            ],
            effects: &[
                "tool_surface_validate",
                "tool_governance",
                "servertool_effect_plan",
                "chat_history_governance",
            ],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Request-side tool and history governance only; no route selection and no provider-specific wire shaping.",
        },
        NodeContract {
            node_id: "HubReqOutbound05ProviderSemantic",
            version: CONTRACT_VERSION,
            phase: "req_outbound",
            owner_builder: "run_hub_req_outbound_05_provider_semantic_entrypoint",
            data_in: shape("HubReqChatProcess03Governed", &["model"], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubReqOutbound05ProviderSemantic", &["model"], COMMON_DATA_FORBIDDEN),
            meta_read: &["providerProtocol", "outboundStream", "routecodexRoutingPolicyGroup"],
            meta_write: &[],
            effects: &["provider_neutral_semantic_projection", "tool_surface_validate"],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Provider-neutral outbound semantics only; provider HTTP body and SDK options are built later by Provider Runtime.",
        },
        NodeContract {
            node_id: "ProviderReqOutbound06WirePayload",
            version: CONTRACT_VERSION,
            phase: "req_outbound",
            owner_builder: "build_provider_req_outbound_06_from_hub_req_outbound_05",
            data_in: shape("HubReqOutbound05ProviderSemantic", &["model"], PROVIDER_WIRE_FORBIDDEN),
            data_out: shape("ProviderReqOutbound06WirePayload", &[], PROVIDER_WIRE_FORBIDDEN),
            meta_read: &[],
            meta_write: &[],
            effects: &[
                "provider_wire_build",
                "sdk_options_encoding",
                "tool_surface_validate_provider_wire",
            ],
            forbidden_paths: PROVIDER_WIRE_FORBIDDEN_PATHS,
            help: "Provider wire payload only; provider HTTP body and SDK options must contain zero internal metadata, route controls, or Meta* carriers.",
        },
    ]
}

fn response_pipeline_contracts() -> Vec<NodeContract> {
    vec![
        NodeContract {
            node_id: "HubRespInbound02Parsed",
            version: CONTRACT_VERSION,
            phase: "resp_inbound",
            owner_builder: "parse_hub_resp_inbound_02_from_provider_resp_inbound_01",
            data_in: shape("ProviderRespInbound01Raw", &[], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubRespInbound02Parsed", &[], COMMON_DATA_FORBIDDEN),
            meta_read: &["requestId", "pipelineId", "providerProtocol"],
            meta_write: &["providerProtocol"],
            effects: &[
                "parse_provider_response_shape",
                "preserve_response_semantics",
                "tool_surface_validate",
            ],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Response inbound parsing only; no tool governance, no client projection, no metadata injection into response payload.",
        },
        NodeContract {
            node_id: "HubRespChatProcess03Governed",
            version: CONTRACT_VERSION,
            phase: "resp_chatprocess",
            owner_builder: "build_hub_resp_chatprocess_03_from_hub_resp_inbound_02",
            data_in: shape("HubRespInbound02Parsed", &[], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubRespChatProcess03Governed", &[], COMMON_DATA_FORBIDDEN),
            meta_read: &["requestId", "pipelineId", "entryEndpoint", "providerProtocol"],
            meta_write: &["serverToolRuntimeAction", "stopMessageState"],
            effects: &[
                "tool_surface_validate",
                "tool_result_harvest",
                "servertool_followup_plan",
                "internal_tool_strip",
            ],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Response-side tool governance only; no provider wire rebuild, no client protocol projection, no metadata injection into response payload.",
        },
        NodeContract {
            node_id: "HubRespOutbound04ClientSemantic",
            version: CONTRACT_VERSION,
            phase: "resp_outbound",
            owner_builder: "project_hub_resp_outbound_04_from_hub_resp_chatprocess_03",
            data_in: shape("HubRespChatProcess03Governed", &[], COMMON_DATA_FORBIDDEN),
            data_out: shape("HubRespOutbound04ClientSemantic", &[], COMMON_DATA_FORBIDDEN),
            meta_read: &["requestId", "pipelineId", "entryEndpoint", "clientProtocol"],
            meta_write: &["clientProtocol"],
            effects: &[
                "client_protocol_projection",
                "responses_shape_build",
                "tool_surface_validate",
            ],
            forbidden_paths: COMMON_FORBIDDEN_PATHS,
            help: "Client-facing response projection only; no provider wire rebuild, no tool governance, no internal carrier injection into client body.",
        },
    ]
}

fn virtual_router_contracts() -> Vec<NodeContract> {
    vec![NodeContract {
        node_id: "VrRoute04SelectedTarget",
        version: CONTRACT_VERSION,
        phase: "vr_route",
        owner_builder: "build_vr_route_04_from_hub_req_chatprocess_03",
        data_in: shape("HubReqChatProcess03Governed", &["model"], COMMON_DATA_FORBIDDEN),
        data_out: shape("VrRoute04SelectedTarget", &["providerKey"], VR_DECISION_FORBIDDEN),
        meta_read: &[
            "allowedProviders",
            "excludedProviderKeys",
            "disabledProviderKeyAliases",
            "__shadowCompareForcedProviderKey",
            "__routecodexRetryProviderKey",
            "routecodexRoutingPolicyGroup",
        ],
        meta_write: &["selectedProviderKey", "selectedRouteId", "routingDecisionRecord"],
        effects: &["route_classify", "candidate_select", "quota_health_policy_consume"],
        forbidden_paths: VR_FORBIDDEN_PATHS,
        help: "Virtual Router selects target only; it must not patch payload, govern tools, or build provider wire payload.",
    }]
}

fn meta_carrier_contracts() -> Vec<MetaCarrierContract> {
    vec![
        MetaCarrierContract {
            carrier_id: "MetaReq01EntryCaptured",
            version: CONTRACT_VERSION,
            scope_fields: META_SCOPE_FIELDS,
            allowed_fields: &[
                "requestId",
                "pipelineId",
                "entryEndpoint",
                "providerProtocol",
                "clientRequestId",
                "clientHeaders",
                "clientConnectionState",
            ],
            forbidden_destinations: META_FORBIDDEN_DESTINATIONS,
            release_rule: "promote only to MetaReq02RuntimeCarrier inside the same request pipeline; never merge into data payload.",
            help: "Captures entry facts and request-bound control fields from server adapter.",
        },
        MetaCarrierContract {
            carrier_id: "MetaReq02RuntimeCarrier",
            version: CONTRACT_VERSION,
            scope_fields: META_SCOPE_FIELDS,
            allowed_fields: &[
                "routeHint",
                "serverToolRequired",
                "hasImageAttachment",
                "responsesResume",
                "processMode",
                "sessionId",
                "conversationId",
                "webSearchIntent",
            ],
            forbidden_destinations: META_FORBIDDEN_DESTINATIONS,
            release_rule: "promote only to MetaRoute03RouteCarrier or MetaResp04SameRequestCarrier; never persist as live metadata object.",
            help: "Carries request runtime controls for Hub Pipeline governance.",
        },
        MetaCarrierContract {
            carrier_id: "MetaRoute03RouteCarrier",
            version: CONTRACT_VERSION,
            scope_fields: META_SCOPE_FIELDS,
            allowed_fields: &[
                "allowedProviders",
                "excludedProviderKeys",
                "disabledProviderKeyAliases",
                "__shadowCompareForcedProviderKey",
                "__routecodexRetryProviderKey",
                "routecodexRoutingPolicyGroup",
                "routecodexLocalPort",
                "routecodexPortMode",
                "routecodexPortBinding",
            ],
            forbidden_destinations: META_FORBIDDEN_DESTINATIONS,
            release_rule: "route controls terminate at VrRoute04SelectedTarget and decision record; do not enter provider request payload.",
            help: "Carries routing controls consumed by Virtual Router target selection.",
        },
        MetaCarrierContract {
            carrier_id: "MetaResp04SameRequestCarrier",
            version: CONTRACT_VERSION,
            scope_fields: META_SCOPE_FIELDS,
            allowed_fields: &[
                "requestId",
                "pipelineId",
                "entryEndpoint",
                "providerProtocol",
                "serverToolRuntimeAction",
                "responsesRequestContext",
                "stopMessageState",
            ],
            forbidden_destinations: META_FORBIDDEN_DESTINATIONS,
            release_rule: "response controls are readable only within the same request/response closure and must release at MetaDone05Released.",
            help: "Carries response-side controls for the same request closure.",
        },
        MetaCarrierContract {
            carrier_id: "MetaDone05Released",
            version: CONTRACT_VERSION,
            scope_fields: META_SCOPE_FIELDS,
            allowed_fields: &[],
            forbidden_destinations: META_FORBIDDEN_DESTINATIONS,
            release_rule: "no live metadata object survives this point; only explicit continuation keys or debug snapshots may persist.",
            help: "Marks end of request-bound metadata lifetime.",
        },
    ]
}

fn shape(
    type_name: &'static str,
    required_fields: &'static [&'static str],
    forbidden_fields: &'static [&'static str],
) -> ContractShape {
    ContractShape {
        type_name,
        required_fields,
        forbidden_fields,
    }
}

fn top_level_field_exists(value: &Value, field: &str) -> bool {
    value
        .as_object()
        .map(|object| object.contains_key(field))
        .unwrap_or(false)
}

fn json_path_exists(value: &Value, path: &str) -> bool {
    let mut current = value;
    for segment in path.split('.') {
        let Some(object) = current.as_object() else {
            return false;
        };
        let Some(next) = object.get(segment) else {
            return false;
        };
        current = next;
    }
    true
}

const COMMON_DATA_FORBIDDEN: &[&str] = &[
    "metadata",
    "metaCarrier",
    "metadataCarrier",
    "runtimeMetadata",
    "errorCarrier",
    "classifiedError",
];

const PROVIDER_WIRE_FORBIDDEN: &[&str] = &[
    "metadata",
    "metaCarrier",
    "metadataCarrier",
    "runtimeMetadata",
    "errorCarrier",
    "classifiedError",
    "routeHint",
    "__routeHint",
];

const VR_DECISION_FORBIDDEN: &[&str] = &[
    "metadata",
    "metaCarrier",
    "metadataCarrier",
    "runtimeMetadata",
    "payload",
    "patchedPayload",
    "providerPayload",
    "wirePayload",
    "messages",
    "tools",
    "tool_calls",
];

const COMMON_FORBIDDEN_PATHS: &[&str] = &[
    "metadata",
    "metaCarrier",
    "metadataCarrier",
    "runtimeMetadata",
    "provider.body.metadata",
    "provider.options.metadata",
    "provider.sdkOptions.metadata",
    "direct.body.metadata",
    "client.body.metadata",
    "client.response.metadata",
];

const PROVIDER_WIRE_FORBIDDEN_PATHS: &[&str] = &[
    "metadata",
    "metaCarrier",
    "metadataCarrier",
    "runtimeMetadata",
    "provider.body.metadata",
    "provider.options.metadata",
    "provider.sdkOptions.metadata",
    "direct.body.metadata",
    "client.body.metadata",
    "client.response.metadata",
    "routeHint",
    "__routeHint",
    "providerKey",
    "selectedProviderKey",
    "routingDecisionRecord",
];

const VR_FORBIDDEN_PATHS: &[&str] = &[
    "metadata",
    "payload",
    "patchedPayload",
    "providerPayload",
    "wirePayload",
    "messages",
    "tools",
    "tool_calls",
    "provider.body.metadata",
    "direct.body.metadata",
    "client.body.metadata",
];

const META_SCOPE_FIELDS: &[&str] = &[
    "requestId",
    "pipelineId",
    "entryEndpoint",
    "providerProtocol",
    "portOrServerId",
    "sessionId",
    "conversationId",
];

const META_FORBIDDEN_DESTINATIONS: &[&str] = &[
    "providerHttpBody",
    "providerSdkOptions",
    "directPassthroughBody",
    "clientResponseBody",
    "providerPersistentState",
    "crossRequestSingleton",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_hub_and_meta_contracts() {
        let output = describe_hub_pipeline_contracts();
        assert_eq!(output["contractVersion"], CONTRACT_VERSION);
        assert_eq!(output["nodes"].as_array().unwrap().len(), 7);
        assert_eq!(output["metaCarriers"].as_array().unwrap().len(), 5);
        assert_eq!(
            output["metaCarriers"][2]["carrierId"],
            "MetaRoute03RouteCarrier"
        );
    }

    #[test]
    fn describes_single_virtual_router_contract() {
        let output = describe_pipeline_contract("VrRoute04SelectedTarget").unwrap();
        assert_eq!(output["node"]["nodeId"], "VrRoute04SelectedTarget");
        assert!(output["node"]["metaRead"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "__shadowCompareForcedProviderKey"));
    }

    #[test]
    fn validation_rejects_metadata_in_data_payload() {
        let err = validate_pipeline_node_contract_boundary(
            "HubReqChatProcess03Governed",
            &json!({"model":"m"}),
            &json!({"model":"m","metadata":{"routeHint":"x"}}),
        )
        .unwrap_err();
        assert!(err.contains("forbidden paths present"));
    }

    #[test]
    fn validation_rejects_vr_payload_patch() {
        let err = validate_pipeline_node_contract_boundary(
            "VrRoute04SelectedTarget",
            &json!({"providerKey":"p.key"}),
            &json!({"providerKey":"p.key","patchedPayload":{}}),
        )
        .unwrap_err();
        assert!(err.contains("after.patchedPayload"));
    }

    #[test]
    fn red_test_vr_route_controls_do_not_read_generic_metadata_directly() {
        let state_source = include_str!("../virtual_router_engine/instructions/state.rs");
        let route_source = include_str!("../virtual_router_engine/engine/route.rs");
        for forbidden in [
            concat!("metadata", ".get(\"allowedProviders\")"),
            concat!("metadata", ".get(\"disabledProviderKeyAliases\")"),
            concat!("metadata", ".get(\"__shadowCompareForcedProviderKey\")"),
            concat!("metadata", ".get(\"__routecodexRetryProviderKey\")"),
            concat!("resolve_route_hint", "(metadata)"),
        ] {
            assert!(
                !state_source.contains(forbidden) && !route_source.contains(forbidden),
                "VR routing control must flow through MetaRoute03RouteCarrier, found {forbidden}"
            );
        }
    }

    #[test]
    fn red_test_node_observation_keeps_data_processed_out_of_metadata() {
        let sources = [
            include_str!("../hub_pipeline_blocks/nodes.rs"),
            include_str!("../chat_node_result_semantics.rs"),
            include_str!("../req_process_stage1_tool_governance_blocks/request_result.rs"),
        ];
        for source in sources {
            assert!(
                !source.contains(concat!("metadata.insert(\"dataProcessed\"",)),
                "node observation dataProcessed must not be inserted into control metadata"
            );
            assert!(
                !source.contains(concat!(
                    "\"metadata\".to_string(),\n        json!({",
                    "\n          \"dataProcessed\""
                )),
                "node observation dataProcessed must not be nested in metadata JSON"
            );
        }
    }
}

#[test]
fn describes_all_eight_pipeline_contracts() {
    let all = all_node_contracts();
    assert_eq!(all.len(), 8);
    let node_ids: Vec<_> = all.iter().map(|c| c.node_id).collect();
    for expected in [
        "HubReqInbound02Standardized",
        "HubReqChatProcess03Governed",
        "HubReqOutbound05ProviderSemantic",
        "ProviderReqOutbound06WirePayload",
        "HubRespInbound02Parsed",
        "HubRespChatProcess03Governed",
        "HubRespOutbound04ClientSemantic",
        "VrRoute04SelectedTarget",
    ] {
        assert!(
            node_ids.iter().any(|id| *id == expected),
            "missing node contract: {expected}"
        );
    }
}

#[test]
fn response_pipeline_contracts_have_valid_owners() {
    for contract in response_pipeline_contracts() {
        let owner = contract.owner_builder;
        assert!(
            owner.starts_with("parse_")
                || owner.starts_with("build_")
                || owner.starts_with("project_"),
            "response contract {owner} must use parse_/build_/project_ prefix"
        );
    }
}

#[test]
fn validation_rejects_provider_wire_metadata() {
    let err = validate_pipeline_node_contract_boundary(
        "ProviderReqOutbound06WirePayload",
        &json!({"model":"m","metadata":{"routeHint":"x"}}),
        &json!({"model":"m","metadata":{"routeHint":"x"}}),
    )
    .unwrap_err();
    assert!(err.contains("forbidden paths present"));
    assert!(err.contains("metadata"));
}

#[test]
fn validation_rejects_route_hint_in_provider_wire() {
    let err = validate_pipeline_node_contract_boundary(
        "ProviderReqOutbound06WirePayload",
        &json!({"model":"m"}),
        &json!({"model":"m","routeHint":"ph_xxx"}),
    )
    .unwrap_err();
    assert!(err.contains("forbidden paths present"));
    assert!(err.contains("routeHint"));
}
