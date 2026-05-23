mod hashline_apply;
mod hashline_hash;
mod hashline_parser;
mod hashline_to_apply_patch;
mod hashline_types;

use serde::{Deserialize, Serialize};

pub use hashline_apply::{apply_hashline_ops, materialize_changeset};
pub use hashline_hash::{compute_line_hash, compute_line_hashes, verify_anchor};
pub use hashline_parser::parse_hashline_ops;
pub use hashline_to_apply_patch::emit_apply_patch;
pub use hashline_types::{
    ApplyResult, HashlineChangeset, HashlineConflict, HashlineError, HashlineErrorCode, HashlineOp,
    OpKind,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineNativeEditInput {
    pub patch: String,
    pub file_path: String,
    pub file_content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineNativeEditResult {
    pub ok: bool,
    pub normalized_patch: Option<String>,
    pub changeset: Option<HashlineChangeset>,
    pub error: Option<HashlineError>,
}

pub fn run_hashline_native_edit(input: HashlineNativeEditInput) -> HashlineNativeEditResult {
    match parse_hashline_ops(&input.patch).and_then(|ops| {
        apply_hashline_ops(&ops, input.file_path.as_str(), input.file_content.as_str())
    }) {
        Ok(changeset) => HashlineNativeEditResult {
            ok: true,
            normalized_patch: Some(emit_apply_patch(&changeset)),
            changeset: Some(changeset),
            error: None,
        },
        Err(error) => HashlineNativeEditResult {
            ok: false,
            normalized_patch: None,
            changeset: None,
            error: Some(error),
        },
    }
}
