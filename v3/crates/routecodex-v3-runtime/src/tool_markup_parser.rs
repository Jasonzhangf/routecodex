//! Shared pure lexical owner for provider tool markup.
//!
//! This module recognizes the declared fullwidth DSML envelope, the bounded
//! `<tool_call>` grammar and the exact standalone control labels. It returns
//! neutral segments and never mutates a payload. Direct hooks and the Relay
//! response Chat Process each keep their own payload rewrite authority.

use serde::de::IgnoredAny;
use std::collections::HashMap;

pub(crate) const OPEN: &str = "<｜｜DSML｜｜ calls>";
pub(crate) const CLOSE: &str = "</｜｜DSML｜｜ calls>";
pub(crate) const INVOKE: &str = "<｜｜DSML｜｜ invoke";
pub(crate) const END_INVOKE: &str = "</｜｜DSML｜｜ invoke>";
pub(crate) const PARAM: &str = "<｜｜DSML｜｜ parameter";
pub(crate) const END_PARAM: &str = "</｜｜DSML｜｜ parameter>";
pub(crate) const BARE_DSML: &str = "<｜｜DSML｜｜>";
pub(crate) const ASCII_TOOL_CALLS: &str = "<|DSML|tool_calls>";
pub(crate) const ANALYSIS_CLOSINGS: &[&str] = &[
    "<|end_of_analysis|>",
    "<|end▁of▁analysis|>",
    // Exact observed 2026-10-19 fullwidth-bar variant.
    "<｜end▁of▁analysis｜>",
];
pub(crate) const CLOSING_FRAGMENTS: &[&str] = &[" calls>", "｜｜DSML｜｜ calls>"];
pub(crate) const TOOL_CALL_OPEN: &str = "<tool_call>";
pub(crate) const TOOL_CALL_CLOSE: &str = "</tool_call>";
pub(crate) const ARG_KEY_OPEN: &str = "<arg_key>";
pub(crate) const ARG_KEY_CLOSE: &str = "</arg_key>";
pub(crate) const ARG_VALUE_OPEN: &str = "<arg_value>";
pub(crate) const ARG_VALUE_CLOSE: &str = "</arg_value>";
const MINIMAX_PREFIX: &str = "]<]minimax[>[";
const MINIMAX_OPEN: &str = "]<]minimax[>[<tool_call>";
const MINIMAX_CLOSE: &str = "]<]minimax[>[</tool_call>";

/// Every standalone text label this owner removes even when no tool is
/// declared. A client-visible prefix that already contains one of these can
/// still be rewritten by the complete-attempt DSML owner, so it must never be
/// flushed ahead of that owner.
pub(crate) fn governed_text_markers() -> Vec<&'static str> {
    let mut markers = vec![OPEN, CLOSE, BARE_DSML, ASCII_TOOL_CALLS];
    markers.extend_from_slice(ANALYSIS_CLOSINGS);
    markers.extend_from_slice(CLOSING_FRAGMENTS);
    markers
}

// Parse the observed invoke child-tag dialects. The error bool identifies
// an unfinished declared invocation; unknown/opaque envelopes remain business
// text. Structural prefixes are consumed here, never stripped from values.
fn invoke_envelope<'a>(
    text: &'a str,
    start: usize,
    declarations: &ToolMarkupDeclarations,
) -> Result<(Vec<ParsedToolCall<'a>>, usize), bool> {
    let prefixed = text[start..].starts_with(MINIMAX_OPEN);
    let prefix = if prefixed { MINIMAX_PREFIX } else { "" };
    let open = if prefixed {
        MINIMAX_OPEN
    } else {
        TOOL_CALL_OPEN
    };
    let close = if prefixed {
        MINIMAX_CLOSE
    } else {
        TOOL_CALL_CLOSE
    };
    let mut rest = text[start..].strip_prefix(open).ok_or(false)?;
    let mut calls: Vec<ParsedToolCall<'a>> = Vec::new();
    loop {
        let trimmed = rest.trim_start();
        let closed = trimmed.strip_prefix(close).or_else(|| {
            (!prefixed && !calls.is_empty())
                .then(|| trimmed.strip_prefix("</tool_call"))
                .flatten()
                .filter(|after| after.trim().is_empty())
        });
        if !prefixed
            && !calls.is_empty()
            && trimmed.starts_with("<inv")
            && "<invoke".starts_with(trimmed.trim_end())
        {
            return Err(true);
        }
        let bare_invoke = trimmed
            .strip_prefix("invoke ")
            .is_some_and(|rest| rest.trim_start().starts_with("name=\""));
        let complete_inner =
            !prefixed && !calls.is_empty() && !trimmed.starts_with("<invoke") && !bare_invoke;
        if closed.is_some() || complete_inner {
            if calls.is_empty() {
                return Err(false);
            }
            let end = text.len() - closed.unwrap_or(rest).len();
            for call in &mut calls {
                call.envelope = &text[start..end];
            }
            return Ok((calls, end));
        }
        let invocation = trimmed.strip_prefix(prefix).ok_or(!calls.is_empty())?;
        let opener = if !prefixed && invocation.starts_with("invoke ") {
            "invoke"
        } else {
            "<invoke"
        };
        let (attrs, after) = attributes(invocation, opener).ok_or(!calls.is_empty())?;
        let name = attribute(&attrs, "name").ok_or(false)?;
        let identity = declarations.get(name).ok_or(false)?;
        if attrs.len() != 1 || identity.kind != ToolMarkupKind::Function {
            return Err(false);
        }
        rest = after;
        let mut arguments: Vec<(String, String)> = Vec::new();
        loop {
            rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix(&format!("{prefix}</invoke>")) {
                rest = after;
                break;
            }
            let field = rest
                .strip_prefix(prefix)
                .and_then(|s| s.strip_prefix('<'))
                .ok_or(true)?;
            let (key, value_start) = field.split_once('>').ok_or(true)?;
            if !valid_grammar_name(key) || arguments.iter().any(|(existing, _)| existing == key) {
                return Err(false);
            }
            let closing = format!("{prefix}</{key}>");
            let (value, after) = value_start.split_once(&closing).ok_or(true)?;
            arguments.push((
                key.to_owned(),
                render_alternate_value(value, identity.parameter_kinds.get(key).copied()),
            ));
            rest = after;
        }
        calls.push(ParsedToolCall {
            wire_name: name,
            call_id: None,
            arguments: render_function_arguments(&arguments),
            envelope: "",
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolMarkupKind {
    Function,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolMarkupParamKind {
    String,
    Number,
    Boolean,
    Array,
    Object,
    Other,
}

impl ToolMarkupParamKind {
    pub(crate) fn declared(value: &str) -> Self {
        match value {
            "string" => Self::String,
            "integer" | "number" => Self::Number,
            "boolean" => Self::Boolean,
            "array" => Self::Array,
            "object" => Self::Object,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolMarkupIdentity {
    pub(crate) kind: ToolMarkupKind,
    pub(crate) parameter_kinds: HashMap<String, ToolMarkupParamKind>,
}

/// Declaration view required by the shared grammar. It carries no request,
/// routing or provider state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ToolMarkupDeclarations {
    tools: HashMap<String, ToolMarkupIdentity>,
}

impl ToolMarkupDeclarations {
    pub(crate) fn insert(&mut self, wire_name: String, identity: ToolMarkupIdentity) {
        self.tools.insert(wire_name, identity);
    }

    pub(crate) fn remove(&mut self, wire_name: &str) {
        self.tools.remove(wire_name);
    }

    /// True when no declared tool can match provider markup. A context with no
    /// declarations cannot harvest anything, so its attempt rewrite is the
    /// identity.
    pub(crate) fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    fn get(&self, wire_name: &str) -> Option<&ToolMarkupIdentity> {
        self.tools.get(wire_name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedToolCall<'a> {
    pub(crate) wire_name: &'a str,
    pub(crate) call_id: Option<&'a str>,
    pub(crate) arguments: String,
    /// Original consumed envelope, used by callers that must not partially
    /// rewrite a serialized invocation they do not harvest yet.
    pub(crate) envelope: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolMarkupSegment<'a> {
    Text(&'a str),
    Calls(Vec<ParsedToolCall<'a>>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolMarkupScan<'a> {
    pub(crate) segments: Vec<ToolMarkupSegment<'a>>,
    pub(crate) removed_label: bool,
    pub(crate) opener_label: bool,
    /// True only for a declared function invocation that started but cannot be
    /// completed. Unknown, literal and complete-but-unrepresentable text stays
    /// opaque.
    pub(crate) incomplete_tool_invocation: bool,
    pub(crate) opaque_invocation: bool,
}

fn line_content(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

/// Exact demonstrated standalone protocol labels. The bool is tool-intent.
fn removable_label(content: &str) -> Option<bool> {
    if content == OPEN || content == ASCII_TOOL_CALLS {
        Some(true)
    } else if content == CLOSE
        || content == BARE_DSML
        || ANALYSIS_CLOSINGS.contains(&content)
        || CLOSING_FRAGMENTS.contains(&content)
    {
        Some(false)
    } else {
        None
    }
}

fn close_residue_end(text: &str, start: usize) -> Option<usize> {
    let mut cursor = start;
    let mut bare_closings = 0;
    for line in text.get(start..)?.split_inclusive('\n') {
        cursor += line.len();
        match line_content(line) {
            ">" => bare_closings += 1,
            CLOSE if bare_closings > 0 => return Some(cursor),
            _ => return None,
        }
    }
    None
}

/// The demonstrated malformed alternate opener is `<|name">`. A normal
/// `<name>` XML shape is deliberately not recognized.
fn alternate_opener_name(content: &str) -> Option<&str> {
    let name = content.strip_prefix("<|")?.strip_suffix("\">")?;
    (!name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && !name.starts_with('|'))
    .then_some(name)
}

fn alternate_close_residue(name: &str) -> Option<String> {
    name.find('_').map(|index| format!("{}>", &name[index..]))
}

fn render_function_arguments(arguments: &[(String, String)]) -> String {
    format!(
        "{{{}}}",
        arguments
            .iter()
            .map(|(name, value)| {
                format!(
                    "{}:{value}",
                    serde_json::to_string(name).unwrap_or_else(|_| "\"\"".to_owned())
                )
            })
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn render_alternate_value(text: &str, kind: Option<ToolMarkupParamKind>) -> String {
    let valid_json = serde_json::from_str::<IgnoredAny>(text).is_ok();
    let number = matches!(text.as_bytes().first().copied(), Some(b'-' | b'0'..=b'9')) && valid_json;
    let string = || serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned());
    match kind {
        Some(ToolMarkupParamKind::String) => string(),
        Some(ToolMarkupParamKind::Number) if number => text.to_owned(),
        Some(ToolMarkupParamKind::Boolean) if matches!(text, "true" | "false") => text.to_owned(),
        Some(ToolMarkupParamKind::Array) if text.starts_with('[') && valid_json => text.to_owned(),
        Some(ToolMarkupParamKind::Object) if text.starts_with('{') && valid_json => text.to_owned(),
        Some(ToolMarkupParamKind::Other) | None if valid_json && !text.starts_with('"') => {
            text.to_owned()
        }
        _ => string(),
    }
}

fn valid_grammar_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn attributes<'a>(text: &'a str, start: &str) -> Option<(Vec<(&'a str, &'a str)>, &'a str)> {
    let mut rest = text.strip_prefix(start)?;
    let mut attrs: Vec<(&str, &str)> = Vec::new();
    loop {
        if let Some(after) = rest.strip_prefix('>') {
            return Some((attrs, after));
        }
        let trimmed = rest.trim_start();
        if trimmed.len() == rest.len() {
            return None;
        }
        rest = trimmed;
        if let Some(after) = rest.strip_prefix('>') {
            return Some((attrs, after));
        }
        let (name, after) = rest.split_once("=\"")?;
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        let (value, after) = after.split_once('"')?;
        if attrs.iter().any(|(existing, _)| *existing == name) {
            return None;
        }
        attrs.push((name, value));
        rest = after;
    }
}

fn attribute<'a>(attrs: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    let mut matches = attrs.iter().filter(|(key, _)| *key == name);
    let (_, value) = matches.next()?;
    matches.next().is_none().then_some(*value)
}

fn envelope<'a>(
    text: &'a str,
    declarations: &ToolMarkupDeclarations,
) -> Option<(Vec<ParsedToolCall<'a>>, &'a str)> {
    let mut rest = text.strip_prefix(OPEN)?;
    let mut calls: Vec<ParsedToolCall<'a>> = Vec::new();
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix(CLOSE) {
            if calls.is_empty() {
                return None;
            }
            let consumed = text.len() - after.len();
            let envelope = &text[..consumed];
            for call in &mut calls {
                call.envelope = envelope;
            }
            return Some((calls, after));
        }
        let (attrs, after) = attributes(rest, INVOKE)?;
        if attrs
            .iter()
            .any(|(key, _)| *key != "name" && *key != "call_id")
        {
            return None;
        }
        let name = attribute(&attrs, "name")?;
        let identity = declarations.get(name)?;
        // A custom declaration takes freeform `input`, not the DSML parameter
        // map. Emitting a function call would change the declared kind, so the
        // complete envelope stays provider text.
        if identity.kind != ToolMarkupKind::Function {
            return None;
        }
        rest = after;
        let mut arguments: Vec<(String, String)> = Vec::new();
        loop {
            rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix(END_INVOKE) {
                rest = after;
                break;
            }
            let (param, after) = attributes(rest, PARAM)?;
            let param_name = attribute(&param, "name")?;
            let param_string = attribute(&param, "string")?;
            if param.len() != 2 {
                return None;
            }
            let (value, after) = after.split_once(END_PARAM)?;
            let value = match param_string {
                "true" => serde_json::to_string(value).ok()?,
                "false" => {
                    // Validate syntax without materializing numbers as f64.
                    // The complete JSON value remains the provider's text.
                    serde_json::from_str::<IgnoredAny>(value).ok()?;
                    value.to_owned()
                }
                _ => return None,
            };
            if arguments.iter().any(|(existing, _)| existing == param_name) {
                return None;
            }
            arguments.push((param_name.to_owned(), value));
            rest = after;
        }
        calls.push(ParsedToolCall {
            wire_name: name,
            call_id: attribute(&attrs, "call_id"),
            arguments: render_function_arguments(&arguments),
            envelope: "",
        });
    }
}

/// Harvest the demonstrated bounded `<tool_call>` grammar. Every argument is
/// delimited, typed only by the current declaration registry, and retained in
/// its source order.
fn parse_tool_call_invocation<'a>(
    text: &'a str,
    start: usize,
    declarations: &ToolMarkupDeclarations,
) -> Option<(ParsedToolCall<'a>, usize)> {
    let rest = text.get(start..)?.strip_prefix(TOOL_CALL_OPEN)?;
    let argument_start = rest.find(ARG_KEY_OPEN)?;
    let name = &rest[..argument_start];
    let mut rest = &rest[argument_start..];
    if !valid_grammar_name(name) {
        return None;
    }
    let identity = declarations.get(name)?;
    if identity.kind != ToolMarkupKind::Function {
        return None;
    }
    let mut arguments = Vec::new();
    loop {
        if let Some(after) = rest.strip_prefix(TOOL_CALL_CLOSE) {
            if arguments.is_empty() {
                return None;
            }
            let end = text.len() - after.len();
            return Some((
                ParsedToolCall {
                    wire_name: name,
                    call_id: None,
                    arguments: render_function_arguments(&arguments),
                    envelope: &text[start..end],
                },
                end,
            ));
        }
        let after = rest.strip_prefix(ARG_KEY_OPEN)?;
        let (key, after) = after.split_once(ARG_KEY_CLOSE)?;
        if !valid_grammar_name(key)
            || arguments
                .iter()
                .any(|(existing, _): &(String, String)| existing == key)
        {
            return None;
        }
        let after = after.strip_prefix(ARG_VALUE_OPEN)?;
        let (value, after) = after.split_once(ARG_VALUE_CLOSE)?;
        arguments.push((
            key.to_owned(),
            render_alternate_value(value, identity.parameter_kinds.get(key).copied()),
        ));
        rest = after;
    }
}

struct AlternateHarvest<'a> {
    call: ParsedToolCall<'a>,
    end: usize,
}

/// A bounded alternate invocation has one malformed opener line, one or more
/// fully delimited `<parameter>value</parameter>` lines, one matching close
/// line, and at most one directly associated close residue line.
fn parse_alternate_invocation<'a>(
    text: &'a str,
    start: usize,
    body_start: usize,
    name: &'a str,
    identity: Option<&ToolMarkupIdentity>,
) -> Option<AlternateHarvest<'a>> {
    let identity = identity?;
    if identity.kind != ToolMarkupKind::Function {
        return None;
    }
    let mut offset = body_start;
    let mut arguments = Vec::new();
    loop {
        let rest = text.get(offset..)?;
        let line = rest.split_inclusive('\n').next()?;
        let content = line_content(line);
        let line_end = offset + line.len();
        if let Some(close_name) = content.strip_prefix("</") {
            if close_name.strip_suffix('>')? != name {
                return None;
            }
            let mut end = line_end;
            if let Some(residue) = alternate_close_residue(name) {
                let tail = text.get(end..).unwrap_or_default();
                if !tail.is_empty() {
                    let residue_line = tail.split_inclusive('\n').next().unwrap_or_default();
                    if line_content(residue_line) == residue {
                        end += residue_line.len();
                    }
                }
            }
            return Some(AlternateHarvest {
                call: ParsedToolCall {
                    wire_name: name,
                    call_id: None,
                    arguments: render_function_arguments(&arguments),
                    envelope: &text[start..end],
                },
                end,
            });
        }
        let (parameter, value_and_close) = content.strip_prefix('<')?.split_once('>')?;
        if parameter.is_empty()
            || !parameter
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return None;
        }
        let value = value_and_close.strip_suffix(format!("</{parameter}>").as_str())?;
        if arguments
            .iter()
            .any(|(existing, _): &(String, String)| existing == parameter)
        {
            return None;
        }
        arguments.push((
            parameter.to_owned(),
            render_alternate_value(value, identity.parameter_kinds.get(parameter).copied()),
        ));
        offset = line_end;
    }
}

/// A declared function invocation that failed the complete fullwidth envelope
/// parse and has no outer close is recognized executable truncation rather
/// than literal text. Complete but unrepresentable envelopes stay preserved.
fn recognized_truncated_fullwidth(text: &str, declarations: &ToolMarkupDeclarations) -> bool {
    let Some(rest) = text.strip_prefix(OPEN) else {
        return false;
    };
    let Some((attrs, after)) = attributes(rest.trim_start(), INVOKE) else {
        return false;
    };
    if attrs
        .iter()
        .any(|(key, _)| *key != "name" && *key != "call_id")
    {
        return false;
    }
    let Some(name) = attribute(&attrs, "name") else {
        return false;
    };
    let Some(identity) = declarations.get(name) else {
        return false;
    };
    identity.kind == ToolMarkupKind::Function && !after.contains(CLOSE)
}

fn declared_function_tool_call_start(
    text: &str,
    start: usize,
    declarations: &ToolMarkupDeclarations,
) -> bool {
    let Some(rest) = text
        .get(start..)
        .and_then(|text| text.strip_prefix(TOOL_CALL_OPEN))
    else {
        return false;
    };
    let name = rest.find(ARG_KEY_OPEN).map_or(rest, |end| &rest[..end]);
    declarations
        .get(name)
        .is_some_and(|identity| identity.kind == ToolMarkupKind::Function)
}

pub(crate) fn scan_tool_markup<'a>(
    text: &'a str,
    declarations: &ToolMarkupDeclarations,
) -> ToolMarkupScan<'a> {
    let mut segments = Vec::new();
    let mut removed_label = false;
    let mut opener_label = false;
    let mut consumed = 0;
    let mut cursor = 0;
    let mut fence: Option<(char, usize)> = None;
    let mut inline = None;
    let mut quote = None;
    let mut skip_until = 0;
    let mut blockquote = false;
    let mut incomplete_tool_invocation = false;
    let mut opaque_invocation = false;
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        let current_line_start = line_start;
        let line_end = line_start + line.len();
        cursor = cursor
            .max(current_line_start)
            .max(consumed.max(skip_until))
            .min(line_end);
        line_start = line_end;
        if cursor == line_end {
            continue;
        }
        let trimmed = line.trim_start();
        // Envelope arguments are consumed atomically. Their Markdown-like
        // contents must not change the lexical scope of subsequent text.
        if cursor == current_line_start {
            if trimmed.trim().is_empty() {
                blockquote = false;
            }
            let marker = trimmed.chars().next().unwrap_or('\n');
            let run = trimmed.chars().take_while(|c| *c == marker).count();
            if let Some((opening, length)) = fence {
                if marker == opening && run >= length && trimmed[run..].trim().is_empty() {
                    fence = None;
                }
                cursor = line_end;
                continue;
            }
            if line.starts_with("    ") || line.starts_with('\t') {
                cursor = line_end;
                continue;
            }
            if matches!(marker, '`' | '~') && run >= 3 {
                fence = Some((marker, run));
                cursor = line_end;
                continue;
            }
            if fence.is_none() && inline.is_none() && quote.is_none() && !blockquote {
                let content = line_content(line);
                if let Some(end) = close_residue_end(text, current_line_start) {
                    if cursor > consumed {
                        segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                    }
                    consumed = end;
                    cursor = line_end;
                    removed_label = true;
                    continue;
                }
                if let Some(tool_intent) = removable_label(content) {
                    // Complete representable envelopes keep atomic conversion
                    // priority even when their open wrapper is on its own line.
                    let complete_fullwidth_follows = content == OPEN
                        && text
                            .get(line_end..)
                            .map(str::trim_start)
                            .is_some_and(|rest| rest.starts_with(INVOKE));
                    if !complete_fullwidth_follows {
                        if cursor > consumed {
                            segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                        }
                        consumed = line_end;
                        cursor = line_end;
                        removed_label = true;
                        opener_label |= tool_intent;
                        continue;
                    }
                }
                if let Some(name) = alternate_opener_name(content) {
                    match parse_alternate_invocation(
                        text,
                        current_line_start,
                        line_end,
                        name,
                        declarations.get(name),
                    ) {
                        Some(harvest) => {
                            if cursor > consumed {
                                segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                            }
                            segments.push(ToolMarkupSegment::Calls(vec![harvest.call]));
                            consumed = harvest.end;
                            // Keep the line iterator aligned: later physical
                            // lines are skipped by the consumed offset above,
                            // just like a multi-line fullwidth envelope.
                            cursor = line_end;
                        }
                        None => {
                            opaque_invocation = true;
                            if declarations
                                .get(name)
                                .is_some_and(|identity| identity.kind == ToolMarkupKind::Function)
                                && !text[line_end..]
                                    .lines()
                                    .any(|line| line_content(line) == format!("</{name}>"))
                            {
                                incomplete_tool_invocation = true;
                            }
                            break;
                        }
                    }
                    continue;
                }
            }
            blockquote |= trimmed.starts_with('>');
            if blockquote {
                cursor = line_end;
                continue;
            }
        }
        while cursor < line_end {
            if cursor < consumed.max(skip_until) {
                cursor = consumed.max(skip_until).min(line_end);
                continue;
            }
            let tail = &text[cursor..];
            let ch = tail.chars().next().unwrap();
            if ch == '`' && quote.is_none() {
                let run = tail.bytes().take_while(|c| *c == b'`').count();
                if inline == Some(run) {
                    inline = None;
                } else if inline.is_none() {
                    inline = Some(run);
                }
                cursor += run;
                continue;
            }
            if inline.is_none() {
                if ch == '\\' && quote.is_some() {
                    cursor += ch.len_utf8();
                    if let Some(escaped) = text[cursor..].chars().next() {
                        cursor += escaped.len_utf8();
                    }
                    continue;
                }
                let previous = text[..cursor].chars().next_back();
                let next = tail.chars().nth(1);
                let apostrophe = matches!(ch, '\'' | '’')
                    && previous.is_some_and(|c| c.is_ascii_alphanumeric())
                    && next.is_some_and(|c| c.is_ascii_alphanumeric());
                if quote == Some(ch) && !apostrophe {
                    quote = None;
                } else if quote.is_none() && !apostrophe {
                    quote = match ch {
                        '“' => Some('”'),
                        '‘' => Some('’'),
                        '「' => Some('」'),
                        '『' => Some('』'),
                        '"' | '\''
                            if previous.is_none_or(|p| {
                                p.is_whitespace() || matches!(p, '(' | '[' | '{' | ':')
                            }) =>
                        {
                            Some(ch)
                        }
                        _ => None,
                    };
                }
            }
            let plain_invoke = tail.strip_prefix(TOOL_CALL_OPEN).is_some_and(|rest| {
                let rest = rest.trim_start();
                rest.starts_with("<invoke") || rest.starts_with("invoke ")
            });
            if inline.is_none()
                && quote.is_none()
                && !blockquote
                && (tail.starts_with(MINIMAX_OPEN) || plain_invoke)
            {
                match invoke_envelope(text, cursor, declarations) {
                    Ok((calls, end)) => {
                        if cursor > consumed {
                            segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                        }
                        segments.push(ToolMarkupSegment::Calls(calls));
                        consumed = end;
                        cursor = end.min(line_end);
                    }
                    Err(incomplete) => {
                        incomplete_tool_invocation |= incomplete;
                        opaque_invocation = true;
                        let close = if plain_invoke {
                            TOOL_CALL_CLOSE
                        } else {
                            MINIMAX_CLOSE
                        };
                        skip_until = tail
                            .find(close)
                            .map(|end| cursor + end + close.len())
                            .unwrap_or(text.len());
                        cursor = skip_until.min(line_end);
                    }
                }
                continue;
            }
            if inline.is_none() && quote.is_none() && tail.starts_with(OPEN) {
                if let Some((calls, rest)) = envelope(tail, declarations) {
                    if cursor > consumed {
                        segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                    }
                    segments.push(ToolMarkupSegment::Calls(calls));
                    consumed = text.len() - rest.len();
                    cursor = consumed.min(line_end);
                    continue;
                }
                if recognized_truncated_fullwidth(tail, declarations) {
                    incomplete_tool_invocation = true;
                }
                opaque_invocation = true;
                // Do not extract a nested call from an envelope that failed
                // atomic parsing. The original complete span remains visible.
                skip_until = tail
                    .find(CLOSE)
                    .map(|end| cursor + end + CLOSE.len())
                    .unwrap_or(text.len());
                cursor = skip_until.min(line_end);
                continue;
            }
            let paired_tool_start = (cursor == current_line_start
                && tail.starts_with(" calls><tool_call>"))
            .then_some(cursor + " calls>".len());
            if inline.is_none()
                && quote.is_none()
                && !blockquote
                && (tail.starts_with(TOOL_CALL_OPEN) || paired_tool_start.is_some())
            {
                let tool_start = paired_tool_start.unwrap_or(cursor);
                if let Some((call, end)) =
                    parse_tool_call_invocation(text, tool_start, declarations)
                {
                    if cursor > consumed {
                        segments.push(ToolMarkupSegment::Text(&text[consumed..cursor]));
                    }
                    segments.push(ToolMarkupSegment::Calls(vec![call]));
                    consumed = end;
                    cursor = end.min(line_end);
                } else {
                    opaque_invocation = true;
                    if declared_function_tool_call_start(text, tool_start, declarations)
                        && text
                            .get(tool_start..)
                            .is_some_and(|rest| !rest.contains(TOOL_CALL_CLOSE))
                    {
                        incomplete_tool_invocation = true;
                    }
                    cursor += ch.len_utf8();
                }
                continue;
            }
            cursor += ch.len_utf8();
        }
    }
    if consumed < text.len() {
        segments.push(ToolMarkupSegment::Text(&text[consumed..]));
    }
    ToolMarkupScan {
        segments,
        removed_label,
        opener_label,
        incomplete_tool_invocation,
        opaque_invocation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_markup_parser_issue03c2a07_review_prose_tail() {
        let text = "<tool_call>invoke name=\"read_image\"><file_path>x</file_path></invoke>\ninvoke the next step only after confirmation.";
        let scan = scan_tool_markup(text, &declarations());
        assert!(!scan.incomplete_tool_invocation, "{scan:?}");
        assert!(matches!(&scan.segments[0], ToolMarkupSegment::Calls(calls) if calls.len() == 1));
        assert_eq!(
            scan.segments[1],
            ToolMarkupSegment::Text("\ninvoke the next step only after confirmation.")
        );
    }

    #[test]
    fn tool_markup_parser_issue03c2a07_inner_completion_and_preservation() {
        let declarations = declarations();
        let value = "  \"quoted\"\\path\n```\n]<]minimax[>[ e\u{301}  ";
        for opener in ["<invoke", "invoke"] {
            for outer_close in ["", TOOL_CALL_CLOSE] {
                let text = format!("Before\n<tool_call>{opener} name=\"read_image\"><file_path>{value}</file_path></invoke>{outer_close}\nAfter");
                let scan = scan_tool_markup(&text, &declarations);
                assert!(!scan.incomplete_tool_invocation, "{scan:?}");
                let calls: Vec<_> = scan
                    .segments
                    .iter()
                    .filter_map(|s| match s {
                        ToolMarkupSegment::Calls(calls) => Some(calls),
                        _ => None,
                    })
                    .flatten()
                    .collect();
                assert_eq!(calls.len(), 1, "{scan:?}");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&calls[0].arguments).unwrap(),
                    serde_json::json!({"file_path":value})
                );
                let text: String = scan
                    .segments
                    .iter()
                    .filter_map(|s| match s {
                        ToolMarkupSegment::Text(text) => Some(*text),
                        _ => None,
                    })
                    .collect();
                assert_eq!(text, "Before\n\nAfter");
            }
        }
        for suffix in [
            "",
            "<file_path>x",
            "<file_path>x</file_path>",
            "<file_path>x</tool_call>",
        ] {
            let text = format!("<tool_call>invoke name=\"read_image\">{suffix}");
            assert!(
                scan_tool_markup(&text, &declarations).incomplete_tool_invocation,
                "{text}"
            );
        }
        let complete = "<tool_call>invoke name=\"read_image\"><file_path>x</file_path></invoke>";
        let half_close = format!("{complete}</tool_call");
        let scan = scan_tool_markup(&half_close, &declarations);
        assert!(!scan.incomplete_tool_invocation);
        assert!(
            scan.segments.iter().all(
                |s| !matches!(s, ToolMarkupSegment::Text(text) if text.contains("</tool_call"))
            ),
            "{scan:?}"
        );
        for tail in ["<inv", "<invoke", "invoke name=\"read_image\""] {
            let text = format!("{complete}{tail}");
            assert!(
                scan_tool_markup(&text, &declarations).incomplete_tool_invocation,
                "{text}"
            );
        }
        for text in [
            format!("```xml\n{complete}\n```"),
            format!("`{complete}`"),
            format!("\"{complete}\""),
            complete.replace("read_image", "unknown"),
            "ordinary invoke name=\"read_image\"><file_path>x</file_path></invoke>".into(),
        ] {
            let scan = scan_tool_markup(&text, &declarations);
            assert!(!scan.incomplete_tool_invocation);
            assert_eq!(scan.segments, vec![ToolMarkupSegment::Text(text.as_str())]);
        }
    }

    #[test]
    fn tool_markup_parser_f665809_minimax_values_and_atomic_boundaries() {
        let mut declared = declarations();
        declared.insert(
            "exec_command".into(),
            ToolMarkupIdentity {
                kind: ToolMarkupKind::Function,
                parameter_kinds: HashMap::from([
                    ("cmd".into(), ToolMarkupParamKind::String),
                    ("workdir".into(), ToolMarkupParamKind::String),
                    ("max_output_tokens".into(), ToolMarkupParamKind::Number),
                    ("yield_time_ms".into(), ToolMarkupParamKind::Number),
                ]),
            },
        );
        let value = "  printf \"hi\"\\path\n```\n]<]minimax[>[ ordinary value  ";
        let text = format!("{MINIMAX_OPEN}{MINIMAX_PREFIX}<invoke name=\"exec_command\">{MINIMAX_PREFIX}<cmd>{value}{MINIMAX_PREFIX}</cmd>{MINIMAX_PREFIX}<workdir>123{MINIMAX_PREFIX}</workdir>{MINIMAX_PREFIX}<max_output_tokens>4000{MINIMAX_PREFIX}</max_output_tokens>{MINIMAX_PREFIX}<yield_time_ms>bad-model-value{MINIMAX_PREFIX}</yield_time_ms>{MINIMAX_PREFIX}</invoke>{MINIMAX_CLOSE}");
        let scan = scan_tool_markup(&text, &declared);
        assert!(!scan.incomplete_tool_invocation);
        let ToolMarkupSegment::Calls(calls) = &scan.segments[0] else {
            panic!("not harvested: {scan:?}")
        };
        assert_eq!(calls.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&calls[0].arguments).unwrap(),
            serde_json::json!({"cmd":value,"workdir":"123","max_output_tokens":4000,"yield_time_ms":"bad-model-value"})
        );
        for text in [
            format!("```xml\n{text}\n```"),
            format!("`{text}`"),
            format!("\"{text}\""),
            format!("    {text}"),
        ] {
            let scan = scan_tool_markup(&text, &declared);
            assert!(
                scan.segments
                    .iter()
                    .all(|segment| matches!(segment, ToolMarkupSegment::Text(_))),
                "literal was harvested: {scan:?}"
            );
            assert!(!scan.incomplete_tool_invocation);
        }
        for suffix in [
            "",
            "]<]minimax[>[<file_path>x",
            "]<]minimax[>[<file_path>x]<]minimax[>[</file_path>",
            "]<]minimax[>[</invoke>",
        ] {
            let truncated =
                format!("{MINIMAX_OPEN}{MINIMAX_PREFIX}<invoke name=\"read_image\">{suffix}");
            assert!(
                scan_tool_markup(&truncated, &declared).incomplete_tool_invocation,
                "declared truncation escaped: {truncated}"
            );
        }
        let unknown = format!("{MINIMAX_OPEN}{MINIMAX_PREFIX}<invoke name=\"unknown\">{MINIMAX_PREFIX}<cmd>x{MINIMAX_PREFIX}</cmd>{MINIMAX_PREFIX}</invoke>{MINIMAX_CLOSE}");
        let scan = scan_tool_markup(&unknown, &declared);
        assert!(!scan.incomplete_tool_invocation);
        assert_eq!(
            scan.segments,
            vec![ToolMarkupSegment::Text(unknown.as_str())]
        );
    }

    fn declarations() -> ToolMarkupDeclarations {
        let mut declarations = ToolMarkupDeclarations::default();
        declarations.insert(
            "read_image".to_string(),
            ToolMarkupIdentity {
                kind: ToolMarkupKind::Function,
                parameter_kinds: HashMap::from([(
                    "file_path".to_string(),
                    ToolMarkupParamKind::String,
                )]),
            },
        );
        declarations
    }

    fn read_image(value: &str) -> String {
        format!(
            "{OPEN}<｜｜DSML｜｜ invoke name=\"read_image\"><｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">{value}{END_PARAM}{END_INVOKE}{CLOSE}"
        )
    }

    #[test]
    fn tool_markup_parser_consumes_argument_fences_atomically_and_removes_observed_label() {
        let observed_label = "<｜end▁of▁analysis｜>";
        let text = format!(
            "{}\n{observed_label}\n{}",
            read_image("first\n```\ninside argument"),
            read_image("second")
        );
        let scan = scan_tool_markup(&text, &declarations());

        assert!(
            scan.removed_label,
            "observed fullwidth label was not removed"
        );
        assert!(
            !scan.incomplete_tool_invocation,
            "fence inside an argument must not truncate"
        );
        let calls: Vec<_> = scan
            .segments
            .iter()
            .filter_map(|segment| match segment {
                ToolMarkupSegment::Calls(calls) => Some(calls.as_slice()),
                ToolMarkupSegment::Text(_) => None,
            })
            .flatten()
            .collect();
        assert_eq!(calls.len(), 2, "both complete envelopes must be recognized");
        assert_eq!(calls[0].wire_name, "read_image");
        assert_eq!(
            calls[0].arguments,
            "{\"file_path\":\"first\\n```\\ninside argument\"}"
        );
        assert_eq!(calls[1].arguments, "{\"file_path\":\"second\"}");
        let text_after: String = scan
            .segments
            .iter()
            .filter_map(|segment| match segment {
                ToolMarkupSegment::Text(text) => Some(*text),
                ToolMarkupSegment::Calls(_) => None,
            })
            .collect();
        assert!(
            !text_after.contains(observed_label),
            "observed label must remain outside text: {text_after:?}"
        );
    }

    #[test]
    fn tool_markup_parser_distinguishes_incomplete_declared_tool_invocations() {
        // Declared function invocation that never reaches its close: this is the
        // recognized incomplete shape that must discard the governed attempt.
        let truncated_fullwidth = format!(
            "{OPEN}<｜｜DSML｜｜ invoke name=\"read_image\"><｜｜DSML｜｜ parameter name=\"file_path\" string=\"true\">x"
        );
        let scan = scan_tool_markup(&truncated_fullwidth, &declarations());
        assert!(scan.incomplete_tool_invocation);

        let truncated_tool_call =
            "<tool_call>read_image<arg_key>file_path</arg_key><arg_value>x</arg_value>";
        let scan = scan_tool_markup(truncated_tool_call, &declarations());
        assert!(scan.incomplete_tool_invocation);

        // Unknown or complete-but-unrepresentable business text stays opaque and
        // must not be promoted into the incomplete-invocation policy.
        for opaque in [
            "<tool_call>undeclared<arg_key>cmd</arg_key><arg_value>x</arg_value>",
            "<tool_call>read_image<arg_key>file_path</arg_key><arg_value>x</arg_value><arg_key>file_path</arg_key><arg_value>y</arg_value></tool_call>",
            "<tool_call>read_image<arg_key>file_path</arg_key><arg_value>x</arg_value></tool_call>",
            "<|read_image\">\n<file_path>a</file_path>\n<file_path>b</file_path>\n</read_image>",
            "<|undeclared\">\n<cmd>x</cmd>",
        ] {
            let scan = scan_tool_markup(opaque, &declarations());
            assert!(
                !scan.incomplete_tool_invocation,
                "opaque text must not be classified incomplete: {opaque}"
            );
        }
    }
}
