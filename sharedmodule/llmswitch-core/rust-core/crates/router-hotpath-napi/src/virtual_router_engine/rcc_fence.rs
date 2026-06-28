use serde::{Deserialize, Serialize};

const RCC_FENCE_OPEN: &str = "<**rcc**>";
const RCC_FENCE_CLOSE: &str = "</rcc**>";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccFenceBlock {
    pub raw: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub command_line: String,
    pub domain: String,
    pub action: String,
    pub args: Vec<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccDirective {
    pub directive_type: String,
    pub domain: String,
    pub action: String,
    pub args: Vec<String>,
    pub body: String,
    pub passthrough: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RccFenceDocument {
    pub blocks: Vec<RccFenceBlock>,
    pub directives: Vec<RccDirective>,
}

fn trim_blank_edges(text: &str) -> String {
    text.trim_matches(|ch| ch == '\n' || ch == '\r').to_string()
}

fn parse_block(
    content: &str,
    raw: String,
    start_offset: usize,
    end_offset: usize,
) -> Result<RccFenceBlock, String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let Some(command_index) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
    };
    let command_line = lines[command_index].trim().to_string();
    let tokens: Vec<&str> = command_line.split_whitespace().collect();
    if tokens.len() < 2 {
        return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
    }
    let domain = tokens[0].trim().to_ascii_lowercase();
    let action = tokens[1].trim().to_ascii_lowercase();
    let args = tokens
        .iter()
        .skip(2)
        .map(|entry| entry.trim().to_string())
        .collect();
    let body = if command_index + 1 >= lines.len() {
        String::new()
    } else {
        trim_blank_edges(&lines[(command_index + 1)..].join("\n"))
    };

    Ok(RccFenceBlock {
        raw,
        start_offset,
        end_offset,
        command_line,
        domain,
        action,
        args,
        body,
    })
}

fn require_empty_body(block: &RccFenceBlock) -> Result<(), String> {
    if block.body.trim().is_empty() {
        return Ok(());
    }
    Err("RCC_FENCE_BODY_FORBIDDEN".to_string())
}

fn require_non_empty_body(block: &RccFenceBlock) -> Result<(), String> {
    if block.body.trim().is_empty() {
        return Err("RCC_FENCE_BODY_REQUIRED".to_string());
    }
    Ok(())
}

fn resolve_directive(block: &RccFenceBlock) -> Result<RccDirective, String> {
    let directive_type = format!("{}.{}", block.domain, block.action);
    match block.domain.as_str() {
        "stopless" => match block.action.as_str() {
            "start" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "body-forward".to_string(),
                })
            }
            "pause" | "resume" | "stop" => Ok(RccDirective {
                directive_type,
                domain: block.domain.clone(),
                action: block.action.clone(),
                args: block.args.clone(),
                body: block.body.clone(),
                passthrough: "private-only".to_string(),
            }),
            "done" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "private-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "stop_message" => match block.action.as_str() {
            "set" => {
                require_non_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: block.body.clone(),
                    passthrough: "private-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "route" => match block.action.as_str() {
            "use" | "allow" | "disable" => {
                if block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        "precommand" => match block.action.as_str() {
            "set" => {
                if block.args.len() != 1 {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: block.args.clone(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            "clear" => {
                if !block.args.is_empty() {
                    return Err("RCC_FENCE_INVALID_COMMAND_LINE".to_string());
                }
                require_empty_body(block)?;
                Ok(RccDirective {
                    directive_type,
                    domain: block.domain.clone(),
                    action: block.action.clone(),
                    args: Vec::new(),
                    body: String::new(),
                    passthrough: "state-only".to_string(),
                })
            }
            _ => Err("RCC_FENCE_UNKNOWN_ACTION".to_string()),
        },
        _ => Err("RCC_FENCE_UNKNOWN_DOMAIN".to_string()),
    }
}

pub(crate) fn parse_rcc_fence_blocks(text: &str) -> Result<Vec<RccFenceBlock>, String> {
    let mut blocks = Vec::new();
    let mut cursor = 0usize;

    while let Some(open_rel) = text[cursor..].find(RCC_FENCE_OPEN) {
        let start_offset = cursor + open_rel;
        let content_start = start_offset + RCC_FENCE_OPEN.len();
        let remaining = &text[content_start..];
        let Some(close_rel) = remaining.find(RCC_FENCE_CLOSE) else {
            return Err("RCC_FENCE_UNCLOSED".to_string());
        };
        let close_offset = content_start + close_rel;
        if let Some(nested_rel) = remaining[..close_rel].find(RCC_FENCE_OPEN) {
            let nested_abs = content_start + nested_rel;
            if nested_abs < close_offset {
                return Err("RCC_FENCE_NESTED_UNSUPPORTED".to_string());
            }
        }
        let end_offset = close_offset + RCC_FENCE_CLOSE.len();
        let raw = text[start_offset..end_offset].to_string();
        let inner = &text[content_start..close_offset];
        blocks.push(parse_block(inner, raw, start_offset, end_offset)?);
        cursor = end_offset;
    }

    Ok(blocks)
}

pub(crate) fn parse_rcc_fence_document(text: &str) -> Result<RccFenceDocument, String> {
    let blocks = parse_rcc_fence_blocks(text)?;
    let mut directives = Vec::with_capacity(blocks.len());
    for block in &blocks {
        directives.push(resolve_directive(block)?);
    }
    Ok(RccFenceDocument { blocks, directives })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_complete_stopless_block() {
        let doc = parse_rcc_fence_document(
            "prefix\n<**rcc**>\nstopless start\nBuild the release artifact\ncollect logs\n</rcc**>\nsuffix",
        )
        .expect("document");

        assert_eq!(doc.blocks.len(), 1);
        let block = &doc.blocks[0];
        assert_eq!(block.domain, "stopless");
        assert_eq!(block.action, "start");
        assert_eq!(block.command_line, "stopless start");
        assert_eq!(block.body, "Build the release artifact\ncollect logs");

        assert_eq!(doc.directives[0].directive_type, "stopless.start");
        assert_eq!(doc.directives[0].passthrough, "body-forward");
    }

    #[test]
    fn preserves_multiple_block_order() {
        let doc = parse_rcc_fence_document(
            "<**rcc**>\nroute use provider.a.model\n</rcc**>\n<**rcc**>\nstop_message set\nhello\n</rcc**>",
        )
        .expect("document");

        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.directives[0].directive_type, "route.use");
        assert_eq!(doc.directives[1].directive_type, "stop_message.set");
    }

    #[test]
    fn supports_body_forward_private_only_and_state_only_passthrough_modes() {
        let start = parse_rcc_fence_document("<**rcc**>\nstopless start\nship it\n</rcc**>")
            .expect("start");
        let pause =
            parse_rcc_fence_document("<**rcc**>\nstopless pause\nwaiting for Jason\n</rcc**>")
                .expect("pause");
        let clear =
            parse_rcc_fence_document("<**rcc**>\nstop_message clear\n</rcc**>").expect("clear");

        assert_eq!(start.directives[0].passthrough, "body-forward");
        assert_eq!(pause.directives[0].passthrough, "private-only");
        assert_eq!(clear.directives[0].passthrough, "state-only");
    }

    #[test]
    fn rejects_unclosed_block() {
        let error =
            parse_rcc_fence_document("<**rcc**>\nstopless start\nbody").expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_UNCLOSED");
    }

    #[test]
    fn rejects_nested_block() {
        let error = parse_rcc_fence_document(
            "<**rcc**>\nstopless start\n<**rcc**>\nstop_message clear\n</rcc**>\n</rcc**>",
        )
        .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_NESTED_UNSUPPORTED");
    }

    #[test]
    fn rejects_unknown_domain() {
        let error = parse_rcc_fence_document("<**rcc**>\nunknown start\nbody\n</rcc**>")
            .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_UNKNOWN_DOMAIN");
    }

    #[test]
    fn rejects_missing_required_body() {
        let error = parse_rcc_fence_document("<**rcc**>\nstopless done\n</rcc**>")
            .expect_err("should fail");
        assert_eq!(error, "RCC_FENCE_BODY_REQUIRED");
    }
}
