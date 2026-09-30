//! Public DAGpipe consumer proving a request-scoped typed control channel.

use super::{
    InverseRecord, PairingRecord, RequestSlots, RuntimeIngressDescriptor, RuntimeIngressTransport,
    RuntimeInputKind, RuntimeRequestOrigin, V3NormalizedRequestLease,
};
use pipeline_runtime::{
    ArcId, Cancellation, Identity, Operator, OperatorContext, Registry, Runtime, ValueType,
};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

const GRAPH_SOURCE: &str = include_str!(
    "../../../../../docs/architecture/dagpipe/v3.operation_runner.request.normalize_request_losslessly.graph.json"
);
const MAP_SOURCE: &str =
    include_str!("../../../../../docs/architecture/v3-resource-operation-map.yml");
const INVERSE: &str = "v3.operation_runner.request_inverse_context";
const PAIRING: &str = "v3.operation_runner.explicit_history_pairing";
const INGRESS: &str = "v3.operation_runner.ingress_contract";
const WRITE_INVERSE: &str = "node02.inverse.publish";
const WRITE_PAIRING: &str = "node02.pairing.publish";
const READ_INVERSE: &str = "node02.inverse.read";
const READ_PAIRING: &str = "node02.pairing.read";

#[derive(Clone, Copy)]
struct StaticAccessContract {
    ingress_read: bool,
    inverse_read: bool,
    pairing_read: bool,
    inverse_write: bool,
    pairing_write: bool,
    read_effect: Option<&'static str>,
    write_effect: Option<&'static str>,
}

impl StaticAccessContract {
    fn from_map(map_source: &str) -> Result<Self, String> {
        let resources = [
            Self::resource_block(map_source, "ingress")?,
            Self::resource_block(map_source, "inverse")?,
            Self::resource_block(map_source, "pairing")?,
        ];
        let resources = [
            resources[0].ok_or("V3 resource map lacks ingress_contract")?,
            resources[1].ok_or("V3 resource map lacks request_inverse_context")?,
            resources[2].ok_or("V3 resource map lacks explicit_history_pairing")?,
        ];
        Ok(Self {
            ingress_read: Self::has(
                resources[0],
                "allowed_readers",
                "normalize_v3_operation_runner_request_losslessly",
            ),
            inverse_read: Self::has(
                resources[1],
                "allowed_readers",
                "normalize_v3_operation_runner_request_losslessly",
            ),
            pairing_read: Self::has(
                resources[2],
                "allowed_readers",
                "normalize_v3_operation_runner_request_losslessly",
            ),
            inverse_write: Self::has(
                resources[1],
                "allowed_writers",
                "normalize_v3_operation_runner_request_losslessly",
            ),
            pairing_write: Self::has(
                resources[2],
                "allowed_writers",
                "normalize_v3_operation_runner_request_losslessly",
            ),
            read_effect: Some(READ_PAIRING),
            write_effect: Some(WRITE_PAIRING),
        })
    }

    fn resource_block<'a>(source: &'a str, label: &'static str) -> Result<Option<&'a str>, String> {
        let marker = match label {
            "ingress" => "resource_id: v3.operation_runner.ingress_contract",
            "inverse" => "resource_id: v3.operation_runner.request_inverse_context",
            "pairing" => "resource_id: v3.operation_runner.explicit_history_pairing",
            _ => return Err("unknown Node02 resource label".into()),
        };
        let Some(start) = source.find(marker) else {
            return Err(format!("V3 resource map lacks {marker}"));
        };
        let remainder = &source[start..];
        let end = remainder
            .find("\n  - resource_id: ")
            .unwrap_or(remainder.len());
        Ok(Some(&remainder[..end]))
    }

    fn has(resource: &str, field: &str, owner: &str) -> bool {
        let Some(relative) = resource.find(&format!("    {field}:")) else {
            return false;
        };
        let line = &resource[relative..];
        let end = line.find('\n').unwrap_or(line.len());
        line[..end].contains(owner)
    }
}

struct RestrictedHandles {
    slots: Arc<Mutex<RequestSlots>>,
    ingress: RuntimeIngressDescriptor,
}

impl RestrictedHandles {
    fn from_graph(
        graph_source: &str,
        slots: Arc<Mutex<RequestSlots>>,
        ingress: RuntimeIngressDescriptor,
    ) -> Result<Self, String> {
        Self::from_graph_and_map(graph_source, MAP_SOURCE, slots, ingress)
    }

    fn from_graph_and_map(
        graph_source: &str,
        map_source: &str,
        slots: Arc<Mutex<RequestSlots>>,
        ingress: RuntimeIngressDescriptor,
    ) -> Result<Self, String> {
        let contract = StaticAccessContract::from_map(map_source)?;
        match (ingress.transport, ingress.input_kind, ingress.origin) {
            (
                RuntimeIngressTransport::Http | RuntimeIngressTransport::ResponsesWebSocket,
                RuntimeInputKind::RawEntry,
                RuntimeRequestOrigin::ClientEntry,
            )
            | (
                RuntimeIngressTransport::Http | RuntimeIngressTransport::ResponsesWebSocket,
                RuntimeInputKind::AlreadyCanonical,
                RuntimeRequestOrigin::Retry,
            ) => {}
            _ => return Err("invalid typed ingress origin and input kind".into()),
        }
        let declared_effect_ok = match ingress.input_kind {
            RuntimeInputKind::RawEntry => contract.write_effect == Some(WRITE_PAIRING),
            RuntimeInputKind::AlreadyCanonical => contract.read_effect == Some(READ_PAIRING),
        };
        if !declared_effect_ok {
            return Err("Node02 static access contract lacks its declared slot effect".into());
        }
        let graph: Value = serde_json::from_str(graph_source).map_err(|error| error.to_string())?;
        let Some(node) = graph["nodes"].as_array().and_then(|nodes| nodes.first()) else {
            return Err("Node02 graph omitted its node".into());
        };
        let resources = node["resources"].clone();
        let has = |direction: &str, resource: &str| {
            resources[direction]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(resource)))
        };
        if !contract.ingress_read || !has("reads", INGRESS) {
            return Err("Node02 lacks typed ingress grant".into());
        }
        if !contract.inverse_read || !has("reads", INVERSE) {
            return Err("Node02 lacks read grant for inverse context".into());
        }
        if !contract.pairing_read || !has("reads", PAIRING) {
            return Err("Node02 lacks read grant for history pairing".into());
        }
        if matches!(ingress.input_kind, RuntimeInputKind::RawEntry) {
            if !contract.inverse_write || !has("writes", INVERSE) {
                return Err("Node02 lacks write grant for inverse context".into());
            }
            if !contract.pairing_write || !has("writes", PAIRING) {
                return Err("Node02 lacks write grant for history pairing".into());
            }
        }
        Ok(Self { slots, ingress })
    }

    fn publish(&self, inverse: InverseRecord, pairing: PairingRecord) -> Result<(), String> {
        if self.ingress.input_kind != RuntimeInputKind::RawEntry {
            return Err("AlreadyCanonical has no write handle".into());
        }
        let mut slots = self.slots.lock().map_err(|error| error.to_string())?;
        if slots.inverse.is_some() || slots.pairing.is_some() {
            return Err("request slots already published".into());
        }
        *slots = RequestSlots {
            inverse: Some(inverse),
            pairing: Some(pairing),
        };
        Ok(())
    }

    fn read(&self) -> Result<(InverseRecord, PairingRecord), String> {
        let slots = self.slots.lock().map_err(|error| error.to_string())?;
        match (&slots.inverse, &slots.pairing) {
            (Some(inverse), Some(pairing)) => Ok((inverse.clone(), pairing.clone())),
            _ => Err("canonical retry lacks original request slots".into()),
        }
    }
}

struct CapabilityOperator {
    handles: RestrictedHandles,
    fail_before_publish: bool,
}

impl Operator for CapabilityOperator {
    fn name(&self) -> &'static str {
        "routecodex.v3.operation.normalize_request_losslessly"
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> ValueType {
        ValueType::Any
    }

    fn output_type(&self) -> ValueType {
        ValueType::Object
    }

    fn effects(&self) -> &'static [&'static str] {
        match self.handles.ingress.input_kind {
            RuntimeInputKind::RawEntry => &[WRITE_INVERSE, WRITE_PAIRING],
            RuntimeInputKind::AlreadyCanonical => &[READ_INVERSE, READ_PAIRING],
        }
    }

    fn execute(&self, input: Value, _context: &OperatorContext) -> Result<Value, String> {
        if self.fail_before_publish {
            return Err("controlled publication failure".into());
        }
        match self.handles.ingress.input_kind {
            RuntimeInputKind::RawEntry => {
                self.handles.publish(
                    InverseRecord {
                        entry_protocol: self.handles.ingress.entry_protocol.clone(),
                        source_path: "$.tools[0]".into(),
                    },
                    PairingRecord {
                        call_id: "call_1".into(),
                        output_id: "output_1".into(),
                    },
                )?;
            }
            RuntimeInputKind::AlreadyCanonical => {
                self.handles.read()?;
            }
        }
        Ok(input)
    }
}

fn run_consumer(
    slots: Arc<Mutex<RequestSlots>>,
    ingress: RuntimeIngressDescriptor,
    business: Value,
    fail_before_publish: bool,
    omit_effect: Option<&str>,
) -> Result<Value, String> {
    run_consumer_with_cancellation(
        slots,
        ingress,
        business,
        fail_before_publish,
        omit_effect,
        &Cancellation::default(),
    )
}

fn run_consumer_with_cancellation(
    slots: Arc<Mutex<RequestSlots>>,
    ingress: RuntimeIngressDescriptor,
    business: Value,
    fail_before_publish: bool,
    omit_effect: Option<&str>,
    cancellation: &Cancellation,
) -> Result<Value, String> {
    let handles = RestrictedHandles::from_graph(GRAPH_SOURCE, slots, ingress.clone())?;
    let mut registry = Registry::default();
    registry
        .register(CapabilityOperator {
            handles,
            fail_before_publish,
        })
        .map_err(|error| error.to_string())?;
    let graph =
        pipeline_runtime::parse_graph_json(GRAPH_SOURCE).map_err(|error| error.to_string())?;
    let effects: BTreeSet<String> = match ingress.input_kind {
        RuntimeInputKind::RawEntry => [WRITE_INVERSE, WRITE_PAIRING],
        RuntimeInputKind::AlreadyCanonical => [READ_INVERSE, READ_PAIRING],
    }
    .into_iter()
    .filter(|effect| Some(*effect) != omit_effect)
    .map(str::to_string)
    .collect();
    let compiled =
        pipeline_runtime::compile(graph, &registry, &effects).map_err(|error| error.to_string())?;
    let identity = Identity {
        project_id: "routecodex-v3".into(),
        graph_id: compiled.id().into(),
        graph_version: compiled.version().into(),
        execution_id: "capability-request".into(),
        attempt_id: match ingress.input_kind {
            RuntimeInputKind::RawEntry => "original",
            RuntimeInputKind::AlreadyCanonical => "retry",
        }
        .into(),
    };
    let mut inputs = HashMap::<ArcId, Value>::new();
    inputs.insert("client-json".into(), business);
    let result = Runtime::new(effects)
        .run(&compiled, identity, inputs, cancellation)
        .map_err(|error| error.to_string())?;
    result
        .outputs
        .get("canonical-request")
        .map(|output| output.payload.clone())
        .ok_or_else(|| "capability graph omitted canonical-request".into())
}

#[test]
fn capability_injected_operator_keeps_control_out_of_business_arc() {
    let business = json!({"model": "client-model", "tools": [{"name": "functions.exec", "arguments": r#"{"cmd":"echo one"}"#}]});
    let captured = super::execute_v3_operation_runner_request_capture_client_json(
        business.clone(),
        RuntimeIngressDescriptor::http("responses"),
    )
    .expect("public capture entry");
    let (captured_payload, lease) = captured.into_parts();
    let slots = lease.metadata_center.clone();
    let output = run_consumer(
        slots.clone(),
        lease.ingress.clone(),
        captured_payload,
        false,
        None,
    )
    .expect("real DAGpipe consumer");
    assert_eq!(output, business);
    let slots = slots.lock().expect("request slots lock");
    assert_eq!(
        slots.inverse.as_ref().expect("inverse").source_path,
        "$.tools[0]"
    );
    assert_eq!(slots.pairing.as_ref().expect("pairing").call_id, "call_1");
}

#[test]
fn capability_rejects_undeclared_grants_and_atomic_failure() {
    let lease = V3NormalizedRequestLease::new(RuntimeIngressDescriptor::http("responses"));
    let slots = lease.metadata_center.clone();
    let ingress = lease.ingress.clone();
    let missing = run_consumer(
        slots.clone(),
        ingress.clone(),
        json!({}),
        false,
        Some(WRITE_PAIRING),
    )
    .expect_err("SDK compile rejects missing effect grant");
    assert!(missing.contains(WRITE_PAIRING), "{missing}");
    let invalid_graph = GRAPH_SOURCE.replace(INGRESS, "unregistered.ingress");
    let error = RestrictedHandles::from_graph(&invalid_graph, slots.clone(), ingress.clone())
        .err()
        .expect("Runtime adapter rejects missing graph declaration");
    assert!(error.contains("typed ingress grant"), "{error}");
    let failure = run_consumer(slots.clone(), ingress, json!({}), true, None)
        .expect_err("controlled failure must remain a failure");
    assert!(
        failure.contains("controlled publication failure"),
        "{failure}"
    );
    let slots = slots.lock().expect("request slots lock");
    assert!(slots.inverse.is_none() && slots.pairing.is_none());
}

#[test]
fn capability_request_slots_are_isolated_and_reused() {
    let first = std::thread::spawn(|| {
        let lease = V3NormalizedRequestLease::new(RuntimeIngressDescriptor::http("responses"));
        run_consumer(
            lease.metadata_center.clone(),
            lease.ingress.clone(),
            json!({"request": 1}),
            false,
            None,
        )
        .expect("first request");
        lease
    });
    let second = std::thread::spawn(|| {
        let lease = V3NormalizedRequestLease::new(RuntimeIngressDescriptor::responses_websocket());
        run_consumer(
            lease.metadata_center.clone(),
            lease.ingress.clone(),
            json!({"request": 2}),
            false,
            None,
        )
        .expect("second request");
        lease
    });
    let first = first.join().expect("first thread");
    let second = second.join().expect("second thread");
    assert!(!Arc::ptr_eq(
        &first.metadata_center,
        &second.metadata_center
    ));
    assert!(first
        .metadata_center
        .lock()
        .expect("first lock")
        .inverse
        .is_some());
    assert!(second
        .metadata_center
        .lock()
        .expect("second lock")
        .pairing
        .is_some());
    assert_eq!(
        second
            .metadata_center
            .lock()
            .expect("second lock")
            .inverse
            .as_ref()
            .expect("inverse")
            .entry_protocol,
        "openai-responses"
    );
    let retry = json!({"request": 1, "attempt": 2});
    let before = first.metadata_center.lock().expect("before retry");
    let original_inverse = before.inverse.clone();
    let original_pairing = before.pairing.clone();
    drop(before);
    assert_eq!(
        run_consumer(
            first.metadata_center.clone(),
            first.ingress.already_canonical(),
            retry.clone(),
            false,
            None
        )
        .expect("retry keeps request slots"),
        retry
    );
    let after = first.metadata_center.lock().expect("after retry");
    assert_eq!(after.inverse, original_inverse);
    assert_eq!(after.pairing, original_pairing);
}

#[test]
fn capability_runtime_finalizer_releases_after_success_failure_and_sdk_cancellation() {
    let raw = RuntimeIngressDescriptor::http("responses");
    for terminal in ["success", "failure", "cancellation"] {
        let slots = {
            let captured = super::execute_v3_operation_runner_request_capture_client_json(
                json!({"request": terminal}),
                raw.clone(),
            )
            .expect("public Runtime capture entry");
            let (business, lease) = captured.into_parts();
            let slots = lease.metadata_center.clone();
            run_consumer(slots.clone(), raw.clone(), business, false, None)
                .expect("SDK publishes both request slots");
            assert!(slots
                .lock()
                .expect("slots before terminal")
                .inverse
                .is_some());
            let canonical = raw.already_canonical();
            match terminal {
                "success" => {
                    run_consumer(
                        slots.clone(),
                        canonical,
                        json!({"retry": true}),
                        false,
                        None,
                    )
                    .expect("SDK canonical read succeeds");
                }
                "failure" => {
                    let error = run_consumer(slots.clone(), canonical, json!({}), true, None)
                        .expect_err("SDK operator failure");
                    assert!(error.contains("controlled publication failure"), "{error}");
                }
                "cancellation" => {
                    let cancellation = Cancellation::default();
                    cancellation.cancel();
                    let error = run_consumer_with_cancellation(
                        slots.clone(),
                        canonical,
                        json!({}),
                        false,
                        None,
                        &cancellation,
                    )
                    .expect_err("SDK cancellation must fail the graph run");
                    assert!(error.contains("cancelled"), "{error}");
                }
                _ => unreachable!(),
            }
            slots
        };
        let released = slots.lock().expect("slots after Runtime finalizer");
        assert!(
            released.inverse.is_none() && released.pairing.is_none(),
            "{terminal}"
        );
    }
}

#[test]
fn capability_restricted_handles_refuse_canonical_write_and_missing_graph_grants() {
    let lease = V3NormalizedRequestLease::new(RuntimeIngressDescriptor::http("responses"));
    let raw = lease.ingress.clone();
    let mut missing_write: Value = serde_json::from_str(GRAPH_SOURCE).expect("graph JSON");
    missing_write["nodes"][0]["resources"]["writes"] = json!([PAIRING]);
    let missing_write = serde_json::to_string(&missing_write).expect("modified graph JSON");
    let error =
        RestrictedHandles::from_graph(&missing_write, lease.metadata_center.clone(), raw.clone())
            .err()
            .expect("missing graph write declaration rejected");
    assert!(error.contains("write grant for inverse context"), "{error}");
    let mut missing_read: Value = serde_json::from_str(GRAPH_SOURCE).expect("graph JSON");
    missing_read["nodes"][0]["resources"]["reads"] = json!([INGRESS, INVERSE]);
    let missing_read = serde_json::to_string(&missing_read).expect("modified graph JSON");
    let error =
        RestrictedHandles::from_graph(&missing_read, lease.metadata_center.clone(), raw.clone())
            .err()
            .expect("missing graph read declaration rejected");
    assert!(error.contains("read grant for history pairing"), "{error}");

    let inverse_block = StaticAccessContract::resource_block(MAP_SOURCE, "inverse")
        .expect("map parse")
        .expect("inverse resource block");
    let denied_writer = MAP_SOURCE.replace(
        inverse_block,
        &inverse_block.replace(
            "allowed_writers: [normalize_v3_operation_runner_request_losslessly]",
            "allowed_writers: []",
        ),
    );
    let error = RestrictedHandles::from_graph_and_map(
        GRAPH_SOURCE,
        &denied_writer,
        lease.metadata_center.clone(),
        raw.clone(),
    )
    .err()
    .expect("V3 map denied writer");
    assert!(error.contains("write grant for inverse context"), "{error}");
    let pairing_block = StaticAccessContract::resource_block(MAP_SOURCE, "pairing")
        .expect("map parse")
        .expect("pairing resource block");
    let denied_reader = MAP_SOURCE.replace(
        pairing_block,
        &pairing_block.replace(
            "allowed_readers: [normalize_v3_operation_runner_request_losslessly, govern_v3_operation_runner_chat_request, project_v3_operation_runner_standard_provider_request, govern_v3_operation_runner_chat_response]",
            "allowed_readers: []",
        ),
    );
    let error = RestrictedHandles::from_graph_and_map(
        GRAPH_SOURCE,
        &denied_reader,
        lease.metadata_center.clone(),
        raw.clone(),
    )
    .err()
    .expect("V3 map denied reader");
    assert!(error.contains("read grant for history pairing"), "{error}");
    let canonical = RestrictedHandles::from_graph(
        GRAPH_SOURCE,
        lease.metadata_center.clone(),
        raw.already_canonical(),
    )
    .expect("canonical read handles");
    let error = canonical
        .publish(
            InverseRecord {
                entry_protocol: "responses".into(),
                source_path: "$".into(),
            },
            PairingRecord {
                call_id: "call".into(),
                output_id: "output".into(),
            },
        )
        .expect_err("canonical invocation has no write handle");
    assert!(error.contains("no write handle"), "{error}");
    let slots = lease.metadata_center.lock().expect("unmodified slots");
    assert!(slots.inverse.is_none() && slots.pairing.is_none());
}
