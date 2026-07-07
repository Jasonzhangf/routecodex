// feature_id: config.user_config_codec
// feature_id: config.provider_config_codec
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigTextDecodeInput {
    raw: String,
    #[serde(default)]
    config_path: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFormatDetectInput {
    config_path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFileWriteInput {
    config_path: String,
    parsed: Value,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserConfigStringScalarUpdateInput {
    config_path: String,
    table_path: Vec<String>,
    key: String,
    value: String,
}

pub fn decode_user_config_text_json(input_json: &str) -> Result<String, String> {
    decode_config_text_json(input_json, ConfigFileKind::User)
}

pub fn decode_provider_config_text_json(input_json: &str) -> Result<String, String> {
    decode_config_text_json(input_json, ConfigFileKind::Provider)
}

pub fn detect_user_config_format_json(input_json: &str) -> Result<String, String> {
    detect_config_format_json(input_json, ConfigFileKind::User)
}

pub fn detect_provider_config_format_json(input_json: &str) -> Result<String, String> {
    detect_config_format_json(input_json, ConfigFileKind::Provider)
}

pub fn write_user_config_file_json(input_json: &str) -> Result<String, String> {
    write_config_file_json(input_json, ConfigFileKind::User)
}

pub fn write_provider_config_file_json(input_json: &str) -> Result<String, String> {
    write_config_file_json(input_json, ConfigFileKind::Provider)
}

pub fn update_user_config_string_scalar_json(input_json: &str) -> Result<String, String> {
    let input: UserConfigStringScalarUpdateInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid user config scalar update input: {err}"))?;
    ensure_toml_path(input.config_path.trim(), &ConfigFileKind::User)?;
    let raw = fs::read_to_string(&input.config_path)
        .map_err(|err| format!("Failed to read config file {}: {err}", input.config_path))?;
    let updated = crate::config_toml_codec::update_toml_string_scalar_in_table_json(
        &json!({
            "raw": raw,
            "tablePath": input.table_path,
            "key": input.key,
            "value": input.value,
        })
        .to_string(),
    )?;
    write_raw_config_atomically(&input.config_path, &updated)?;
    decode_persisted_config_output(&input.config_path, &updated, ConfigFileKind::User)
}

#[derive(Clone, Copy)]
enum ConfigFileKind {
    User,
    Provider,
}

impl ConfigFileKind {
    fn label(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Provider => "provider",
        }
    }

    fn format_error(&self, config_path: &str) -> String {
        format!(
            "[config] {} config JSON support removed; expected TOML file: {}",
            self.label(),
            config_path
        )
    }

    fn writer_format_error(&self) -> String {
        format!(
            "[config] {} config JSON support removed; writer only accepts TOML",
            self.label()
        )
    }
}

fn decode_config_text_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigTextDecodeInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid {} config text decode input: {err}", kind.label()))?;
    if let Some(config_path) = input.config_path.as_deref() {
        ensure_toml_path(config_path.trim(), &kind)?;
    }
    let parsed_json = crate::config_toml_codec::parse_toml_record_json(&input.raw)?;
    let parsed: Value = serde_json::from_str(&parsed_json)
        .map_err(|err| format!("[config] failed to decode parsed TOML JSON: {err}"))?;
    let Value::Object(_) = parsed else {
        return Err("[config] TOML codec returned non-object root for config text".to_string());
    };
    serde_json::to_string(&json!({
        "format": "toml",
        "parsed": parsed,
    }))
    .map_err(|err| format!("[config] failed to encode {} config text decode output: {err}", kind.label()))
}

fn detect_config_format_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigFormatDetectInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid {} config format detect input: {err}", kind.label()))?;
    ensure_toml_path(input.config_path.trim(), &kind)?;
    serde_json::to_string(&json!({ "format": "toml" }))
        .map_err(|err| format!("[config] failed to encode {} config format output: {err}", kind.label()))
}

fn write_config_file_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigFileWriteInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid {} config write input: {err}", kind.label()))?;
    if let Some(format) = input.format.as_deref() {
        if format != "toml" {
            return Err(kind.writer_format_error());
        }
    } else {
        ensure_toml_path(input.config_path.trim(), &kind)?;
    }
    let Value::Object(_) = &input.parsed else {
        return Err(format!(
            "[config] {} config writer expected object root",
            kind.label()
        ));
    };
    let raw = crate::config_toml_codec::serialize_toml_record_json(&input.parsed.to_string())?;
    write_raw_config_atomically(&input.config_path, &raw)?;
    encode_persisted_config_output(&input.config_path, raw, input.parsed, kind)
}

fn decode_persisted_config_output(
    config_path: &str,
    raw: &str,
    kind: ConfigFileKind,
) -> Result<String, String> {
    let decoded_json = decode_config_text_json(
        &json!({
            "configPath": config_path,
            "raw": raw,
        })
        .to_string(),
        kind,
    )?;
    let decoded: Value = serde_json::from_str(&decoded_json)
        .map_err(|err| format!("[config] failed to decode persisted config output: {err}"))?;
    let parsed = decoded
        .get("parsed")
        .cloned()
        .ok_or_else(|| "[config] decoded persisted config output missing parsed".to_string())?;
    encode_persisted_config_output(config_path, raw.to_string(), parsed, kind)
}

fn encode_persisted_config_output(
    config_path: &str,
    raw: String,
    parsed: Value,
    kind: ConfigFileKind,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "path": config_path,
        "format": "toml",
        "raw": raw,
        "parsed": parsed,
    }))
    .map_err(|err| format!("[config] failed to encode {} config write output: {err}", kind.label()))
}

fn write_raw_config_atomically(config_path: &str, raw: &str) -> Result<(), String> {
    let wrote_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let tmp_path = format!("{config_path}.tmp.{}.{}", process::id(), wrote_at_ms);
    fs::write(&tmp_path, raw).map_err(|err| format!("Failed to write config file {tmp_path}: {err}"))?;
    fs::rename(&tmp_path, config_path)
        .map_err(|err| format!("Failed to move config file {tmp_path} to {config_path}: {err}"))
}

fn ensure_toml_path(config_path: &str, kind: &ConfigFileKind) -> Result<(), String> {
    if config_path.is_empty() {
        return Err(kind.format_error(config_path));
    }
    let ext = Path::new(config_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "toml" {
        return Err(kind.format_error(config_path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_provider_config_text_json, decode_user_config_text_json,
        detect_provider_config_format_json, detect_user_config_format_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn decode_user_config_text_reads_toml_payload() {
        let output = decode_user_config_text_json(
            &json!({
                "configPath": "config.toml",
                "raw": "version = \"2.0.0\"\nvirtualrouterMode = \"v2\"\n"
            })
            .to_string(),
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            decoded
                .get("parsed")
                .and_then(Value::as_object)
                .and_then(|parsed| parsed.get("virtualrouterMode"))
                .and_then(Value::as_str),
            Some("v2")
        );
    }

    #[test]
    fn decode_provider_config_text_reads_toml_payload() {
        let output = decode_provider_config_text_json(
            &json!({
                "configPath": "config.v2.toml",
                "raw": "version = \"2.0.0\"\nproviderId = \"demo\"\n[provider]\nid = \"demo\"\ntype = \"openai\"\n"
            })
            .to_string(),
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(
            decoded
                .get("parsed")
                .and_then(Value::as_object)
                .and_then(|parsed| parsed.get("providerId"))
                .and_then(Value::as_str),
            Some("demo")
        );
    }

    #[test]
    fn decode_user_config_text_rejects_json_path() {
        let error = decode_user_config_text_json(
            &json!({ "configPath": "config.json", "raw": "{\"version\":\"2.0.0\"}\n" }).to_string(),
        )
        .unwrap_err();
        assert!(error.contains("user config JSON support removed"));
    }

    #[test]
    fn decode_provider_config_text_rejects_json_path() {
        let error = decode_provider_config_text_json(
            &json!({ "configPath": "config.v2.json", "raw": "{\"version\":\"2.0.0\"}\n" }).to_string(),
        )
        .unwrap_err();
        assert!(error.contains("provider config JSON support removed"));
    }

    #[test]
    fn detect_config_format_accepts_only_toml() {
        let user: Value = serde_json::from_str(
            &detect_user_config_format_json(&json!({ "configPath": "config.toml" }).to_string())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(user.get("format").and_then(Value::as_str), Some("toml"));

        let provider: Value = serde_json::from_str(
            &detect_provider_config_format_json(
                &json!({ "configPath": "config.v2.toml" }).to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(provider.get("format").and_then(Value::as_str), Some("toml"));

        let user_error =
            detect_user_config_format_json(&json!({ "configPath": "config.json" }).to_string())
                .unwrap_err();
        assert!(user_error.contains("user config JSON support removed"));

        let provider_error = detect_provider_config_format_json(
            &json!({ "configPath": "config.v2.json" }).to_string(),
        )
        .unwrap_err();
        assert!(provider_error.contains("provider config JSON support removed"));
    }
}
