#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct V3ThinkingTagTextProjection {
    pub(crate) visible: String,
    pub(crate) reasoning: Vec<String>,
    pub(crate) tag_observed: bool,
}

pub(super) fn project_v3_thinking_tag_text(text: &str) -> V3ThinkingTagTextProjection {
    const OPEN: &str = "<thinking>";
    const CLOSE: &str = "</thinking>";
    let mut projection = V3ThinkingTagTextProjection::default();
    let mut remaining = text;
    while let Some(open_at) = remaining.find(OPEN) {
        projection.tag_observed = true;
        projection.visible.push_str(&remaining[..open_at]);
        let after_open = &remaining[open_at + OPEN.len()..];
        if let Some(close_at) = after_open.find(CLOSE) {
            let reasoning = &after_open[..close_at];
            if !reasoning.is_empty() {
                projection.reasoning.push(reasoning.to_string());
            }
            remaining = &after_open[close_at + CLOSE.len()..];
        } else {
            projection.visible.push_str(after_open);
            remaining = "";
            break;
        }
    }
    if !remaining.is_empty() {
        if remaining.contains(CLOSE) {
            projection.tag_observed = true;
            projection.visible.push_str(&remaining.replace(CLOSE, ""));
        } else {
            projection.visible.push_str(remaining);
        }
    }
    projection
}
