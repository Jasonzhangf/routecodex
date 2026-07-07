// feature_id: config.user_config_codec
// feature_id: config.provider_config_codec
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFileDecodeInput {
    config_path: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigTextDecodeInput {
    raw: String,
    #[serde(default)]
    config_path: Option<String>,
}

pub fn decode_user_config_file_json(input_json: &str) -> Result<String, String> {
    decode_config_file_json(input_json, ConfigFileKind::User)
}

pub fn decode_provider_config_file_json(input_json: &str) -> Result<String, String> {
    decode_config_file_json(input_json, ConfigFileKind::Provider)
}

pub fn decode_user_config_text_json(input_json: &str) -> Result<String, String> {
    decode_config_text_json(input_json, ConfigFileKind::User)
}

pub fn decode_provider_config_text_json(input_json: &str) -> Result<String, String> {
    decode_config_text_json(input_json, ConfigFileKind::Provider)
}

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
}

fn decode_config_file_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigFileDecodeInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid {} config decode input: {err}", kind.label()))?;
    let config_path = input.config_path.trim();
    ensure_toml_path(config_path, &kind)?;
    let raw = fs::read_to_string(config_path)
        .map_err(|err| format!("[config] failed to read config file {config_path}: {err}"))?;
    let parsed_json = crate::config_toml_codec::parse_toml_record_json(&raw)?;
    let parsed: Value = serde_json::from_str(&parsed_json)
        .map_err(|err| format!("[config] failed to decode parsed TOML JSON: {err}"))?;
    let Value::Object(_) = parsed else {
        return Err("[config] TOML codec returned non-object root for config file".to_string());
    };
    serde_json::to_string(&json!({
        "path": config_path,
        "format": "toml",
        "raw": raw,
        "parsed": parsed,
    }))
    .map_err(|err| format!("[config] failed to encode {} config decode output: {err}", kind.label()))
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
    use super::{decode_provider_config_file_json, decode_user_config_file_json};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn mk_tmp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn decode_user_config_file_reads_toml_payload() {
        let root = mk_tmp_dir("routecodex-user-config-codec");
        let config_path = root.join("config.toml");
        fs::write(
            &config_path,
            "version = \"2.0.0\"\nvirtualrouterMode = \"v2\"\n",
        )
        .unwrap();

        let output = decode_user_config_file_json(
            &json!({ "configPath": config_path.to_string_lossy() }).to_string(),
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(decoded.get("format").and_then(Value::as_str), Some("toml"));
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
    fn decode_provider_config_file_reads_toml_payload() {
        let root = mk_tmp_dir("routecodex-provider-config-codec");
        let config_path = root.join("config.v2.toml");
        fs::write(
            &config_path,
            [
                "version = \"2.0.0\"",
                "providerId = \"demo\"",
                "",
                "[provider]",
                "id = \"demo\"",
                "type = \"openai\"",
                "",
            ]
            .join("\n"),
        )
        .unwrap();

        let output = decode_provider_config_file_json(
            &json!({ "configPath": config_path.to_string_lossy() }).to_string(),
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(decoded.get("format").and_then(Value::as_str), Some("toml"));
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
    fn decode_user_config_file_rejects_json_path() {
        let root = mk_tmp_dir("routecodex-user-config-json");
        let config_path = root.join("config.json");
        fs::write(&config_path, "{\"version\":\"2.0.0\"}\n").unwrap();
        let error = decode_user_config_file_json(
            &json!({ "configPath": config_path.to_string_lossy() }).to_string(),
        )
        .unwrap_err();
        assert!(error.contains("user config JSON support removed"));
    }

    #[test]
    fn decode_provider_config_file_rejects_json_path() {
        let root = mk_tmp_dir("routecodex-provider-config-json");
        let config_path = root.join("config.v2.json");
        fs::write(&config_path, "{\"version\":\"2.0.0\"}\n").unwrap();
        let error = decode_provider_config_file_json(
            &json!({ "configPath": config_path.to_string_lossy() }).to_string(),
        )
        .unwrap_err();
        assert!(error.contains("provider config JSON support removed"));
    }

    #[test]
    fn decode_user_config_text_reads_toml_payload() {
        let output = super::decode_user_config_text_json(
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
}
