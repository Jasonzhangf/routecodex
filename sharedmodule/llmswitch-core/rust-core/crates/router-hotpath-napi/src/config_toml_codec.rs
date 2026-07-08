// feature_id: config.toml_codec
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone)]
struct CollectionState {
    square_depth: i32,
    brace_depth: i32,
    in_string: bool,
    escape: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TomlStringScalarPatchInput {
    raw: String,
    #[serde(default)]
    table_path: Vec<String>,
    key: String,
    value: String,
}

pub fn parse_toml_record_json(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Ok("{}".to_string());
    }
    let json = parse_toml_record_lenient(raw)?;
    serde_json::to_string(&json)
        .map_err(|err| format!("[config] failed to encode parsed TOML: {err}"))
}

pub fn serialize_toml_record_json(record_json: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(record_json)
        .map_err(|err| format!("[config] invalid TOML record JSON: {err}"))?;
    let Value::Object(map) = parsed else {
        return Err("[config] TOML serializer expects an object root".to_string());
    };
    let value = json_object_to_toml_value(map)?;
    toml::to_string(&value)
        .map_err(|err| format!("[config] failed to serialize TOML record: {err}"))
}

pub fn update_toml_string_scalar_in_table_json(input_json: &str) -> Result<String, String> {
    let input: TomlStringScalarPatchInput = serde_json::from_str(input_json)
        .map_err(|err| format!("[config] invalid TOML scalar patch input: {err}"))?;
    update_toml_string_scalar_in_table(&input.raw, &input.table_path, &input.key, &input.value)
}

fn update_toml_string_scalar_in_table(
    raw: &str,
    table_path: &[String],
    key: &str,
    value: &str,
) -> Result<String, String> {
    let mut lines: Vec<String> = raw
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    let serialized_value = serde_json::to_string(value)
        .map_err(|err| format!("[config] failed to serialize TOML string scalar: {err}"))?;

    if table_path.is_empty() {
        let root_end = lines
            .iter()
            .position(|line| {
                let trimmed = line.trim();
                trimmed.starts_with('[') && trimmed.ends_with(']')
            })
            .unwrap_or(lines.len());
        for index in 0..root_end {
            if let Some(replaced) = replace_toml_scalar_line(&lines[index], key, &serialized_value)
            {
                lines[index] = replaced;
                return Ok(lines.join("\n"));
            }
        }
        let mut insert_at = 0;
        while insert_at < root_end && lines[insert_at].trim().is_empty() {
            insert_at += 1;
        }
        lines.insert(insert_at, format!("{key} = {serialized_value}"));
        return Ok(lines.join("\n"));
    }

    let mut target_table_found = false;
    let mut target_table_start = 0usize;
    let mut target_table_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
            continue;
        }
        if trimmed.starts_with("[[") && trimmed.ends_with("]]") {
            continue;
        }
        let parsed_path =
            parse_table_path(trimmed.trim_start_matches('[').trim_end_matches(']').trim())?;
        if target_table_found {
            target_table_end = index;
            break;
        }
        if parsed_path == table_path {
            target_table_found = true;
            target_table_start = index;
        }
    }

    if !target_table_found {
        let suffix = if !lines.is_empty() && lines.last().is_some_and(|line| line.is_empty()) {
            ""
        } else {
            "\n"
        };
        let header = format!("[{}]", table_path.join("."));
        return Ok(format!(
            "{raw}{suffix}\n{header}\n{key} = {serialized_value}\n"
        ));
    }

    for index in (target_table_start + 1)..target_table_end {
        if let Some(replaced) = replace_toml_scalar_line(&lines[index], key, &serialized_value) {
            lines[index] = replaced;
            let mut out = lines.join("\n");
            if !raw.ends_with('\n') {
                out.push('\n');
            }
            while out.ends_with("\n\n\n") {
                out.pop();
            }
            return Ok(out);
        }
    }

    lines.insert(target_table_end, format!("{key} = {serialized_value}"));
    let mut out = lines.join("\n");
    if !raw.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn parse_table_path(raw_header: &str) -> Result<Vec<String>, String> {
    split_top_level(raw_header, '.')
        .into_iter()
        .map(|segment| segment.trim().to_string())
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            if segment.starts_with('"') && segment.ends_with('"') {
                serde_json::from_str(&segment).map_err(|err| {
                    format!("[config] invalid quoted TOML table path segment: {err}")
                })
            } else {
                Ok(segment)
            }
        })
        .collect()
}

fn replace_toml_scalar_line(line: &str, key: &str, serialized_value: &str) -> Option<String> {
    let trimmed_start = line.trim_start();
    let leading_len = line.len().saturating_sub(trimmed_start.len());
    if !trimmed_start.starts_with(key) {
        return None;
    }
    let after_key = &trimmed_start[key.len()..];
    let after_key_trimmed = after_key.trim_start();
    if !after_key_trimmed.starts_with('=') {
        return None;
    }
    let eq_leading = after_key.len().saturating_sub(after_key_trimmed.len());
    let after_eq = &after_key_trimmed[1..];
    let after_eq_leading = after_eq.len().saturating_sub(after_eq.trim_start().len());
    let value_and_comment = after_eq.trim_start();
    let suffix = match find_comment_start(value_and_comment) {
        Some(comment_start) => {
            let suffix_start = value_and_comment[..comment_start]
                .char_indices()
                .rev()
                .find_map(|(index, ch)| {
                    if ch.is_whitespace() {
                        None
                    } else {
                        Some(index + ch.len_utf8())
                    }
                })
                .unwrap_or(0);
            &value_and_comment[suffix_start..]
        }
        None => "",
    };
    let before = format!(
        "{}{}{}={}",
        &line[..leading_len],
        key,
        " ".repeat(eq_leading),
        " ".repeat(after_eq_leading)
    );
    Some(format!("{before}{serialized_value}{suffix}"))
}

fn find_comment_start(input: &str) -> Option<usize> {
    let mut in_string = false;
    let mut escape = false;
    for (index, ch) in input.char_indices() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '#' {
            return Some(index);
        }
    }
    None
}

fn parse_toml_record_lenient(raw: &str) -> Result<Value, String> {
    let mut root = Value::Object(Map::new());
    let mut current_path: Vec<String> = Vec::new();
    let lines: Vec<&str> = raw.lines().collect();
    let mut index = 0usize;

    while index < lines.len() {
        let line_number = index + 1;
        let mut line = strip_toml_comment(lines[index]);
        index += 1;
        if line.is_empty() {
            continue;
        }

        if line.starts_with("[[") && line.ends_with("]]") {
            let path =
                parse_table_path(line.trim_start_matches("[[").trim_end_matches("]]").trim())?;
            ensure_header_target(&mut root, &path, true)
                .map_err(|err| format!("{err} at line {line_number}"))?;
            current_path = path;
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            let path = parse_table_path(line.trim_start_matches('[').trim_end_matches(']').trim())?;
            ensure_header_target(&mut root, &path, false)
                .map_err(|err| format!("{err} at line {line_number}"))?;
            current_path = path;
            continue;
        }

        let Some(eq) = line.find('=') else {
            return Err(format!(
                "[config] invalid TOML assignment \"{line}\" at line {line_number}"
            ));
        };
        if eq == 0 {
            return Err(format!(
                "[config] invalid TOML assignment \"{line}\" at line {line_number}"
            ));
        }

        let key_path = parse_table_path(line[..eq].trim())?;
        let mut value_raw = line[(eq + 1)..].trim().to_string();
        let mut collection_state = create_collection_state();
        advance_collection_state(&mut collection_state, &value_raw);
        while !is_collection_balanced(&collection_state) {
            if index >= lines.len() {
                return Err(format!(
                    "[config] unterminated TOML collection for key \"{}\"",
                    key_path.join(".")
                ));
            }
            let next_line = strip_toml_comment(lines[index]);
            index += 1;
            if next_line.is_empty() {
                continue;
            }
            value_raw.push(' ');
            value_raw.push_str(&next_line);
            advance_collection_state(&mut collection_state, &next_line);
        }

        let value = parse_toml_value_lenient(&value_raw)?;
        assign_value_at_current_path(&mut root, &current_path, &key_path, value)
            .map_err(|err| format!("{err} at line {line_number}"))?;
    }

    Ok(root)
}

fn strip_toml_comment(raw: &str) -> String {
    let mut out = String::new();
    let mut in_string = false;
    let mut escape = false;
    for ch in raw.trim_end_matches('\r').chars() {
        if in_string {
            out.push(ch);
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        if ch == '#' {
            break;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn create_collection_state() -> CollectionState {
    CollectionState {
        square_depth: 0,
        brace_depth: 0,
        in_string: false,
        escape: false,
    }
}

fn advance_collection_state(state: &mut CollectionState, input: &str) {
    for ch in input.chars() {
        if state.in_string {
            if state.escape {
                state.escape = false;
                continue;
            }
            if ch == '\\' {
                state.escape = true;
                continue;
            }
            if ch == '"' {
                state.in_string = false;
            }
            continue;
        }
        if ch == '"' {
            state.in_string = true;
            continue;
        }
        if ch == '[' {
            state.square_depth += 1;
            continue;
        }
        if ch == ']' {
            state.square_depth -= 1;
            continue;
        }
        if ch == '{' {
            state.brace_depth += 1;
            continue;
        }
        if ch == '}' {
            state.brace_depth -= 1;
        }
    }
}

fn is_collection_balanced(state: &CollectionState) -> bool {
    !state.in_string && state.square_depth == 0 && state.brace_depth == 0
}

fn split_top_level(input: &str, delimiter: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut state = create_collection_state();
    for ch in input.chars() {
        if state.in_string {
            current.push(ch);
            if state.escape {
                state.escape = false;
                continue;
            }
            if ch == '\\' {
                state.escape = true;
                continue;
            }
            if ch == '"' {
                state.in_string = false;
            }
            continue;
        }
        if ch == '"' {
            state.in_string = true;
            current.push(ch);
            continue;
        }
        if ch == '[' {
            state.square_depth += 1;
        } else if ch == ']' {
            state.square_depth -= 1;
        } else if ch == '{' {
            state.brace_depth += 1;
        } else if ch == '}' {
            state.brace_depth -= 1;
        }
        if ch == delimiter && state.square_depth == 0 && state.brace_depth == 0 {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
            current.clear();
            continue;
        }
        current.push(ch);
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    parts
}

fn parse_toml_value_lenient(raw: &str) -> Result<Value, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("[config] invalid empty TOML value".to_string());
    }
    if value.starts_with('"') && value.ends_with('"') {
        let parsed: String = serde_json::from_str(value)
            .map_err(|err| format!("[config] invalid TOML string: {err}"))?;
        return Ok(Value::String(parsed));
    }
    if value == "true" {
        return Ok(Value::Bool(true));
    }
    if value == "false" {
        return Ok(Value::Bool(false));
    }
    if let Ok(integer) = value.parse::<i64>() {
        if value.chars().all(|ch| ch == '-' || ch.is_ascii_digit()) {
            return Ok(Value::Number(Number::from(integer)));
        }
    }
    if value.contains('.') {
        if let Ok(float) = value.parse::<f64>() {
            if let Some(number) = Number::from_f64(float) {
                return Ok(Value::Number(number));
            }
        }
    }
    if value.starts_with('[') && value.ends_with(']') {
        let body = value[1..value.len() - 1].trim();
        if body.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let mut values = Vec::new();
        for entry in split_top_level(body, ',') {
            values.push(parse_toml_value_lenient(&entry)?);
        }
        return Ok(Value::Array(values));
    }
    if value.starts_with('{') && value.ends_with('}') {
        return parse_inline_table_lenient(value);
    }
    Err(format!("[config] unsupported TOML value \"{value}\""))
}

fn parse_inline_table_lenient(raw: &str) -> Result<Value, String> {
    let body = raw[1..raw.len() - 1].trim();
    let mut record = Value::Object(Map::new());
    if body.is_empty() {
        return Ok(record);
    }
    for entry in split_top_level(body, ',') {
        let Some(eq) = entry.find('=') else {
            return Err(format!(
                "[config] invalid TOML inline table entry \"{entry}\""
            ));
        };
        if eq == 0 {
            return Err(format!(
                "[config] invalid TOML inline table entry \"{entry}\""
            ));
        }
        let key_path = parse_table_path(entry[..eq].trim())?;
        let value = parse_toml_value_lenient(entry[(eq + 1)..].trim())?;
        assign_value_to_object_path(&mut record, &key_path, value)?;
    }
    Ok(record)
}

fn ensure_header_target(
    root: &mut Value,
    path: &[String],
    as_array_table: bool,
) -> Result<(), String> {
    let mut cursor = root;
    for (index, segment) in path.iter().enumerate() {
        let is_leaf = index == path.len() - 1;
        if is_leaf && as_array_table {
            cursor = ensure_child_array_table(cursor, segment)?;
            continue;
        }
        cursor = ensure_child_record(cursor, segment)?;
    }
    Ok(())
}

fn ensure_child_record<'a>(parent: &'a mut Value, key: &str) -> Result<&'a mut Value, String> {
    let Value::Object(map) = parent else {
        return Err(format!(
            "[config] TOML path \"{key}\" collides with a non-object value"
        ));
    };
    let entry = map
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if entry.is_array() {
        let Value::Array(items) = entry else {
            unreachable!();
        };
        let Some(last) = items.last_mut() else {
            return Err(format!(
                "[config] TOML path \"{key}\" points to an empty array-table"
            ));
        };
        if !last.is_object() {
            return Err(format!(
                "[config] TOML path \"{key}\" points to an invalid array-table entry"
            ));
        }
        return Ok(last);
    }
    if !entry.is_object() {
        return Err(format!(
            "[config] TOML path \"{key}\" collides with a non-object value"
        ));
    }
    Ok(entry)
}

fn ensure_child_array_table<'a>(parent: &'a mut Value, key: &str) -> Result<&'a mut Value, String> {
    let Value::Object(map) = parent else {
        return Err(format!(
            "[config] TOML array-table \"{key}\" collides with a non-object value"
        ));
    };
    let entry = map
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Value::Array(items) = entry else {
        return Err(format!(
            "[config] TOML array-table \"{key}\" collides with a non-array value"
        ));
    };
    items.push(Value::Object(Map::new()));
    let last = items
        .last_mut()
        .ok_or_else(|| format!("[config] TOML array-table \"{key}\" failed to create entry"))?;
    Ok(last)
}

fn assign_value_at_current_path(
    root: &mut Value,
    current_path: &[String],
    key_path: &[String],
    value: Value,
) -> Result<(), String> {
    let mut cursor = root;
    for segment in current_path {
        cursor = ensure_child_record(cursor, segment)?;
    }
    assign_value_to_object_path(cursor, key_path, value)
}

fn assign_value_to_object_path(
    target: &mut Value,
    key_path: &[String],
    value: Value,
) -> Result<(), String> {
    if key_path.is_empty() {
        return Err("[config] TOML assignment key path cannot be empty".to_string());
    }
    let mut cursor = target;
    for segment in &key_path[..key_path.len() - 1] {
        cursor = ensure_child_record(cursor, segment)?;
    }
    let Value::Object(map) = cursor else {
        return Err("[config] TOML assignment target is not an object".to_string());
    };
    map.insert(key_path[key_path.len() - 1].clone(), value);
    Ok(())
}

fn toml_value_to_json(value: toml::Value) -> Result<Value, String> {
    match value {
        toml::Value::String(value) => Ok(Value::String(value)),
        toml::Value::Integer(value) => Ok(Value::Number(Number::from(value))),
        toml::Value::Float(value) => Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| "[config] TOML float is not JSON representable".to_string()),
        toml::Value::Boolean(value) => Ok(Value::Bool(value)),
        toml::Value::Datetime(value) => Ok(Value::String(value.to_string())),
        toml::Value::Array(values) => values
            .into_iter()
            .map(toml_value_to_json)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        toml::Value::Table(values) => {
            let mut out = Map::new();
            for (key, value) in values {
                out.insert(key, toml_value_to_json(value)?);
            }
            Ok(Value::Object(out))
        }
    }
}

fn json_object_to_toml_value(map: Map<String, Value>) -> Result<toml::Value, String> {
    let mut table = toml::map::Map::new();
    for (key, value) in map {
        table.insert(key, json_value_to_toml(value)?);
    }
    Ok(toml::Value::Table(table))
}

fn json_value_to_toml(value: Value) -> Result<toml::Value, String> {
    match value {
        Value::Null => Err("[config] TOML does not support null values".to_string()),
        Value::Bool(value) => Ok(toml::Value::Boolean(value)),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                return Ok(toml::Value::Integer(integer));
            }
            if let Some(float) = value.as_f64() {
                return Ok(toml::Value::Float(float));
            }
            Err("[config] TOML number is out of range".to_string())
        }
        Value::String(value) => Ok(toml::Value::String(value)),
        Value::Array(values) => values
            .into_iter()
            .map(json_value_to_toml)
            .collect::<Result<Vec<_>, _>>()
            .map(toml::Value::Array),
        Value::Object(map) => {
            let mut table = toml::map::Map::new();
            for (key, value) in map {
                table.insert(key, json_value_to_toml(value)?);
            }
            Ok(toml::Value::Table(table))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_toml_record_json, serialize_toml_record_json, update_toml_string_scalar_in_table_json,
    };
    use serde_json::Value;

    #[test]
    fn parses_routecodex_config_shapes() {
        let parsed = parse_toml_record_json(
            r#"
version = "2.0.0"
virtualrouterMode = "v2"

[httpserver]
host = "127.0.0.1"
port = 5555

[virtualrouter.routingPolicyGroups.default.routing.default]
id = "default-primary"
targets = ["demo.mock-1"]
"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&parsed).unwrap();
        assert_eq!(value["httpserver"]["port"], 5555);
        assert_eq!(
            value["virtualrouter"]["routingPolicyGroups"]["default"]["routing"]["default"]
                ["targets"][0],
            "demo.mock-1"
        );
    }

    #[test]
    fn preserves_legacy_duplicate_table_merge_semantics() {
        let parsed = parse_toml_record_json(
            r#"
[virtualrouter.forwarders."fwd.paid.gpt-5.5"]
protocol = "openai"
model = "gpt-5.5"
strategy = "priority"

[[virtualrouter.forwarders."fwd.paid.gpt-5.5".targets]]
providerId = "cc"
priority = 1
disabled = false

[virtualrouter.forwarders."fwd.paid.gpt-5.5"]
protocol = "openai"
model = "gpt-5.5"
strategy = "priority"

[[virtualrouter.forwarders."fwd.paid.gpt-5.5".targets]]
providerId = "asxs"
priority = 1
disabled = false
"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&parsed).unwrap();
        let targets = &value["virtualrouter"]["forwarders"]["fwd.paid.gpt-5.5"]["targets"];
        assert_eq!(targets.as_array().unwrap().len(), 2);
        assert_eq!(targets[0]["providerId"], "cc");
        assert_eq!(targets[1]["providerId"], "asxs");
    }

    #[test]
    fn serializes_provider_config_roundtrip() {
        let raw = r#"{
  "version": "2.0.0",
  "providerId": "demo",
  "provider": {
    "id": "demo",
    "type": "openai",
    "models": {
      "qwen3.5-plus": {
        "capabilities": ["web_search", "multimodal"]
      }
    }
  }
}"#;
        let serialized = serialize_toml_record_json(raw).unwrap();
        let reparsed = parse_toml_record_json(&serialized).unwrap();
        let value: Value = serde_json::from_str(&reparsed).unwrap();
        assert_eq!(
            value["provider"]["models"]["qwen3.5-plus"]["capabilities"][1],
            "multimodal"
        );
    }

    #[test]
    fn updates_string_scalar_without_dropping_comments() {
        let input = serde_json::json!({
            "raw": "# top\nversion = \"2.0.0\"\noauthBrowser = \"default\"   # pick browser\n\n[httpserver]\nport = 5555\n",
            "tablePath": [],
            "key": "oauthBrowser",
            "value": "camoufox"
        });
        let updated = update_toml_string_scalar_in_table_json(&input.to_string()).unwrap();
        assert!(updated.contains("# top"));
        assert!(updated.contains("oauthBrowser = \"camoufox\"   # pick browser"));
        assert!(updated.contains("[httpserver]"));
    }

    #[test]
    fn creates_missing_table_for_scalar_update() {
        let input = serde_json::json!({
            "raw": "version = \"2.0.0\"\n",
            "tablePath": ["virtualrouter"],
            "key": "activeRoutingPolicyGroup",
            "value": "canary"
        });
        let updated = update_toml_string_scalar_in_table_json(&input.to_string()).unwrap();
        assert!(updated.contains("[virtualrouter]"));
        assert!(updated.contains("activeRoutingPolicyGroup = \"canary\""));
    }

    #[test]
    fn inserts_root_key_before_first_table() {
        let input = serde_json::json!({
            "raw": "version = \"2.0.0\"\n\n[httpserver]\nhost = \"127.0.0.1\"\n",
            "tablePath": [],
            "key": "oauthBrowser",
            "value": "camoufox"
        });
        let updated = update_toml_string_scalar_in_table_json(&input.to_string()).unwrap();
        assert!(updated.find("oauthBrowser").unwrap() < updated.find("[httpserver]").unwrap());
    }

    #[test]
    fn inserts_table_key_before_child_table() {
        let input = serde_json::json!({
            "raw": "[virtualrouter]\nactiveRoutingPolicyGroup = \"default\"\n\n[virtualrouter.session]\nenabled = true\ntickMs = 1500\n",
            "tablePath": ["virtualrouter"],
            "key": "oauthBrowser",
            "value": "camoufox"
        });
        let updated = update_toml_string_scalar_in_table_json(&input.to_string()).unwrap();
        assert!(updated.contains("oauthBrowser = \"camoufox\""));
        assert!(
            updated.find("oauthBrowser").unwrap()
                < updated.find("[virtualrouter.session]").unwrap()
        );
    }
}
