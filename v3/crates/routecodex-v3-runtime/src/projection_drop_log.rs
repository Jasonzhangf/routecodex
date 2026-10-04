//! Stage-3 出站目标协议白名单投影的丢弃记录与专用持久化日志。
//!
//! 用户批准的请求路径规则：请求进入 stage 1 inbound 归一化（无损、无校验）、
//! stage 2 governance（逐字段、无校验）、stage 3 target output-protocol
//! whitelist projection。stage 3 遇到无法进入目标协议白名单的字段时不得报错：
//! 先最大化兼容（能转换就转换），确实没有兼容表示时才 DROP + RECORD + PRINT，
//! 并继续请求。
//!
//! 丢弃证据写入独立的 append-only JSONL 文件，刻意与 `debug.log_file` 物理分离
//! （不得混入 debug 日志），每条丢弃字段一行。`ControlFieldLeak` 属于控制面泄漏
//! 不变量，仍是 hard error，不走本通道。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

/// stage-3 target output-protocol whitelist projection 的 stage 标签。
pub const V3_PROJECTION_DROP_STAGE3: &str = "outbound_target_protocol_projection";

/// 一条 stage-3 出站投影丢弃记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct V3ProjectionDropRecord {
    pub request_id: String,
    /// 入口监听端口（入口身份；不可得时为空串）。
    pub entry_port: String,
    pub target_protocol: String,
    pub stage: String,
    pub json_path: String,
    pub reason: String,
    /// 客户端原始值（ReqInbound01 client raw payload）。
    pub source_value: Value,
    /// 经过 stage 1/2 之后的 canonical 值（stage 3 所见）。
    pub canonical_value: Value,
    /// 执行丢弃的 owner 函数名。
    pub drop_site: String,
}

impl V3ProjectionDropRecord {
    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| {
            format!("{{\"error\":\"projection drop record serialization failed: {error}\"}}")
        })
    }
}

/// 投影侧自足的轻量丢弃描述符：只含 stage 3 现场即可得到的字段。
///
/// 请求身份（`request_id` / `entry_port` / 客户端原样 `source_value`）只有请求
/// 作用域才拥有，因此由 relay 在 `V3ProjectionDropContext::record` 时补齐。
/// 这样投影函数不必携带上下文参数，架构契约要求的一字参调用形状得以保持，
/// 同时任何入口都不会出现「算出丢弃但不落盘」的静默缺口。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct V3ProjectionDrop {
    pub target_protocol: String,
    pub stage: String,
    pub json_path: String,
    pub reason: String,
    /// 经过 stage 1/2 之后的 canonical 值（stage 3 所见）。
    pub canonical_value: Value,
    /// 执行丢弃的 owner 函数名。
    pub drop_site: String,
}

/// stage-3 投影上下文：请求身份 + 客户端原始 payload 句柄 + 丢弃日志路径。
///
/// `client_original` 是 ReqInbound01 的客户端原始 payload 句柄（Arc），因此
/// stage 3 只看到 canonical payload 时仍能取到 `source_value`。
#[derive(Debug, Clone)]
pub struct V3ProjectionDropContext {
    pub request_id: String,
    pub entry_port: String,
    pub log_file: Option<String>,
    client_original: Arc<Value>,
}

impl V3ProjectionDropContext {
    pub fn new(
        request_id: impl Into<String>,
        entry_port: impl Into<String>,
        log_file: Option<String>,
        client_original: Arc<Value>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            entry_port: entry_port.into(),
            log_file,
            client_original,
        }
    }

    /// 从已编译 manifest 构建：请求身份 + 入口端口 + 独立丢弃日志路径 +
    /// 客户端原始 payload 句柄。
    pub fn from_manifest(
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        request_id: &str,
        client_original: Arc<Value>,
    ) -> Self {
        Self::new(
            request_id,
            manifest
                .servers
                .get(server_id)
                .map(|server| server.port.to_string())
                .unwrap_or_default(),
            manifest.debug.projection_drop_log_file.clone(),
            client_original,
        )
    }

    /// 无请求身份/原始 payload 的占位上下文，仅供保留旧签名的 wrapper 与单测使用。
    pub fn disabled() -> Self {
        Self {
            request_id: String::new(),
            entry_port: String::new(),
            log_file: None,
            client_original: Arc::new(Value::Null),
        }
    }

    pub fn client_original(&self) -> &Value {
        &self.client_original
    }

    /// 按 `json_path` 从客户端原始 payload 取 `source_value`；缺失时为 Null。
    pub fn source_value_at(&self, json_path: &str) -> Value {
        resolve_v3_json_path(&self.client_original, json_path).unwrap_or(Value::Null)
    }

    /// 用请求身份重新盖章并落盘。
    ///
    /// 投影链本身只产出「现场可得」的字段（target_protocol / stage / json_path /
    /// reason / canonical_value / drop_site），因此不需要把请求身份一路穿参；
    /// 只有请求作用域拥有 request_id / entry_port / 客户端原样 source_value，
    /// 在这里补齐后 `emit`。任何入口都必须调用本方法，避免「算出丢弃但不落盘」。
    pub fn restamp_and_emit(&self, records: &mut [V3ProjectionDropRecord]) {
        if records.is_empty() {
            return;
        }
        for record in records.iter_mut() {
            record.request_id = self.request_id.clone();
            record.entry_port = self.entry_port.clone();
            record.source_value = self.source_value_at(&record.json_path);
        }
        self.emit(records);
    }

    /// 用请求身份补齐投影描述符并落盘：唯一需要请求作用域的步骤。
    ///
    /// 描述符由 stage 3 投影产生（不含请求身份），此处补 `request_id` /
    /// `entry_port` / 客户端原样 `source_value` 后交给 `emit`。
    pub fn record(&self, drops: &[V3ProjectionDrop]) {
        if drops.is_empty() {
            return;
        }
        let records: Vec<V3ProjectionDropRecord> = drops
            .iter()
            .map(|drop| V3ProjectionDropRecord {
                request_id: self.request_id.clone(),
                entry_port: self.entry_port.clone(),
                target_protocol: drop.target_protocol.clone(),
                stage: drop.stage.clone(),
                json_path: drop.json_path.clone(),
                reason: drop.reason.clone(),
                source_value: self.source_value_at(&drop.json_path),
                canonical_value: drop.canonical_value.clone(),
                drop_site: drop.drop_site.clone(),
            })
            .collect();
        self.emit(&records);
    }

    /// PRINT 每条丢弃记录，并在配置了日志路径时 append 到独立 JSONL 文件。
    pub fn emit(&self, records: &[V3ProjectionDropRecord]) {
        if records.is_empty() {
            return;
        }
        for record in records {
            eprintln!("[v3-projection-drop] {}", record.to_json_line());
        }
        if let Err(error) = append_v3_projection_drop_records(self.log_file.as_deref(), records) {
            eprintln!(
                "[v3-projection-drop] failed to append projection drop log {}: {error}",
                self.log_file.as_deref().unwrap_or("<unset>")
            );
        }
    }
}

/// 启动 wiring：确保丢弃日志父目录存在并创建 append-only 文件。
pub fn ensure_v3_projection_drop_log_file(log_file: &str) -> std::io::Result<()> {
    let path = Path::new(log_file);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    Ok(())
}

/// append-only JSONL 写入：每条丢弃字段一行，父目录按需创建。
pub fn append_v3_projection_drop_records(
    log_file: Option<&str>,
    records: &[V3ProjectionDropRecord],
) -> std::io::Result<()> {
    let Some(path) = log_file else {
        return Ok(());
    };
    if records.is_empty() {
        return Ok(());
    }
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    for record in records {
        writeln!(file, "{}", record.to_json_line())?;
    }
    file.flush()
}

/// 最小 JSON path 解析，支持 `$.key`、`.key`、`[index]` 组合（丢弃站点使用）。
pub fn resolve_v3_json_path(value: &Value, json_path: &str) -> Option<Value> {
    let mut current = value;
    let mut rest = json_path.strip_prefix('$').unwrap_or(json_path);
    loop {
        if rest.is_empty() {
            return Some(current.clone());
        }
        if let Some(stripped) = rest.strip_prefix('.') {
            let (key, tail) = split_json_path_key(stripped);
            current = current.get(key)?;
            rest = tail;
            continue;
        }
        if let Some(stripped) = rest.strip_prefix('[') {
            let end = stripped.find(']')?;
            let index: usize = stripped[..end].trim().parse().ok()?;
            current = current.get(index)?;
            rest = &stripped[end + 1..];
            continue;
        }
        return None;
    }
}

fn split_json_path_key(rest: &str) -> (&str, &str) {
    let end = rest
        .find(|ch: char| ch == '.' || ch == '[')
        .unwrap_or(rest.len());
    (&rest[..end], &rest[end..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_json_path_reads_nested_arrays() {
        let value = json!({"tools": "not-an-array", "items": [{"name": "a"}, {"name": "b"}]});
        assert_eq!(
            resolve_v3_json_path(&value, "$.tools"),
            Some(json!("not-an-array"))
        );
        assert_eq!(
            resolve_v3_json_path(&value, "$.items[1].name"),
            Some(json!("b"))
        );
        assert_eq!(resolve_v3_json_path(&value, "$.missing"), None);
    }

    #[test]
    fn context_source_value_uses_client_original() {
        let context = V3ProjectionDropContext::new(
            "req-1",
            "8399",
            None,
            Arc::new(json!({"tools": {"unexpected": true}})),
        );
        assert_eq!(
            context.source_value_at("$.tools"),
            json!({"unexpected": true})
        );
        assert_eq!(context.source_value_at("$.absent"), Value::Null);
    }

    #[test]
    fn append_writes_one_jsonl_line_per_record() {
        let dir = std::env::temp_dir().join(format!(
            "rcc-projection-drop-unit-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        let path = dir.join("projection-drops.jsonl");
        let record = V3ProjectionDropRecord {
            request_id: "req-unit".into(),
            entry_port: "8399".into(),
            target_protocol: "openai_chat".into(),
            stage: "outbound_target_protocol_projection".into(),
            json_path: "$.tools".into(),
            reason: "non_array_tools_unrepresentable".into(),
            source_value: json!("not-an-array"),
            canonical_value: json!("not-an-array"),
            drop_site: "project_openai_chat_provider_tools_for_web_search_mode".into(),
        };
        append_v3_projection_drop_records(Some(&path.display().to_string()), &[record.clone()])
            .expect("drop log append must succeed");
        append_v3_projection_drop_records(Some(&path.display().to_string()), &[record])
            .expect("drop log append must succeed");
        let body = std::fs::read_to_string(&path).expect("drop log must be readable");
        assert_eq!(body.lines().count(), 2, "{body}");
        assert!(body.contains("\"request_id\":\"req-unit\""), "{body}");
        assert!(body.contains("\"json_path\":\"$.tools\""), "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
