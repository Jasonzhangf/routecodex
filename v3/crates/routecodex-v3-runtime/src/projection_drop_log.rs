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
    /// 丢弃落盘时刻（Unix epoch 毫秒）。由 `emit`（唯一的 PRINT + append owner）
    /// 盖章，因此任何入口都不会产出无时间戳的记录。
    #[serde(default)]
    pub ts: u64,
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
    /// stage-3 投影站点使用的唯一构造函数：只填现场可得的字段。
    ///
    /// 请求身份（`request_id` / `entry_port` / 客户端原样 `source_value`）由请求
    /// 作用域在 `restamp_and_emit` 补齐，`ts` 由 `emit` 盖章；因此投影链不必穿参
    /// 请求上下文，同时任何入口都不会出现「算出丢弃但不落盘」的静默缺口。
    pub fn new(
        target_protocol: impl Into<String>,
        json_path: impl Into<String>,
        reason: impl Into<String>,
        canonical_value: Value,
        drop_site: impl Into<String>,
    ) -> Self {
        Self {
            ts: 0,
            request_id: String::new(),
            entry_port: String::new(),
            target_protocol: target_protocol.into(),
            stage: V3_PROJECTION_DROP_STAGE3.to_string(),
            json_path: json_path.into(),
            reason: reason.into(),
            source_value: Value::Null,
            canonical_value,
            drop_site: drop_site.into(),
        }
    }

    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| {
            format!("{{\"error\":\"projection drop record serialization failed: {error}\"}}")
        })
    }
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

    /// PRINT 每条丢弃记录，并在配置了日志路径时 append 到独立 JSONL 文件。
    ///
    /// `ts` 在这里盖章：`emit` 是唯一的 PRINT + append owner，因此无论哪个入口
    /// 产出记录，都不会出现缺时间戳的行。
    pub fn emit(&self, records: &mut [V3ProjectionDropRecord]) {
        if records.is_empty() {
            return;
        }
        let now_ms = v3_projection_drop_now_epoch_ms();
        for record in records.iter_mut() {
            record.ts = now_ms;
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

/// 丢弃记录的 `ts` 真源：Unix epoch 毫秒（与项目其它 epoch_ms 字段一致）。
fn v3_projection_drop_now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// JSON path 段：对象成员或数组下标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3JsonPathSegment {
    Key(String),
    Index(usize),
}

/// 把 `$.key` / `.key` / `["quoted key"]` / `[0]` 组合解析成段序列。
///
/// 与 `json_path_child` 的产出形态一一对应（裸标识符走 `.key`，含非
/// `[A-Za-z0-9_]` 字符的键走 `["..."]`），因此丢弃站点产出的路径一定可以被
/// 读回（`source_value`/`canonical_value`）并移除（真正的 drop）。
pub fn split_v3_json_path(json_path: &str) -> Option<Vec<V3JsonPathSegment>> {
    let mut segments = Vec::new();
    let mut rest = json_path.strip_prefix('$').unwrap_or(json_path);
    loop {
        if rest.is_empty() {
            return Some(segments);
        }
        if let Some(stripped) = rest.strip_prefix('.') {
            let end = stripped
                .find(|ch: char| ch == '.' || ch == '[')
                .unwrap_or(stripped.len());
            let key = &stripped[..end];
            if key.is_empty() {
                return None;
            }
            segments.push(V3JsonPathSegment::Key(key.to_string()));
            rest = &stripped[end..];
            continue;
        }
        if let Some(stripped) = rest.strip_prefix('[') {
            let (token, tail) = split_v3_json_path_bracket(stripped)?;
            rest = tail;
            if token.starts_with('"') {
                segments.push(V3JsonPathSegment::Key(serde_json::from_str(token).ok()?));
            } else {
                segments.push(V3JsonPathSegment::Index(token.parse().ok()?));
            }
            continue;
        }
        return None;
    }
}

/// 从 `[` 之后的内容里切出括号内 token 及其后的剩余路径。
///
/// 引号形式按 JSON 字符串语义扫描：`\` 转义后的字符（含 `]` 和 `"`）属于 token
/// 内容，不是结束符。`json_path_child` 用 `serde_json::to_string` 渲染非标识符
/// 键，而 JSON 转义不会转义 `]`，所以 `weird]key` 会产出 `$["weird]key"]`；只有
/// 按字符串语义扫描才能把它原样解析回来，从而保证「记录到的丢弃一定真的丢弃」。
fn split_v3_json_path_bracket(stripped: &str) -> Option<(&str, &str)> {
    if !stripped.starts_with('"') {
        let end = stripped.find(']')?;
        return Some((&stripped[..end], &stripped[end + 1..]));
    }
    let mut escaped = false;
    for (offset, ch) in stripped.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => {
                let token_end = offset + ch.len_utf8();
                let tail = stripped[token_end..].strip_prefix(']')?;
                return Some((&stripped[..token_end], tail));
            }
            _ => {}
        }
    }
    None
}

/// 最小 JSON path 读取，支持 `$.key`、`.key`、`["key"]`、`[index]` 组合。
pub fn resolve_v3_json_path(value: &Value, json_path: &str) -> Option<Value> {
    let mut current = value;
    for segment in split_v3_json_path(json_path)? {
        current = match segment {
            V3JsonPathSegment::Key(key) => current.get(key)?,
            V3JsonPathSegment::Index(index) => current.get(index)?,
        };
    }
    Some(current.clone())
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
    fn resolve_json_path_reads_quoted_and_indexed_segments() {
        // `json_path_child` emits `["..."]` for keys that are not bare
        // identifiers; those paths must still be readable.
        let value = json!({"x-foo": 1, "a.b": {"c": 2}, "arr": ["z"]});
        assert_eq!(resolve_v3_json_path(&value, "$[\"x-foo\"]"), Some(json!(1)));
        assert_eq!(resolve_v3_json_path(&value, "$[\"a.b\"].c"), Some(json!(2)));
        assert_eq!(resolve_v3_json_path(&value, "$.arr[0]"), Some(json!("z")));
        assert_eq!(
            split_v3_json_path("$[\"x-foo\"]"),
            Some(vec![V3JsonPathSegment::Key("x-foo".to_string())])
        );
        assert_eq!(
            split_v3_json_path("$.arr[0]"),
            Some(vec![
                V3JsonPathSegment::Key("arr".to_string()),
                V3JsonPathSegment::Index(0)
            ])
        );
        assert_eq!(split_v3_json_path("$"), Some(Vec::new()));
        assert_eq!(split_v3_json_path("$[\"unterminated]"), None);
    }

    #[test]
    fn resolve_json_path_round_trips_keys_with_brackets_and_quotes() {
        // JSON string escaping does not escape `]`, so `json_path_child` emits
        // `$["weird]key"]` for such a key. The bracket scan must honour string
        // semantics, otherwise the drop is recorded but never removed.
        let value = json!({"weird]key": 1, "quo\"te": 2, "back\\slash": 3});
        assert_eq!(
            resolve_v3_json_path(&value, "$[\"weird]key\"]"),
            Some(json!(1))
        );
        assert_eq!(
            resolve_v3_json_path(&value, "$[\"quo\\\"te\"]"),
            Some(json!(2))
        );
        assert_eq!(
            resolve_v3_json_path(&value, "$[\"back\\\\slash\"]"),
            Some(json!(3))
        );
        // An index after a bracket-quoted key still parses.
        let nested = json!({"weird]key": {"arr": ["z"]}});
        assert_eq!(
            resolve_v3_json_path(&nested, "$[\"weird]key\"].arr[0]"),
            Some(json!("z"))
        );
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
    fn restamp_and_emit_fills_identity_and_client_original() {
        // `emit` alone stamps only `ts`. Production must use `restamp_and_emit`
        // or the persisted line carries an empty request id, an empty entry
        // port and a null client original.
        let context = V3ProjectionDropContext::new(
            "req-1",
            "8399",
            None,
            Arc::new(json!({"x-vendor-flag": true})),
        );
        let mut records = vec![V3ProjectionDropRecord::new(
            "responses",
            "$[\"x-vendor-flag\"]",
            "unmapped_target_protocol_field_unrepresentable",
            json!(true),
            "test",
        )];
        context.restamp_and_emit(&mut records);
        assert_eq!(records[0].request_id, "req-1");
        assert_eq!(records[0].entry_port, "8399");
        assert_eq!(records[0].source_value, json!(true));
        assert!(
            records[0].ts > 1_700_000_000_000,
            "restamp must also stamp ts"
        );
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
        let mut record = V3ProjectionDropRecord::new(
            "openai_chat",
            "$.tools",
            "non_array_tools_unrepresentable",
            json!("not-an-array"),
            "project_openai_chat_provider_tools_for_web_search_mode",
        );
        record.ts = 1_700_000_000_000;
        record.request_id = "req-unit".into();
        record.entry_port = "8399".into();
        record.source_value = json!("not-an-array");
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
