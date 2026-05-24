use regex::Regex;
use std::collections::HashSet;

fn strip_box_drawing_prefix(line: &str) -> String {
    Regex::new(r"^[\s│└├─]+")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.trim_start().to_string())
}

fn strip_terminal_right_gutter_noise(line: &str) -> String {
    Regex::new(r"\s+[│┃]\s*[·.]{6,}\s*$")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.to_string())
}

fn is_transcript_collapsed_placeholder(line: &str) -> bool {
    Regex::new(r"(?i)^\s*[│└├─\s]*[.…·]+\s*\+\d+\s+lines\s*$")
        .map(|re| re.is_match(line))
        .unwrap_or(false)
}

fn transcript_tree_marker(line: &str) -> Option<char> {
    line.trim_start()
        .chars()
        .next()
        .filter(|ch| matches!(ch, '│' | '└' | '├'))
}

fn unwrap_ran_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    let first = lines.first()?.trim_start();
    if !first.starts_with("• Ran ") {
        return None;
    }
    if lines.len() < 2 {
        return None;
    }
    let has_tree_body = lines.iter().skip(1).any(|line| {
        Regex::new(r"^[\s]*[│└├]")
            .map(|re| re.is_match(line))
            .unwrap_or(false)
    });
    if !has_tree_body {
        return None;
    }

    let mut out: Vec<String> = Vec::new();
    for line in lines.iter().skip(1) {
        if is_transcript_collapsed_placeholder(line) {
            continue;
        }
        match transcript_tree_marker(line) {
            Some('└') => {}
            Some('│') | Some('├') => continue,
            _ => {}
        }
        let stripped = strip_box_drawing_prefix(line).trim().to_string();
        if stripped.is_empty() || stripped.eq_ignore_ascii_case("(ctrl + t to view transcript)") {
            continue;
        }
        out.push(stripped);
    }
    let text = out.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn is_chunked_exec_transcript_header_line(line: &str) -> bool {
    Regex::new(
        r"(?i)^(?:\[工具结果\]|Command:\s+.*|Chunk ID:\s+.*|Wall time:\s+.*|Process exited with code\s+.*|Process running with session ID\s+.*|Original token count:\s+.*)$",
    )
    .map(|re| re.is_match(line.trim()))
    .unwrap_or(false)
}

fn unwrap_chunked_exec_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return None;
    }
    let output_idx = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("Output:"))?;
    let header = &lines[..output_idx];
    if header.is_empty()
        || !header
            .iter()
            .all(|line| is_chunked_exec_transcript_header_line(line))
    {
        return None;
    }
    Some(
        lines
            .iter()
            .skip(output_idx + 1)
            .copied()
            .collect::<Vec<&str>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

pub(crate) fn sanitize_text_harvest_shape(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_gutter = trimmed
        .lines()
        .map(strip_terminal_right_gutter_noise)
        .collect::<Vec<String>>()
        .join("\n");
    if let Some(unwrapped) = unwrap_chunked_exec_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    if let Some(unwrapped) = unwrap_ran_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    without_gutter.trim().to_string()
}

pub(crate) fn collect_stage1_harvest_input_texts(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut push = |value: String| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if seen.insert(trimmed.clone()) {
            out.push(trimmed);
        }
    };

    push(raw.to_string());
    push(sanitize_text_harvest_shape(raw));
    out
}
