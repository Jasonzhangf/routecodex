use super::{
    chunk_string_json, flatten_by_comma_json, pack_shell_args_json, repair_find_meta_json,
    split_command_string_json,
};
use serde_json::json;

#[test]
fn shared_tooling_repair_find_meta_json() {
    let input = json!("find . -type f -exec echo {} ;").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed.as_str().unwrap().contains("\\;"));
}

#[test]
fn shared_tooling_repair_find_meta_json_escapes_bare_parens() {
    let input =
        json!("find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -print").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let repaired = parsed.as_str().unwrap_or("");
    assert!(repaired.contains("find . -type f \\("));
    assert!(repaired.contains("\\) -print"));
}

#[test]
fn shared_tooling_repair_find_meta_json_does_not_touch_non_find_shell() {
    let input = json!("bash -lc 'echo (hello)'").to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_str().unwrap_or(""), "bash -lc 'echo (hello)'");
}

#[test]
fn shared_tooling_repair_find_meta_json_repairs_quoted_find_parens_and_exec() {
    let input = json!(
        "bash -lc 'find . -type f ( -name \"*.ts\" -o -name \"*.tsx\" ) -exec sed -n \"1,3p\" {} ; | head -5'"
    )
    .to_string();
    let raw = repair_find_meta_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let repaired = parsed.as_str().unwrap_or("");
    assert!(repaired.contains("find . -type f \\("));
    assert!(repaired.contains("\\) -exec sed -n \"1,3p\" {} \\;"));
}

#[test]
fn shared_tooling_split_command_string_json() {
    let input = json!("echo hello world").to_string();
    let raw = split_command_string_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 3);
}

#[test]
fn shared_tooling_pack_shell_args_json() {
    let input = json!({"command": "cd /tmp && ls"}).to_string();
    let raw = pack_shell_args_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["workdir"], "/tmp");
    assert!(parsed["command"].is_array());
}

#[test]
fn shared_tooling_flatten_by_comma_json() {
    let input = json!(["a, b", "c"]).to_string();
    let raw = flatten_by_comma_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 3);
}

#[test]
fn shared_tooling_chunk_string_json() {
    let input =
        json!({"s": "abcdefghij", "minParts": 2, "maxParts": 4, "targetChunk": 4}).to_string();
    let raw = chunk_string_json(input).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed.as_array().unwrap().len() >= 2);
}
