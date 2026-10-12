use super::operators::client_source_error::{
    ClientSourceErrorOperator, ClientSourceResources, STAGES,
};
use super::*;
use std::sync::{Arc, Mutex};

const ERROR_GRAPH: &str =
    include_str!("../../../../../docs/architecture/dagpipe/v3.operation_runner.error.graph.json");

fn capabilities() -> BTreeSet<String> {
    [
        "v3.error.chain",
        "v3.error.execution_decision",
        "v3.error.client_projection_candidate",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// Compile and execute the canonical six-node Error graph. The registered
/// operators share only this request's typed resource, which the Runtime reads
/// after the SDK reports completed execution. Other Error families stay legacy.
pub fn execute_v3_client_source_error_chain(
    failure: routecodex_v3_error::V3ClientTransportFailure,
) -> Result<V3ClientSourceErrorChainExecution, OperationRunnerError> {
    let resources = Arc::new(Mutex::new(ClientSourceResources::new(failure)));
    let mut registry = Registry::default();
    for stage in 0..STAGES.len() {
        registry.register(ClientSourceErrorOperator {
            stage,
            resources: Arc::clone(&resources),
        })?;
    }
    let graph = pipeline_runtime::parse_graph_json(ERROR_GRAPH)?;
    let compiled = pipeline_runtime::compile(graph, &registry, &capabilities())?;
    let identity = {
        let resource = resources.lock().expect("Error resource lock");
        Identity {
            project_id: "routecodex-v3".into(),
            graph_id: compiled.id().into(),
            graph_version: compiled.version().into(),
            execution_id: resource.failure.request_id.clone(),
            attempt_id: resource
                .failure
                .attempt_id
                .clone()
                .unwrap_or_else(|| "request-scope".into()),
        }
    };
    let result = Runtime::new(capabilities()).run(
        &compiled,
        identity,
        HashMap::from([("source-failure".into(), serde_json::json!({}))]),
        &Cancellation::default(),
    )?;
    let completed: Vec<&'static str> = result
        .journal
        .iter()
        .filter_map(|event| {
            if let pipeline_runtime::Event::NodeCompleted { node_id, .. } = event {
                STAGES
                    .iter()
                    .position(|(id, _)| *id == node_id)
                    .map(|index| routecodex_v3_error::V3_CLIENT_SOURCE_ERROR_CHAIN_NODE_IDS[index])
            } else {
                None
            }
        })
        .collect();
    let completed_node_ids = completed
        .try_into()
        .map_err(|_| OperationRunnerError::new("Error SDK did not complete six nodes"))?;
    let mut resource = resources.lock().expect("Error resource lock");
    let outcome = resource
        .outcome
        .take()
        .ok_or_else(|| OperationRunnerError::new("Error graph omitted typed internal outcome"))?;
    let host = resource
        .host
        .take()
        .ok_or_else(|| OperationRunnerError::new("Error graph omitted HostCaptured resource"))?;
    let transport_outcome = consume_v3_client_source_outcome(&outcome, &host);
    Ok(V3ClientSourceErrorChainExecution {
        outcome,
        completed_node_ids,
        transport_outcome,
        journal: result.journal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_error_operators_require_typed_resource_write_capabilities() {
        let resources = Arc::new(Mutex::new(ClientSourceResources::new(
            routecodex_v3_error::V3ClientTransportFailure {
                operation: routecodex_v3_error::V3ClientTransportOperation::Cancellation,
                io_kind: None,
                os_cause: Some("test cancellation".into()),
                connection_id: 1,
                request_id: "request-capability-test".into(),
                attempt_id: None,
            },
        )));
        let mut registry = Registry::default();
        for stage in 0..STAGES.len() {
            registry
                .register(ClientSourceErrorOperator {
                    stage,
                    resources: Arc::clone(&resources),
                })
                .unwrap();
        }
        let graph = pipeline_runtime::parse_graph_json(ERROR_GRAPH).unwrap();
        let error = pipeline_runtime::compile(graph, &registry, &BTreeSet::new()).unwrap_err();
        assert!(error.message.contains("undeclared capability"), "{error}");
        assert!(
            resources.lock().unwrap().source.is_none(),
            "compilation executed an effect"
        );
    }
}
