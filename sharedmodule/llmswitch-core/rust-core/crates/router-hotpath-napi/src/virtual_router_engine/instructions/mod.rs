mod clean;
mod parse;
mod path;
mod state;
mod types;

pub(crate) use clean::{
    clean_malformed_routing_instruction_markers, clean_routing_instruction_markers,
};
pub(crate) use parse::{
    has_routing_instruction_marker_in_messages,
    has_routing_instruction_marker_in_responses_context, parse_routing_instructions_from_messages,
    parse_routing_instructions_from_request, parse_single_instruction,
};
pub(crate) use path::{
    is_precommand_script_path_allowed, plan_auth_file_resolution_for_host,
    plan_provider_config_root_for_host, plan_routecodex_config_loader_paths_for_host,
    resolve_rcc_path_for_host, resolve_rcc_path_for_host_with_env,
    resolve_rcc_snapshots_dir_for_host_with_env, resolve_rcc_user_dir_for_host,
    resolve_rcc_user_dir_for_host_with_env, resolve_routecodex_config_path_for_host,
    resolve_auth_file_key_for_host, with_rcc_user_dir_override, AuthFileResolvePlanInput,
    ProviderConfigRootPlanInput, RccSnapshotsDirResolveInput, RouteCodexConfigLoaderPathPlanInput,
    RouteCodexConfigPathResolveInput,
};
pub(crate) use state::{
    apply_routing_instructions, build_metadata_instructions, ensure_stop_message_mode_max_repeats,
    has_client_inject_fields, pre_command_state_snapshot, stop_message_state_snapshot,
    strip_client_inject_fields, strip_stop_message_fields,
};
pub(crate) use types::{
    InstructionTarget, PreCommandInstruction, RoutingInstruction, RoutingInstructionState,
    StopMessageInstruction,
};
