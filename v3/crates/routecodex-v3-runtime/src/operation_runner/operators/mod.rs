mod capture_client_json;
mod current_field_associations;
mod current_projection_view;
mod field_operator_gemini;
mod field_operator_helpers;
mod field_operator_history;
mod field_operator_instructions;
mod field_operator_library;
mod field_operator_profiles;
mod field_operator_records;
mod hosted_history_projection;
mod normalize_request_losslessly;
mod project_canonical_fields;
mod project_canonical_history;
mod project_canonical_history_native;
mod project_canonical_instructions;
mod project_canonical_paths;
mod project_canonical_request;
mod project_canonical_siblings;
mod project_canonical_tools;

#[cfg(test)]
mod field_operator_library_tests;
#[cfg(test)]
mod field_operator_tool_output_r28_tests;

pub(super) use capture_client_json::CaptureClientJsonOperator;
pub use current_field_associations::{
    apply_canonical_field_edit, CanonicalFieldEdit, CurrentFieldAssociation,
    CurrentFieldAssociations,
};
pub use hosted_history_projection::{project_hosted_history_emissions, HostedHistoryEmission};
pub(super) use normalize_request_losslessly::NormalizeRequestLosslesslyOperator;
pub(crate) use project_canonical_fields::project_canonical_standard_view;
pub(crate) use project_canonical_instructions::is_unchanged_native_instruction_separator;
pub use project_canonical_request::{
    project_canonical_direct_request, project_canonical_request, CanonicalRequestProjection,
    DirectRequestProjection,
};
pub(crate) use project_canonical_siblings::{
    restore_standard_projection_siblings, restore_standard_transform_siblings,
};
pub(crate) use project_canonical_tools::project_registered_native_gemini_tools;
