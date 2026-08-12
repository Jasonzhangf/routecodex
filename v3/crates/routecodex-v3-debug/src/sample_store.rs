use serde_json::Value;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 200;

pub struct V3CodexSampleStore {
    enabled: bool,
    retention: usize,
    /// 只落错误样本（force=true 的 error evidence）；由 server 从 internal 默认值
    /// 与 `--snap` 运行时授权（full_codex_sampling）组合传入。
    error_samples_only: bool,
    persistence_guard: Mutex<()>,
}

impl V3CodexSampleStore {
    pub fn new(enabled: bool, retention: usize, error_samples_only: bool) -> Self {
        Self {
            enabled,
            retention,
            error_samples_only,
            persistence_guard: Mutex::new(()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn retention(&self) -> usize {
        self.retention
    }

    pub fn persist(
        &self,
        port: u16,
        entry_protocol: &str,
        endpoint: &str,
        request_id: &str,
        file_name: &str,
        payload: &Value,
        force: bool,
        status: Option<u16>,
    ) -> Result<(), String> {
        if !self.enabled && !force {
            return Ok(());
        }
        if !force && self.error_samples_only {
            return Ok(());
        }
        // 账号/配额类错误状态不落盘（401/402/403/429/503 等）。
        if force {
            if let Some(status) = status {
                if routecodex_v3_config::internal::v3_error_sample_skip_statuses().contains(&status) {
                    return Ok(());
                }
            }
        }
        let _persistence_guard = self
            .persistence_guard
            .lock()
            .map_err(|error| format!("codex sample persistence lock poisoned: {error}"))?;
        let port_root = resolve_v3_codex_samples_root()?
            .join(format_v3_codex_sample_endpoint_dir(
                entry_protocol,
                endpoint,
            ))
            .join("ports")
            .join(port.to_string());
        let dir = port_root.join(encode_v3_codex_sample_path_segment(request_id));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        // 样本含敏感请求/错误载荷：目录 0700、文件 0600（不依赖 umask）。
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let path = dir.join(file_name);
        let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        serde_json::to_writer_pretty(&mut file, payload).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        enforce_v3_codex_sample_request_retention(&port_root, Some(&dir), self.retention)?;
        Ok(())
    }

    pub fn enforce_listener_retention(&self, port: u16) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let samples_root = resolve_v3_codex_samples_root()?;
        if !samples_root.exists() {
            return Ok(());
        }
        let endpoint_dirs = fs::read_dir(&samples_root)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        for endpoint_dir in endpoint_dirs {
            if !endpoint_dir
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let port_root = endpoint_dir.path().join("ports").join(port.to_string());
            if !port_root.is_dir() {
                continue;
            }
            enforce_v3_codex_sample_request_retention(&port_root, None, self.retention)?;
        }
        Ok(())
    }
}

fn resolve_v3_codex_samples_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "codex sample filesystem requires HOME".to_string())?;
    if home.to_string_lossy().trim().is_empty() {
        return Err("codex sample filesystem requires non-empty HOME".to_string());
    }
    Ok(PathBuf::from(home).join(".rcc").join("codex-samples"))
}

fn format_v3_codex_sample_endpoint_dir(entry_protocol: &str, endpoint: &str) -> String {
    match (entry_protocol, endpoint) {
        ("responses", "/v1/responses") => "openai-responses".to_string(),
        ("openai_chat", "/v1/chat/completions") => "openai-chat-completions".to_string(),
        ("anthropic", "/v1/messages") => "anthropic-messages".to_string(),
        ("gemini", _) => "gemini-generate-content".to_string(),
        _ => encode_v3_codex_sample_path_segment(
            endpoint.trim_start_matches('/').replace('/', "-").as_str(),
        ),
    }
}

fn encode_v3_codex_sample_path_segment(value: &str) -> String {
    let path_safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if path_safe.is_empty() {
        "unknown".to_string()
    } else {
        path_safe
    }
}

fn enforce_v3_codex_sample_request_retention(
    port_root: &Path,
    protected_request_dir: Option<&Path>,
    retention: usize,
) -> Result<(), String> {
    let entries = fs::read_dir(port_root)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut request_dirs = Vec::new();
    for entry in entries {
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let modified = entry
            .metadata()
            .map_err(|error| error.to_string())?
            .modified()
            .map_err(|error| error.to_string())?;
        request_dirs.push((entry, modified));
    }
    if request_dirs.len() <= retention {
        return Ok(());
    }
    request_dirs.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let excess = request_dirs.len() - retention;
    let removable = request_dirs
        .into_iter()
        .filter(|(entry, _)| {
            protected_request_dir.is_none_or(|protected| entry.path() != protected)
        })
        .take(excess)
        .collect::<Vec<_>>();
    if removable.len() != excess {
        return Err(format!(
            "codex sample retention cannot preserve current request while removing {excess} directories"
        ));
    }
    for (entry, _) in removable {
        fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_test_home(f: impl FnOnce(&std::path::Path)) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!(
            "v3-codex-sample-store-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        f(&base);
        if let Some(previous) = previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn sample_dir(home_base: &std::path::Path) -> std::path::PathBuf {
        home_base
            .join("home")
            .join(".rcc")
            .join("codex-samples")
            .join("openai-responses")
            .join("ports")
            .join("10000")
    }

    #[test]
    fn persist_writes_verbatim_sample_when_enabled() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            let payload = json!({"model": "deepseek-v4-flash", "input": [{"role": "user", "content": "hello"}]});
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "request.json", &payload, false, None)
                .unwrap();
            let path = sample_dir(home_base)
                .join("req-1")
                .join("request.json");
            let written = fs::read_to_string(&path).unwrap();
            assert!(written.contains("deepseek-v4-flash"));
            assert!(written.contains("hello"));
            assert!(!written.contains("ROUTECODEX_DEBUG"));
        });
    }

    #[test]
    fn persist_skips_when_disabled_without_force() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "request.json", &json!({"a": 1}), false, None)
                .unwrap();
            assert!(!sample_dir(home_base).join("req-1").exists());
        });
    }

    #[test]
    fn persist_forces_error_evidence_when_disabled() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "error.json", &json!({"status": 502}), true, Some(502))
                .unwrap();
            let path = sample_dir(home_base).join("req-1").join("error.json");
            let written = fs::read_to_string(&path).unwrap();
            assert!(written.contains("502"));
        });
    }

    #[test]
    fn persist_skips_error_sample_for_skipped_status_even_when_forced() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION, false);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "error.json", &json!({"status": 503}), true, Some(503))
                .unwrap();
            assert!(
                !sample_dir(home_base).join("req-1").exists(),
                "skipped account/quota error status must not be persisted"
            );
            store
                .persist(10000, "responses", "/v1/responses", "req-2", "error.json", &json!({"status": 502}), true, Some(502))
                .unwrap();
            assert!(
                sample_dir(home_base).join("req-2").join("error.json").exists(),
                "non-skipped error status must still be persisted"
            );
        });
    }

    #[test]
    fn persist_skips_normal_sample_when_error_samples_only() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION, true);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "request.json", &json!({"a": 1}), false, None)
                .unwrap();
            assert!(
                !sample_dir(home_base).join("req-1").exists(),
                "normal sample must not be persisted when error_samples_only"
            );
            store
                .persist(10000, "responses", "/v1/responses", "req-2", "error.json", &json!({"status": 500}), true, Some(500))
                .unwrap();
            assert!(
                sample_dir(home_base).join("req-2").join("error.json").exists(),
                "error evidence must still be persisted when error_samples_only"
            );
        });
    }

    #[test]
    fn retention_caps_samples_at_configured_limit() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, 200, false);
            for index in 0..201 {
                store
                    .persist(10000, "responses", "/v1/responses", &format!("req-{index}"), "request.json", &json!({"n": index}), true, Some(502))
                    .unwrap();
            }
            let dirs = fs::read_dir(sample_dir(home_base)).unwrap().count();
            assert_eq!(dirs, 200);
        });
    }

    #[test]
    fn endpoint_dir_mapping_is_stable() {
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("responses", "/v1/responses"),
            "openai-responses"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("openai_chat", "/v1/chat/completions"),
            "openai-chat-completions"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("anthropic", "/v1/messages"),
            "anthropic-messages"
        );
        assert_eq!(
            format_v3_codex_sample_endpoint_dir("gemini", "/v1beta/models/gemini-2.0-flash:generateContent"),
            "gemini-generate-content"
        );
    }

    #[test]
    fn unknown_request_id_encodes_to_unknown() {
        assert_eq!(encode_v3_codex_sample_path_segment("///"), "unknown");
        assert_eq!(
            encode_v3_codex_sample_path_segment("router-gpt-5.6-sol-20260810T223407524-738231-8043"),
            "router-gpt-5.6-sol-20260810T223407524-738231-8043"
        );
    }
}
