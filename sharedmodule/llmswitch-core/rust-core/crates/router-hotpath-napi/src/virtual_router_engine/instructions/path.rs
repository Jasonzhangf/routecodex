use regex::Regex;
use std::cell::RefCell;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use super::types::{DEFAULT_PRECOMMAND_SCRIPT, DEFAULT_PRECOMMAND_SCRIPT_CONTENT};

thread_local! {
    static RCC_USER_DIR_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

struct RccUserDirOverrideGuard {
    previous: Option<PathBuf>,
}

impl Drop for RccUserDirOverrideGuard {
    fn drop(&mut self) {
        RCC_USER_DIR_OVERRIDE.with(|slot| {
            *slot.borrow_mut() = self.previous.take();
        });
    }
}

fn normalize_override_user_dir(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn read_override_user_dir() -> Option<PathBuf> {
    RCC_USER_DIR_OVERRIDE.with(|slot| slot.borrow().clone())
}

pub(crate) fn with_rcc_user_dir_override<T>(
    raw: Option<&str>,
    callback: impl FnOnce() -> T,
) -> T {
    let next = normalize_override_user_dir(raw);
    let previous = RCC_USER_DIR_OVERRIDE.with(|slot| {
        let previous = slot.borrow().clone();
        *slot.borrow_mut() = next;
        previous
    });
    let _guard = RccUserDirOverrideGuard { previous };
    callback()
}

fn expand_home(value: &str, home_dir: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        return home_dir.join(stripped);
    }
    PathBuf::from(value)
}

fn resolve_rcc_user_dir() -> Result<PathBuf, String> {
    if let Some(explicit) = read_override_user_dir() {
        return Ok(explicit);
    }
    let home = env::var("HOME")
        .ok()
        .or_else(|| env::var("USERPROFILE").ok())
        .unwrap_or_default();
    let trimmed = home.trim();
    if trimmed.is_empty() {
        return Err("precommand: cannot resolve homedir".to_string());
    }
    let home_dir = PathBuf::from(trimmed);
    let legacy_dir = home_dir.join(".routecodex");
    for key in ["RCC_HOME", "ROUTECODEX_USER_DIR", "ROUTECODEX_HOME"] {
        if let Ok(value) = env::var(key) {
            let raw = value.trim();
            if raw.is_empty() {
                continue;
            }
            let candidate = expand_home(raw, &home_dir);
            if candidate == legacy_dir {
                continue;
            }
            return Ok(candidate);
        }
    }
    Ok(home_dir.join(".rcc"))
}

fn resolve_precommand_base_dir() -> Result<PathBuf, String> {
    resolve_rcc_user_dir().map(|base| base.join("precommand"))
}

fn normalize_relative_path(raw: &str) -> Result<String, String> {
    let cleaned = raw.replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(&cleaned).components() {
        use std::path::Component;
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err("precommand: invalid relative path".to_string());
            }
            Component::ParentDir => {
                return Err("precommand: invalid relative path".to_string());
            }
            Component::CurDir => {}
            Component::Normal(value) => {
                let piece = value.to_string_lossy().trim().to_string();
                if !piece.is_empty() {
                    parts.push(piece);
                }
            }
        }
    }
    if parts.is_empty() {
        return Err("precommand: invalid relative path".to_string());
    }
    Ok(parts.join("/"))
}

fn normalize_precommand_relative_path(raw: &str, from_file_scheme: bool) -> Result<String, String> {
    let normalized = normalize_relative_path(raw)?;
    if normalized == "precommand" {
        return Err("precommand: expected script file under ~/.rcc/precommand".to_string());
    }
    if normalized.starts_with("precommand/") {
        return Ok(normalized["precommand/".len()..].to_string());
    }
    if from_file_scheme {
        return Err("precommand file://: path must be under file://precommand/...".to_string());
    }
    Ok(normalized)
}

fn try_create_default_precommand_script(base: &Path, script_path: &Path) {
    if fs::create_dir_all(base).is_err() {
        return;
    }
    if script_path.exists() {
        return;
    }
    let _ = fs::write(script_path, DEFAULT_PRECOMMAND_SCRIPT_CONTENT.as_bytes());
}

pub(super) fn resolve_precommand_script_path(raw: &str) -> Result<String, String> {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return Err("precommand: missing script path".to_string());
    }
    if text.starts_with('<') && text.ends_with('>') && text.len() >= 3 {
        text = text[1..text.len() - 1].trim().to_string();
    }
    let from_file_scheme = text.to_ascii_lowercase().starts_with("file://");
    let rel_raw = if from_file_scheme {
        text["file://".len()..].trim().to_string()
    } else {
        text
    };
    if rel_raw.is_empty() {
        return Err("precommand file://: missing relative path".to_string());
    }
    if rel_raw.starts_with('/')
        || rel_raw.starts_with('\\')
        || Regex::new(r"^[a-zA-Z]:[\\/]").unwrap().is_match(&rel_raw)
    {
        return Err(
            "precommand: only supports paths relative to ~/.rcc/precommand".to_string(),
        );
    }
    let rel_to_precommand = normalize_precommand_relative_path(&rel_raw, from_file_scheme)?;
    let base = resolve_precommand_base_dir()?;
    let abs = base.join(Path::new(&rel_to_precommand));
    if abs != base && !abs.starts_with(&base) {
        return Err("precommand: path escapes ~/.rcc/precommand".to_string());
    }
    let stat = fs::metadata(&abs);
    let stat = match stat {
        Ok(meta) => meta,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound
                && rel_to_precommand == DEFAULT_PRECOMMAND_SCRIPT
            {
                try_create_default_precommand_script(&base, &abs);
                fs::metadata(&abs).map_err(|retry_err| {
                    format!("precommand: cannot stat {}: {}", abs.display(), retry_err)
                })?
            } else {
                return Err(format!(
                    "precommand: cannot stat {}: {}",
                    abs.display(),
                    err
                ));
            }
        }
    };
    if !stat.is_file() {
        return Err(format!("precommand: not a file: {}", abs.display()));
    }
    Ok(abs.to_string_lossy().to_string())
}

pub(super) fn is_stop_message_file_reference(raw: &str) -> bool {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return false;
    }
    if text.starts_with('<') && text.ends_with('>') && text.len() >= 3 {
        text = text[1..text.len() - 1].trim().to_string();
    }
    text.to_ascii_lowercase().starts_with("file://")
}

pub(super) fn resolve_stop_message_text(raw: &str) -> Result<String, String> {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return Ok(raw.to_string());
    }
    if text.starts_with('<') && text.ends_with('>') && text.len() >= 3 {
        text = text[1..text.len() - 1].trim().to_string();
    }
    if !text.to_ascii_lowercase().starts_with("file://") {
        return Ok(raw.to_string());
    }
    let rel_raw = text["file://".len()..].trim().to_string();
    if rel_raw.is_empty() {
        return Err("stopMessage file://: missing relative path".to_string());
    }
    if rel_raw.starts_with('/')
        || rel_raw.starts_with('\\')
        || Regex::new(r"^[a-zA-Z]:[\\/]").unwrap().is_match(&rel_raw)
    {
        return Err(
            "stopMessage file://: only supports paths relative to ~/.rcc".to_string(),
        );
    }
    let normalized_rel = normalize_relative_path(&rel_raw)
        .map_err(|_| "stopMessage file://: invalid relative path".to_string())?;
    let base = resolve_rcc_user_dir()
        .map_err(|err| err.replace("precommand", "stopMessage file://"))?;
    let abs = base.join(Path::new(&normalized_rel));
    if abs != base && !abs.starts_with(&base) {
        return Err("stopMessage file://: path escapes ~/.rcc".to_string());
    }
    let stat = fs::metadata(&abs).map_err(|err| {
        format!(
            "stopMessage file://: cannot stat {}: {}",
            abs.display(),
            err
        )
    })?;
    if !stat.is_file() {
        return Err(format!(
            "stopMessage file://: not a file: {}",
            abs.display()
        ));
    }
    let content = fs::read_to_string(&abs).map_err(|err| {
        format!(
            "stopMessage file://: cannot read {}: {}",
            abs.display(),
            err
        )
    })?;
    Ok(content)
}
