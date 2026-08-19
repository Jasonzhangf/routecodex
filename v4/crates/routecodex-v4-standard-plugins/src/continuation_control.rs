use routecodex_v4_cordis_bridge::{
    ExecCtx, ScopeContinuationOwner, ScopeEntryProtocol, ScopeSessionCommand, ScopeSessionOperation,
};
use routecodex_v4_plugin_contract::{PluginEffect, PluginKind, PluginPhase};
use serde::Deserialize;
use serde_json::Value;

use crate::{plugin, PluginCategory, StandardPlugin};

const COMMIT_ID: &str = "v4.std.continuation.commit";
const RELEASE_ID: &str = "v4.std.continuation.release";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContinuationControlFacts {
    entry_protocol: ScopeEntryProtocol,
    continuation_owner: ScopeContinuationOwner,
    pipeline_id: String,
    port: u16,
    session_scope: String,
    conversation_scope: String,
    request_id: String,
    full_input_hash: String,
    sequence: u64,
}

pub(crate) fn descriptors() -> Vec<StandardPlugin> {
    vec![
        plugin(
            "v4.std.continuation.commit",
            PluginCategory::Control,
            "V4HubRespChatProcess03Governed",
            "response_chat_process",
            Some(3),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            500,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.scope_command"],
        ),
        plugin(
            "v4.std.continuation.release",
            PluginCategory::Control,
            "V4HubRespChatProcess03Governed",
            "response_chat_process",
            Some(3),
            PluginKind::Control,
            PluginEffect::ControlOnly,
            PluginPhase::Control,
            510,
            vec!["v4.control.metadata_center"],
            vec!["v4.control.scope_command"],
        ),
    ]
}

fn scope_command(control: &Value, operation: ScopeSessionOperation) -> Result<Value, String> {
    let scope = control
        .get("continuation")
        .ok_or_else(|| "metadata_center.continuation control is required".to_string())?;
    let facts: ContinuationControlFacts = serde_json::from_value(scope.clone())
        .map_err(|error| format!("invalid metadata_center.continuation control: {error}"))?;
    if facts.pipeline_id.trim().is_empty()
        || facts.session_scope.trim().is_empty()
        || facts.conversation_scope.trim().is_empty()
        || facts.request_id.trim().is_empty()
        || facts.full_input_hash.trim().is_empty()
        || facts.port == 0
    {
        return Err("metadata_center.continuation required field is empty".to_string());
    }
    serde_json::to_value(ScopeSessionCommand {
        entry_protocol: facts.entry_protocol,
        continuation_owner: facts.continuation_owner,
        pipeline_id: facts.pipeline_id,
        port: facts.port,
        session_scope: facts.session_scope,
        conversation_scope: facts.conversation_scope,
        request_id: facts.request_id,
        full_input_hash: facts.full_input_hash,
        operation,
        sequence: facts.sequence,
    })
    .map_err(|error| format!("build scope_session control value: {error}"))
}

fn commit(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let control = ctx
        .read_control_resource("v4.control.metadata_center")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| "metadata_center control is required".to_string())?;
    let value = scope_command(&control, ScopeSessionOperation::Bind)?;
    ctx.write_control_resource("v4.control.scope_command", value)
        .map_err(|error| error.to_string())
}

fn release(ctx: &mut ExecCtx<'_>) -> Result<(), String> {
    let control = ctx
        .read_control_resource("v4.control.metadata_center")
        .map_err(|error| error.to_string())?
        .cloned()
        .ok_or_else(|| "metadata_center control is required".to_string())?;
    let value = scope_command(&control, ScopeSessionOperation::Release)?;
    ctx.write_control_resource("v4.control.scope_command", value)
        .map_err(|error| error.to_string())
}

pub(crate) fn handles() -> Vec<(&'static str, fn(&mut ExecCtx<'_>) -> Result<(), String>)> {
    vec![
        (
            COMMIT_ID,
            commit as fn(&mut ExecCtx<'_>) -> Result<(), String>,
        ),
        (RELEASE_ID, release),
    ]
}
