use serde_json::Value;

use super::current_projection_view::CurrentProjectionView;
use super::field_operator_library::profile_index;
use super::project_canonical_fields::project_direct_fields;
use super::project_canonical_history::project_direct_history;
use super::project_canonical_history_native::project_direct_native_history;
use super::project_canonical_tools::project_direct_tools;
use crate::hub_v1::V3HubProviderWireProtocol;
use crate::operation_runner::{
    AttemptContext, AttemptDeclarationMap, AttemptProjectionContext, CurrentFieldAssociations,
    ExplicitHistoryPairing, RequestInverseContext, ToolMappingReference,
};
use crate::projection_drop_log::V3ProjectionDropRecord;
use crate::selected_provider_model_binding::{
    bind_v3_selected_provider_model, V3SelectedProviderModelBinding,
};
use routecodex_v3_target::V3TargetCandidate;

pub struct DirectRequestProjection {
    pub payload: Value,
    pub declarations: Vec<ToolMappingReference>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalRequestProjection {
    pub payload: Value,
    /// Stage-3 standard-projection drop records produced by the single Req07
    /// facade. They travel as a typed side channel to the request-scope drop
    /// sink; they are never reconstructed from the payload or logs.
    pub drops: Vec<V3ProjectionDropRecord>,
    pub attempt: AttemptContext,
}

/// Assemble the registered Direct working view. Each inverse operator owns its
/// source fields; the compiled profile selects declaration transformation.
/// This helper performs no raw re-normalization or protocol routing.
pub fn project_canonical_direct_request(
    canonical: &Value,
    inverse: &RequestInverseContext,
    associations: &CurrentFieldAssociations,
    history: &ExplicitHistoryPairing,
) -> Result<DirectRequestProjection, String> {
    let view = CurrentProjectionView::new(canonical, inverse, associations);
    let mut payload = project_direct_fields(&view)?;
    if let Some(fields) = payload.as_object_mut() {
        for history_fields in [
            project_direct_history(&view, history)?,
            project_direct_native_history(&view, history)?,
        ] {
            if let Value::Object(history_fields) = history_fields {
                fields.extend(history_fields);
            }
        }
        let profile = profile_index()?;
        let transform = profile
            .row(&inverse.normalized_protocol, "tools")
            .and_then(|row| row.transform_id());
        let tools = project_direct_tools(&view, transform)?;
        if canonical.get("tools").is_some() {
            fields.insert("tools".into(), tools.tools);
        }
        return Ok(DirectRequestProjection {
            payload,
            declarations: tools.declarations,
        });
    }
    Ok(DirectRequestProjection {
        payload,
        declarations: Vec::new(),
    })
}

/// Project a governed canonical request plus request-local inverse/current
/// resources into one provider payload and one typed attempt context.
///
/// This helper does not publish successful attempts, route, retry, or mutate
/// the immutable original pair/current association input.
pub fn project_canonical_request(
    canonical: &Value,
    inverse: &RequestInverseContext,
    current: &CurrentFieldAssociations,
    history: &ExplicitHistoryPairing,
    execution_mode: crate::hub_v1::V3HubExecutionMode,
    provider_protocol: V3HubProviderWireProtocol,
    selected: &V3TargetCandidate,
    attempt_id: &str,
) -> Result<CanonicalRequestProjection, String> {
    // The declared provider-wire representation requires an object root. A
    // root-level opaque record is the lossless carrier of a client root that
    // was not a JSON object: the canonical Chat request then holds no
    // representable request semantics, only the preserved original bytes. No
    // execution mode can form a provider payload from it, so the single
    // projection facade rejects it here instead of shipping an invented
    // request. Normalization itself stays lossless.
    if inverse
        .opaque_record_references
        .iter()
        .any(|reference| reference.path == "$")
    {
        return Err(
            "client request root is not a JSON object; no provider wire payload can be formed"
                .to_string(),
        );
    }
    let has_web_search = selected
        .model_capabilities
        .iter()
        .any(|capability| capability == "web_search");
    let provider_protocol_id = crate::hub_v1::provider_protocol_compat_id(provider_protocol);

    let (payload, declarations, drops) = match execution_mode {
        crate::hub_v1::V3HubExecutionMode::Direct => {
            let projection =
                project_canonical_direct_request(canonical, inverse, current, history)?;
            let payload = bind_selected_provider_model(projection.payload, selected)?;
            (payload, projection.declarations, Vec::new())
        }
        crate::hub_v1::V3HubExecutionMode::Relay => match provider_protocol {
            V3HubProviderWireProtocol::OpenAiChat => {
                let (payload, drops, declarations) = crate::hub_v1::
                    build_v3_openai_chat_standard_request_from_chat_canonical_for_selected_with_declarations(
                        canonical,
                        inverse,
                        current,
                        Some(selected.model_id.as_str()),
                        selected.web_search_execution_mode,
                        has_web_search,
                    )?;
                (
                    bind_selected_provider_model(payload, selected)?,
                    declarations,
                    drops,
                )
            }
            V3HubProviderWireProtocol::Responses => {
                let (payload, drops, declarations) = crate::hub_v1::
                    build_v3_openai_responses_standard_request_from_chat_canonical_for_selected_with_declarations(
                        canonical,
                        inverse,
                        current,
                        has_web_search,
                    )?;
                (
                    bind_selected_provider_model(payload, selected)?,
                    declarations,
                    drops,
                )
            }
            V3HubProviderWireProtocol::Anthropic => {
                // The single standard Anthropic source is the current canonical
                // Chat view projected through the Anthropic target-protocol
                // whitelist. The same view is the declaration source; the
                // emitter resolves each actual tool emission against current
                // canonical provenance instead of a Responses-only staging
                // projection.
                let standard_view =
                    super::project_canonical_fields::project_canonical_standard_view(canonical)?;
                let (source, drops) = crate::hub_v1::
                    build_v3_anthropic_provider_request_source_from_chat_canonical_with_drops(
                        &standard_view,
                    )?;
                let (wire, declarations) = crate::hub_v1::
                    encode_v3_responses_semantic_as_anthropic_request_with_current_declarations(
                        source,
                        inverse,
                        current,
                    )
                    .map_err(|error| error.to_string())?;
                (
                    bind_selected_provider_model(wire, selected)?,
                    declarations,
                    drops,
                )
            }
            V3HubProviderWireProtocol::Gemini => {
                let (payload, drops, declarations) = crate::hub_v1::
                    build_v3_gemini_standard_request_from_chat_canonical_with_declarations(
                        canonical, inverse, current, &selected.model_capabilities,
                    )?;
                (payload, declarations, drops)
            }
        },
    };

    let attempt = make_attempt_context(
        &declarations,
        attempt_id,
        &provider_protocol_id,
        &selected.model_id,
    );
    Ok(CanonicalRequestProjection {
        payload,
        drops,
        attempt,
    })
}

fn make_attempt_context(
    declarations: &[ToolMappingReference],
    attempt_id: &str,
    provider_protocol: &str,
    model_id: &str,
) -> AttemptContext {
    AttemptContext {
        attempt_id: attempt_id.to_string(),
        projection: AttemptProjectionContext {
            attempt_id: attempt_id.to_string(),
            provider_protocol: provider_protocol.to_string(),
            provider_model: model_id.to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: attempt_id.to_string(),
            provider_protocol: provider_protocol.to_string(),
            provider_model: model_id.to_string(),
            tool_mappings: declarations.to_vec(),
        },
    }
}

fn bind_selected_provider_model(
    payload: Value,
    selected: &V3TargetCandidate,
) -> Result<Value, String> {
    bind_v3_selected_provider_model(payload, selected)
        .map(V3SelectedProviderModelBinding::into_payload)
}

#[cfg(test)]
mod tests {
    use super::project_canonical_direct_request;
    use crate::operation_runner::operators::field_operator_library::normalize_client_request;
    use crate::operation_runner::RequestScopedContextPair;
    use serde_json::{json, Value};

    fn run(protocol: &str, raw: &Value, change: impl FnOnce(&mut Value)) -> Value {
        let normalized = normalize_client_request(protocol, raw).unwrap();
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        let associations = crate::operation_runner::CurrentFieldAssociations::from_normalization(
            &pair.inverse_context,
        );
        let mut canonical = normalized.canonical_request;
        change(&mut canonical);
        project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &associations,
            &pair.explicit_history_pairing,
        )
        .unwrap()
        .payload
    }

    #[test]
    fn registered_direct_composition_preserves_each_protocols_full_request() {
        let samples = [
            (
                "responses",
                json!({"model":"m","input":[{"role":"user","content":"hello"}],
                "tools":[{"type":"custom","name":"apply_patch","format":{"type":"text"}}],
                "vendor.key[0]":{"keep":null}}),
            ),
            (
                "openai-chat",
                json!({"model":"m","messages":[{"role":"user","content":"hello"}],
                "tools":[{"type":"function","function":{"name":"exec","parameters":{"type":"object"}}}]}),
            ),
            (
                "anthropic",
                json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],
                "tools":[{"name":"mcp","input_schema":{"type":"object"}}],"max_tokens":50}),
            ),
            (
                "gemini",
                json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],
                "tools":[{"functionDeclarations":[{"name":"exec","parameters":{"type":"object"}}]}],
                "generationConfig":{"maxOutputTokens":50}}),
            ),
        ];
        for (protocol, raw) in samples {
            assert_eq!(run(protocol, &raw, |_| {}), raw, "{protocol}");
        }
    }

    #[test]
    fn registered_direct_composition_reads_current_command_and_patch_bytes() {
        let command = "printf '%s\\n' 'literal $() and `bytes`'\nprintf complete-tail";
        let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
        let raw = json!({"model":"m","input":[
            {"type":"function_call","call_id":"exec-call","namespace":"functions","name":"exec","arguments":"old"},
            {"type":"custom_tool_call","call_id":"patch-call","namespace":"functions","name":"apply_patch","input":"old"}
        ]});
        let output = run("responses", &raw, |canonical| {
            canonical["messages"][0]["tool_calls"][0]["function"]["arguments"] = json!(command);
            canonical["messages"][1]["tool_calls"][0]["custom"]["input"] = json!(patch);
        });
        assert_eq!(output["input"][0]["arguments"], command);
        assert_eq!(output["input"][1]["input"], patch);
        assert_eq!(output["input"][0]["call_id"], "exec-call");
        assert_eq!(output["input"][1]["namespace"], "functions");
    }
}
