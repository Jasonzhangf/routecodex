use super::hashline_types::{ApplyResult, HashlineChangeset, OpKind};

fn push_lines(out: &mut String, prefix: &str, lines: &[String]) {
    for line in lines {
        out.push_str(prefix);
        out.push_str(line);
        out.push('\n');
    }
}

fn emit_result_hunk(out: &mut String, result: &ApplyResult) {
    out.push_str("@@\n");
    match result.op {
        OpKind::Insert => {
            push_lines(out, "+", &result.new_lines);
        }
        OpKind::Delete => {
            push_lines(out, "-", &result.old_lines);
        }
        OpKind::Replace => {
            push_lines(out, "-", &result.old_lines);
            push_lines(out, "+", &result.new_lines);
        }
        OpKind::Context => {}
    }
}

pub fn emit_apply_patch(changeset: &HashlineChangeset) -> String {
    let mut out = String::new();
    out.push_str("*** Begin Patch\n");
    out.push_str("*** Update File: ");
    out.push_str(&changeset.file_path);
    out.push('\n');

    for result in &changeset.results {
        emit_result_hunk(&mut out, result);
    }

    out.push_str("*** End Patch");
    out
}
