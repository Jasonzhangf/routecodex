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

pub(crate) fn resolve_rcc_user_dir_for_host_with_env(
    home_dir: Option<&str>,
    env_values: &[(&str, Option<&str>)],
) -> Result<PathBuf, String> {
    if let Some(explicit) = read_override_user_dir() {
        return Ok(explicit);
    }
    let home_dir = resolve_home_dir(home_dir)?;
    let legacy_dir = home_dir.join(".routecodex");
    for (key, value) in env_values {
        let raw = value.unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        let candidate = absolutize_path(expand_home(raw, &home_dir));
        if candidate == legacy_dir {
            return Err(format!(
                "[config] {} points to retired ~/.routecodex root; use ~/.rcc",
                key
            ));
        }
        return Ok(candidate);
    }
    Ok(home_dir.join(".rcc"))
}

pub(crate) fn resolve_rcc_user_dir_for_host(home_dir: Option<&str>) -> Result<PathBuf, String> {
    let rcc_home = env::var("RCC_HOME").ok();
    let routecodex_user_dir = env::var("ROUTECODEX_USER_DIR").ok();
    let routecodex_home = env::var("ROUTECODEX_HOME").ok();
    resolve_rcc_user_dir_for_host_with_env(
        home_dir,
        &[
            ("RCC_HOME", rcc_home.as_deref()),
            ("ROUTECODEX_USER_DIR", routecodex_user_dir.as_deref()),
            ("ROUTECODEX_HOME", routecodex_home.as_deref()),
        ],
    )
}

fn resolve_rcc_user_dir() -> Result<PathBuf, String> {
    resolve_rcc_user_dir_for_host(None)
}

pub(crate) fn resolve_rcc_path_for_host(
    segments: &[String],
    home_dir: Option<&str>,
) -> Result<PathBuf, String> {
    resolve_rcc_path_for_host_with_env(
        home_dir,
        segments,
        &[
            ("RCC_HOME", env::var("RCC_HOME").ok().as_deref()),
            (
                "ROUTECODEX_USER_DIR",
                env::var("ROUTECODEX_USER_DIR").ok().as_deref(),
            ),
            (
                "ROUTECODEX_HOME",
                env::var("ROUTECODEX_HOME").ok().as_deref(),
            ),
        ],
    )
}

pub(crate) fn resolve_rcc_path_for_host_with_env(
    home_dir: Option<&str>,
    segments: &[String],
    env_values: &[(&str, Option<&str>)],
) -> Result<PathBuf, String> {
    let base = resolve_rcc_user_dir_for_host_with_env(home_dir, env_values)?;
    Ok(join_segments_like_node_path_join(base, segments))
}

fn join_segments_like_node_path_join(mut base: PathBuf, segments: &[String]) -> PathBuf {
    for segment in segments {
        for component in Path::new(segment).components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    base.pop();
                }
                Component::Prefix(_) | Component::RootDir => {}
                Component::Normal(value) => {
                    base.push(value);
                }
            }
        }
    }
    base
}

pub(crate) struct RouteCodexConfigPathResolveInput<'a> {
    pub preferred_path: Option<&'a str>,
    pub config_name: Option<&'a str>,
    pub allow_directory_scan: bool,
    pub base_dir: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub home_dir: Option<&'a str>,
    pub exec_path: Option<&'a str>,
    pub routecodex_config_path: Option<&'a str>,
    pub routecodex_config: Option<&'a str>,
    pub rcc_home: Option<&'a str>,
    pub routecodex_user_dir: Option<&'a str>,
    pub routecodex_home: Option<&'a str>,
}

pub(crate) struct AuthFileResolvePlanInput<'a> {
    pub key_id: &'a str,
    pub auth_dir: Option<&'a str>,
    pub home_dir: Option<&'a str>,
    pub rcc_home: Option<&'a str>,
    pub routecodex_user_dir: Option<&'a str>,
    pub routecodex_home: Option<&'a str>,
}

pub(crate) struct RouteCodexConfigLoaderPathPlanInput<'a> {
    pub explicit_path: Option<&'a str>,
    pub routecodex_provider_dir: Option<&'a str>,
    pub rcc_provider_dir: Option<&'a str>,
}

pub(crate) struct ProviderConfigRootPlanInput<'a> {
    pub root_dir: Option<&'a str>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthFileResolvePlan {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_key: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteCodexConfigLoaderPathPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_root_dir: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderConfigRootPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_dir: Option<String>,
}

pub(crate) fn plan_auth_file_resolution_for_host(
    input: AuthFileResolvePlanInput<'_>,
) -> Result<AuthFileResolvePlan, String> {
    if !input.key_id.starts_with("authfile-") {
        return Ok(AuthFileResolvePlan {
            kind: "literal".to_string(),
            value: Some(input.key_id.to_string()),
            file_path: None,
            cache_key: None,
        });
    }
    let file_name = input.key_id.strip_prefix("authfile-").unwrap_or_default();
    let auth_dir = match input
        .auth_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(auth_dir) => PathBuf::from(auth_dir),
        None => resolve_rcc_path_for_host_with_env(
            input.home_dir,
            &["auth".to_string()],
            &[
                ("RCC_HOME", input.rcc_home),
                ("ROUTECODEX_USER_DIR", input.routecodex_user_dir),
                ("ROUTECODEX_HOME", input.routecodex_home),
            ],
        )?,
    };
    let file_path = join_segments_like_node_path_join(auth_dir, &[file_name.to_string()]);
    Ok(AuthFileResolvePlan {
        kind: "authFile".to_string(),
        value: None,
        file_path: Some(file_path.to_string_lossy().to_string()),
        cache_key: Some(input.key_id.to_string()),
    })
}

pub(crate) fn plan_routecodex_config_loader_paths_for_host(
    input: RouteCodexConfigLoaderPathPlanInput<'_>,
) -> RouteCodexConfigLoaderPathPlan {
    let explicit_path = input
        .explicit_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            absolutize_path(PathBuf::from(value))
                .to_string_lossy()
                .to_string()
        });
    let provider_root_dir = [input.routecodex_provider_dir, input.rcc_provider_dir]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| {
            absolutize_path(PathBuf::from(value))
                .to_string_lossy()
                .to_string()
        });
    RouteCodexConfigLoaderPathPlan {
        explicit_path,
        provider_root_dir,
    }
}

pub(crate) fn plan_provider_config_root_for_host(
    input: ProviderConfigRootPlanInput<'_>,
) -> ProviderConfigRootPlan {
    let root_dir = input
        .root_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            absolutize_path(PathBuf::from(value))
                .to_string_lossy()
                .to_string()
        });
    ProviderConfigRootPlan { root_dir }
}

const DEFAULT_CONFIG_NAME: &str = "config.toml";

pub(crate) fn resolve_routecodex_config_path_for_host(
    input: RouteCodexConfigPathResolveInput<'_>,
) -> Result<PathBuf, String> {
    let base_dir =
        resolve_config_base_dir(input.base_dir, input.cwd, input.home_dir, input.exec_path);
    let rcc_env = [
        ("RCC_HOME", input.rcc_home),
        ("ROUTECODEX_USER_DIR", input.routecodex_user_dir),
        ("ROUTECODEX_HOME", input.routecodex_home),
    ];
    let config_name = input
        .config_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut candidates: Vec<String> = Vec::new();
    push_present(&mut candidates, input.preferred_path);
    push_present(&mut candidates, input.routecodex_config_path);
    push_present(&mut candidates, input.routecodex_config);

    let name = config_name.unwrap_or(DEFAULT_CONFIG_NAME);
    candidates.push(base_dir.join(name).to_string_lossy().to_string());
    candidates.push(
        base_dir
            .join("config")
            .join(name)
            .to_string_lossy()
            .to_string(),
    );

    let primary_home = resolve_rcc_user_dir_for_host_with_env(input.home_dir, &rcc_env)?;
    if config_name.is_some() {
        candidates.push(primary_home.join(name).to_string_lossy().to_string());
        candidates.push(
            primary_home
                .join("config")
                .join(name)
                .to_string_lossy()
                .to_string(),
        );
    } else {
        candidates.push(
            primary_home
                .join(DEFAULT_CONFIG_NAME)
                .to_string_lossy()
                .to_string(),
        );
    }

    let default_config_dir =
        join_segments_like_node_path_join(primary_home.clone(), &["config".to_string()]);
    if input.allow_directory_scan {
        candidates.push(primary_home.to_string_lossy().to_string());
        candidates.push(default_config_dir.to_string_lossy().to_string());
    } else {
        candidates.push(default_config_dir.join(name).to_string_lossy().to_string());
    }

    for candidate in &candidates {
        let expanded_path = expand_config_path(candidate, input.home_dir);
        if expanded_path.as_os_str().is_empty() {
            continue;
        }
        if expanded_path
            .extension()
            .map(|value| value.to_string_lossy().trim().eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            return Err(format!(
                "Filesystem error accessing {candidate}: [config] user config JSON support removed; expected TOML file: {}",
                expanded_path.display()
            ));
        }
        match fs::metadata(&expanded_path) {
            Ok(metadata) if metadata.is_file() => return Ok(expanded_path),
            Ok(metadata) if metadata.is_dir() && input.allow_directory_scan => {
                if let Some(config_file) = scan_config_directory(&expanded_path, name)? {
                    return Ok(config_file);
                }
            }
            Ok(_) | Err(_) => {}
        }
    }

    Err(format!(
        "No configuration file found. Searched: {}.",
        candidates.join(", ")
    ))
}

fn push_present(candidates: &mut Vec<String>, value: Option<&str>) {
    if let Some(raw) = value {
        if !raw.trim().is_empty() {
            candidates.push(raw.to_string());
        }
    }
}

fn resolve_config_base_dir(
    base_dir: Option<&str>,
    cwd: Option<&str>,
    home_dir: Option<&str>,
    exec_path: Option<&str>,
) -> PathBuf {
    if let Some(raw) = base_dir {
        if !raw.trim().is_empty() {
            return absolutize_path(PathBuf::from(raw.trim()));
        }
    }
    if let Some(raw) = cwd {
        if !raw.trim().is_empty() {
            return absolutize_path(PathBuf::from(raw.trim()));
        }
    }
    if let Some(raw) = home_dir {
        if !raw.trim().is_empty() {
            return absolutize_path(PathBuf::from(raw.trim()));
        }
    }
    if let Some(raw) = exec_path {
        if !raw.trim().is_empty() {
            return PathBuf::from(raw.trim())
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
        }
    }
    PathBuf::from(".")
}

fn expand_config_path(path_string: &str, home_dir: Option<&str>) -> PathBuf {
    if path_string.is_empty() {
        return PathBuf::new();
    }
    if let Some(rest) = path_string.strip_prefix('~') {
        let home = resolve_home_dir(home_dir).unwrap_or_else(|_| PathBuf::from("."));
        return PathBuf::from(format!("{}{}", home.to_string_lossy(), rest));
    }
    PathBuf::from(path_string)
}

fn scan_config_directory(
    directory: &Path,
    preferred_name: &str,
) -> Result<Option<PathBuf>, String> {
    let expected = preferred_name.to_lowercase();
    let entries = fs::read_dir(directory)
        .map_err(|err| format!("Filesystem error accessing {}: {err}", directory.display()))?;
    for entry_result in entries {
        let entry = entry_result
            .map_err(|err| format!("Filesystem error accessing {}: {err}", directory.display()))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.to_lowercase() == expected {
            return Ok(Some(directory.join(file_name)));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod host_path_tests {
    use super::{
        plan_auth_file_resolution_for_host, plan_provider_config_root_for_host,
        plan_routecodex_config_loader_paths_for_host, resolve_rcc_path_for_host,
        resolve_rcc_user_dir_for_host, resolve_routecodex_config_path_for_host,
        AuthFileResolvePlanInput, ProviderConfigRootPlanInput, RouteCodexConfigLoaderPathPlanInput,
        RouteCodexConfigPathResolveInput,
    };
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, MutexGuard};
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn temp_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("routecodex-{label}-{stamp}"));
        fs::create_dir_all(&root).unwrap();
        root
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
        let error = resolve_rcc_user_dir_for_host(Some(home.to_str().unwrap()))
            .expect_err("retired RouteCodex root must fail fast");
        assert!(error.contains("retired ~/.routecodex root"));
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

    #[test]
    fn resolve_rcc_path_for_host_matches_node_path_join_normalization() {
        let _lock = lock_env();
        let _env = clear_rcc_env();
        let home = PathBuf::from("/tmp/rcc-path-normalize-probe");
        assert_eq!(
            resolve_rcc_path_for_host(
                &[
                    "logs".to_string(),
                    "..".to_string(),
                    "/provider".to_string()
                ],
                Some(home.to_str().unwrap()),
            )
            .unwrap(),
            home.join(".rcc").join("provider")
        );
    }

    #[test]
    fn resolve_routecodex_config_path_prefers_explicit_env_path() {
        let root = temp_root("config-env");
        let rcc_home = root.join(".rcc");
        let env_config = root.join("from-env.toml");
        fs::create_dir_all(&rcc_home).unwrap();
        fs::write(&env_config, "version = \"2.0.0\"\n").unwrap();
        let resolved = resolve_routecodex_config_path_for_host(RouteCodexConfigPathResolveInput {
            preferred_path: None,
            config_name: None,
            allow_directory_scan: true,
            base_dir: Some(root.to_str().unwrap()),
            cwd: Some(root.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            exec_path: None,
            routecodex_config_path: Some(env_config.to_str().unwrap()),
            routecodex_config: None,
            rcc_home: Some(rcc_home.to_str().unwrap()),
            routecodex_user_dir: Some(rcc_home.to_str().unwrap()),
            routecodex_home: Some(rcc_home.to_str().unwrap()),
        })
        .unwrap();
        assert_eq!(resolved, env_config);
    }

    #[test]
    fn resolve_routecodex_config_path_scans_rcc_user_dir() {
        let root = temp_root("config-scan");
        let rcc_home = root.join(".rcc");
        let config_path = rcc_home.join("config.toml");
        fs::create_dir_all(&rcc_home).unwrap();
        fs::write(&config_path, "version = \"2.0.0\"\n").unwrap();
        let resolved = resolve_routecodex_config_path_for_host(RouteCodexConfigPathResolveInput {
            preferred_path: None,
            config_name: None,
            allow_directory_scan: true,
            base_dir: Some(root.to_str().unwrap()),
            cwd: Some(root.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            exec_path: None,
            routecodex_config_path: None,
            routecodex_config: None,
            rcc_home: Some(rcc_home.to_str().unwrap()),
            routecodex_user_dir: Some(rcc_home.to_str().unwrap()),
            routecodex_home: Some(rcc_home.to_str().unwrap()),
        })
        .unwrap();
        assert_eq!(resolved, config_path);
    }

    #[test]
    fn resolve_routecodex_config_path_rejects_json_candidate() {
        let root = temp_root("config-json");
        let config_path = root.join("config.json");
        fs::write(&config_path, "{\"version\":\"1\"}\n").unwrap();
        let error = resolve_routecodex_config_path_for_host(RouteCodexConfigPathResolveInput {
            preferred_path: Some(config_path.to_str().unwrap()),
            config_name: None,
            allow_directory_scan: true,
            base_dir: Some(root.to_str().unwrap()),
            cwd: Some(root.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            exec_path: None,
            routecodex_config_path: None,
            routecodex_config: None,
            rcc_home: None,
            routecodex_user_dir: None,
            routecodex_home: None,
        })
        .expect_err("json config candidate must fail fast");
        assert!(error.contains("user config JSON support removed"));
    }

    #[test]
    fn plan_auth_file_resolution_returns_literal_for_non_authfile_key() {
        let root = temp_root("auth-literal");
        let plan = plan_auth_file_resolution_for_host(AuthFileResolvePlanInput {
            key_id: " sk-test-authfile-demo ",
            auth_dir: Some(root.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            rcc_home: None,
            routecodex_user_dir: None,
            routecodex_home: None,
        })
        .unwrap();
        assert_eq!(plan.kind, "literal");
        assert_eq!(plan.value.as_deref(), Some(" sk-test-authfile-demo "));
        assert_eq!(plan.file_path, None);
        assert_eq!(plan.cache_key, None);
    }

    #[test]
    fn plan_auth_file_resolution_joins_filename_under_auth_dir() {
        let root = temp_root("auth-plan");
        let auth_dir = root.join("auth");
        let plan = plan_auth_file_resolution_for_host(AuthFileResolvePlanInput {
            key_id: "authfile-demo-default",
            auth_dir: Some(auth_dir.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            rcc_home: None,
            routecodex_user_dir: None,
            routecodex_home: None,
        })
        .unwrap();
        assert_eq!(plan.kind, "authFile");
        assert_eq!(plan.value, None);
        assert_eq!(
            plan.file_path.as_deref(),
            Some(auth_dir.join("demo-default").to_str().unwrap())
        );
        assert_eq!(plan.cache_key.as_deref(), Some("authfile-demo-default"));
    }

    #[test]
    fn plan_auth_file_resolution_preserves_empty_suffix_path_join() {
        let root = temp_root("auth-empty");
        let auth_dir = root.join("auth");
        let plan = plan_auth_file_resolution_for_host(AuthFileResolvePlanInput {
            key_id: "authfile-",
            auth_dir: Some(auth_dir.to_str().unwrap()),
            home_dir: Some(root.to_str().unwrap()),
            rcc_home: None,
            routecodex_user_dir: None,
            routecodex_home: None,
        })
        .unwrap();
        assert_eq!(plan.kind, "authFile");
        assert_eq!(plan.file_path.as_deref(), Some(auth_dir.to_str().unwrap()));
        assert_eq!(plan.cache_key.as_deref(), Some("authfile-"));
    }

    #[test]
    fn plan_auth_file_resolution_uses_default_rcc_auth_dir() {
        let root = temp_root("auth-default");
        let plan = plan_auth_file_resolution_for_host(AuthFileResolvePlanInput {
            key_id: "authfile-secret",
            auth_dir: None,
            home_dir: Some(root.to_str().unwrap()),
            rcc_home: None,
            routecodex_user_dir: None,
            routecodex_home: None,
        })
        .unwrap();
        assert_eq!(
            plan.file_path.as_deref(),
            Some(
                root.join(".rcc")
                    .join("auth")
                    .join("secret")
                    .to_str()
                    .unwrap()
            )
        );
    }

    #[test]
    fn plan_routecodex_config_loader_paths_matches_ts_explicit_path_resolution() {
        let root = temp_root("loader-explicit");
        let relative = "config.toml";
        let current_dir = env::current_dir().unwrap();
        let plan =
            plan_routecodex_config_loader_paths_for_host(RouteCodexConfigLoaderPathPlanInput {
                explicit_path: Some(relative),
                routecodex_provider_dir: None,
                rcc_provider_dir: None,
            });
        assert_eq!(
            plan.explicit_path.as_deref(),
            Some(current_dir.join(relative).to_str().unwrap())
        );

        let absolute = root.join("config.toml");
        let plan =
            plan_routecodex_config_loader_paths_for_host(RouteCodexConfigLoaderPathPlanInput {
                explicit_path: Some(absolute.to_str().unwrap()),
                routecodex_provider_dir: None,
                rcc_provider_dir: None,
            });
        assert_eq!(
            plan.explicit_path.as_deref(),
            Some(absolute.to_str().unwrap())
        );
    }

    #[test]
    fn plan_routecodex_config_loader_paths_matches_provider_env_precedence() {
        let root = temp_root("loader-provider");
        let routecodex_provider_dir = root.join("routecodex-provider");
        let rcc_provider_dir = root.join("rcc-provider");
        let plan =
            plan_routecodex_config_loader_paths_for_host(RouteCodexConfigLoaderPathPlanInput {
                explicit_path: None,
                routecodex_provider_dir: Some(routecodex_provider_dir.to_str().unwrap()),
                rcc_provider_dir: Some(rcc_provider_dir.to_str().unwrap()),
            });
        assert_eq!(
            plan.provider_root_dir.as_deref(),
            Some(routecodex_provider_dir.to_str().unwrap())
        );

        let plan =
            plan_routecodex_config_loader_paths_for_host(RouteCodexConfigLoaderPathPlanInput {
                explicit_path: None,
                routecodex_provider_dir: Some("   "),
                rcc_provider_dir: Some("relative-provider"),
            });
        assert_eq!(
            plan.provider_root_dir.as_deref(),
            Some(
                env::current_dir()
                    .unwrap()
                    .join("relative-provider")
                    .to_str()
                    .unwrap()
            )
        );
    }

    #[test]
    fn plan_provider_config_root_matches_ts_explicit_root_resolution() {
        let root = temp_root("provider-root");
        let absolute = root.join("provider");
        let plan = plan_provider_config_root_for_host(ProviderConfigRootPlanInput {
            root_dir: Some(absolute.to_str().unwrap()),
        });
        assert_eq!(plan.root_dir.as_deref(), Some(absolute.to_str().unwrap()));

        let plan = plan_provider_config_root_for_host(ProviderConfigRootPlanInput {
            root_dir: Some(" relative-provider "),
        });
        assert_eq!(
            plan.root_dir.as_deref(),
            Some(
                env::current_dir()
                    .unwrap()
                    .join("relative-provider")
                    .to_str()
                    .unwrap()
            )
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
