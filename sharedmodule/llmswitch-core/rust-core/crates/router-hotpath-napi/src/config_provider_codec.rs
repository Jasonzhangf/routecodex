// feature_id: config.provider_config_codec
// feature_id: config.provider_config_coercion
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigCoerceInput {
    parsed: Value,
    #[serde(default)]
    fallback_provider_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigFilePlanInput {
    file_names: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigIdResolveInput {
    dir_id: String,
    file_name: String,
    file_path: String,
    is_base_file: bool,
    parsed: Value,
    provider: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigRootLoadInput {
    root_dir: String,
}

pub fn coerce_provider_config_v2_from_parsed_json(input_json: &str) -> Result<String, String> {
    let input: ProviderConfigCoerceInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid provider config coerce input: {err}"))?;
    let config =
        coerce_provider_config_v2_from_parsed(input.parsed, input.fallback_provider_id.as_deref());
    let output = json!({ "config": config });
    serde_json::to_string(&output)
        .map_err(|err| format!("[config] failed to encode provider config coerce output: {err}"))
}

pub fn plan_provider_config_v2_files_json(input_json: &str) -> Result<String, String> {
    let input: ProviderConfigFilePlanInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid provider config file plan input: {err}"))?;
    if let Some(file_name) = input
        .file_names
        .iter()
        .find(|file_name| is_retired_provider_config_json_file_name(file_name))
    {
        return Err(format!(
            "[config] provider config JSON support removed; delete retired file: {file_name}"
        ));
    }
    let mut files: Vec<String> = input
        .file_names
        .into_iter()
        .filter(|file_name| is_provider_config_v2_file_name(file_name))
        .collect();
    files.sort_by(|left, right| {
        if left == "config.v2.toml" {
            std::cmp::Ordering::Less
        } else if right == "config.v2.toml" {
            std::cmp::Ordering::Greater
        } else {
            left.cmp(right)
        }
    });
    let output_files: Vec<Value> = files
        .into_iter()
        .map(|file_name| {
            json!({
                "fileName": file_name,
                "isBaseFile": file_name == "config.v2.toml"
            })
        })
        .collect();
    serde_json::to_string(&json!({ "files": output_files }))
        .map_err(|err| format!("[config] failed to encode provider config file plan: {err}"))
}

pub fn resolve_provider_config_v2_identity_json(input_json: &str) -> Result<String, String> {
    let input: ProviderConfigIdResolveInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid provider config identity input: {err}"))?;
    let output = resolve_provider_config_v2_identity(input)?;
    serde_json::to_string(&output)
        .map_err(|err| format!("[config] failed to encode provider config identity output: {err}"))
}

pub fn load_provider_configs_v2_from_root_json(input_json: &str) -> Result<String, String> {
    let input: ProviderConfigRootLoadInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid provider config root load input: {err}"))?;
    let root = PathBuf::from(input.root_dir.trim());
    if root.as_os_str().is_empty() {
        return Err("[config] provider config rootDir is required".to_string());
    }
    fs::create_dir_all(&root).map_err(|err| {
        format!(
            "[config] failed to create provider root {}: {err}",
            root.display()
        )
    })?;

    let mut dirs = read_provider_dirs(&root)?;
    dirs.sort_by(|left, right| left.id.cmp(&right.id));

    let mut configs: BTreeMap<String, Value> = BTreeMap::new();
    for dir in dirs {
        let files = read_provider_config_files(&dir)?;
        for file in files {
            let raw = fs::read_to_string(&file.path).map_err(|err| {
                format!(
                    "[config] failed to read provider config {}: {err}",
                    file.path.display()
                )
            })?;
            let parsed_raw = crate::config_toml_codec::parse_toml_record_json(&raw)?;
            let parsed: Value = serde_json::from_str(&parsed_raw).map_err(|err| {
                format!(
                    "[config] failed to decode provider TOML JSON {}: {err}",
                    file.path.display()
                )
            })?;
            let coerced = coerce_provider_config_v2_from_parsed(parsed.clone(), Some(&dir.id));
            if coerced.is_null() {
                continue;
            }
            let provider = coerced.get("provider").cloned().ok_or_else(|| {
                format!(
                    "[config] provider config {} returned missing provider",
                    file.path.display()
                )
            })?;
            let identity = resolve_provider_config_v2_identity(ProviderConfigIdResolveInput {
                dir_id: dir.id.clone(),
                file_name: file.file_name.clone(),
                file_path: file.path.to_string_lossy().to_string(),
                is_base_file: file.is_base_file,
                parsed,
                provider,
            })?;
            let provider_id = read_trimmed_string(identity.get("providerId")).ok_or_else(|| {
                format!(
                    "[config] provider config {} returned invalid providerId",
                    file.path.display()
                )
            })?;
            if configs.contains_key(&provider_id) {
                return Err(format!(
                    "[config] duplicate providerId \"{}\" loaded from {}. Provider ids must be globally unique.",
                    provider_id,
                    file.path.display()
                ));
            }
            let version = read_trimmed_string(coerced.get("version"))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "2.0.0".to_string());
            let identity_provider = identity.get("provider").cloned().ok_or_else(|| {
                format!(
                    "[config] provider config {} returned missing identity provider",
                    file.path.display()
                )
            })?;
            configs.insert(
                provider_id.clone(),
                json!({
                    "version": version,
                    "providerId": provider_id,
                    "provider": identity_provider,
                }),
            );
        }
    }
    serde_json::to_string(&json!({ "configs": configs }))
        .map_err(|err| format!("[config] failed to encode provider configs: {err}"))
}

struct ProviderDirEntry {
    id: String,
    path: PathBuf,
}

struct ProviderConfigFileEntry {
    file_name: String,
    path: PathBuf,
    is_base_file: bool,
}

fn read_provider_dirs(root: &Path) -> Result<Vec<ProviderDirEntry>, String> {
    let entries = fs::read_dir(root)
        .map_err(|err| format!("[config] failed to read provider root {}: {err}", root.display()))?;
    let mut dirs = Vec::new();
    for entry_result in entries {
        let entry = entry_result.map_err(|err| {
            format!(
                "[config] failed to read provider root entry {}: {err}",
                root.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|err| {
            format!(
                "[config] failed to inspect provider root entry {}: {err}",
                entry.path().display()
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id == ".DS_Store" {
            continue;
        }
        dirs.push(ProviderDirEntry {
            id,
            path: entry.path(),
        });
    }
    Ok(dirs)
}

fn read_provider_config_files(
    dir: &ProviderDirEntry,
) -> Result<Vec<ProviderConfigFileEntry>, String> {
    let entries = fs::read_dir(&dir.path).map_err(|err| {
        format!(
            "[config] failed to read provider dir {}: {err}",
            dir.path.display()
        )
    })?;
    let mut file_names = Vec::new();
    for entry_result in entries {
        let entry = entry_result.map_err(|err| {
            format!(
                "[config] failed to read provider dir entry {}: {err}",
                dir.path.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|err| {
            format!(
                "[config] failed to inspect provider dir entry {}: {err}",
                entry.path().display()
            )
        })?;
        if file_type.is_file() {
            file_names.push(entry.file_name().to_string_lossy().to_string());
        }
    }
    let planned_raw =
        plan_provider_config_v2_files_json(&json!({ "fileNames": file_names }).to_string())?;
    let planned: Value = serde_json::from_str(&planned_raw)
        .map_err(|err| format!("[config] failed to decode provider config file plan: {err}"))?;
    let files = planned
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "[config] provider config file planner returned invalid files".to_string())?;
    files
        .iter()
        .map(|file| {
            let file_name = read_trimmed_string(file.get("fileName")).ok_or_else(|| {
                "[config] provider config file planner returned invalid fileName".to_string()
            })?;
            let is_base_file = file.get("isBaseFile").and_then(Value::as_bool).ok_or_else(|| {
                "[config] provider config file planner returned invalid isBaseFile".to_string()
            })?;
            Ok(ProviderConfigFileEntry {
                path: dir.path.join(&file_name),
                file_name,
                is_base_file,
            })
        })
        .collect()
}

fn coerce_provider_config_v2_from_parsed(
    parsed: Value,
    fallback_provider_id: Option<&str>,
) -> Value {
    let Value::Object(parsed_map) = parsed else {
        return Value::Null;
    };
    let Some(Value::Object(provider_map)) = parsed_map.get("provider") else {
        return Value::Null;
    };
    let mut provider = provider_map.clone();
    let provider_id_raw = read_trimmed_string(parsed_map.get("providerId"));
    let provider_node_id = read_trimmed_string(provider.get("id"));
    let fallback_id = fallback_provider_id.unwrap_or("").trim().to_string();
    let provider_id = provider_id_raw
        .or(provider_node_id.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_id);
    if provider_id.is_empty() {
        return Value::Null;
    }
    if provider_node_id.as_deref().unwrap_or("").is_empty() {
        provider.insert("id".to_string(), Value::String(provider_id.clone()));
    }
    let version = read_trimmed_string(parsed_map.get("version"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "2.0.0".to_string());
    json!({
        "version": version,
        "providerId": provider_id,
        "provider": Value::Object(provider),
    })
}

fn is_provider_config_v2_file_name(file_name: &str) -> bool {
    let normalized = file_name.trim().to_lowercase();
    if !normalized.ends_with(".toml") {
        return false;
    }
    if !normalized.starts_with("config.v2") {
        return false;
    }
    if normalized.contains(".bak.") {
        return false;
    }
    normalized == "config.v2.toml" || is_suffixed_provider_config_v2_toml(&normalized)
}

fn is_retired_provider_config_json_file_name(file_name: &str) -> bool {
    let normalized = file_name.trim().to_lowercase();
    normalized == "config.v1.json" || normalized == "config.v2.json"
}

fn is_suffixed_provider_config_v2_toml(normalized: &str) -> bool {
    normalized.starts_with("config.v2.")
        && normalized.ends_with(".toml")
        && normalized.len() > "config.v2..toml".len()
}

fn resolve_provider_config_v2_identity(
    input: ProviderConfigIdResolveInput,
) -> Result<Value, String> {
    let provider_id_raw = read_trimmed_string(input.parsed.get("providerId")).unwrap_or_default();
    let Value::Object(mut provider) = input.provider else {
        return Err(format!(
            "[config] provider payload for {} must be an object",
            input.file_path
        ));
    };
    let provider_node_id = read_trimmed_string(provider.get("id")).unwrap_or_default();

    if input.is_base_file {
        let provider_id = input.dir_id.trim().to_string();
        if provider_id.is_empty() {
            return Err(format!(
                "[config] invalid provider directory name for {}",
                input.file_path
            ));
        }
        if !provider_id_raw.is_empty() && provider_id_raw != provider_id {
            return Err(format!(
                "[config] providerId mismatch: dir=\"{}\" file=\"{}\". Use the directory name as the single source of truth for {}.",
                provider_id, provider_id_raw, input.file_name
            ));
        }
        if !provider_node_id.is_empty() && provider_node_id != provider_id {
            return Err(format!(
                "[config] provider.id mismatch: dir=\"{}\" provider.id=\"{}\". Use the directory name as the single source of truth for {}.",
                provider_id, provider_node_id, input.file_name
            ));
        }
        if provider_node_id.is_empty() {
            provider.insert("id".to_string(), Value::String(provider_id.clone()));
        }
        return Ok(json!({
            "providerId": provider_id,
            "provider": Value::Object(provider),
        }));
    }

    let explicit_provider_id = if !provider_id_raw.is_empty() {
        provider_id_raw.clone()
    } else {
        provider_node_id.clone()
    };
    if explicit_provider_id.is_empty() {
        return Err(format!(
            "[config] {} must declare providerId or provider.id because suffixed config files are standalone providers.",
            input.file_path
        ));
    }
    if !provider_id_raw.is_empty()
        && !provider_node_id.is_empty()
        && provider_id_raw != provider_node_id
    {
        return Err(format!(
            "[config] providerId/provider.id mismatch in {}: providerId=\"{}\" provider.id=\"{}\".",
            input.file_path, provider_id_raw, provider_node_id
        ));
    }
    if provider_node_id.is_empty() {
        provider.insert(
            "id".to_string(),
            Value::String(explicit_provider_id.clone()),
        );
    }
    Ok(json!({
        "providerId": explicit_provider_id,
        "provider": Value::Object(provider),
    }))
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        coerce_provider_config_v2_from_parsed_json, load_provider_configs_v2_from_root_json,
        plan_provider_config_v2_files_json,
        resolve_provider_config_v2_identity_json,
    };
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("routecodex-{label}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn coerces_provider_config_with_root_provider_id() {
        let input = serde_json::json!({
            "parsed": {
                "version": "2.1.0",
                "providerId": "demo",
                "provider": {
                    "type": "openai",
                    "baseURL": "https://example.test"
                }
            }
        });
        let output = coerce_provider_config_v2_from_parsed_json(&input.to_string()).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["config"]["version"], "2.1.0");
        assert_eq!(value["config"]["providerId"], "demo");
        assert_eq!(value["config"]["provider"]["id"], "demo");
    }

    #[test]
    fn coerces_provider_config_with_fallback_id_and_default_version() {
        let input = serde_json::json!({
            "parsed": {
                "provider": {
                    "type": "anthropic"
                }
            },
            "fallbackProviderId": "fallback-demo"
        });
        let output = coerce_provider_config_v2_from_parsed_json(&input.to_string()).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["config"]["version"], "2.0.0");
        assert_eq!(value["config"]["providerId"], "fallback-demo");
        assert_eq!(value["config"]["provider"]["id"], "fallback-demo");
    }

    #[test]
    fn returns_null_without_provider_object_or_id() {
        let no_provider = serde_json::json!({ "parsed": { "providerId": "demo" } });
        let no_provider_output =
            coerce_provider_config_v2_from_parsed_json(&no_provider.to_string()).unwrap();
        let no_provider_value: Value = serde_json::from_str(&no_provider_output).unwrap();
        assert_eq!(no_provider_value["config"], Value::Null);

        let no_id = serde_json::json!({ "parsed": { "provider": { "type": "openai" } } });
        let no_id_output = coerce_provider_config_v2_from_parsed_json(&no_id.to_string()).unwrap();
        let no_id_value: Value = serde_json::from_str(&no_id_output).unwrap();
        assert_eq!(no_id_value["config"], Value::Null);
    }

    #[test]
    fn plans_provider_config_v2_files() {
        let input = serde_json::json!({
            "fileNames": [
                "config.v1.toml",
                "config.v2.bak.toml",
                "config.v2.toml",
                "config.v2.zed.toml",
                "config.v2.alpha.toml"
            ]
        });
        let output = plan_provider_config_v2_files_json(&input.to_string()).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        let files = value["files"].as_array().unwrap();
        assert_eq!(files[0]["fileName"], "config.v2.toml");
        assert_eq!(files[1]["fileName"], "config.v2.alpha.toml");
        assert_eq!(files[2]["fileName"], "config.v2.zed.toml");
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn rejects_retired_provider_config_json_files() {
        let input = serde_json::json!({
            "fileNames": [
                "config.v2.toml",
                "config.v2.json"
            ]
        });
        let error = plan_provider_config_v2_files_json(&input.to_string()).unwrap_err();
        assert!(error.contains("provider config JSON support removed"));
        assert!(error.contains("config.v2.json"));
    }

    #[test]
    fn resolves_base_provider_identity_from_directory() {
        let input = serde_json::json!({
            "dirId": "demo",
            "fileName": "config.v2.toml",
            "filePath": "/tmp/demo/config.v2.toml",
            "isBaseFile": true,
            "parsed": { "provider": { "type": "openai" } },
            "provider": { "type": "openai" }
        });
        let output = resolve_provider_config_v2_identity_json(&input.to_string()).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["providerId"], "demo");
        assert_eq!(value["provider"]["id"], "demo");
    }

    #[test]
    fn rejects_suffixed_provider_without_explicit_id() {
        let input = serde_json::json!({
            "dirId": "demo",
            "fileName": "config.v2.extra.toml",
            "filePath": "/tmp/demo/config.v2.extra.toml",
            "isBaseFile": false,
            "parsed": { "provider": { "type": "openai" } },
            "provider": { "type": "openai" }
        });
        let error = resolve_provider_config_v2_identity_json(&input.to_string()).unwrap_err();
        assert!(error.contains("must declare providerId or provider.id"));
    }

    #[test]
    fn loads_provider_configs_from_root() {
        let root = temp_root("provider-root");
        let provider_dir = root.join("demo");
        fs::create_dir_all(&provider_dir).unwrap();
        fs::write(
            provider_dir.join("config.v2.toml"),
            r#"
version = "2.0.0"

[provider]
type = "openai"
baseURL = "https://demo.example.test"
"#,
        )
        .unwrap();

        let input = serde_json::json!({ "rootDir": root.to_string_lossy() });
        let output = load_provider_configs_v2_from_root_json(&input.to_string()).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["configs"]["demo"]["providerId"], "demo");
        assert_eq!(value["configs"]["demo"]["provider"]["id"], "demo");
        assert_eq!(
            value["configs"]["demo"]["provider"]["baseURL"],
            "https://demo.example.test"
        );
    }

    #[test]
    fn root_loader_rejects_duplicate_provider_ids() {
        let root = temp_root("provider-duplicate");
        let provider_dir = root.join("demo");
        fs::create_dir_all(&provider_dir).unwrap();
        fs::write(
            provider_dir.join("config.v2.alpha.toml"),
            r#"
version = "2.0.0"
providerId = "shared"

[provider]
type = "openai"
"#,
        )
        .unwrap();
        fs::write(
            provider_dir.join("config.v2.beta.toml"),
            r#"
version = "2.0.0"
providerId = "shared"

[provider]
type = "openai"
"#,
        )
        .unwrap();

        let input = serde_json::json!({ "rootDir": root.to_string_lossy() });
        let error = load_provider_configs_v2_from_root_json(&input.to_string()).unwrap_err();
        assert!(error.contains("duplicate providerId \"shared\""));
    }
}
