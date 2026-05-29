use crate::shared_tooling::collapse_extra_newlines_and_trim;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockClearDirectiveOutput {
    pub had_clear: bool,
    pub next: String,
}

fn is_clock_clear_marker(raw: &str) -> bool {
    let compact = raw
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    compact == "clock:clear"
}

pub fn strip_clock_clear_directive_text(text: String) -> ClockClearDirectiveOutput {
    if text.is_empty() {
        return ClockClearDirectiveOutput {
            had_clear: false,
            next: text,
        };
    }

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut had_clear = false;

    while cursor < text.len() {
        let remaining = &text[cursor..];
        let Some(start_rel) = remaining.find("<**") else {
            out.push_str(remaining);
            break;
        };

        let start = cursor + start_rel;
        out.push_str(&text[cursor..start]);

        let marker_body_start = start + 3;
        let marker_remaining = &text[marker_body_start..];
        let Some(end_rel) = marker_remaining.find("**>") else {
            out.push_str(&text[start..]);
            break;
        };

        let marker_body_end = marker_body_start + end_rel;
        let marker_end = marker_body_end + 3;
        let marker_inner = &text[marker_body_start..marker_body_end];

        if is_clock_clear_marker(marker_inner) {
            had_clear = true;
        } else {
            out.push_str(&text[start..marker_end]);
        }

        cursor = marker_end;
    }

    if had_clear {
        out = collapse_extra_newlines_and_trim(&out);
    }

    ClockClearDirectiveOutput {
        had_clear,
        next: out,
    }
}
