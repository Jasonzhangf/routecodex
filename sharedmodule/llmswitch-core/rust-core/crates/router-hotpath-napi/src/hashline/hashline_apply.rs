use std::collections::HashSet;

use super::hashline_hash::compute_line_hash;
use super::hashline_types::{
    ApplyResult, HashlineChangeset, HashlineError, HashlineErrorCode, HashlineOp, OpKind,
};

fn split_lines(file_content: &str) -> Vec<String> {
    if file_content.is_empty() {
        return Vec::new();
    }
    file_content.split('\n').map(|line| line.to_string()).collect()
}

fn join_lines(lines: &[String]) -> String {
    lines.join("\n")
}

fn line_num_to_index(line_num: u32) -> Result<usize, HashlineError> {
    usize::try_from(line_num.saturating_sub(1)).map_err(|_| {
        HashlineError::new(
            HashlineErrorCode::InternalError,
            "failed to convert line number to usize index",
        )
    })
}

fn ensure_single_file_scope(op: &HashlineOp, file_path: &str, op_idx: usize) -> Result<(), HashlineError> {
    if let Some(op_file_path) = op.file_path.as_ref() {
        if op_file_path != file_path {
            return Err(
                HashlineError::new(
                    HashlineErrorCode::MultiFileUnsupported,
                    "phase1 hashline only supports a single target file",
                )
                .with_src_line(op.src_line)
                .with_op_idx(op_idx),
            );
        }
    }
    Ok(())
}

fn ensure_no_conflict(ops: &[HashlineOp]) -> Result<(), HashlineError> {
    let mut seen = HashSet::<u32>::new();
    for (op_idx, op) in ops.iter().enumerate() {
        let Some(line_num) = op.line_num else {
            continue;
        };
        if matches!(op.op, OpKind::Context) {
            continue;
        }
        if !seen.insert(line_num) {
            return Err(
                HashlineError::new(
                    HashlineErrorCode::OpConflict,
                    format!("multiple mutating ops target line {}", line_num),
                )
                .with_src_line(op.src_line)
                .with_op_idx(op_idx),
            );
        }
    }
    Ok(())
}

fn read_line<'a>(
    original_lines: &'a [String],
    line_num: u32,
    op: &HashlineOp,
    op_idx: usize,
) -> Result<&'a String, HashlineError> {
    let line_idx = line_num_to_index(line_num)?;
    original_lines.get(line_idx).ok_or_else(|| {
        HashlineError::new(
            HashlineErrorCode::LineNotFound,
            format!("line {} not found in target file", line_num),
        )
        .with_src_line(op.src_line)
        .with_op_idx(op_idx)
    })
}

pub fn apply_hashline_ops(
    ops: &[HashlineOp],
    file_path: &str,
    file_content: &str,
) -> Result<HashlineChangeset, HashlineError> {
    if ops.is_empty() {
        return Err(HashlineError::new(
            HashlineErrorCode::EmptyPatch,
            "hashline apply received empty op list",
        ));
    }

    ensure_no_conflict(ops)?;

    let original_lines = split_lines(file_content);
    let mut next_lines = original_lines.clone();
    let mut indexed_ops: Vec<(usize, &HashlineOp)> = ops.iter().enumerate().collect();
    indexed_ops.sort_by(|a, b| {
        let a_line = a.1.line_num.unwrap_or(u32::MAX);
        let b_line = b.1.line_num.unwrap_or(u32::MAX);
        b_line.cmp(&a_line).then_with(|| b.0.cmp(&a.0))
    });

    let mut results: Vec<ApplyResult> = Vec::new();

    for (op_idx, op) in indexed_ops {
        ensure_single_file_scope(op, file_path, op_idx)?;

        match op.op {
            OpKind::Context => continue,
            OpKind::Delete | OpKind::Replace => {
                let line_num = op.line_num.ok_or_else(|| {
                    HashlineError::new(
                        HashlineErrorCode::ParseError,
                        "delete/replace op requires line_num",
                    )
                    .with_src_line(op.src_line)
                    .with_op_idx(op_idx)
                })?;
                let original_line = read_line(&original_lines, line_num, op, op_idx)?.clone();
                let expected = op.anchor_bigram.ok_or_else(|| {
                    HashlineError::new(
                        HashlineErrorCode::ParseError,
                        "delete/replace op requires anchor_bigram",
                    )
                    .with_src_line(op.src_line)
                    .with_op_idx(op_idx)
                })?;
                let computed = compute_line_hash(&original_line);
                if computed != expected {
                    return Err(
                        HashlineError::new(
                            HashlineErrorCode::AnchorMismatch,
                            format!("anchor mismatch at line {}", line_num),
                        )
                        .with_src_line(op.src_line)
                        .with_op_idx(op_idx)
                        .with_anchor(expected, computed),
                    );
                }

                let line_idx = line_num_to_index(line_num)?;
                let current_line = next_lines.get(line_idx).cloned().ok_or_else(|| {
                    HashlineError::new(
                        HashlineErrorCode::LineNotFound,
                        format!("line {} no longer exists during apply", line_num),
                    )
                    .with_src_line(op.src_line)
                    .with_op_idx(op_idx)
                })?;

                let old_hash = Some(compute_line_hash(&current_line));
                let old_lines = vec![current_line.clone()];
                let (new_lines, new_hash, lines) = match op.op {
                    OpKind::Delete => (Vec::new(), None, old_lines.clone()),
                    OpKind::Replace => {
                        let new_lines = op.payload.clone();
                        let new_hash = new_lines.first().map(|line| compute_line_hash(line));
                        let lines = new_lines.clone();
                        (new_lines, new_hash, lines)
                    }
                    _ => unreachable!(),
                };

                next_lines.remove(line_idx);
                for replacement in new_lines.iter().rev() {
                    next_lines.insert(line_idx, replacement.clone());
                }

                results.push(ApplyResult {
                    file_path: file_path.to_string(),
                    op: op.op.clone(),
                    line_idx: line_idx as u32,
                    old_hash,
                    new_hash,
                    lines,
                    old_lines,
                    new_lines,
                });
            }
            OpKind::Insert => {
                let insert_idx = match op.line_num {
                    Some(line_num) => {
                        let line_idx = line_num_to_index(line_num)?;
                        if line_idx > next_lines.len() {
                            return Err(
                                HashlineError::new(
                                    HashlineErrorCode::LineNotFound,
                                    format!("insert line {} exceeds file length", line_num),
                                )
                                .with_src_line(op.src_line)
                                .with_op_idx(op_idx),
                            );
                        }
                        line_idx
                    }
                    None => next_lines.len(),
                };
                let new_lines = op.payload.clone();
                let new_hash = new_lines.first().map(|line| compute_line_hash(line));
                for line in new_lines.iter().rev() {
                    next_lines.insert(insert_idx, line.clone());
                }
                results.push(ApplyResult {
                    file_path: file_path.to_string(),
                    op: op.op.clone(),
                    line_idx: insert_idx as u32,
                    old_hash: None,
                    new_hash,
                    lines: new_lines.clone(),
                    old_lines: Vec::new(),
                    new_lines,
                });
            }
        }
    }

    results.sort_by_key(|item| item.line_idx);

    Ok(HashlineChangeset {
        file_path: file_path.to_string(),
        results,
        has_conflict: false,
        conflicts: Vec::new(),
    })
}

pub fn materialize_changeset(
    changeset: &HashlineChangeset,
    file_content: &str,
) -> Result<String, HashlineError> {
    let mut next_lines = split_lines(file_content);
    let mut results = changeset.results.clone();
    results.sort_by(|a, b| b.line_idx.cmp(&a.line_idx));

    for result in results {
        let line_idx = result.line_idx as usize;
        match result.op {
            OpKind::Delete => {
                if line_idx >= next_lines.len() {
                    return Err(HashlineError::new(
                        HashlineErrorCode::LineNotFound,
                        format!("materialize delete line {} out of bounds", result.line_idx + 1),
                    ));
                }
                next_lines.remove(line_idx);
            }
            OpKind::Replace => {
                if line_idx >= next_lines.len() {
                    return Err(HashlineError::new(
                        HashlineErrorCode::LineNotFound,
                        format!("materialize replace line {} out of bounds", result.line_idx + 1),
                    ));
                }
                next_lines.remove(line_idx);
                for line in result.new_lines.iter().rev() {
                    next_lines.insert(line_idx, line.clone());
                }
            }
            OpKind::Insert => {
                if line_idx > next_lines.len() {
                    return Err(HashlineError::new(
                        HashlineErrorCode::LineNotFound,
                        format!("materialize insert line {} out of bounds", result.line_idx + 1),
                    ));
                }
                for line in result.new_lines.iter().rev() {
                    next_lines.insert(line_idx, line.clone());
                }
            }
            OpKind::Context => {}
        }
    }

    Ok(join_lines(&next_lines))
}
