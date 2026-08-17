// feature_id: v3.config_mgmt_provider_files
// Provider 文件管理：<config_dir>/provider/<id>/config.v2.toml 的扫描、
// 解析与原子写入。解析/序列化复用 routecodex-v3-config 的 v2 compat 模型，
// 禁止本模块重复实现 provider 语义。
use routecodex_v3_config::{
    generate_v2_provider_config_file, parse_v2_provider_config_file, V2ProviderConfigFile,
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
                let candidate = entry
                    .path()
                    .join(V2_PROVIDER_CONFIG_FILE_NAME);
                if candidate.is_file() {
                    ids.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("scan provider directory {} failed: {error}", root.display())),
    }
    ids.sort();
    Ok(ids)
}

pub fn read_provider_file(config_dir: &Path, provider_id: &str) -> Result<ProviderFileEntry, String> {
    let path = provider_config_file_path(config_dir, provider_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("provider config {} read failed: {error}", path.display()))?;
    let config = parse_v2_provider_config_file(&raw)
        .map_err(|error| format!("provider config {} parse failed: {error}", path.display()))?;
    Ok(ProviderFileEntry {
        provider_id: provider_id.to_string(),
        directory: path
            .parent()
            .unwrap_or(&path)
            .to_path_buf(),
        config,
    })
}

/// 原子写入 provider 文件（tmp + rename），文件已存在时先备份。
pub fn write_provider_file(
    config_dir: &Path,
    provider_id: &str,
    config: &V2ProviderConfigFile,
) -> Result<PathBuf, String> {
    let path = provider_config_file_path(config_dir, provider_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create provider dir {} failed: {error}", parent.display()))?;
    }
    if path.exists() {
        backup_file(&path, "provider-update")?;
    }
    let raw = generate_v2_provider_config_file(config)
        .map_err(|error| format!("generate provider config failed: {error}"))?;
    let temp_path = path.with_extension(format!("toml.tmp-{}", std::process::id()));
    std::fs::write(&temp_path, raw)
        .map_err(|error| format!("write provider temp {} failed: {error}", temp_path.display()))?;
    std::fs::rename(&temp_path, &path)
        .map_err(|error| format!("atomic replace provider {} failed: {error}", path.display()))?;
    Ok(path)
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
    format!(
        "{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}"
    )
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
