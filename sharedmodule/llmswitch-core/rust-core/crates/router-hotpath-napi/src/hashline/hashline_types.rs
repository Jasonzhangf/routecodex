use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Context,
    Insert,
    Delete,
    Replace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineOp {
    pub op: OpKind,
    pub file_path: Option<String>,
    pub line_num: Option<u32>,
    pub payload: Vec<String>,
    pub anchor_bigram: Option<u32>,
    pub src_line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub file_path: String,
    pub op: OpKind,
    pub line_idx: u32,
    pub old_hash: Option<u32>,
    pub new_hash: Option<u32>,
    pub lines: Vec<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineConflict {
    pub kind: String,
    pub op_idx: usize,
    pub line_num: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineChangeset {
    pub file_path: String,
    pub results: Vec<ApplyResult>,
    pub has_conflict: bool,
    pub conflicts: Vec<HashlineConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HashlineErrorCode {
    #[serde(rename = "HASHLINE_PARSE_ERROR")]
    ParseError,
    #[serde(rename = "HASHLINE_ANCHOR_MISMATCH")]
    AnchorMismatch,
    #[serde(rename = "HASHLINE_LINE_NOT_FOUND")]
    LineNotFound,
    #[serde(rename = "HASHLINE_OP_CONFLICT")]
    OpConflict,
    #[serde(rename = "HASHLINE_MULTI_FILE_UNSUPPORTED")]
    MultiFileUnsupported,
    #[serde(rename = "HASHLINE_EMPTY_PATCH")]
    EmptyPatch,
    #[serde(rename = "HASHLINE_INTERNAL_ERROR")]
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashlineError {
    pub code: HashlineErrorCode,
    pub message: String,
    pub src_line: Option<u32>,
    pub op_idx: Option<usize>,
    pub expected: Option<u32>,
    pub computed: Option<u32>,
}

impl HashlineError {
    pub fn new(code: HashlineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            src_line: None,
            op_idx: None,
            expected: None,
            computed: None,
        }
    }

    pub fn with_src_line(mut self, src_line: u32) -> Self {
        self.src_line = Some(src_line);
        self
    }

    pub fn with_op_idx(mut self, op_idx: usize) -> Self {
        self.op_idx = Some(op_idx);
        self
    }

    pub fn with_anchor(mut self, expected: u32, computed: u32) -> Self {
        self.expected = Some(expected);
        self.computed = Some(computed);
        self
    }
}
