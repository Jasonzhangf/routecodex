use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const V3_CODEX_SAMPLE_REQUEST_RETENTION: usize = 200;

pub struct V3CodexSampleStore {
    enabled: bool,
    retention: usize,
    persistence_guard: Mutex<()>,
}

impl V3CodexSampleStore {
    pub fn new(enabled: bool, retention: usize) -> Self {
        Self {
            enabled,
            retention,
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
    ) -> Result<(), String> {
        if !self.enabled && !force {
            return Ok(());
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
        let path = dir.join(file_name);
        let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
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

    struct TestHome(std::sync::Mutex<()>);

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
            let store = V3CodexSampleStore::new(true, V3_CODEX_SAMPLE_REQUEST_RETENTION);
            let payload = json!({"model": "deepseek-v4-flash", "input": [{"role": "user", "content": "hello"}]});
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "request.json", &payload, false)
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
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "request.json", &json!({"a": 1}), false)
                .unwrap();
            assert!(!sample_dir(home_base).join("req-1").exists());
        });
    }

    #[test]
    fn persist_forces_error_evidence_when_disabled() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(false, V3_CODEX_SAMPLE_REQUEST_RETENTION);
            store
                .persist(10000, "responses", "/v1/responses", "req-1", "error.json", &json!({"status": 503}), true)
                .unwrap();
            let path = sample_dir(home_base).join("req-1").join("error.json");
            let written = fs::read_to_string(&path).unwrap();
            assert!(written.contains("503"));
        });
    }

    #[test]
    fn retention_caps_samples_at_configured_limit() {
        with_test_home(|home_base| {
            let store = V3CodexSampleStore::new(true, 200);
            for index in 0..201 {
                store
                    .persist(10000, "responses", "/v1/responses", &format!("req-{index}"), "request.json", &json!({"n": index}), false)
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
