use super::*;

pub(crate) fn format_v3_usage_request_id(request_id: &str) -> String {
    let normalized = request_id.trim();
    let normalized = if normalized.is_empty() {
        "unknown-request"
    } else {
        normalized
    };
    if let Some(sequence) = parse_v3_direct_sequence(normalized, '-') {
        return sequence;
    }
    if let Some(rest) = normalized.strip_prefix("req_") {
        if let Some(sequence) = parse_v3_direct_sequence(rest, '_') {
            return sequence;
        }
    }
    if let Some(sequence) = parse_v3_trailing_provider_sequence(normalized) {
        return sequence;
    }
    short_v3_request_tail(normalized, 8)
}

pub(crate) fn parse_v3_direct_sequence(value: &str, delimiter: char) -> Option<String> {
    let (left, right) = value.split_once(delimiter)?;
    if !left.is_empty()
        && !right.is_empty()
        && left.chars().all(|character| character.is_ascii_digit())
        && right.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{left}-{right}"))
    } else {
        None
    }
}

pub(crate) fn parse_v3_trailing_provider_sequence(value: &str) -> Option<String> {
    let without_suffix = value.split(':').next().unwrap_or(value);
    let mut segments = without_suffix.rsplitn(3, '-');
    let daily = segments.next()?;
    let total = segments.next()?;
    if !daily.is_empty()
        && !total.is_empty()
        && daily.chars().all(|character| character.is_ascii_digit())
        && total.chars().all(|character| character.is_ascii_digit())
    {
        Some(format!("{total}-{daily}"))
    } else {
        None
    }
}

pub(crate) fn short_v3_request_tail(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars[chars.len() - max_chars..].iter().collect()
}

pub(crate) fn format_v3_console_project_name(project_path: Option<&str>) -> String {
    let Some(project) = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return "-".to_string();
    };
    let trimmed = project.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return "-".to_string();
    }
    std::path::Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .map(format_v3_console_safe_label)
        .filter(|value| value != "-")
        .unwrap_or_else(|| {
            trimmed
                .rsplit(['/', '\\'])
                .find(|value| !value.trim().is_empty())
                .map(format_v3_console_safe_label)
                .unwrap_or_else(|| "-".to_string())
        })
}
