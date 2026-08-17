// feature_id: v3.admin_metrics
// 观测面统计：从 server 日志尾部聚合每 port 请求量、失败数与路由目标分布，
// 以及受管实例状态。本模块只提供展示用观测数据（日志即观测证据），
// 不承担任何配置/路由语义。
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize)]
pub struct PortTraffic {
    pub received: u64,
    pub executed: u64,
    pub provider_errors: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LogTrafficStats {
    pub received_total: u64,
    pub provider_errors_total: u64,
    pub per_port: BTreeMap<String, PortTraffic>,
    pub route_targets: BTreeMap<String, u64>,
    /// 统计来源日志路径。
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ManagedInstanceStatus {
    pub instance_id: Option<String>,
    pub state: Option<String>,
    pub updated_at_epoch_ms: Option<u64>,
    pub detail: Option<serde_json::Value>,
}

const TAIL_BYTES: u64 = 32 * 1024 * 1024;

pub fn scan_server_log(path: &Path) -> LogTrafficStats {
    let mut stats = LogTrafficStats {
        source: path.display().to_string(),
        ..Default::default()
    };
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return stats,
    };
    let mut file = file;
    let len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return stats,
    };
    let start = len.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return stats;
    }
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let line = line.as_bytes();
        let json_event = parse_json_event(line);
        match json_event {
            Some((event, server_id)) => {
                let traffic = stats.per_port.entry(server_id).or_default();
                match event.as_str() {
                    "received" => {
                        traffic.received += 1;
                        stats.received_total += 1;
                    }
                    "executed" => traffic.executed += 1,
                    _ => {}
                }
            }
            None => {
                if contains(line, b"provider-error") {
                    stats.provider_errors_total += 1;
                }
                if let Some(target) = parse_console_route_selected_target(line) {
                    *stats.route_targets.entry(target).or_default() += 1;
                }
            }
        }
    }
    stats
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

fn parse_json_event(line: &[u8]) -> Option<(String, String)> {
    if !line.starts_with(b"{") {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(line).ok()?;
    let event = parsed.get("event")?.as_str()?.to_string();
    let server_id = parsed
        .get("server_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    Some((event, server_id))
}

fn contains(line: &[u8], needle: &[u8]) -> bool {
    line.windows(needle.len()).any(|window| window == needle)
}

fn parse_console_route_selected_target(line: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(line).ok()?;
    if !text.contains("route_selected") {
        return None;
    }
    let marker = "target=";
    let index = text.find(marker)?;
    let rest = &text[index + marker.len()..];
    let target = rest.split_whitespace().next()?;
    Some(target.to_string())
}
