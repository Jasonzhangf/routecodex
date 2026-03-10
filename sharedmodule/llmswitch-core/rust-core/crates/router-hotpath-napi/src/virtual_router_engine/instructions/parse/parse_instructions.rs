use regex::Regex;
use std::env;

use super::super::path::{
    is_stop_message_file_reference, resolve_precommand_script_path, resolve_stop_message_text,
};
use super::super::types::{
    PreCommandInstruction, RoutingInstruction, StopMessageInstruction,
    StopMessageInstructionParseOutput, DEFAULT_PRECOMMAND_SCRIPT,
};
use super::parse_targets::{is_valid_identifier, parse_target, split_target_and_process_mode};

fn find_closing_quote(text: &str, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (idx, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some(idx);
        }
    }
    None
}

fn read_precommand_token(body: &str) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let first = body.chars().next().unwrap_or_default();
    if first == '"' || first == '\'' {
        let end = find_closing_quote(body, first)?;
        let extracted = body[1..end].replace("\\\"", "\"").replace("\\'", "'");
        return Some(extracted);
    }
    if let Some(idx) = body.find(',') {
        return Some(body[..idx].trim().to_string());
    }
    Some(body.trim().to_string())
}

fn parse_pre_command_instruction(instruction: &str) -> Result<Option<RoutingInstruction>, String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if Regex::new(r"^precommand$")
        .unwrap()
        .is_match(&trimmed.to_ascii_lowercase())
    {
        let script_path = resolve_precommand_default_script()?;
        return Ok(Some(RoutingInstruction {
            kind: "preCommandSet".to_string(),
            target: None,
            provider: None,
            stop_message: None,
            pre_command: Some(PreCommandInstruction {
                kind: "set".to_string(),
                script_path: Some(script_path),
            }),
        }));
    }
    if !Regex::new(r"^precommand\s*:")
        .unwrap()
        .is_match(&trimmed.to_ascii_lowercase())
    {
        return Ok(None);
    }
    let idx = trimmed.find(':').unwrap_or(trimmed.len());
    if idx >= trimmed.len() {
        return Ok(None);
    }
    let body = trimmed[idx + 1..].trim();
    if body.is_empty() {
        return Ok(None);
    }
    let parsed = read_precommand_token(body).unwrap_or_default();
    let normalized = parsed.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if Regex::new(r"^(?:clear|off|none)$")
        .unwrap()
        .is_match(&normalized.to_ascii_lowercase())
    {
        return Ok(Some(RoutingInstruction {
            kind: "preCommandClear".to_string(),
            target: None,
            provider: None,
            stop_message: None,
            pre_command: Some(PreCommandInstruction {
                kind: "clear".to_string(),
                script_path: None,
            }),
        }));
    }
    if Regex::new(r"^on$")
        .unwrap()
        .is_match(&normalized.to_ascii_lowercase())
    {
        let script_path = resolve_precommand_default_script()?;
        return Ok(Some(RoutingInstruction {
            kind: "preCommandSet".to_string(),
            target: None,
            provider: None,
            stop_message: None,
            pre_command: Some(PreCommandInstruction {
                kind: "set".to_string(),
                script_path: Some(script_path),
            }),
        }));
    }
    let script_path = resolve_precommand_script_path(normalized)?;
    Ok(Some(RoutingInstruction {
        kind: "preCommandSet".to_string(),
        target: None,
        provider: None,
        stop_message: None,
        pre_command: Some(PreCommandInstruction {
            kind: "set".to_string(),
            script_path: Some(script_path),
        }),
    }))
}

fn resolve_precommand_default_script() -> Result<String, String> {
    if let Ok(value) = env::var("ROUTECODEX_PRECOMMAND_DEFAULT_SCRIPT") {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return resolve_precommand_script_path(&trimmed);
        }
    }
    resolve_precommand_script_path(DEFAULT_PRECOMMAND_SCRIPT)
}

fn parse_stop_message_instruction(instruction: &str) -> Result<Option<RoutingInstruction>, String> {
    let raw = crate::virtual_router_stop_message_instruction::parse_stop_message_instruction_json(
        instruction.to_string(),
    )
    .map_err(|e| e.to_string())?;
    if raw.trim().is_empty() || raw.trim() == "null" {
        return Ok(None);
    }
    let parsed: Option<StopMessageInstructionParseOutput> =
        serde_json::from_str(&raw).map_err(|e| format!("stopMessage parse failed: {}", e))?;
    let parsed = match parsed {
        Some(value) => value,
        None => return Ok(None),
    };
    if parsed.kind == "clear" {
        return Ok(Some(RoutingInstruction {
            kind: "stopMessageClear".to_string(),
            target: None,
            provider: None,
            stop_message: Some(StopMessageInstruction {
                kind: "clear".to_string(),
                text: None,
                max_repeats: None,
                ai_mode: None,
                source: None,
                from_historical: false,
            }),
            pre_command: None,
        }));
    }
    if parsed.kind != "set" {
        return Ok(None);
    }
    let text = parsed.text.unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(None);
    }
    let resolved_text = resolve_stop_message_text(&text)?;
    let source = if is_stop_message_file_reference(&text) {
        Some("explicit_file".to_string())
    } else {
        Some("explicit_text".to_string())
    };
    Ok(Some(RoutingInstruction {
        kind: "stopMessageSet".to_string(),
        target: None,
        provider: None,
        stop_message: Some(StopMessageInstruction {
            kind: "set".to_string(),
            text: Some(resolved_text),
            max_repeats: parsed.max_repeats,
            ai_mode: parsed.ai_mode,
            source,
            from_historical: false,
        }),
        pre_command: None,
    }))
}

fn parse_named_target_instruction(instruction: &str, prefix: &str) -> Option<RoutingInstruction> {
    let re = Regex::new(&format!("(?i)^{}\\s*:", prefix)).ok()?;
    if !re.is_match(instruction) {
        return None;
    }
    let idx = instruction.find(':')?;
    let body = instruction[idx + 1..].trim();
    if body.is_empty() {
        return None;
    }
    let (target_text, process_mode) = split_target_and_process_mode(body);
    if target_text.is_empty() {
        return None;
    }
    let mut parsed = parse_target(&target_text)?;
    if let Some(mode) = process_mode {
        parsed.process_mode = Some(mode);
    }
    Some(RoutingInstruction {
        kind: prefix.to_string(),
        target: Some(parsed),
        provider: None,
        stop_message: None,
        pre_command: None,
    })
}

pub(super) fn parse_single_instruction(
    instruction: &str,
) -> Result<Option<RoutingInstruction>, String> {
    if Regex::new(r"^clear$")
        .unwrap()
        .is_match(&instruction.to_ascii_lowercase())
    {
        return Ok(Some(RoutingInstruction {
            kind: "clear".to_string(),
            target: None,
            provider: None,
            stop_message: None,
            pre_command: None,
        }));
    }
    if let Some(pre) = parse_pre_command_instruction(instruction)? {
        return Ok(Some(pre));
    }
    if let Some(stop) = parse_stop_message_instruction(instruction)? {
        return Ok(Some(stop));
    }
    if let Some(sticky) = parse_named_target_instruction(instruction, "sticky") {
        return Ok(Some(sticky));
    }
    if let Some(force) = parse_named_target_instruction(instruction, "force") {
        return Ok(Some(force));
    }
    if let Some(prefer) = parse_named_target_instruction(instruction, "prefer") {
        return Ok(Some(prefer));
    }
    if instruction.starts_with('!') {
        let raw_target = instruction[1..].trim();
        let (target_text, process_mode) = split_target_and_process_mode(raw_target);
        if target_text.is_empty() {
            return Ok(None);
        }
        let mut parsed = match parse_target(&target_text) {
            Some(value) => value,
            None => return Ok(None),
        };
        if let Some(mode) = process_mode {
            parsed.process_mode = Some(mode);
        }
        if !target_text.contains('.') {
            if let Some(provider) = parsed.provider.clone() {
                return Ok(Some(RoutingInstruction {
                    kind: "allow".to_string(),
                    target: None,
                    provider: Some(provider),
                    stop_message: None,
                    pre_command: None,
                }));
            }
            return Ok(None);
        }
        return Ok(Some(RoutingInstruction {
            kind: "prefer".to_string(),
            target: Some(parsed),
            provider: None,
            stop_message: None,
            pre_command: None,
        }));
    }
    if instruction.starts_with('#') {
        let target = instruction[1..].trim();
        if let Some(parsed) = parse_target(target) {
            return Ok(Some(RoutingInstruction {
                kind: "disable".to_string(),
                target: Some(parsed),
                provider: None,
                stop_message: None,
                pre_command: None,
            }));
        }
    } else if instruction.starts_with('@') {
        let target = instruction[1..].trim();
        if let Some(parsed) = parse_target(target) {
            return Ok(Some(RoutingInstruction {
                kind: "enable".to_string(),
                target: Some(parsed),
                provider: None,
                stop_message: None,
                pre_command: None,
            }));
        }
    } else if let Some(parsed) = parse_target(instruction) {
        if parsed.path_length.unwrap_or_default() > 1 {
            return Ok(Some(RoutingInstruction {
                kind: "force".to_string(),
                target: Some(parsed),
                provider: None,
                stop_message: None,
                pre_command: None,
            }));
        }
    } else if is_valid_identifier(instruction) {
        return Ok(Some(RoutingInstruction {
            kind: "allow".to_string(),
            target: None,
            provider: Some(instruction.to_string()),
            stop_message: None,
            pre_command: None,
        }));
    }
    Ok(None)
}

pub(super) fn normalize_stop_message_instruction_precedence(
    instructions: Vec<RoutingInstruction>,
) -> Vec<RoutingInstruction> {
    if instructions.len() <= 1 {
        return instructions;
    }
    let is_stop = |inst: &RoutingInstruction| {
        matches!(
            inst.kind.as_str(),
            "stopMessageSet" | "stopMessageMode" | "stopMessageClear"
        )
    };
    let has_global_clear = instructions.iter().any(|inst| inst.kind == "clear");
    let has_stop_clear = instructions
        .iter()
        .any(|inst| inst.kind == "stopMessageClear");
    if has_global_clear {
        let mut last_idx = None;
        for (idx, inst) in instructions.iter().enumerate() {
            if inst.kind == "clear" {
                last_idx = Some(idx);
            }
        }
        if let Some(idx) = last_idx {
            return vec![instructions[idx].clone()];
        }
        return instructions;
    }
    if has_stop_clear {
        let mut last_idx = None;
        for (idx, inst) in instructions.iter().enumerate() {
            if inst.kind == "stopMessageClear" {
                last_idx = Some(idx);
            }
        }
        if let Some(idx) = last_idx {
            return vec![instructions[idx].clone()];
        }
        return instructions;
    }
    let mut last_stop = None;
    for idx in (0..instructions.len()).rev() {
        if is_stop(&instructions[idx]) {
            last_stop = Some(idx);
            break;
        }
    }
    if let Some(last_idx) = last_stop {
        return instructions
            .into_iter()
            .enumerate()
            .filter(|(idx, inst)| !is_stop(inst) || *idx == last_idx)
            .map(|(_, inst)| inst)
            .collect();
    }
    instructions
}
