use regex::Regex;
use std::cell::RefCell;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

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

pub(crate) fn with_rcc_user_dir_override<T>(raw: Option<&str>, callback: impl FnOnce() -> T) -> T {
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

fn absolutize_path(value: PathBuf) -> PathBuf {
    if value.is_absolute() {
        return value;
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(value)
}

fn resolve_home_dir(home_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = home_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(absolutize_path(PathBuf::from(trimmed)));
        }
    }
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
    Ok(absolutize_path(PathBuf::from(trimmed)))
}

pub(crate) fn resolve_rcc_user_dir_for_host(home_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(explicit) = read_override_user_dir() {
        return Ok(explicit);
    }
    let home_dir = resolve_home_dir(home_dir)?;
    let legacy_dir = home_dir.join(".routecodex");
    for key in ["RCC_HOME", "ROUTECODEX_USER_DIR", "ROUTECODEX_HOME"] {
        if let Ok(value) = env::var(key) {
            let raw = value.trim();
            if raw.is_empty() {
                continue;
            }
            let candidate = absolutize_path(expand_home(raw, &home_dir));
            if candidate == legacy_dir {
                continue;
            }
            return Ok(candidate);
        }
    }
    Ok(home_dir.join(".rcc"))
}

fn resolve_rcc_user_dir() -> Result<PathBuf, String> {
    resolve_rcc_user_dir_for_host(None)
}

pub(crate) fn resolve_rcc_path_for_host(
    segments: &[String],
    home_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let mut base = resolve_rcc_user_dir_for_host(home_dir)?;
    for segment in segments {
        base.push(segment);
    }
    Ok(base)
}

#[cfg(test)]
mod host_path_tests {
    use super::{resolve_rcc_path_for_host, resolve_rcc_user_dir_for_host};
    use std::env;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let previous = env::var(key).ok();
            match value {
                Some(next) => env::set_var(key, next),
                None => env::remove_var(key),
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.previous.as_deref() {
                Some(previous) => env::set_var(self.key, previous),
                None => env::remove_var(self.key),
            }
        }
    }

    fn clear_rcc_env() -> Vec<EnvGuard> {
        vec![
            EnvGuard::set("RCC_HOME", None),
            EnvGuard::set("ROUTECODEX_USER_DIR", None),
            EnvGuard::set("ROUTECODEX_HOME", None),
        ]
    }

    #[test]
    fn resolve_rcc_user_dir_for_host_uses_primary_home_dir() {
        let _lock = lock_env();
        let _env = clear_rcc_env();
        let home = PathBuf::from("/tmp/rcc-home-probe");
        assert_eq!(
            resolve_rcc_user_dir_for_host(Some(home.to_str().unwrap())).unwrap(),
            home.join(".rcc")
        );
    }

    #[test]
    fn resolve_rcc_user_dir_for_host_ignores_retired_legacy_env_root() {
        let _lock = lock_env();
        let _clear = clear_rcc_env();
        let home = PathBuf::from("/tmp/rcc-legacy-probe");
        let legacy = home.join(".routecodex");
        let _rcc_home = EnvGuard::set("RCC_HOME", Some(legacy.to_str().unwrap()));
        assert_eq!(
            resolve_rcc_user_dir_for_host(Some(home.to_str().unwrap())).unwrap(),
            home.join(".rcc")
        );
    }

    #[test]
    fn resolve_rcc_path_for_host_joins_segments_under_user_dir() {
        let _lock = lock_env();
        let _env = clear_rcc_env();
        let home = PathBuf::from("/tmp/rcc-path-probe");
        assert_eq!(
            resolve_rcc_path_for_host(
                &["logs".to_string(), "servertool-events.jsonl".to_string()],
                Some(home.to_str().unwrap()),
            )
            .unwrap(),
            home.join(".rcc")
                .join("logs")
                .join("servertool-events.jsonl")
        );
    }
}

fn resolve_precommand_base_dir() -> Result<PathBuf, String> {
    resolve_rcc_user_dir().map(|base| base.join("precommand"))
}

fn normalize_path_for_containment(raw: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
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
        return Err("precommand: only supports paths relative to ~/.rcc/precommand".to_string());
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

pub(crate) fn is_precommand_script_path_allowed(raw_path: &str) -> Result<bool, String> {
    let script_path = raw_path.trim();
    if script_path.is_empty() {
        return Ok(false);
    }
    let base = normalize_path_for_containment(&resolve_precommand_base_dir()?);
    let abs = normalize_path_for_containment(&PathBuf::from(script_path));
    if abs != base && !abs.starts_with(&base) {
        return Ok(false);
    }
    let stat = match fs::metadata(&abs) {
        Ok(meta) => meta,
        Err(_) => return Ok(false),
    };
    Ok(stat.is_file())
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
        return Err("stopMessage file://: only supports paths relative to ~/.rcc".to_string());
    }
    let normalized_rel = normalize_relative_path(&rel_raw)
        .map_err(|_| "stopMessage file://: invalid relative path".to_string())?;
    let base =
        resolve_rcc_user_dir().map_err(|err| err.replace("precommand", "stopMessage file://"))?;
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

// ============================================================
// rcc_user_dir isolation red tests
// ============================================================

#[cfg(test)]
mod isolation_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("rcc-user-dir-iso-{}-{n}-{seq}", std::process::id()))
    }

    // T2a: two different rcc_user_dir overrides must resolve to different base paths
    #[test]
    fn rcc_user_dir_override_resolves_different_paths() {
        let dir_a = unique_temp();
        let dir_b = unique_temp();
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        // With override A active
        with_rcc_user_dir_override(dir_a.to_str(), || {
            let resolved = resolve_rcc_user_dir();
            assert!(resolved.is_ok());
            assert_eq!(resolved.unwrap(), dir_a, "must resolve to dir_a");
        });

        // With override B active
        with_rcc_user_dir_override(dir_b.to_str(), || {
            let resolved = resolve_rcc_user_dir();
            assert!(resolved.is_ok());
            assert_eq!(resolved.unwrap(), dir_b, "must resolve to dir_b");
        });

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }

    // T2b: path resolution under rcc_user_dir must not cross into another dir
    #[test]
    fn rcc_user_dir_override_path_resolution_no_cross() {
        let dir_a = unique_temp();
        let dir_b = unique_temp();
        fs::create_dir_all(&dir_a.join("precommand")).unwrap();
        fs::create_dir_all(&dir_b.join("precommand")).unwrap();

        // Write a script into dir_a
        let script_a = dir_a.join("precommand").join("test.sh");
        fs::write(&script_a, "#!/bin/sh\necho hello").unwrap();

        // Write a different script into dir_b
        let script_b = dir_b.join("precommand").join("test.sh");
        fs::write(&script_b, "#!/bin/sh\necho world").unwrap();

        // dir_a should resolve to dir_a's script
        with_rcc_user_dir_override(dir_a.to_str(), || {
            let result = resolve_precommand_script_path("test.sh");
            assert!(result.is_ok(), "should resolve test.sh in dir_a");
            let resolved = result.unwrap();
            assert!(
                resolved.contains(dir_a.to_str().unwrap()),
                "must be under dir_a"
            );
        });

        // dir_b should resolve to dir_b's script, not dir_a's
        with_rcc_user_dir_override(dir_b.to_str(), || {
            let result = resolve_precommand_script_path("test.sh");
            assert!(result.is_ok(), "should resolve test.sh in dir_b");
            let resolved = result.unwrap();
            assert!(
                resolved.contains(dir_b.to_str().unwrap()),
                "must be under dir_b"
            );
            assert!(
                !resolved.contains(dir_a.to_str().unwrap()),
                "must NOT cross into dir_a"
            );
        });

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }

    #[test]
    fn precommand_script_allowed_accepts_only_files_under_precommand_dir() {
        let dir = unique_temp();
        let precommand_dir = dir.join("precommand");
        let script_path = precommand_dir.join("allowed.sh");
        let outside_path = dir.join("outside.sh");
        fs::create_dir_all(&precommand_dir).unwrap();
        fs::write(&script_path, "#!/bin/sh\necho allowed").unwrap();
        fs::write(&outside_path, "#!/bin/sh\necho outside").unwrap();

        with_rcc_user_dir_override(dir.to_str(), || {
            assert_eq!(
                is_precommand_script_path_allowed(script_path.to_str().unwrap()).unwrap(),
                true
            );
            assert_eq!(
                is_precommand_script_path_allowed(outside_path.to_str().unwrap()).unwrap(),
                false
            );
            assert_eq!(
                is_precommand_script_path_allowed(precommand_dir.to_str().unwrap()).unwrap(),
                false
            );
        });

        let _ = fs::remove_dir_all(dir);
    }

    // T2c: nested override clears correctly (RAII guard restores previous)
    #[test]
    fn rcc_user_dir_override_raii_guard_restores() {
        let dir_a = unique_temp();
        let dir_b = unique_temp();
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        with_rcc_user_dir_override(dir_a.to_str(), || {
            let r1 = resolve_rcc_user_dir().unwrap();
            assert_eq!(r1, dir_a);

            // Inner override sets dir_b
            with_rcc_user_dir_override(dir_b.to_str(), || {
                let r2 = resolve_rcc_user_dir().unwrap();
                assert_eq!(r2, dir_b);
            });

            // After inner override drops, must restore to dir_a
            let r3 = resolve_rcc_user_dir().unwrap();
            assert_eq!(r3, dir_a, "RAII guard must restore previous override");
        });

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }
}
