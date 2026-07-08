// feature_id: config.user_config_codec
// feature_id: config.provider_config_codec
// feature_id: config.user_config_materialization
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::virtual_router_engine::instructions::{
    plan_routecodex_config_loader_paths_for_host, resolve_rcc_path_for_host_with_env,
    resolve_routecodex_config_path_for_host, RouteCodexConfigLoaderPathPlanInput,
    RouteCodexConfigPathResolveInput,
};
use crate::virtual_router_engine::runtime_config_materialization::{
    build_routecodex_provider_profiles_json, compile_routecodex_runtime_manifest_json,
    extract_routecodex_materialized_provider_configs_json,
    materialize_routecodex_user_config_from_manifest_json,
    normalize_routecodex_v2_runtime_source_json,
    resolve_primary_routecodex_routing_policy_group_json,
};

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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteCodexConfigLoadInput {
    #[serde(default)]
    explicit_path: Option<String>,
    #[serde(default)]
    routecodex_provider_dir: Option<String>,
    #[serde(default)]
    rcc_provider_dir: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    exec_path: Option<String>,
    #[serde(default)]
    routecodex_config_path: Option<String>,
    #[serde(default)]
    routecodex_config: Option<String>,
    #[serde(default)]
    rcc_home: Option<String>,
    #[serde(default)]
    routecodex_user_dir: Option<String>,
    #[serde(default)]
    routecodex_home: Option<String>,
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

pub fn load_routecodex_config_json(input_json: &str) -> Result<String, String> {
    let input: RouteCodexConfigLoadInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid routecodex config load input: {err}"))?;
    let path_plan =
        plan_routecodex_config_loader_paths_for_host(RouteCodexConfigLoaderPathPlanInput {
            explicit_path: input.explicit_path.as_deref(),
            routecodex_provider_dir: input.routecodex_provider_dir.as_deref(),
            rcc_provider_dir: input.rcc_provider_dir.as_deref(),
        });
    let config_path = match path_plan.explicit_path.as_deref() {
        Some(path) => Path::new(path).to_path_buf(),
        None => resolve_routecodex_config_path_for_host(RouteCodexConfigPathResolveInput {
            preferred_path: None,
            config_name: None,
            allow_directory_scan: true,
            base_dir: None,
            cwd: input.cwd.as_deref(),
            home_dir: input.home_dir.as_deref(),
            exec_path: input.exec_path.as_deref(),
            routecodex_config_path: input.routecodex_config_path.as_deref(),
            routecodex_config: input.routecodex_config.as_deref(),
            rcc_home: input.rcc_home.as_deref(),
            routecodex_user_dir: input.routecodex_user_dir.as_deref(),
            routecodex_home: input.routecodex_home.as_deref(),
        })?,
    };
    let config_path_text = config_path.to_string_lossy().to_string();
    let raw = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read config file {}: {err}",
            config_path.display()
        )
    })?;
    let decoded_json = decode_config_text_json(
        &json!({
            "configPath": config_path_text,
            "raw": raw,
        })
        .to_string(),
        ConfigFileKind::User,
    )?;
    let decoded: Value = serde_json::from_str(&decoded_json)
        .map_err(|err| format!("[config] failed to decode user config load output: {err}"))?;
    let parsed = decoded.get("parsed").cloned().ok_or_else(|| {
        "[config] routecodex config load output missing parsed user config".to_string()
    })?;
    let normalized = extract_user_config_object(
        &normalize_routecodex_v2_runtime_source_json(json!({ "userConfig": parsed }).to_string())
            .map_err(|err| err.to_string())?,
    )?;
    let errors = collect_source_errors(&normalized)?;
    if !errors.is_empty() {
        let mut message = "[config] v2 config must use single-source layout:".to_string();
        for error in errors {
            message.push_str("\n- ");
            message.push_str(&error);
        }
        return Err(message);
    }
    let provider_configs = match extract_provider_configs(&normalized)? {
        Some(configs) => configs,
        None => load_provider_configs_for_loader(&input, path_plan.provider_root_dir.as_deref())?,
    };
    let routing_policy_group = resolve_primary_routecodex_routing_policy_group_json(
        json!({ "userConfig": normalized }).to_string(),
    )
    .map_err(|err| err.to_string())?;
    let routing_policy_group_value: Value = serde_json::from_str(&routing_policy_group)
        .map_err(|err| format!("[config] failed to decode routing policy group: {err}"))?;
    let mut options = serde_json::Map::new();
    if let Some(group) = routing_policy_group_value
        .get("routingPolicyGroup")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        options.insert(
            "routingPolicyGroup".to_string(),
            Value::String(group.to_string()),
        );
    }
    let manifest_json = compile_routecodex_runtime_manifest_json(
        json!({
            "userConfig": normalized,
            "providerConfigs": provider_configs,
            "options": Value::Object(options),
        })
        .to_string(),
    )
    .map_err(|err| err.to_string())?;
    let manifest: Value = serde_json::from_str(&manifest_json)
        .map_err(|err| format!("[config] failed to decode runtime manifest: {err}"))?;
    let materialized = extract_user_config_object(
        &materialize_routecodex_user_config_from_manifest_json(
            json!({
                "userConfig": normalized,
                "manifest": manifest,
            })
            .to_string(),
        )
        .map_err(|err| err.to_string())?,
    )?;
    let provider_profiles = extract_provider_profiles(&materialized)?;
    serde_json::to_string(&json!({
        "configPath": config_path_text,
        "userConfig": materialized,
        "providerProfiles": provider_profiles,
    }))
    .map_err(|err| format!("[config] failed to encode routecodex config load output: {err}"))
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
    let input: ConfigTextDecodeInput = serde_json::from_str(input_json).map_err(|err| {
        format!(
            "[config] invalid {} config text decode input: {err}",
            kind.label()
        )
    })?;
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
    .map_err(|err| {
        format!(
            "[config] failed to encode {} config text decode output: {err}",
            kind.label()
        )
    })
}

fn detect_config_format_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigFormatDetectInput = serde_json::from_str(input_json).map_err(|err| {
        format!(
            "[config] invalid {} config format detect input: {err}",
            kind.label()
        )
    })?;
    ensure_toml_path(input.config_path.trim(), &kind)?;
    serde_json::to_string(&json!({ "format": "toml" })).map_err(|err| {
        format!(
            "[config] failed to encode {} config format output: {err}",
            kind.label()
        )
    })
}

fn write_config_file_json(input_json: &str, kind: ConfigFileKind) -> Result<String, String> {
    let input: ConfigFileWriteInput = serde_json::from_str(input_json).map_err(|err| {
        format!(
            "[config] invalid {} config write input: {err}",
            kind.label()
        )
    })?;
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
    .map_err(|err| {
        format!(
            "[config] failed to encode {} config write output: {err}",
            kind.label()
        )
    })
}

fn write_raw_config_atomically(config_path: &str, raw: &str) -> Result<(), String> {
    let wrote_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let tmp_path = format!("{config_path}.tmp.{}.{}", process::id(), wrote_at_ms);
    fs::write(&tmp_path, raw)
        .map_err(|err| format!("Failed to write config file {tmp_path}: {err}"))?;
    fs::rename(&tmp_path, config_path)
        .map_err(|err| format!("Failed to move config file {tmp_path} to {config_path}: {err}"))
}

fn extract_user_config_object(raw_json: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(raw_json)
        .map_err(|err| format!("[config] failed to decode user config object: {err}"))?;
    let user_config = value
        .get("userConfig")
        .cloned()
        .ok_or_else(|| "[config] native loader missing userConfig".to_string())?;
    if !user_config.is_object() {
        return Err("[config] native loader returned non-object userConfig".to_string());
    }
    Ok(user_config)
}

fn collect_source_errors(user_config: &Value) -> Result<Vec<String>, String> {
    let raw = crate::virtual_router_engine::runtime_config_materialization::collect_v2_config_source_errors_json(
        json!({ "userConfig": user_config }).to_string(),
    )
    .map_err(|err| err.to_string())?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("[config] failed to decode source errors: {err}"))?;
    let errors = value
        .get("errors")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "[config] native loader source validator returned invalid errors".to_string()
        })?;
    Ok(errors
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect())
}

fn extract_provider_configs(user_config: &Value) -> Result<Option<Value>, String> {
    let raw = extract_routecodex_materialized_provider_configs_json(
        json!({ "userConfig": user_config }).to_string(),
    )
    .map_err(|err| err.to_string())?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("[config] failed to decode materialized provider configs: {err}"))?;
    match value.get("providerConfigs") {
        Some(Value::Null) | None => Ok(None),
        Some(configs) if configs.is_object() => Ok(Some(configs.clone())),
        _ => Err(
            "[config] native loader provider extractor returned invalid providerConfigs"
                .to_string(),
        ),
    }
}

fn load_provider_configs_for_loader(
    input: &RouteCodexConfigLoadInput,
    provider_root_dir: Option<&str>,
) -> Result<Value, String> {
    let root_dir = match provider_root_dir {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => resolve_rcc_path_for_host_with_env(
            input.home_dir.as_deref(),
            &["provider".to_string()],
            &[
                ("RCC_HOME", input.rcc_home.as_deref()),
                ("ROUTECODEX_USER_DIR", input.routecodex_user_dir.as_deref()),
                ("ROUTECODEX_HOME", input.routecodex_home.as_deref()),
            ],
        )?
        .to_string_lossy()
        .to_string(),
    };
    let raw = crate::config_provider_codec::load_provider_configs_v2_from_root_json(
        &json!({ "rootDir": root_dir }).to_string(),
    )?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("[config] failed to decode provider configs: {err}"))?;
    let configs = value
        .get("configs")
        .cloned()
        .ok_or_else(|| "[config] native provider root loader missing configs".to_string())?;
    if !configs.is_object() {
        return Err("[config] native provider root loader returned invalid configs".to_string());
    }
    Ok(configs)
}

fn extract_provider_profiles(user_config: &Value) -> Result<Value, String> {
    let raw =
        build_routecodex_provider_profiles_json(json!({ "userConfig": user_config }).to_string())
            .map_err(|err| err.to_string())?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("[config] failed to decode provider profiles: {err}"))?;
    let profiles = value.get("providerProfiles").cloned().ok_or_else(|| {
        "[config] native provider profile builder missing providerProfiles".to_string()
    })?;
    if !profiles.is_object() {
        return Err(
            "[config] native provider profile builder returned invalid providerProfiles"
                .to_string(),
        );
    }
    Ok(profiles)
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
            &json!({ "configPath": "config.v2.json", "raw": "{\"version\":\"2.0.0\"}\n" })
                .to_string(),
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
