// feature_id: v3.admin_metrics
// 观测面统计：受管实例状态投影。持久化请求统计由 Config JSONL store owner
// 读取，本模块不再扫描文本日志。
// 不承担任何配置/路由语义。
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ManagedInstanceStatus {
    pub instance_id: Option<String>,
    pub state: Option<String>,
    pub updated_at_epoch_ms: Option<u64>,
    pub detail: Option<serde_json::Value>,
}

pub fn read_managed_instance_status(config_dir: &Path) -> Option<ManagedInstanceStatus> {
    let instances_dir = config_dir
        .join("state")
        .join("runtime-lifecycle")
        .join("v3")
        .join("instances");
    let mut latest: Option<(String, std::time::SystemTime)> = None;
    if let Ok(entries) = std::fs::read_dir(&instances_dir) {
        for entry in entries.flatten() {
            let status_path = entry.path().join("status.json");
            if let Ok(modified) = std::fs::metadata(&status_path).and_then(|m| m.modified()) {
                match &latest {
                    Some((_, existing)) if *existing >= modified => {}
                    _ => latest = Some((entry.file_name().to_string_lossy().to_string(), modified)),
                }
            }
        }
    }
    let instance = latest?.0;
    let raw = std::fs::read_to_string(instances_dir.join(&instance).join("status.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(ManagedInstanceStatus {
        instance_id: parsed
            .get("instance_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        state: parsed
            .get("state")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        updated_at_epoch_ms: parsed
            .get("updated_at_epoch_ms")
            .and_then(serde_json::Value::as_u64),
        detail: parsed.get("detail").cloned(),
    })
}
