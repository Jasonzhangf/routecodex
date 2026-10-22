//! First-frame commit gate for Responses Direct attempts.
//!
//! The client channel becomes append-only at the first committed business
//! frame, so the commit decision must prove two things from the buffered
//! provider prefix alone:
//!
//! 1. the complete-attempt text governance of this attempt is the identity on
//!    everything flushed so far, and
//! 2. the flushed prefix already carries visible business text.
//!
//! (2) makes the complete-attempt empty/blank/invisible-final judgment
//! irrevocably true: visible text only grows, so no later provider frame can
//! turn this attempt into a `provider_response_empty` 502 that would need a
//! retry or a provider switch. Reasoning-only and whitespace-only deltas never
//! commit.
//!
//! (1) keeps the registered Direct response hook authoritative. Both text
//! governance owners that can rewrite a plain Responses attempt are content
//! driven: the thinking-tag rewrite moves `<thinking>` bodies out of
//! `output_text`, and the DSML owner removes standalone protocol labels without
//! any tool declaration. The probe treats a prefix as governed only while none
//! of those exact markers appears in it and while the newest observed text does
//! not end with a marker prefix; a marker split across two provider frames is
//! therefore never committed half-way.
//!
//! The same probe stays active after the commit. The collector stops
//! projecting further frames when a marker appears, because a committed
//! append-only channel cannot retract them, and holds a frame whose tail may
//! still become a marker until the next observation resolves it.

use serde_json::Value;

use crate::hub_v1::V3HubProviderWireProtocol;

/// Number of trailing characters kept for the split-marker check. Longer than
/// any governed marker, so a full marker is always found inside the tail.
const TEXT_TAIL_CHARS: usize = 64;

#[derive(Debug)]
pub(crate) struct V3DirectPrefixCommitProbe {
    protocol: V3HubProviderWireProtocol,
    markers: Vec<&'static str>,
    visible_text: bool,
    confirmed_marker: bool,
    text_tail: String,
}

impl V3DirectPrefixCommitProbe {
    pub(crate) fn new(protocol: V3HubProviderWireProtocol) -> Self {
        Self {
            protocol,
            markers: crate::direct_response_hooks::v3_direct_governed_text_markers(),
            visible_text: false,
            confirmed_marker: false,
            text_tail: String::new(),
        }
    }

    /// Observe one decoded provider event of the buffered attempt prefix.
    pub(crate) fn observe_event(&mut self, event: &Value) {
        if self.protocol != V3HubProviderWireProtocol::Responses {
            return;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => self.observe_text(event.get("delta")),
            Some("response.output_text.done") => self.observe_text(event.get("text")),
            Some("response.content_part.added" | "response.content_part.done") => {
                self.observe_part(event.get("part"));
            }
            Some("response.output_item.added" | "response.output_item.done") => {
                self.observe_item(event.get("item"));
            }
            Some("response.created" | "response.in_progress" | "response.queued") => {
                for item in event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    self.observe_item(Some(item));
                }
            }
            _ => {}
        }
    }

    fn observe_item(&mut self, item: Option<&Value>) {
        let Some(item) = item else {
            return;
        };
        // Reasoning and tool-call items are never text-governed, so only
        // assistant message carriers can move bytes between `output_text` and
        // synthesized reasoning.
        if item.get("type").and_then(Value::as_str) != Some("message") {
            return;
        }
        self.observe_text(item.get("text"));
        for part in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.observe_part(Some(part));
        }
    }

    fn observe_part(&mut self, part: Option<&Value>) {
        let Some(part) = part else {
            return;
        };
        if part.get("type").and_then(Value::as_str) != Some("output_text") {
            return;
        }
        self.observe_text(part.get("text"));
    }

    fn observe_text(&mut self, text: Option<&Value>) {
        let Some(text) = text.and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.visible_text |= crate::hub_v1::v3_text_has_visible_content(text);
        self.confirmed_marker |= self.markers.iter().any(|marker| text.contains(marker));
        self.text_tail = text
            .chars()
            .rev()
            .take(TEXT_TAIL_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    }

    /// True only while the whole buffered prefix is governed business content:
    /// no marker any text-governance owner could act on was observed, the newest
    /// text does not end with a marker prefix, and the prefix already carries
    /// visible text.
    pub(crate) fn is_committable(&self) -> bool {
        self.visible_text && !self.confirmed_marker && !self.trailing_marker_prefix()
    }

    /// A complete governed marker was observed. A committed channel cannot
    /// retract the frames that carry it, so the attempt must stop projecting.
    pub(crate) fn confirmed_governed_marker(&self) -> bool {
        self.confirmed_marker
    }

    /// The newest observed text ends with a proper prefix of a governed marker.
    /// The next provider frame decides whether it becomes a marker, so a
    /// committed channel must not project this frame yet.
    pub(crate) fn trailing_marker_prefix(&self) -> bool {
        if self.text_tail.is_empty() {
            return false;
        }
        self.markers.iter().any(|marker| {
            marker.char_indices().any(|(index, ch)| {
                let prefix_len = index + ch.len_utf8();
                prefix_len < marker.len() && self.text_tail.ends_with(&marker[..prefix_len])
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe() -> V3DirectPrefixCommitProbe {
        V3DirectPrefixCommitProbe::new(V3HubProviderWireProtocol::Responses)
    }

    fn delta(text: &str) -> Value {
        json!({"type": "response.output_text.delta", "delta": text})
    }

    #[test]
    fn plain_visible_text_is_committable() {
        let mut probe = probe();
        probe.observe_event(&json!({"type": "response.created", "response": {"output": []}}));
        assert!(!probe.is_committable());
        probe.observe_event(&delta("Hello"));
        assert!(probe.is_committable());
    }

    #[test]
    fn whitespace_only_and_reasoning_do_not_commit() {
        let mut probe = probe();
        probe.observe_event(&delta("   \n"));
        assert!(!probe.is_committable());
        probe.observe_event(
            &json!({"type": "response.reasoning_summary_text.delta", "delta": "plan"}),
        );
        assert!(!probe.is_committable());
        probe.observe_event(&json!({"type": "response.output_item.added", "item": {"type": "reasoning", "id": "rs_1"}}));
        assert!(!probe.is_committable());
    }

    #[test]
    fn ordinary_angle_bracket_prose_is_committable() {
        let mut probe = probe();
        probe.observe_event(&delta("if a < b then b > a"));
        assert!(
            probe.is_committable(),
            "plain comparison operators are not governed markers"
        );
    }

    #[test]
    fn thinking_wrap_never_commits() {
        let mut probe = probe();
        probe.observe_event(&delta("<thinking>secret</thinking>answer"));
        assert!(!probe.is_committable());
        assert!(probe.confirmed_governed_marker());
        probe.observe_event(&delta("more visible text"));
        assert!(
            !probe.is_committable(),
            "a governed marker stops certification for the attempt"
        );
    }

    #[test]
    fn analysis_label_never_commits() {
        let mut probe = probe();
        probe.observe_event(&delta("Visible.\n<|end▁of▁analysis|>\n"));
        assert!(!probe.is_committable());
        assert!(probe.confirmed_governed_marker());
    }

    #[test]
    fn split_marker_prefix_is_not_committable_until_resolved() {
        let mut probe = probe();
        probe.observe_event(&delta("visible <think"));
        assert!(
            !probe.is_committable(),
            "a trailing marker prefix is unresolved, not safe"
        );
        assert!(!probe.confirmed_governed_marker());
        probe.observe_event(&delta("ing>hidden</thinking>"));
        assert!(probe.confirmed_governed_marker());
        assert!(!probe.is_committable());
    }

    #[test]
    fn resolved_false_marker_prefix_becomes_committable() {
        let mut probe = probe();
        probe.observe_event(&delta("1 <"));
        assert!(!probe.is_committable());
        probe.observe_event(&delta(" 2"));
        assert!(
            probe.is_committable(),
            "an unresolved prefix that never became a marker is safe"
        );
        assert!(!probe.confirmed_governed_marker());
    }

    #[test]
    fn partial_item_and_snapshot_carriers_are_scanned() {
        let mut probe = probe();
        probe.observe_event(&json!({
            "type": "response.created",
            "response": {"output": [{"type": "message", "content": [{"type": "output_text", "text": "<thinking>"}]}]}
        }));
        probe.observe_event(&delta("plain"));
        assert!(!probe.is_committable());
    }

    #[test]
    fn other_protocols_never_commit() {
        let mut probe = V3DirectPrefixCommitProbe::new(V3HubProviderWireProtocol::OpenAiChat);
        probe.observe_event(&delta("Hello"));
        assert!(!probe.is_committable());
    }
}
