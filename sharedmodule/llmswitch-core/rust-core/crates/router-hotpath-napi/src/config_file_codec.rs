// feature_id: config.user_config_codec
// feature_id: config.provider_config_codec
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigTextDecodeInput {
    raw: String,
    #[serde(default)]
    config_path: Option<String>,
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
    use super::{decode_provider_config_text_json, decode_user_config_text_json};
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
}
