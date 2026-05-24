use regex::Regex;
use std::fs;

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_text::{
    current_workspace_root, normalize_apply_patch_header_path,
};

fn normalize_patch_compare_line(raw: &str) -> String {
    raw.replace('\r', "")
        .replace('\t', " ")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim()
        .to_string()
}

fn line_sequence_matches_exact(haystack: &[String], start: usize, needle: &[String]) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle
        .iter()
        .enumerate()
        .all(|(offset, line)| haystack[start + offset] == *line)
}

fn line_sequence_matches_trimmed(haystack: &[String], start: usize, needle: &[String]) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle
        .iter()
        .enumerate()
        .all(|(offset, line)| haystack[start + offset].trim() == line.trim())
}

fn line_sequence_matches_whitespace_normalized(
    haystack: &[String],
    start: usize,
    needle: &[String],
) -> bool {
    if needle.is_empty() || start + needle.len() > haystack.len() {
        return false;
    }
    needle.iter().enumerate().all(|(offset, line)| {
        normalize_patch_compare_line(haystack[start + offset].as_str())
            == normalize_patch_compare_line(line.as_str())
    })
}

fn unique_match_in_window<F>(
    haystack: &[String],
    needle: &[String],
    preferred_index: usize,
    radius: usize,
    matcher: F,
) -> Option<usize>
where
    F: Fn(&[String], usize, &[String]) -> bool,
{
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let max_start = haystack.len().saturating_sub(needle.len());
    let start = preferred_index.saturating_sub(radius).min(max_start);
    let end = preferred_index.saturating_add(radius).min(max_start);
    let mut matches = Vec::<usize>::new();
    for index in start..=end {
        if matcher(haystack, index, needle) {
            matches.push(index);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    matches.into_iter().next()
}

fn unique_match_anywhere<F>(haystack: &[String], needle: &[String], matcher: F) -> Option<usize>
where
    F: Fn(&[String], usize, &[String]) -> bool,
{
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let max_start = haystack.len().saturating_sub(needle.len());
    let mut matches = Vec::<usize>::new();
    for start in 0..=max_start {
        if matcher(haystack, start, needle) {
            matches.push(start);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    matches.into_iter().next()
}

fn locate_live_file_block(
    file_lines: &[String],
    removed_lines: &[String],
    preferred_index: usize,
) -> Option<usize> {
    if removed_lines.is_empty() || file_lines.len() < removed_lines.len() {
        return None;
    }
    unique_match_in_window(
        file_lines,
        removed_lines,
        preferred_index,
        8,
        line_sequence_matches_exact,
    )
    .or_else(|| {
        unique_match_in_window(
            file_lines,
            removed_lines,
            preferred_index,
            8,
            line_sequence_matches_trimmed,
        )
    })
    .or_else(|| {
        unique_match_in_window(
            file_lines,
            removed_lines,
            preferred_index,
            8,
            line_sequence_matches_whitespace_normalized,
        )
    })
    .or_else(|| unique_match_anywhere(file_lines, removed_lines, line_sequence_matches_exact))
    .or_else(|| unique_match_anywhere(file_lines, removed_lines, line_sequence_matches_trimmed))
    .or_else(|| {
        unique_match_anywhere(
            file_lines,
            removed_lines,
            line_sequence_matches_whitespace_normalized,
        )
    })
}

fn parse_unified_hunk_header_line_numbers(line: &str) -> Option<(usize, usize, usize, usize)> {
    let caps = Regex::new(r"^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@")
        .ok()?
        .captures(line.trim())?;
    let old_start = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let old_len = caps
        .get(2)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);
    let new_start = caps.get(3)?.as_str().parse::<usize>().ok()?;
    let new_len = caps
        .get(4)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);
    Some((old_start, old_len, new_start, new_len))
}

fn try_rebuild_line_number_hunk_with_live_context(
    file_path: &str,
    header: &str,
    body_lines: &[String],
) -> Option<Vec<String>> {
    let (old_start, old_len, _new_start, _new_len) =
        parse_unified_hunk_header_line_numbers(header)?;
    let cwd = current_workspace_root()?;
    let absolute_path = cwd.join(file_path);
    let source = fs::read_to_string(absolute_path).ok()?;
    let file_lines: Vec<String> = source
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect();

    let removed_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix('-').map(|rest| rest.to_string()))
        .collect();
    let added_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix('+').map(|rest| rest.to_string()))
        .collect();
    let context_lines: Vec<String> = body_lines
        .iter()
        .filter_map(|line| line.strip_prefix(' ').map(|rest| rest.to_string()))
        .collect();

    if !context_lines.is_empty() {
        return None;
    }

    let preferred_index = old_start.saturating_sub(1);
    let block_start = if !removed_lines.is_empty() {
        locate_live_file_block(
            file_lines.as_slice(),
            removed_lines.as_slice(),
            preferred_index,
        )?
    } else {
        preferred_index.min(file_lines.len())
    };

    let block_end = if !removed_lines.is_empty() {
        block_start.saturating_add(removed_lines.len())
    } else {
        block_start
    };

    let mut rebuilt = Vec::<String>::new();
    rebuilt.push("@@".to_string());
    if block_start > 0 {
        rebuilt.push(format!(" {}", file_lines[block_start - 1]));
    }
    for line in &removed_lines {
        rebuilt.push(format!("-{}", line));
    }
    if removed_lines.is_empty() && old_len > 0 {
        let insert_end = block_start.saturating_add(old_len).min(file_lines.len());
        for line in &file_lines[block_start..insert_end] {
            rebuilt.push(format!(" {}", line));
        }
    }
    for line in &added_lines {
        rebuilt.push(format!("+{}", line));
    }
    if block_end < file_lines.len() {
        rebuilt.push(format!(" {}", file_lines[block_end]));
    }
    Some(rebuilt)
}

pub(crate) fn repair_line_number_update_hunks_with_live_context(patch_text: &str) -> String {
    let lines: Vec<String> = patch_text
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    if lines.is_empty() {
        return patch_text.to_string();
    }

    let mut out = Vec::<String>::new();
    let mut current_update_path: Option<String> = None;
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index].clone();
        if let Some(path) = line.strip_prefix("*** Update File:") {
            let normalized_path = normalize_apply_patch_header_path(path.trim());
            current_update_path = Some(normalized_path);
            out.push(format!(
                "*** Update File: {}",
                current_update_path.as_deref().unwrap_or("")
            ));
            index += 1;
            continue;
        }

        if line.starts_with("*** Add File:")
            || line.starts_with("*** Delete File:")
            || line.starts_with("*** Begin Patch")
            || line.starts_with("*** End Patch")
        {
            current_update_path = None;
            out.push(line);
            index += 1;
            continue;
        }

        if line.starts_with("@@") {
            let header = line.clone();
            let mut body = Vec::<String>::new();
            let mut cursor = index + 1;
            while cursor < lines.len() {
                let next = lines[cursor].clone();
                if next.starts_with("@@")
                    || next.starts_with("*** Update File:")
                    || next.starts_with("*** Add File:")
                    || next.starts_with("*** Delete File:")
                    || next.starts_with("*** End Patch")
                {
                    break;
                }
                body.push(next);
                cursor += 1;
            }

            let rebuilt = current_update_path.as_deref().and_then(|path| {
                try_rebuild_line_number_hunk_with_live_context(
                    path,
                    header.as_str(),
                    body.as_slice(),
                )
            });
            if let Some(rebuilt) = rebuilt {
                out.extend(rebuilt);
            } else {
                out.push(header);
                out.extend(body);
            }
            index = cursor;
            continue;
        }

        out.push(line);
        index += 1;
    }

    out.join("\n")
}
