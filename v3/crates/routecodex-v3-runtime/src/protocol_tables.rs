//! 协议转换查表基础设施（表用 JSON 保存）。
//!
//! 设计契约（Jason 2026-08-08）：
//! - inbound（协议 -> hub 归一化）与 outbound（hub -> 协议反向投影）的字段 / 类型 /
//!   角色 / finish_reason 映射必须以 JSON 表为真源，禁止在 codec 中手写新映射；
//! - 表数据在 `tables/*.json`，结构规范在 `tables/schema/protocol_tables.schema.json`；
//! - 加载器 include_str! + serde_json + OnceLock，加载即校验，校验失败 fail-fast；
//! - 少数无法纯数据表达的转换（折叠、状态机）用表内 `"transform": "fn_name"`
//!   引用注册函数兜底；未注册 transform 在使用时 fail-fast。
//!
//! 本模块只承载查表语义，不承载任何协议转换实现；codec 通过本模块的查询函数
//! 读取映射，禁止绕过表直接手写映射逻辑。

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};

/// 查表方向：Inbound = 协议值 -> hub 值（归一化）；Outbound = hub 值 -> 协议值（反向投影）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3TableDirection {
    Inbound,
    Outbound,
}

/// 已注册的协议转换表类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3TableKind {
    FinishReason,
    Role,
    PartType,
    Field,
    ToolChoice,
    Usage,
    RequestField,
}

impl V3TableKind {
    pub fn table_id(self) -> &'static str {
        match self {
            V3TableKind::FinishReason => "finish_reason_map",
            V3TableKind::Role => "role_map",
            V3TableKind::PartType => "part_type_map",
            V3TableKind::Field => "field_map",
            V3TableKind::ToolChoice => "tool_choice_map",
            V3TableKind::Usage => "usage_map",
            V3TableKind::RequestField => "request_field_map",
        }
    }
}

/// transform 注册函数：少数无法纯数据表达的转换（折叠、状态机）的兜底。
pub type V3TableTransform = fn(&Value) -> Result<Value, String>;

static TRANSFORM_REGISTRY: OnceLock<Mutex<HashMap<&'static str, V3TableTransform>>> =
    OnceLock::new();

fn transform_registry() -> &'static Mutex<HashMap<&'static str, V3TableTransform>> {
    TRANSFORM_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一个 transform 函数（重复注册 fail-fast）。
pub fn register_transform(name: &'static str, f: V3TableTransform) -> Result<(), String> {
    let mut registry = transform_registry()
        .lock()
        .map_err(|_| "transform registry poisoned".to_string())?;
    if registry.insert(name, f).is_some() {
        return Err(format!("transform '{name}' already registered"));
    }
    Ok(())
}

/// 执行已注册的 transform（未注册 fail-fast）。
pub fn run_transform(name: &str, value: &Value) -> Result<Value, String> {
    let registry = transform_registry()
        .lock()
        .map_err(|_| "transform registry poisoned".to_string())?;
    let f = registry
        .get(name)
        .ok_or_else(|| format!("transform '{name}' not registered"))?;
    f(value)
}

/// 校验表内 transform 引用均已注册（供红测与启动校验调用）。
pub fn validate_table_transforms() -> Result<(), String> {
    let tables = protocol_tables()?;
    for (table_id, table) in &tables.tables {
        match table {
            V3TableData::Value { rows, .. } => {
                for row in rows {
                    if let Some(transform) = &row.transform {
                        ensure_transform_registered(table_id, transform)?;
                    }
                }
            }
            V3TableData::Field { entries, .. } => {
                for entry in entries {
                    if let Some(transform) = &entry.transform {
                        ensure_transform_registered(table_id, transform)?;
                    }
                }
            }
            V3TableData::FieldWhitelist { .. } => {}
        }
    }
    Ok(())
}

fn ensure_transform_registered(table_id: &str, transform: &str) -> Result<(), String> {
    let registry = transform_registry()
        .lock()
        .map_err(|_| "transform registry poisoned".to_string())?;
    if registry.contains_key(transform) {
        Ok(())
    } else {
        Err(format!(
            "table '{table_id}' references unregistered transform '{transform}'"
        ))
    }
}

/// 一张 protocol_value_map 的行：hub 为 canonical 轴值；by_protocol 为各协议等价值；
/// direction 限定方向（None = 双向）。
#[derive(Debug, Clone)]
struct V3ValueRow {
    hub: String,
    direction: Option<V3TableDirection>,
    by_protocol: BTreeMap<String, String>,
    transform: Option<String>,
}

impl V3ValueRow {
    fn direction_matches(&self, direction: V3TableDirection) -> bool {
        match self.direction {
            None => true,
            Some(d) => d == direction,
        }
    }
}

/// 一张 bidi_field_map 的行：hub_field 与 protocol 下 protocol_field 互逆等价。
#[derive(Debug, Clone)]
struct V3FieldEntry {
    hub_field: String,
    protocol: String,
    protocol_field: String,
    transform: Option<String>,
}

#[derive(Debug)]
enum V3TableData {
    Value {
        protocols: Vec<String>,
        rows: Vec<V3ValueRow>,
    },
    Field {
        protocols: Vec<String>,
        entries: Vec<V3FieldEntry>,
    },
    FieldWhitelist {
        protocols: Vec<String>,
        /// protocol -> 允许透传的顶层字段名（字段名驻留 'static，表只加载一次）。
        whitelists: BTreeMap<String, BTreeSet<&'static str>>,
    },
}

#[derive(Debug)]
struct V3ProtocolTables {
    tables: BTreeMap<String, V3TableData>,
}

/// 表源：table_id -> JSON 文件内容（编译期嵌入）。
const TABLE_SOURCES: &[(&str, &str)] = &[
    (
        "finish_reason_map",
        include_str!("../tables/finish_reason_map.json"),
    ),
    ("role_map", include_str!("../tables/role_map.json")),
    (
        "part_type_map",
        include_str!("../tables/part_type_map.json"),
    ),
    ("field_map", include_str!("../tables/field_map.json")),
    (
        "tool_choice_map",
        include_str!("../tables/tool_choice_map.json"),
    ),
    ("usage_map", include_str!("../tables/usage_map.json")),
    (
        "request_field_map",
        include_str!("../tables/request_field_map.json"),
    ),
];

static TABLES: OnceLock<Result<V3ProtocolTables, String>> = OnceLock::new();

/// 加载并校验全部协议转换表（首次调用触发；校验失败 fail-fast 并缓存错误）。
pub fn protocol_tables() -> Result<&'static V3ProtocolTables, String> {
    match TABLES.get_or_init(load_all_tables) {
        Ok(tables) => Ok(tables),
        Err(error) => Err(error.clone()),
    }
}

fn load_all_tables() -> Result<V3ProtocolTables, String> {
    let mut tables = BTreeMap::new();
    for (table_id, source) in TABLE_SOURCES {
        let parsed: Value = serde_json::from_str(source)
            .map_err(|error| format!("table '{table_id}' is not valid JSON: {error}"))?;
        let kind = parsed
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("table '{table_id}' missing 'kind'"))?;
        let protocols = parse_protocols(table_id, &parsed)?;
        match kind {
            "protocol_value_map" => {
                let rows = validate_value_table(table_id, &protocols, &parsed)?;
                tables.insert(table_id.to_string(), V3TableData::Value { protocols, rows });
            }
            "bidi_field_map" => {
                let entries = validate_field_table(table_id, &protocols, &parsed)?;
                tables.insert(
                    table_id.to_string(),
                    V3TableData::Field { protocols, entries },
                );
            }
            "field_whitelist_map" => {
                let whitelists = validate_whitelist_table(table_id, &protocols, &parsed)?;
                tables.insert(
                    table_id.to_string(),
                    V3TableData::FieldWhitelist {
                        protocols,
                        whitelists,
                    },
                );
            }
            other => return Err(format!("table '{table_id}' has unsupported kind '{other}'")),
        }
    }
    Ok(V3ProtocolTables { tables })
}

fn parse_protocols(table_id: &str, parsed: &Value) -> Result<Vec<String>, String> {
    let protocols = parsed
        .get("protocols")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("table '{table_id}' missing 'protocols' array"))?;
    let mut seen = BTreeMap::new();
    for protocol in protocols {
        let name = protocol
            .as_str()
            .ok_or_else(|| format!("table '{table_id}' protocols entry is not a string"))?;
        if seen.insert(name.to_string(), ()).is_some() {
            return Err(format!(
                "table '{table_id}' declares duplicate protocol '{name}'"
            ));
        }
    }
    if seen.is_empty() {
        return Err(format!("table '{table_id}' declares empty protocols"));
    }
    Ok(seen.into_keys().collect())
}

/// 校验 protocol_value_map：字段合法性 + inbound 唯一性（同一协议值在 Inbound
/// 可命中的行中只能对应一个 hub；outbound 折叠 hub->协议 多对一合法）。
fn validate_value_table(
    table_id: &str,
    protocols: &[String],
    parsed: &Value,
) -> Result<Vec<V3ValueRow>, String> {
    let values = parsed
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("table '{table_id}' missing 'values' array"))?;
    let mut rows = Vec::new();
    let mut inbound_index: HashMap<(String, String), String> = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let hub = value
            .get("hub")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("table '{table_id}' values[{index}] missing 'hub'"))?;
        let direction = parse_direction(table_id, index, value)?;
        let mut by_protocol = BTreeMap::new();
        for protocol in protocols {
            if let Some(protocol_value) = value.get(protocol) {
                let protocol_value = protocol_value.as_str().ok_or_else(|| {
                    format!(
                        "table '{table_id}' values[{index}] protocol '{protocol}' is not a string"
                    )
                })?;
                by_protocol.insert(protocol.clone(), protocol_value.to_string());
            }
        }
        let transform = value
            .get("transform")
            .and_then(Value::as_str)
            .map(str::to_string);
        // inbound 唯一性：仅约束 Inbound 方向可命中的行（协议值 -> hub 必须唯一；
        // outbound 折叠是 hub -> 协议 多对一，合法）。
        if direction_matches_for_inbound(direction) {
            for (protocol, protocol_value) in &by_protocol {
                let key = (protocol.clone(), protocol_value.clone());
                if let Some(previous) = inbound_index.get(&key) {
                    return Err(format!(
                        "table '{table_id}' inbound ambiguity: protocol '{protocol}' value \
                         '{protocol_value}' maps to both hub '{previous}' and '{hub}'"
                    ));
                }
                inbound_index.insert(key, hub.to_string());
            }
        }
        rows.push(V3ValueRow {
            hub: hub.to_string(),
            direction,
            by_protocol,
            transform,
        });
    }
    if rows.is_empty() {
        return Err(format!("table '{table_id}' has empty values"));
    }
    Ok(rows)
}

/// 行是否会被 Inbound 查询命中（None = 双向，命中；Some(Inbound) 命中；
/// Some(Outbound) 不命中）。
fn direction_matches_for_inbound(direction: Option<V3TableDirection>) -> bool {
    match direction {
        None => true,
        Some(V3TableDirection::Inbound) => true,
        Some(V3TableDirection::Outbound) => false,
    }
}

/// 校验 bidi_field_map：字段合法性 + (protocol, protocol_field) 唯一。
fn validate_field_table(
    table_id: &str,
    protocols: &[String],
    parsed: &Value,
) -> Result<Vec<V3FieldEntry>, String> {
    let entries = parsed
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("table '{table_id}' missing 'entries' array"))?;
    let mut rows = Vec::new();
    let mut inbound_index: HashMap<(String, String), String> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let hub_field = entry
            .get("hub_field")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("table '{table_id}' entries[{index}] missing 'hub_field'"))?;
        let protocol = entry
            .get("protocol")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("table '{table_id}' entries[{index}] missing 'protocol'"))?;
        if !protocols.iter().any(|p| p == protocol) {
            return Err(format!(
                "table '{table_id}' entries[{index}] protocol '{protocol}' not declared in 'protocols'"
            ));
        }
        let protocol_field = entry
            .get("protocol_field")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!("table '{table_id}' entries[{index}] missing 'protocol_field'")
            })?;
        let transform = entry
            .get("transform")
            .and_then(Value::as_str)
            .map(str::to_string);
        let key = (protocol.to_string(), protocol_field.to_string());
        if let Some(previous) = inbound_index.get(&key) {
            return Err(format!(
                "table '{table_id}' inbound ambiguity: protocol '{protocol}' field \
                 '{protocol_field}' maps to both '{previous}' and '{hub_field}'"
            ));
        }
        inbound_index.insert(key, hub_field.to_string());
        rows.push(V3FieldEntry {
            hub_field: hub_field.to_string(),
            protocol: protocol.to_string(),
            protocol_field: protocol_field.to_string(),
            transform,
        });
    }
    if rows.is_empty() {
        return Err(format!("table '{table_id}' has empty entries"));
    }
    Ok(rows)
}

/// 校验 field_whitelist_map：protocol key 必须在声明中；每协议字段数组非空且去重。
fn validate_whitelist_table(
    table_id: &str,
    protocols: &[String],
    parsed: &Value,
) -> Result<BTreeMap<String, BTreeSet<&'static str>>, String> {
    let whitelists = parsed
        .get("whitelists")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("table '{table_id}' missing 'whitelists' object"))?;
    let mut output: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    for (protocol, fields) in whitelists {
        if !protocols.iter().any(|p| p == protocol) {
            return Err(format!(
                "table '{table_id}' whitelist protocol '{protocol}' not declared in 'protocols'"
            ));
        }
        let fields = fields
            .as_array()
            .ok_or_else(|| format!("table '{table_id}' whitelist '{protocol}' is not an array"))?;
        if fields.is_empty() {
            return Err(format!(
                "table '{table_id}' whitelist '{protocol}' is empty"
            ));
        }
        let mut set = BTreeSet::new();
        for field in fields {
            let field = field.as_str().ok_or_else(|| {
                format!("table '{table_id}' whitelist '{protocol}' entry is not a string")
            })?;
            // 字段名驻留 'static：表只加载一次，进程存活期内有效。
            let leaked: &'static str = Box::leak(field.to_string().into_boxed_str());
            set.insert(leaked);
        }
        output.insert(protocol.clone(), set);
    }
    Ok(output)
}

fn parse_direction(
    table_id: &str,
    index: usize,
    value: &Value,
) -> Result<Option<V3TableDirection>, String> {
    match value.get("direction").and_then(Value::as_str) {
        None => Ok(None),
        Some("inbound") => Ok(Some(V3TableDirection::Inbound)),
        Some("outbound") => Ok(Some(V3TableDirection::Outbound)),
        Some(other) => Err(format!(
            "table '{table_id}' values[{index}] has invalid direction '{other}'"
        )),
    }
}

impl V3ProtocolTables {
    /// 值映射查询。
    ///
    /// - Inbound：协议值 -> hub 值（查表归一化）；未命中返回 Ok(None)。
    /// - Outbound：hub 值 -> 协议值（反向投影）；协议列缺省（该协议不支持此 hub
    ///   值）返回 Ok(None)。
    pub fn map_value(
        &self,
        kind: V3TableKind,
        protocol: &str,
        value: &str,
        direction: V3TableDirection,
    ) -> Result<Option<&str>, String> {
        let table_id = kind.table_id();
        let table = self
            .tables
            .get(table_id)
            .ok_or_else(|| format!("table '{table_id}' not loaded"))?;
        let V3TableData::Value { rows, .. } = table else {
            return Err(format!("table '{table_id}' is not a value map"));
        };
        match direction {
            V3TableDirection::Inbound => {
                for row in rows {
                    if let Some(protocol_value) = row.by_protocol.get(protocol) {
                        if protocol_value == value && row.direction_matches(direction) {
                            return Ok(Some(&row.hub));
                        }
                    }
                }
                Ok(None)
            }
            V3TableDirection::Outbound => {
                for row in rows {
                    if row.hub == value && row.direction_matches(direction) {
                        return Ok(row.by_protocol.get(protocol).map(String::as_str));
                    }
                }
                Ok(None)
            }
        }
    }

    /// 字段映射查询（bidi_field_map）。
    ///
    /// - Inbound：协议字段 -> hub 字段。
    /// - Outbound：hub 字段 -> 协议字段。
    pub fn map_field(
        &self,
        protocol: &str,
        field: &str,
        direction: V3TableDirection,
    ) -> Result<Option<&str>, String> {
        let table = self
            .tables
            .get(V3TableKind::Field.table_id())
            .ok_or_else(|| format!("table '{}' not loaded", V3TableKind::Field.table_id()))?;
        let V3TableData::Field { entries, .. } = table else {
            return Err("table 'field_map' is not a field map".to_string());
        };
        match direction {
            V3TableDirection::Inbound => {
                for entry in entries {
                    if entry.protocol == protocol && entry.protocol_field == field {
                        return Ok(Some(&entry.hub_field));
                    }
                }
                Ok(None)
            }
            V3TableDirection::Outbound => {
                for entry in entries {
                    if entry.protocol == protocol && entry.hub_field == field {
                        return Ok(Some(&entry.protocol_field));
                    }
                }
                Ok(None)
            }
        }
    }

    /// 顶层字段白名单查询（field_whitelist_map）：字段是否允许向该协议透传。
    pub fn is_whitelisted(&self, protocol: &str, field: &str) -> Result<bool, String> {
        let table = self
            .tables
            .get(V3TableKind::RequestField.table_id())
            .ok_or_else(|| {
                format!(
                    "table '{}' not loaded",
                    V3TableKind::RequestField.table_id()
                )
            })?;
        let V3TableData::FieldWhitelist { whitelists, .. } = table else {
            return Err("table 'request_field_map' is not a whitelist map".to_string());
        };
        Ok(whitelists
            .get(protocol)
            .map(|fields| fields.contains(field))
            .unwrap_or(false))
    }

    /// 顶层字段白名单查询：返回某协议的全部允许字段（'static，表驻留进程）。
    pub fn whitelisted_fields(&self, protocol: &str) -> Result<BTreeSet<&'static str>, String> {
        let table = self
            .tables
            .get(V3TableKind::RequestField.table_id())
            .ok_or_else(|| {
                format!(
                    "table '{}' not loaded",
                    V3TableKind::RequestField.table_id()
                )
            })?;
        let V3TableData::FieldWhitelist { whitelists, .. } = table else {
            return Err("table 'request_field_map' is not a whitelist map".to_string());
        };
        whitelists
            .get(protocol)
            .cloned()
            .ok_or_else(|| format!("protocol '{protocol}' has no whitelist"))
    }
}

/// 便捷查询：值映射（见 [`V3ProtocolTables::map_value`]）。
pub fn map_value(
    kind: V3TableKind,
    protocol: &str,
    value: &str,
    direction: V3TableDirection,
) -> Result<Option<&'static str>, String> {
    protocol_tables()?.map_value(kind, protocol, value, direction)
}

/// 便捷查询：字段映射（见 [`V3ProtocolTables::map_field`]）。
pub fn map_field(
    protocol: &str,
    field: &str,
    direction: V3TableDirection,
) -> Result<Option<&'static str>, String> {
    protocol_tables()?.map_field(protocol, field, direction)
}

/// 便捷查询：顶层字段是否允许向协议透传（见 [`V3ProtocolTables::is_whitelisted`]）。
pub fn is_whitelisted(protocol: &str, field: &str) -> Result<bool, String> {
    protocol_tables()?.is_whitelisted(protocol, field)
}

/// 便捷查询：返回协议的全部允许透传字段（见 [`V3ProtocolTables::whitelisted_fields`]）。
pub fn whitelisted_fields(
    protocol: &str,
) -> Result<std::collections::BTreeSet<&'static str>, String> {
    protocol_tables()?.whitelisted_fields(protocol)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_or_panic() -> &'static V3ProtocolTables {
        match protocol_tables() {
            Ok(tables) => tables,
            Err(error) => panic!("protocol tables failed to load: {error}"),
        }
    }

    #[test]
    fn all_tables_load() {
        let tables = load_or_panic();
        assert_eq!(tables.tables.len(), TABLE_SOURCES.len());
        for (table_id, _) in TABLE_SOURCES {
            assert!(
                tables.tables.contains_key(*table_id),
                "table {table_id} missing"
            );
        }
    }

    #[test]
    fn finish_reason_bidi_mapping() {
        let tables = load_or_panic();
        // inbound：协议值 -> hub
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "openai_chat",
                    "stop",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("stop")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "openai_chat",
                    "length",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("max_tokens")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "anthropic",
                    "tool_use",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("tool_calls")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "responses",
                    "requires_action",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("tool_calls")
        );
        // outbound：hub -> 协议值
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "responses",
                    "stop",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("end_turn")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "openai_chat",
                    "max_tokens",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("length")
        );
        // 未命中
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::FinishReason,
                    "openai_chat",
                    "unknown_reason",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn role_mapping_and_unsupported_protocol_value() {
        let tables = load_or_panic();
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::Role,
                    "openai_chat",
                    "developer",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("developer")
        );
        // anthropic 无 developer role：outbound 应返回 None（需 transform 折叠兜底）
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::Role,
                    "anthropic",
                    "developer",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            None
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::Role,
                    "anthropic",
                    "system",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("system")
        );
    }

    #[test]
    fn part_type_direction_isolation() {
        let tables = load_or_panic();
        // 请求侧归一化：openai_chat text part -> hub input_text
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::PartType,
                    "openai_chat",
                    "text",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("input_text")
        );
        // 响应侧投影：hub text -> responses output_text
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::PartType,
                    "responses",
                    "text",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("output_text")
        );
        // 方向隔离：hub text 在 inbound 方向不存在（无该行）
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::PartType,
                    "responses",
                    "text",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            None
        );
        // reasoning：responses 无原生列 -> outbound None；anthropic -> thinking
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::PartType,
                    "responses",
                    "reasoning",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("reasoning")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::PartType,
                    "anthropic",
                    "reasoning",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("thinking")
        );
    }

    #[test]
    fn field_bidi_mapping() {
        let tables = load_or_panic();
        assert_eq!(
            tables
                .map_field("openai_chat", "id", V3TableDirection::Inbound)
                .unwrap(),
            Some("responses_item_id")
        );
        assert_eq!(
            tables
                .map_field(
                    "openai_chat",
                    "responses_item_id",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("id")
        );
        assert_eq!(
            tables
                .map_field("openai_chat", "unknown_field", V3TableDirection::Inbound)
                .unwrap(),
            None
        );
    }

    #[test]
    fn inbound_ambiguity_is_rejected() {
        let json = r#"{
            "table_id": "bad_map",
            "kind": "protocol_value_map",
            "protocols": ["openai_chat"],
            "values": [
                {"hub": "system", "openai_chat": "system"},
                {"hub": "developer", "openai_chat": "system"}
            ]
        }"#;
        let parsed: Value = serde_json::from_str(json).unwrap();
        let error = validate_value_table("bad_map", &["openai_chat".to_string()], &parsed)
            .expect_err("inbound ambiguity must be rejected");
        assert!(
            error.contains("inbound ambiguity"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn field_ambiguity_is_rejected() {
        let json = r#"{
            "table_id": "bad_field_map",
            "kind": "bidi_field_map",
            "protocols": ["openai_chat"],
            "entries": [
                {"hub_field": "a", "protocol": "openai_chat", "protocol_field": "x"},
                {"hub_field": "b", "protocol": "openai_chat", "protocol_field": "x"}
            ]
        }"#;
        let parsed: Value = serde_json::from_str(json).unwrap();
        let error = validate_field_table("bad_field_map", &["openai_chat".to_string()], &parsed)
            .expect_err("field ambiguity must be rejected");
        assert!(
            error.contains("inbound ambiguity"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn tool_choice_bidi_mapping() {
        let tables = load_or_panic();
        // inbound：协议值 -> hub
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "responses",
                    "auto",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("auto")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "anthropic",
                    "any",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("required")
        );
        // responses function/tool/custom 均归一化为 hub tool
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "responses",
                    "function",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("tool")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "responses",
                    "custom",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("tool")
        );
        // outbound：hub -> 协议值
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "anthropic",
                    "required",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("any")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::ToolChoice,
                    "anthropic",
                    "tool",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("tool")
        );
    }

    #[test]
    fn usage_same_name_mapping() {
        let tables = load_or_panic();
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::Usage,
                    "responses",
                    "input_tokens",
                    V3TableDirection::Inbound
                )
                .unwrap(),
            Some("input_tokens")
        );
        assert_eq!(
            tables
                .map_value(
                    V3TableKind::Usage,
                    "anthropic",
                    "output_tokens",
                    V3TableDirection::Outbound
                )
                .unwrap(),
            Some("output_tokens")
        );
    }

    #[test]
    fn request_field_whitelist_mapping() {
        let tables = load_or_panic();
        // 白名单查询
        assert!(
            tables.is_whitelisted("responses", "model").unwrap(),
            "responses model must be whitelisted"
        );
        assert!(tables
            .is_whitelisted("openai_chat", "max_completion_tokens")
            .unwrap());
        assert!(tables
            .is_whitelisted("anthropic", "stop_sequences")
            .unwrap());
        assert!(tables
            .is_whitelisted("gemini", "systemInstruction")
            .unwrap());
        // 非白名单字段
        assert!(!tables.is_whitelisted("responses", "no_such_field").unwrap());
        // 未声明的协议 -> false（不 panic）
        assert!(!tables.is_whitelisted("unknown_protocol", "model").unwrap());
        // whitelisted_fields 与 is_whitelisted 一致
        let responses_fields = tables.whitelisted_fields("responses").unwrap();
        assert!(responses_fields.contains("input"));
        assert!(responses_fields.contains("web_search_options"));
        // anthropic 白名单曾含重复 "user"：BTreeSet 去重后仍可查询
        assert!(tables.is_whitelisted("anthropic", "user").unwrap());
    }

    #[test]
    fn transform_registry_lifecycle() {
        let name: &'static str = "test_transform_identity";
        let _ = register_transform(name, |value| Ok(value.clone()));
        let result = run_transform(name, &serde_json::json!({"a": 1}));
        assert_eq!(result.unwrap(), serde_json::json!({"a": 1}));
        // 重复注册 fail-fast
        let duplicate = register_transform(name, |value| Ok(value.clone()));
        assert!(duplicate.is_err());
        // 未注册 fail-fast
        let missing = run_transform("no_such_transform", &serde_json::json!(1));
        assert!(missing.is_err());
    }
}
