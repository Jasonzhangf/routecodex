use super::hashline_types::{HashlineError, HashlineErrorCode, HashlineOp, OpKind};

fn parse_u32(raw: &str, src_line: u32, label: &str) -> Result<u32, HashlineError> {
    raw.parse::<u32>().map_err(|_| {
        HashlineError::new(
            HashlineErrorCode::ParseError,
            format!("invalid {} `{}`", label, raw),
        )
        .with_src_line(src_line)
    })
}

fn parse_header(line: &str, src_line: u32) -> Result<HashlineOp, HashlineError> {
    let trimmed = line.trim();
    let mut parts = trimmed.split_whitespace();
    let op_token = parts.next().ok_or_else(|| {
        HashlineError::new(HashlineErrorCode::ParseError, "missing hashline op")
            .with_src_line(src_line)
    })?;

    let op = match op_token {
        "<" => OpKind::Context,
        "+" => OpKind::Insert,
        "-" => OpKind::Delete,
        "=" => OpKind::Replace,
        _ => {
            return Err(
                HashlineError::new(
                    HashlineErrorCode::ParseError,
                    format!("unsupported hashline op `{}`", op_token),
                )
                .with_src_line(src_line),
            )
        }
    };

    let line_num = parts.next().map(|raw| parse_u32(raw, src_line, "line number")).transpose()?;
    let anchor_bigram = match op {
        OpKind::Delete | OpKind::Replace => {
            let raw = parts.next().ok_or_else(|| {
                HashlineError::new(
                    HashlineErrorCode::ParseError,
                    "delete/replace op requires anchor_bigram",
                )
                .with_src_line(src_line)
            })?;
            Some(parse_u32(raw, src_line, "anchor_bigram")?)
        }
        OpKind::Insert => {
            let _legacy_ignored_anchor = parts.next();
            None
        }
        _ => None,
    };

    if parts.next().is_some() {
        return Err(
            HashlineError::new(
                HashlineErrorCode::ParseError,
                "phase1 hashline parser only supports op + line_num + anchor_bigram",
            )
            .with_src_line(src_line),
        );
    }

    Ok(HashlineOp {
        op,
        file_path: None,
        line_num,
        payload: Vec::new(),
        anchor_bigram,
        src_line,
    })
}

fn is_header_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    matches!(
        trimmed.chars().next(),
        Some('<') | Some('+') | Some('-') | Some('=')
    ) && trimmed
        .chars()
        .nth(1)
        .map(|ch| ch.is_whitespace())
        .unwrap_or(true)
}

fn ensure_payload_requirements(op: &HashlineOp) -> Result<(), HashlineError> {
    match op.op {
        OpKind::Insert | OpKind::Replace if op.payload.is_empty() => Err(
            HashlineError::new(
                HashlineErrorCode::ParseError,
                "insert/replace op requires payload lines",
            )
            .with_src_line(op.src_line),
        ),
        _ => Ok(()),
    }
}

pub fn parse_hashline_ops(patch_body: &str) -> Result<Vec<HashlineOp>, HashlineError> {
    if patch_body.trim().is_empty() {
        return Err(HashlineError::new(
            HashlineErrorCode::EmptyPatch,
            "hashline patch body is empty",
        ));
    }

    let mut ops: Vec<HashlineOp> = Vec::new();
    let mut current_idx: Option<usize> = None;

    for (idx, raw_line) in patch_body.lines().enumerate() {
        let src_line = (idx + 1) as u32;
        if raw_line.trim().is_empty() {
            if let Some(op_idx) = current_idx {
                ops[op_idx].payload.push(String::new());
            }
            continue;
        }

        if is_header_line(raw_line) {
            if let Some(op_idx) = current_idx.take() {
                ensure_payload_requirements(&ops[op_idx])?;
            }
            ops.push(parse_header(raw_line, src_line)?);
            current_idx = Some(ops.len() - 1);
            continue;
        }

        let op_idx = current_idx.ok_or_else(|| {
            HashlineError::new(
                HashlineErrorCode::ParseError,
                "payload line encountered before any hashline op header",
            )
            .with_src_line(src_line)
        })?;
        match ops[op_idx].op {
            OpKind::Insert | OpKind::Replace => ops[op_idx].payload.push(raw_line.to_string()),
            _ => {
                return Err(
                    HashlineError::new(
                        HashlineErrorCode::ParseError,
                        "only insert/replace ops may carry payload lines",
                    )
                    .with_src_line(src_line),
                )
            }
        }
    }

    if let Some(op_idx) = current_idx {
        ensure_payload_requirements(&ops[op_idx])?;
    }

    if ops.is_empty() {
        return Err(HashlineError::new(
            HashlineErrorCode::EmptyPatch,
            "hashline patch body produced no ops",
        ));
    }

    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::parse_hashline_ops;
    use crate::hashline::OpKind;

    #[test]
    fn insert_op_accepts_legacy_anchor_token_without_changing_semantics() {
        let ops = parse_hashline_ops("+ 2 deadbeef\nhello").expect("parse ok");
        assert_eq!(ops.len(), 1);
        assert!(matches!(ops[0].op, OpKind::Insert));
        assert_eq!(ops[0].line_num, Some(2));
        assert_eq!(ops[0].anchor_bigram, None);
        assert_eq!(ops[0].payload, vec!["hello".to_string()]);
    }
}
