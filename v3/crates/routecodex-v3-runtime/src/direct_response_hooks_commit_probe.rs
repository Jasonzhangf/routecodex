//! First-frame commit gate for Responses Direct attempts.
//!
//! The client channel becomes append-only at the first committed business
//! frame, so the commit decision must prove two things from the buffered
//! provider prefix alone:
//!
//! 1. the complete-attempt text governance of this attempt is the identity on
//!    everything flushed so far, and
//! 2. the flushed prefix already carries client-visible business content.
//!
//! (2) makes the complete-attempt empty/blank/invisible-final judgment
//! irrevocably true: both carriers only grow, so no later provider frame can
//! turn this attempt into a `provider_response_empty` 502 that would need a
//! retry or a provider switch. The two carriers are visible `output_text` and a
//! named tool-call output item (`function_call`, `custom_tool_call`,
//! `mcp_call`). The business-content classifier already accepts every typed
//! output item as deliverable, and no text-governance owner rewrites a tool
//! name, so a named tool-call start certifies the attempt exactly as visible
//! text does. Reasoning-only and whitespace-only deltas never commit, and a
//! nameless item proves nothing.
//!
//! The tool-call argument payload is excluded from that certification: the
//! collector holds its frames until the item completes, so the client receives
//! the complete payload once, in order, and never a partial one.
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
//! A request that declares tools adds one more owner behavior: the DSML owner
//! can harvest declared tool markup into synthesized function items, replacing
//! the source text span. That harvest has four entry points: the bounded
//! `<tool_call>` grammar, the fullwidth envelope opener `<｜｜DSML｜｜ invoke`
//! (whose one-line form does not equal the standalone label), the
//! `]<]minimax[>[` provider prefix, and the demonstrated malformed alternate
//! opener `<|name">`. The probe extends its marker set with all of them for
//! such attempts, so a committed prefix never carries a span the owner later
//! turns into a function call.
//!
//! The same probe stays active after the commit, but only as a hold signal.
//! The collector suspends projection while the newest text may still be
//! governed, keeps the frames inside the attempt, and lets the registered
//! complete-attempt owner decide at the terminal. The probe cannot know the
//! owners' protected ranges (fenced and inline code, quoted text), so it must
//! never end a committed transport by itself: that would truncate valid
//! business text which merely contains a marker-like token.

use serde_json::Value;

use crate::direct_response_hooks::{V3GovernedTextMarker, V3GovernedTextScope};
use crate::hub_v1::V3HubProviderWireProtocol;

/// Number of trailing characters kept for the split-marker check. Longer than
/// any governed marker, so a full marker is always found inside the tail.
const TEXT_TAIL_CHARS: usize = 64;

/// How a text carrier relates to the delta stream. Deltas are incremental, so
/// their text is appended to the rolling tail; every other carrier repeats text
/// the deltas already delivered and replaces the tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextCarrier {
    Incremental,
    Complete,
}

/// The last [`TEXT_TAIL_CHARS`] characters of `text`.
fn tail_chars(text: &str) -> &str {
    let count = text.chars().count();
    if count <= TEXT_TAIL_CHARS {
        return text;
    }
    let cut = text
        .char_indices()
        .nth(count - TEXT_TAIL_CHARS)
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    &text[cut..]
}

fn marker_matches(scope: V3GovernedTextScope, text: &str, marker: &str) -> bool {
    match scope {
        V3GovernedTextScope::Inline => text.contains(marker),
        V3GovernedTextScope::Line => text
            .lines()
            .any(|line| line.trim_end_matches('\r') == marker),
    }
}

/// True when `text` already carries a marker this attempt's owners can act on.
fn contains_governed_marker(markers: &[V3GovernedTextMarker], text: &str) -> bool {
    !text.is_empty()
        && markers
            .iter()
            .any(|marker| marker_matches(marker.scope, text, marker.text))
}

/// True when the observed text ends with a proper prefix of `marker`, in the
/// scope that owner matches it: an inline marker may start anywhere, a line
/// marker must occupy the partial last line.
fn marker_prefix_at_end(text_tail: &str, last_line: &str, marker: &V3GovernedTextMarker) -> bool {
    marker.text.char_indices().any(|(index, ch)| {
        let prefix_len = index + ch.len_utf8();
        if prefix_len >= marker.text.len() {
            return false;
        }
        let prefix = &marker.text[..prefix_len];
        match marker.scope {
            V3GovernedTextScope::Inline => text_tail.ends_with(prefix),
            V3GovernedTextScope::Line => last_line == prefix,
        }
    })
}

/// Carrier identity for Responses `output_text` deltas and done events. The
/// delta stream carries `output_index` and `content_index` addressing the same
/// output item and content part the complete-attempt owners read.
fn direct_sse_output_text_key(event: &serde_json::Value) -> (usize, usize) {
    (
        event
            .get("output_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
        event
            .get("content_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
    )
}

#[derive(Debug)]
pub(crate) struct V3DirectPrefixCommitProbe {
    protocol: V3HubProviderWireProtocol,
    markers: Vec<V3GovernedTextMarker>,
    visible_text: bool,
    /// A named tool-call output item started. Its name is client-visible
    /// business content that no text-governance owner rewrites, so it certifies
    /// the complete-attempt business-content judgment the same way visible text
    /// does.
    tool_call_started: bool,
    /// Output indices of tool-call items whose argument payload is not complete
    /// yet. The completeness gate keeps those frames buffered until the item
    /// completes, because a provider-private argument rewrite may still change
    /// them.
    tool_arguments_pending: std::collections::BTreeSet<usize>,
    confirmed_marker: bool,
    tails_by_carrier: std::collections::BTreeMap<(usize, usize), String>,
}

impl V3DirectPrefixCommitProbe {
    pub(crate) fn new(protocol: V3HubProviderWireProtocol) -> Self {
        Self::new_with_declared_tools(protocol, false)
    }

    /// Create the probe for one provider attempt.
    ///
    /// When the request declares tools, the DSML owner can harvest declared
    /// tool markup into synthesized output items, replacing the source text
    /// span. The base governed-marker set only covers labels the owner removes
    /// without any declaration, so the probe extends it with the declared-tool
    /// openers; a committed prefix must never carry a span that later turns
    /// into a function call.
    pub(crate) fn new_with_declared_tools(
        protocol: V3HubProviderWireProtocol,
        declared_tools: bool,
    ) -> Self {
        let mut markers = crate::direct_response_hooks::v3_direct_governed_text_markers();
        if declared_tools {
            markers.extend(
                crate::tool_markup_parser::declared_tool_text_markers()
                    .into_iter()
                    .map(|text| V3GovernedTextMarker {
                        text,
                        scope: V3GovernedTextScope::Inline,
                    }),
            );
        }
        Self {
            protocol,
            markers,
            visible_text: false,
            tool_call_started: false,
            tool_arguments_pending: std::collections::BTreeSet::new(),
            confirmed_marker: false,
            tails_by_carrier: std::collections::BTreeMap::new(),
        }
    }

    /// Observe one decoded provider event of the buffered attempt prefix.
    pub(crate) fn observe_event(&mut self, event: &Value) {
        if self.protocol != V3HubProviderWireProtocol::Responses {
            return;
        }
        match event.get("type").and_then(Value::as_str) {
            // The delta stream is the only incremental carrier, so it is the one
            // a governed marker can be split across.
            Some("response.output_text.delta") => {
                self.observe_text(
                    event.get("delta"),
                    TextCarrier::Incremental,
                    direct_sse_output_text_key(event),
                );
            }
            Some("response.output_text.done") => {
                self.observe_text(
                    event.get("text"),
                    TextCarrier::Complete,
                    direct_sse_output_text_key(event),
                );
            }
            Some("response.content_part.added" | "response.content_part.done") => {
                self.observe_part(event.get("part"), direct_sse_output_text_key(event));
            }
            Some("response.output_item.added") => {
                let carrier_key = direct_sse_output_text_key(event);
                self.observe_tool_item(event.get("item"), carrier_key.0, false);
                self.observe_item(event.get("item"), carrier_key);
            }
            Some("response.output_item.done") => {
                let carrier_key = direct_sse_output_text_key(event);
                self.observe_tool_item(event.get("item"), carrier_key.0, true);
                self.observe_item(event.get("item"), carrier_key);
            }
            // The complete-attempt owners read the terminal snapshot output, so
            // the certification has to read the same text.
            Some(
                "response.created"
                | "response.in_progress"
                | "response.queued"
                | "response.completed"
                | "response.incomplete",
            ) => {
                for (output_index, item) in event
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    // Snapshot items are complete carriers. Their position in
                    // the output array is the authoritative carrier identity,
                    // matching how the complete-attempt owners read the
                    // terminal snapshot.
                    self.observe_tool_item(Some(item), output_index, true);
                    self.observe_item(Some(item), (output_index, 0));
                }
            }
            _ => {}
        }
    }

    /// Observe a tool-call output item.
    ///
    /// A named `function_call`, `custom_tool_call` or `mcp_call` item is
    /// client-visible business content that no text-governance owner rewrites,
    /// so its start frame certifies the complete-attempt business-content
    /// judgment the same way visible text does. The argument payload is not
    /// part of that certification: it stays behind the completeness gate until
    /// the item completes, because a provider-private rewrite may still change
    /// it.
    fn observe_tool_item(&mut self, item: Option<&Value>, output_index: usize, complete: bool) {
        let Some(item) = item else {
            return;
        };
        if !matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "mcp_call")
        ) {
            return;
        }
        let named = item
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty());
        if !named {
            return;
        }
        self.tool_call_started = true;
        if complete {
            self.tool_arguments_pending.remove(&output_index);
        } else {
            self.tool_arguments_pending.insert(output_index);
        }
    }

    fn observe_item(&mut self, item: Option<&Value>, carrier_key: (usize, usize)) {
        let Some(item) = item else {
            return;
        };
        // The complete-attempt thinking owner also rewrites a top-level
        // `output_text` output item, not only a message item.
        if item.get("type").and_then(Value::as_str) == Some("output_text") {
            self.observe_text(item.get("text"), TextCarrier::Complete, carrier_key);
            return;
        }
        // Reasoning and tool-call items are never text-governed, so only
        // assistant message carriers can move bytes between `output_text` and
        // synthesized reasoning.
        if item.get("type").and_then(Value::as_str) != Some("message") {
            return;
        }
        self.observe_text(item.get("text"), TextCarrier::Complete, carrier_key);
        for (content_index, part) in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            self.observe_part(Some(part), (carrier_key.0, content_index));
        }
    }

    fn observe_part(&mut self, part: Option<&Value>, carrier_key: (usize, usize)) {
        let Some(part) = part else {
            return;
        };
        if part.get("type").and_then(Value::as_str) != Some("output_text") {
            return;
        }
        self.observe_text(part.get("text"), TextCarrier::Complete, carrier_key);
    }

    fn observe_text(
        &mut self,
        text: Option<&Value>,
        carrier: TextCarrier,
        carrier_key: (usize, usize),
    ) {
        let Some(text) = text.and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.visible_text |= crate::hub_v1::v3_text_has_visible_content(text);
        // Append incremental text so a marker split across two provider frames
        // stays one string. A complete carrier repeats text the deltas already
        // delivered, so it replaces that carrier's tail instead of duplicating
        // it. Each carrier keeps its own tail so an unrelated output item or
        // content part can never clear or replace another carrier's pending
        // marker; the complete-attempt owners read the same carriers.
        let text_tail = self.tails_by_carrier.entry(carrier_key).or_default();
        let scan = match carrier {
            TextCarrier::Incremental => {
                // Scan the joined text before bounding it: a marker that
                // straddles the junction is only visible while both halves are
                // still adjacent, and the completing delta can be far longer
                // than the tail window.
                text_tail.push_str(text);
                text_tail.clone()
            }
            TextCarrier::Complete => text.to_string(),
        };
        self.confirmed_marker |= contains_governed_marker(&self.markers, &scan);
        let text_tail = self.tails_by_carrier.entry(carrier_key).or_default();
        match carrier {
            TextCarrier::Incremental => {
                *text_tail = tail_chars(&scan).to_string();
            }
            TextCarrier::Complete => {
                *text_tail = tail_chars(&scan).to_string();
            }
        }
    }

    /// True only while the whole buffered prefix is governed business content:
    /// no marker any text-governance owner could act on was observed, no carrier
    /// ends with a marker prefix, and the prefix already carries client-visible
    /// business content (visible text or a named tool-call start). Reasoning
    /// deltas and whitespace alone never certify the commit, so an empty
    /// attempt still recovers through the typed Error chain.
    pub(crate) fn is_committable(&self) -> bool {
        (self.visible_text || self.tool_call_started) && !self.governed_text_pending()
    }

    /// A tool-call argument payload is not complete yet. A committed channel
    /// must not project those frames until the item completes: a
    /// provider-private argument rewrite may still change them, so the complete
    /// payload leaves the gate once, in order.
    pub(crate) fn tool_arguments_pending(&self) -> bool {
        !self.tool_arguments_pending.is_empty()
    }

    /// A complete governed marker was observed. Production code uses
    /// [`Self::governed_text_pending`] because only the registered owner may
    /// decide a committed tail; the probe's own tests check this state directly.
    #[cfg(test)]
    pub(crate) fn confirmed_governed_marker(&self) -> bool {
        self.confirmed_marker
    }

    /// The committed prefix contains, or may still end with, text that a
    /// text-governance owner could rewrite. A committed channel must not project
    /// new frames while this holds: only the registered owner knows its
    /// protected ranges (fenced/inline code, quoted text), so it alone decides
    /// the complete attempt after the terminal, and nothing the owner could
    /// still remove reaches the client prematurely.
    pub(crate) fn governed_text_pending(&self) -> bool {
        self.confirmed_marker || self.trailing_marker_prefix()
    }

    /// The observed text ends with a proper prefix of a governed marker, or with
    /// a bare `>` line the DSML owner removes together with the close label that
    /// follows it. The next provider frame decides which it is, so a committed
    /// channel must not project this frame yet.
    pub(crate) fn trailing_marker_prefix(&self) -> bool {
        self.tails_by_carrier.values().any(|text_tail| {
            if text_tail.is_empty() {
                return false;
            }
            let last_line = text_tail
                .rsplit('\n')
                .next()
                .unwrap_or_default()
                .trim_end_matches('\r');
            // Keep the whole text in scope for the line-scope check so a bare
            // `>` line is evaluated consistently; the tail window is enough.
            let completed_line = text_tail
                .strip_suffix('\n')
                .unwrap_or(text_tail)
                .rsplit('\n')
                .next()
                .unwrap_or_default()
                .trim_end_matches('\r');
            if last_line == ">" || completed_line == ">" {
                return true;
            }
            self.markers
                .iter()
                .any(|marker| marker_prefix_at_end(text_tail, last_line, marker))
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

    fn tool_item_event(
        event_type: &str,
        output_index: usize,
        item_type: &str,
        name: &str,
    ) -> Value {
        json!({
            "type": event_type,
            "output_index": output_index,
            "item": {
                "type": item_type,
                "id": "fc_1",
                "call_id": "call_1",
                "name": name,
                "arguments": ""
            }
        })
    }

    #[test]
    fn named_tool_call_item_start_commits() {
        let mut probe = probe();
        probe.observe_event(&json!({"type": "response.created", "response": {"output": []}}));
        probe.observe_event(
            &json!({"type": "response.reasoning_summary_text.delta", "delta": "plan the call"}),
        );
        assert!(
            !probe.is_committable(),
            "reasoning alone never authorizes a commit"
        );
        probe.observe_event(&tool_item_event(
            "response.output_item.added",
            1,
            "function_call",
            "exec_command",
        ));
        assert!(
            probe.is_committable(),
            "a named tool-call start is client-visible business content"
        );
        assert!(
            probe.tool_arguments_pending(),
            "the argument payload stays behind the completeness gate"
        );
        probe.observe_event(&json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": "{\"command\":\"echo h"
        }));
        assert!(
            probe.tool_arguments_pending(),
            "a partial argument payload must not leave the gate"
        );
        probe.observe_event(&json!({
            "type": "response.output_item.done",
            "output_index": 1,
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "exec_command",
                "arguments": "{\"command\":\"echo hi\"}"
            }
        }));
        assert!(
            !probe.tool_arguments_pending(),
            "a completed tool item releases the argument gate"
        );
        assert!(probe.is_committable());
    }

    #[test]
    fn unnamed_tool_call_item_does_not_commit() {
        let mut probe = probe();
        probe.observe_event(&tool_item_event(
            "response.output_item.added",
            1,
            "function_call",
            "",
        ));
        assert!(
            !probe.is_committable(),
            "a nameless function item proves no client-visible business content"
        );
        assert!(!probe.tool_arguments_pending());
    }

    #[test]
    fn custom_tool_call_start_commits_and_is_gated() {
        let mut probe = probe();
        probe.observe_event(&json!({
            "type": "response.output_item.added",
            "output_index": 2,
            "item": {
                "type": "custom_tool_call",
                "id": "ctc_1",
                "call_id": "call_2",
                "name": "apply_patch",
                "input": ""
            }
        }));
        assert!(probe.is_committable());
        assert!(probe.tool_arguments_pending());
        probe.observe_event(&json!({
            "type": "response.output_item.done",
            "output_index": 2,
            "item": {
                "type": "custom_tool_call",
                "id": "ctc_1",
                "call_id": "call_2",
                "name": "apply_patch",
                "input": "*** Begin Patch"
            }
        }));
        assert!(!probe.tool_arguments_pending());
    }

    #[test]
    fn governed_text_blocks_the_tool_call_commit() {
        let mut probe = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        probe.observe_event(&delta("visible <tool_call>write_file</tool_call>"));
        probe.observe_event(&tool_item_event(
            "response.output_item.added",
            1,
            "function_call",
            "write_file",
        ));
        assert!(
            !probe.is_committable(),
            "a governed prefix still waits for the complete-attempt owner"
        );
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
    fn declared_tool_open_is_governed_only_for_tool_requests() {
        let mut base = probe();
        base.observe_event(&delta("visible <tool_call>write_file</tool_call>"));
        assert!(
            base.is_committable(),
            "without a declared tool the DSML owner cannot harvest the markup"
        );

        let mut with_tools = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        with_tools.observe_event(&delta("visible <tool_call>write_file</tool_call>"));
        assert!(!with_tools.is_committable());
        assert!(
            with_tools.confirmed_governed_marker(),
            "a declared-tool opener must hold the prefix for the complete-attempt owner"
        );
    }

    #[test]
    fn declined_tool_open_split_across_deltas_holds_for_tool_requests() {
        let mut with_tools = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        with_tools.observe_event(&delta("visible "));
        assert!(with_tools.is_committable());
        with_tools.observe_event(&delta("<tool_"));
        assert!(
            !with_tools.is_committable(),
            "an opener split across provider frames must not commit half-way"
        );
        with_tools.observe_event(&delta("call>write_file</tool_call>"));
        assert!(!with_tools.is_committable());
    }

    #[test]
    fn alternate_opener_holds_for_tool_requests() {
        let mut base = probe();
        base.observe_event(&delta(
            "Done.\n<|exec_command\">\n<cmd>ls</cmd>\n</exec_command>",
        ));
        assert!(
            base.is_committable(),
            "without a declared tool the malformed opener stays business text"
        );

        let mut with_tools = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        with_tools.observe_event(&delta("Done.\n<|exec_command\">"));
        assert!(
            !with_tools.is_committable(),
            "the alternate opener is a declared-tool harvest entry point"
        );
        assert!(with_tools.confirmed_governed_marker());
    }

    #[test]
    fn one_line_fullwidth_envelope_holds_for_tool_requests() {
        use crate::tool_markup_parser::{CLOSE, END_INVOKE, END_PARAM, INVOKE, OPEN, PARAM};
        let mut with_tools = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        let one_line = format!(
            "Go.\n{OPEN}{INVOKE} name=\"exec_command\">{PARAM} name=\"cmd\" string=\"true\">ls{END_PARAM}{END_INVOKE}{CLOSE}"
        );
        with_tools.observe_event(&delta(&one_line));
        assert!(
            !with_tools.is_committable(),
            "the one-line fullwidth envelope is harvested, so it must hold"
        );
        assert!(with_tools.confirmed_governed_marker());
    }

    #[test]
    fn minimax_prefix_split_across_deltas_holds_for_tool_requests() {
        let mut with_tools = V3DirectPrefixCommitProbe::new_with_declared_tools(
            V3HubProviderWireProtocol::Responses,
            true,
        );
        with_tools.observe_event(&delta("visible ]<]minimax[>["));
        assert!(
            !with_tools.is_committable(),
            "the minimax provider prefix must hold until its envelope follows"
        );
        assert!(with_tools.confirmed_governed_marker());
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

    /// The reviewer leak: the marker is split so neither frame contains it, but
    /// the streamed text does. A per-frame scan misses it and commits raw
    /// reasoning text.
    #[test]
    fn marker_split_across_two_deltas_is_never_committed() {
        let mut probe = probe();
        probe.observe_event(&delta("visible "));
        assert!(probe.is_committable());
        probe.observe_event(&delta("<thin"));
        assert!(
            !probe.is_committable(),
            "a trailing marker prefix is unresolved"
        );
        probe.observe_event(&delta("king>secret"));
        assert!(
            probe.confirmed_governed_marker(),
            "the split marker must be seen in the accumulated text"
        );
        assert!(!probe.is_committable());
    }

    /// A marker split across deltas is only visible while both halves are still
    /// adjacent, so the joined text is scanned before the tail is bounded. A
    /// completing delta far longer than the tail window must not hide it.
    #[test]
    fn marker_split_across_deltas_with_a_long_completing_delta_is_confirmed() {
        let mut probe = probe();
        probe.observe_event(&delta("visible "));
        assert!(probe.is_committable());
        probe.observe_event(&delta("<thin"));
        assert!(!probe.is_committable());
        let body = "x".repeat(200);
        let completing = format!("king>{body}");
        probe.observe_event(&delta(&completing));
        assert!(
            probe.confirmed_governed_marker(),
            "the joined text must reveal the split marker"
        );
        assert!(!probe.is_committable());
    }

    /// A top-level `output_text` output item is rewritten by the thinking owner,
    /// so its snapshot text also governs the attempt.
    #[test]
    fn output_text_item_text_is_governed() {
        let mut probe = probe();
        probe.observe_event(&delta("clean text"));
        assert!(probe.is_committable());
        probe.observe_event(&json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "output_text",
                "id": "m1",
                "text": "clean text <thinking>secret"
            }
        }));
        assert!(probe.confirmed_governed_marker());
        assert!(!probe.is_committable());
    }

    /// A marker that only reaches the terminal snapshot still governs the
    /// attempt, because the complete-attempt owners read that snapshot.
    #[test]
    fn marker_in_terminal_snapshot_is_confirmed() {
        let mut probe = probe();
        probe.observe_event(&delta("clean visible text"));
        assert!(probe.is_committable());
        probe.observe_event(&json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": [{
                    "type": "message",
                    "id": "m1",
                    "content": [{"type": "output_text", "text": "clean visible text <thinking>secret"}]
                }]
            }
        }));
        assert!(probe.confirmed_governed_marker());
        assert!(!probe.is_committable());
    }

    /// A bare `>` line is removed by the DSML owner together with the close
    /// label that follows it, so it is unresolved until the next frame decides.
    #[test]
    fn trailing_close_residue_line_is_held() {
        let mut probe = probe();
        probe.observe_event(&delta("visible text"));
        assert!(probe.is_committable());
        probe.observe_event(&delta("\n>"));
        assert!(
            !probe.is_committable(),
            "a bare > line may still become the close residue"
        );
        probe.observe_event(&delta("\nplain continuation"));
        assert!(probe.is_committable(), "plain text resolves the residue");
        assert!(!probe.confirmed_governed_marker());
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

    /// An unrelated output item or content part must never clear another
    /// carrier's pending marker tail. The complete-attempt owners read the
    /// same carriers, so certification has to keep them isolated.
    #[test]
    fn cross_carrier_text_never_clears_another_carrier_pending_marker() {
        let mut probe = probe();
        // Carrier (0,0) ends with the start of a governed marker.
        probe.observe_event(&json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": "visible <thin"
        }));
        assert!(!probe.is_committable());
        // Carrier (1,0) emits ordinary text that used to replace the shared
        // tail and clear the pending marker.
        probe.observe_event(&json!({
            "type": "response.output_text.delta",
            "output_index": 1,
            "content_index": 0,
            "delta": "ordinary"
        }));
        assert!(
            !probe.is_committable(),
            "an unrelated carrier must not clear carrier (0,0) pending marker"
        );
        assert!(
            probe.trailing_marker_prefix(),
            "carrier (0,0) pending marker must stay visible"
        );
        // Carrier (0,0) completes the marker; the attempt is governed.
        probe.observe_event(&json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": "king>secret"
        }));
        assert!(probe.confirmed_governed_marker());
        assert!(!probe.is_committable());
    }

    #[test]
    fn snapshot_output_items_keep_their_array_position_carriers() {
        let mut probe = probe();
        probe.observe_event(&delta("safe-prefix "));
        probe.observe_event(&delta("<thin"));
        probe.observe_event(&json!({
            "type": "response.in_progress",
            "response": {
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "safe-prefix <thin"}]
                    },
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "ordinary"}]
                    }
                ]
            }
        }));
        assert!(
            !probe.is_committable(),
            "an unrelated snapshot item must not clear item zero's pending marker"
        );
        probe.observe_event(&delta("king>secret</thinking> tail"));
        assert!(probe.confirmed_governed_marker());
        assert!(!probe.is_committable());
    }

    #[test]
    fn other_protocols_never_commit() {
        let mut probe = V3DirectPrefixCommitProbe::new(V3HubProviderWireProtocol::OpenAiChat);
        probe.observe_event(&delta("Hello"));
        assert!(!probe.is_committable());
    }
}
