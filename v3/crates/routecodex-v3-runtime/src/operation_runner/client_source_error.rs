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

    #[test]
    fn cancellation_without_io_keeps_typed_source_through_all_six_operators() {
        let failure = routecodex_v3_error::V3ClientTransportFailure {
            operation: routecodex_v3_error::V3ClientTransportOperation::Cancellation,
            io_kind: None,
            os_cause: Some("committed client body dropped before completion".into()),
            connection_id: 7,
            request_id: "request-cancellation-source".into(),
            attempt_id: None,
        };
        let resources = Arc::new(Mutex::new(ClientSourceResources::new(failure)));
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
        let compiled = pipeline_runtime::compile(graph, &registry, &capabilities()).unwrap();
        let identity = Identity {
            project_id: "routecodex-v3".into(),
            graph_id: compiled.id().into(),
            graph_version: compiled.version().into(),
            execution_id: "request-cancellation-source".into(),
            attempt_id: "request-scope".into(),
        };
        let result = Runtime::new(capabilities())
            .run(
                &compiled,
                identity,
                HashMap::from([("source-failure".into(), serde_json::json!({}))]),
                &Cancellation::default(),
            )
            .unwrap();

        let completed: Vec<&'static str> = result
            .journal
            .iter()
            .filter_map(|event| {
                if let pipeline_runtime::Event::NodeCompleted { node_id, .. } = event {
                    STAGES
                        .iter()
                        .position(|(id, _)| *id == node_id)
                        .map(|index| {
                            routecodex_v3_error::V3_CLIENT_SOURCE_ERROR_CHAIN_NODE_IDS[index]
                        })
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            completed,
            routecodex_v3_error::V3_CLIENT_SOURCE_ERROR_CHAIN_NODE_IDS
        );

        let resource = resources.lock().unwrap();
        let source = resource.source.as_ref().expect("Error01 source resource");
        assert_eq!(
            source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::ClientCancellation
        );
        assert_eq!(source.code, "client_body_cancellation");
        assert_eq!(source.source_stage, "V3ServerClientTransportBoundary");

        let host = resource.host.as_ref().expect("HostCaptured resource");
        assert_eq!(
            host.operation,
            routecodex_v3_error::V3ClientTransportOperation::Cancellation
        );
        assert_eq!(host.io_kind, None);
        assert_eq!(
            host.os_cause.as_deref(),
            Some("committed client body dropped before completion")
        );
        assert_eq!(host.connection_id, 7);
        assert_eq!(host.request_id, "request-cancellation-source");
        assert_eq!(host.attempt_id, None);
        assert_eq!(host.source.source_kind, source.source_kind);
        assert_eq!(host.source.code, source.code);

        let classified = resource.classified.as_ref().expect("classified resource");
        assert_eq!(
            classified.source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::ClientCancellation
        );
        assert_eq!(classified.source.code, "client_body_cancellation");
        assert_eq!(classified.class, "client_cancellation");
        assert_eq!(classified.terminal_state, "already_terminal");

        let policy = resource.policy.as_ref().expect("policy resource");
        assert_eq!(
            policy.local_action.classified.source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::ClientCancellation
        );
        assert_eq!(
            policy.local_action.action.exhaustion_effect,
            "health_neutral_client_cancellation"
        );
        assert_eq!(
            policy.local_action.action.scope,
            routecodex_v3_error::V3ErrorActionScope::None
        );
        assert!(
            !policy.local_action.action.retry_eligible
                && !policy.local_action.action.health_affecting
        );

        let decision = resource.decision.as_ref().expect("decision resource");
        assert_eq!(
            decision.action,
            routecodex_v3_error::V3Error05ExecutionAction::RejectNonProviderError
        );
        assert!(decision.action.recovery_witness().is_none());
        assert_eq!(
            decision
                .exhaustion
                .local_action
                .classified
                .source
                .source_kind,
            routecodex_v3_error::V3ErrorSourceKind::ClientCancellation
        );

        let outcome = resource.outcome.as_ref().expect("internal outcome");
        assert_eq!(outcome.error_class, "client_cancellation");
        assert!(outcome.health_action.is_none());
        assert_eq!(
            routecodex_v3_error::v3_sse_post_commit_disposition(source),
            routecodex_v3_error::V3SsePostCommitDisposition::CloseEof
        );
    }
}
