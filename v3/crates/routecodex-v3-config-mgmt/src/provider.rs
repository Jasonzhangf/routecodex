// feature_id: v3.config_mgmt_provider_files
// Provider 文件管理：<config_dir>/provider/<id>/config.v2.toml 的扫描、
// 解析与原子写入。解析/序列化复用 routecodex-v3-config 的 v2 compat 模型，
// 禁止本模块重复实现 provider 语义。
use routecodex_v3_config::{
    generate_v2_provider_config_file, parse_v2_provider_config_file, V2ProviderConfigFile,
    V3ConfigStore,
};
use std::path::{Path, PathBuf};

pub const V2_PROVIDER_CONFIG_FILE_NAME: &str = "config.v2.toml";

#[derive(Debug, Clone)]
pub struct ProviderFileEntry {
    pub provider_id: String,
    pub directory: PathBuf,
    pub config: V2ProviderConfigFile,
}

pub fn provider_directory(config_dir: &Path) -> PathBuf {
    config_dir.join("provider")
}

pub fn provider_config_file_path(config_dir: &Path, provider_id: &str) -> PathBuf {
    provider_directory(config_dir)
        .join(provider_id)
        .join(V2_PROVIDER_CONFIG_FILE_NAME)
}

/// 扫描 provider 目录下全部已存在配置文件的 provider id（字典序）。
pub fn list_provider_ids(config_dir: &Path) -> Result<Vec<String>, String> {
    let root = provider_directory(config_dir);
    let mut ids = Vec::new();
    match std::fs::read_dir(&root) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let candidate = entry.path().join(V2_PROVIDER_CONFIG_FILE_NAME);
                if candidate.is_file() {
                    ids.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "scan provider directory {} failed: {error}",
                root.display()
            ))
        }
    }
    ids.sort();
    Ok(ids)
}

pub fn read_provider_file(
    config_dir: &Path,
    provider_id: &str,
) -> Result<ProviderFileEntry, String> {
    let path = provider_config_file_path(config_dir, provider_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("provider config {} read failed: {error}", path.display()))?;
    let config = parse_v2_provider_config_file(&raw)
        .map_err(|error| format!("provider config {} parse failed: {error}", path.display()))?;
    Ok(ProviderFileEntry {
        provider_id: provider_id.to_string(),
        directory: path.parent().unwrap_or(&path).to_path_buf(),
        config,
    })
}

/// 原子写入 provider 文件（tmp + rename），文件已存在时先备份。
pub fn write_provider_file(
    config_dir: &Path,
    provider_id: &str,
    config: &V2ProviderConfigFile,
) -> Result<PathBuf, String> {
    write_provider_file_with_backup(config_dir, provider_id, config).map(|(path, _)| path)
}

/// 同 `write_provider_file`，但把替换前生成的备份路径一并返回，供 revision 审计记录。
/// 新建（目标文件不存在）时备份为 `None`。
pub fn write_provider_file_with_backup(
    config_dir: &Path,
    provider_id: &str,
    config: &V2ProviderConfigFile,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let path = provider_config_file_path(config_dir, provider_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create provider dir {} failed: {error}", parent.display()))?;
    }
    let backup = if path.exists() {
        Some(backup_file(&path, "provider-update")?)
    } else {
        None
    };
    let raw = generate_v2_provider_config_file(config)
        .map_err(|error| format!("generate provider config failed: {error}"))?;
    let temp_path = path.with_extension(format!("toml.tmp-{}", std::process::id()));
    std::fs::write(&temp_path, raw).map_err(|error| {
        format!(
            "write provider temp {} failed: {error}",
            temp_path.display()
        )
    })?;
    std::fs::rename(&temp_path, &path)
        .map_err(|error| format!("atomic replace provider {} failed: {error}", path.display()))?;
    Ok((path, backup))
}

/// 删除 provider 目录：先把 config.v2.toml 备份到 provider 目录之外，再整目录移除。
/// 返回 `(被删除的目录, 备份文件)`；provider 不存在时返回 `Ok(None)`（不报错、不创建）。
pub fn delete_provider_directory(
    config_dir: &Path,
    provider_id: &str,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let directory = provider_directory(config_dir).join(provider_id);
    let path = provider_config_file_path(config_dir, provider_id);
    if !path.is_file() {
        return Ok(None);
    }
    // 备份必须落在被删除的目录之外，否则 remove_dir_all 会把备份一起删掉。
    let backup = backup_provider_file_for_delete(config_dir, provider_id)?;
    std::fs::remove_dir_all(&directory).map_err(|error| {
        format!(
            "remove provider directory {} failed: {error}",
            directory.display()
        )
    })?;
    Ok(Some((directory, backup)))
}

/// 删除前的 provider 配置备份：写入 `<config_dir>/state/provider-backups/`，
/// 与 `backup_file`（原地备份，用于覆盖写入）区分，保证删除后备份仍可恢复。
pub fn backup_provider_file_for_delete(
    config_dir: &Path,
    provider_id: &str,
) -> Result<PathBuf, String> {
    let path = provider_config_file_path(config_dir, provider_id);
    let raw = std::fs::read(&path)
        .map_err(|error| format!("read for backup {} failed: {error}", path.display()))?;
    let directory = config_dir.join("state").join("provider-backups");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create {} failed: {error}", directory.display()))?;
    let backup = directory.join(format!(
        "{provider_id}-{V2_PROVIDER_CONFIG_FILE_NAME}.bak-{}-provider-delete",
        timestamp_compact()
    ));
    std::fs::write(&backup, raw)
        .map_err(|error| format!("write backup {} failed: {error}", backup.display()))?;
    Ok(backup)
}

/// provider 文件内容的 sha256（十六进制）；文件不存在时返回 `"absent"`，
/// 与 `RevisionStore` 既有 `source_sha256` 语义一致（记录被替换前的真实内容）。
pub fn provider_file_source_sha256(config_dir: &Path, provider_id: &str) -> String {
    let path = provider_config_file_path(config_dir, provider_id);
    match std::fs::read(&path) {
        Ok(raw) => {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(&raw))
        }
        Err(_) => "absent".to_string(),
    }
}

/// 候选 provider 的字段级错误。`field` 是 authoring 字段名，`source` 标明该错误
/// 由候选契约检查（`contract`）还是真实编译链（`compile`）产生。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProviderFieldError {
    pub field: String,
    pub message: String,
    pub source: String,
}

/// 候选 provider 校验结果。`ok` 为真当且仅当候选契约检查与真实编译链都通过。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProviderCandidateValidation {
    pub ok: bool,
    pub provider_id: String,
    /// 候选文件里声明的原始 type 文本。
    pub provider_type: String,
    /// 真实编译链归一后的协议名（`responses|anthropic|gemini|openai_chat`）；
    /// 编译未通过时为 None，不做本地猜测。
    pub normalized_type: Option<String>,
    pub base_url: String,
    pub default_model: String,
    pub models: Vec<String>,
    pub errors: Vec<ProviderFieldError>,
    /// 真实编译链返回的原始错误文本（含语义错误细节），未通过时为 Some。
    pub compile_error: Option<String>,
}

/// 候选 provider 校验（不落盘到 config_dir，不修改任何既有配置）。
///
/// 未引用的 provider 不会被 `provider_directory` 编译，因此这里把候选文件放进
/// 一个系统临时目录，用一条只引用该候选（每个声明 model 一个 target）的最小 v3
/// authoring 驱动 **同一条真实编译链**（`V3ConfigStore::load_snapshot` →
/// provider directory → auth/model/schema 校验）。本模块不复制任何 provider
/// 语义：协议归一、auth handle、模型表全部来自编译结果。临时目录在返回前无条件删除。
pub fn validate_provider_candidate(
    provider_id: &str,
    config: &V2ProviderConfigFile,
) -> ProviderCandidateValidation {
    let mut errors = Vec::new();
    let id = provider_id.trim();
    if id.is_empty() {
        push_contract_error(&mut errors, "id", "provider id is required");
    } else if !is_path_safe_provider_id(id) {
        push_contract_error(
            &mut errors,
            "id",
            "provider id must be a single path segment (letters, digits, '.', '-', '_')",
        );
    }
    if config.provider.id.trim() != id {
        push_contract_error(
            &mut errors,
            "id",
            &format!(
                "provider.id {:?} does not match the target provider id {id:?}",
                config.provider.id
            ),
        );
    }
    if let Some(declared) = config.provider_id.as_deref() {
        if declared.trim() != id {
            push_contract_error(
                &mut errors,
                "providerId",
                &format!("providerId {declared:?} does not match the target provider id {id:?}"),
            );
        }
    }
    let base_url = config.provider.base_url.trim().to_string();
    if base_url.is_empty() {
        push_contract_error(&mut errors, "base_url", "baseURL is required");
    } else if !is_http_url(&base_url) {
        push_contract_error(
            &mut errors,
            "base_url",
            "baseURL must be an absolute http(s) URL",
        );
    }
    let declared_models = config.provider.models.keys().cloned().collect::<Vec<_>>();
    let default_model = config.provider.default_model.trim().to_string();
    if declared_models.is_empty() {
        push_contract_error(
            &mut errors,
            "models",
            "at least one [provider.models.<id>] entry is required",
        );
    }
    if default_model.is_empty() {
        push_contract_error(&mut errors, "default_model", "defaultModel is required");
    } else if !declared_models.iter().any(|model| model == &default_model) {
        // 运行时在 route 使用 provider 默认模型时要求 default_model 是 canonical
        // models key（config 编译链同样拒绝），候选契约在此提前给出字段级定位。
        push_contract_error(
            &mut errors,
            "default_model",
            &format!("defaultModel {default_model:?} is not a [provider.models.*] key"),
        );
    }

    let mut validation = ProviderCandidateValidation {
        ok: false,
        provider_id: id.to_string(),
        provider_type: config.provider.provider_type.trim().to_string(),
        normalized_type: None,
        base_url,
        default_model,
        models: declared_models,
        errors,
        compile_error: None,
    };
    if !validation.errors.is_empty() {
        return validation;
    }

    match compile_provider_candidate_manifest(id, config) {
        Ok(manifest) => {
            if let Some(provider) = manifest.providers.get(id) {
                validation.normalized_type = Some(provider.provider_type.clone());
                validation.models = provider.models.keys().cloned().collect();
                validation.default_model = provider.default_model.clone();
            }
            validation.ok = true;
        }
        Err(error) => {
            let field = classify_provider_compile_error(&error);
            validation.errors.push(ProviderFieldError {
                field: field.to_string(),
                message: error.clone(),
                source: "compile".to_string(),
            });
            validation.compile_error = Some(error);
        }
    }
    validation
}

/// 批量导入的单个文档：保留原文以便失败项可重试，解析结果复用
/// `parse_v2_provider_config_file`（不在本模块重新实现 provider 文件语义）。
#[derive(Debug, Clone)]
pub struct ProviderConfigDocument {
    pub text: String,
    pub parsed: Result<V2ProviderConfigFile, String>,
}

/// 批量导入用的多文档切分：TOML 没有多文档标准，这里用独占一行的 `---` 作为
/// 文档分隔符（与 UI 粘贴面一致）。空文档被跳过，解析失败按文档返回显式错误。
pub fn parse_provider_config_documents(text: &str) -> Vec<ProviderConfigDocument> {
    let mut documents: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if line.trim() == "---" {
            documents.push(std::mem::take(&mut current));
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    documents.push(current);
    documents
        .into_iter()
        .filter(|document| !document.trim().is_empty())
        .map(|document| ProviderConfigDocument {
            parsed: parse_v2_provider_config_file(&document).map_err(|error| error.to_string()),
            text: document,
        })
        .collect()
}

/// 用真实编译链编译单个候选 provider，返回含该 provider 的完整 manifest。
///
/// 调用方（WebUI probe/discover）因此可以复用 runtime 的
/// `build_v3_provider_global_probe_target` 等公开入口，而不必在 admin 层
/// 重新实现 auth handle 或模型绑定。临时目录位于系统 temp，绝不写 config_dir。
pub fn compile_provider_candidate_manifest(
    provider_id: &str,
    config: &V2ProviderConfigFile,
) -> Result<routecodex_v3_config::V3Config05ManifestPublished, String> {
    let root = std::env::temp_dir().join(format!(
        "rccv3-provider-candidate-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0),
        CANDIDATE_VALIDATION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    let result = (|| -> Result<routecodex_v3_config::V3Config05ManifestPublished, String> {
        let provider_dir = root.join("provider").join(provider_id);
        std::fs::create_dir_all(&provider_dir)
            .map_err(|error| format!("create candidate scratch dir failed: {error}"))?;
        let raw = generate_v2_provider_config_file(config)
            .map_err(|error| format!("generate candidate provider config failed: {error}"))?;
        std::fs::write(provider_dir.join(V2_PROVIDER_CONFIG_FILE_NAME), raw)
            .map_err(|error| format!("write candidate provider config failed: {error}"))?;
        let root_config = root.join("config.v3.toml");
        std::fs::write(
            &root_config,
            synthetic_candidate_authoring(provider_id, config.provider.models.keys()),
        )
        .map_err(|error| format!("write candidate authoring failed: {error}"))?;
        V3ConfigStore::new(&root_config)
            .load_snapshot()
            .map_err(|error| error.to_string())
    })();
    let _ = std::fs::remove_dir_all(&root);
    result
}

static CANDIDATE_VALIDATION_SEQ: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// 只引用候选 provider 的最小 v3 authoring。pool target 必须显式声明 model，
/// 因此每个声明的 model key 各生成一个 target：provider 目录编译、auth handle
/// 校验、模型表编译与 target 绑定全部走真实编译链。
fn synthetic_candidate_authoring<'a>(
    provider_id: &str,
    models: impl Iterator<Item = &'a String>,
) -> String {
    let targets = models
        .map(|model| {
            format!(
                "{{ kind = \"provider_model\", provider = {}, model = {}, priority = 1 }}",
                toml_basic_string(provider_id),
                toml_basic_string(model)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"version = 3

[servers.provider_candidate_validation]
bind = "127.0.0.1"
port = 45991
routing_group = "provider_candidate_validation"
endpoints = ["responses"]

[route_groups.provider_candidate_validation.pools.default]
targets = [{targets}]
"#
    )
}

/// TOML basic string 转义：候选 model key 直接进入合成 authoring，必须无损转义。
fn toml_basic_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn push_contract_error(errors: &mut Vec<ProviderFieldError>, field: &str, message: &str) {
    errors.push(ProviderFieldError {
        field: field.to_string(),
        message: message.to_string(),
        source: "contract".to_string(),
    });
}

/// provider id 直接作为目录名：只允许单个安全路径段。
fn is_path_safe_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn is_http_url(value: &str) -> bool {
    matches!(url_scheme(value).as_deref(), Some("http") | Some("https"))
        && value.len() > "https://".len()
}

/// 极简 scheme 提取：避免为一个校验引入 URL 解析依赖。
fn url_scheme(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once("://")?;
    if scheme.is_empty()
        || rest.is_empty()
        || !scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
    {
        return None;
    }
    Some(scheme.to_ascii_lowercase())
}

/// 把真实编译错误归到一个 authoring 字段上，供 UI 定位；不改变错误文本本身。
fn classify_provider_compile_error(message: &str) -> &'static str {
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("auth") {
        "auth"
    } else if lowered.contains("default_model") {
        "default_model"
    } else if lowered.contains("base_url") {
        "base_url"
    } else if lowered.contains("models") || lowered.contains("model ") {
        "models"
    } else if lowered.contains("unknown type") || lowered.contains("protocol") {
        "provider_type"
    } else if lowered.contains("identity mismatch") || lowered.contains("id ") {
        "id"
    } else {
        "provider"
    }
}

/// 生成与现有手工备份一致风格的备份文件：<path>.bak-<ts>-<reason>。
pub fn backup_file(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let raw = std::fs::read(path)
        .map_err(|error| format!("read for backup {} failed: {error}", path.display()))?;
    let ts = timestamp_compact();
    let backup = PathBuf::from(format!("{}.bak-{}-{}", path.display(), ts, reason));
    std::fs::write(&backup, raw)
        .map_err(|error| format!("write backup {} failed: {error}", backup.display()))?;
    Ok(backup)
}

/// UTC 时间戳（紧凑格式 YYYYMMDDTHHMMSS），与手工备份命名习惯一致。
pub fn timestamp_compact() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = now.div_euclid(86_400);
    let seconds_of_day = now.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}")
}

/// days since 1970-01-01 -> (year, month, day)；Howard Hinnant civil 算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod candidate_validation_tests {
    use super::*;

    fn candidate(provider_id: &str, provider_type: &str) -> V2ProviderConfigFile {
        parse_v2_provider_config_file(&format!(
            r#"version = "2.0.0"
providerId = "{provider_id}"

[provider]
id = "{provider_id}"
enabled = true
type = "{provider_type}"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "m1"

[provider.auth]
apiKey = "sk-candidate-test"

[provider.models."m1"]
supportsStreaming = true
"#
        ))
        .expect("candidate parses")
    }

    #[test]
    fn candidate_validation_accepts_unreferenced_provider() {
        let result = validate_provider_candidate("fresh", &candidate("fresh", "openai_chat"));
        assert!(result.ok, "errors: {:?}", result.errors);
        assert_eq!(result.normalized_type.as_deref(), Some("openai_chat"));
        assert_eq!(result.models, vec!["m1".to_string()]);
        assert_eq!(result.default_model, "m1");
        assert!(result.compile_error.is_none());
    }

    #[test]
    fn candidate_validation_rejects_unknown_type_and_bad_url() {
        let result = validate_provider_candidate("fresh", &candidate("fresh", "carrier-pigeon"));
        assert!(!result.ok);
        let compile = result.compile_error.clone().unwrap_or_default();
        assert!(
            compile.contains("unknown type") || compile.contains("unknown protocol"),
            "unexpected compile error: {compile}"
        );
        assert_eq!(result.errors[0].field, "provider_type");

        let mut bad_url = candidate("fresh", "openai_chat");
        bad_url.provider.base_url = "not-a-url".to_string();
        let result = validate_provider_candidate("fresh", &bad_url);
        assert!(!result.ok);
        assert_eq!(result.errors[0].field, "base_url");
        assert!(result.compile_error.is_none());
    }

    #[test]
    fn candidate_validation_rejects_ambiguous_auth() {
        let mut ambiguous = candidate("fresh", "openai_chat");
        ambiguous.provider.auth.api_key = Some("sk-a".to_string());
        ambiguous.provider.auth.env = Some("SOME_ENV".to_string());
        let result = validate_provider_candidate("fresh", &ambiguous);
        assert!(!result.ok);
        assert!(result.compile_error.is_some());
        assert_eq!(result.errors[0].field, "auth");
    }

    #[test]
    fn candidate_validation_rejects_id_mismatch_and_path_escape() {
        let result = validate_provider_candidate("other", &candidate("fresh", "openai_chat"));
        assert!(!result.ok);
        assert_eq!(result.errors[0].field, "id");
        let result =
            validate_provider_candidate("../escape", &candidate("../escape", "openai_chat"));
        assert!(!result.ok);
        assert_eq!(result.errors[0].field, "id");
    }

    #[test]
    fn candidate_validation_requires_default_model_key() {
        let mut mismatch = candidate("fresh", "openai_chat");
        mismatch.provider.default_model = "not-declared".to_string();
        let result = validate_provider_candidate("fresh", &mismatch);
        assert!(!result.ok);
        assert!(result
            .errors
            .iter()
            .any(|error| error.field == "default_model"));

        let mut empty = candidate("fresh", "openai_chat");
        empty.provider.models.clear();
        let result = validate_provider_candidate("fresh", &empty);
        assert!(!result.ok);
        assert!(result.errors.iter().any(|error| error.field == "models"));
    }
}
