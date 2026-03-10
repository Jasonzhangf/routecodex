fn resolve_antigravity_alias_key(
    adapter_context: &AdapterContext,
    request_id_hint: Option<&Value>,
) -> String {
    let candidates = [
        adapter_context.runtime_key.as_ref(),
        adapter_context.provider_key.as_ref(),
        adapter_context.provider_id.as_ref(),
        adapter_context.request_id.as_ref(),
    ];
    for raw in candidates.into_iter().flatten() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower == "antigravity" {
            continue;
        }
        if lower.starts_with("antigravity.") {
            let parts: Vec<&str> = trimmed.split('.').collect();
            if parts.len() >= 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
                return format!("{}.{}", parts[0].trim(), parts[1].trim()).to_ascii_lowercase();
            }
        }
        if lower.starts_with("gemini-cli.") {
            let parts: Vec<&str> = trimmed.split('.').collect();
            if parts.len() >= 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
                return format!("antigravity.{}", parts[1].trim()).to_ascii_lowercase();
            }
        }
    }

    let request_id = read_trimmed_string(request_id_hint);
    if let Some(raw) = request_id {
        if let Some(captures) = regex::Regex::new(r"antigravity\.([^\.\s]+)")
            .ok()
            .and_then(|re| re.captures(&raw))
        {
            if let Some(alias) = captures.get(1) {
                let trimmed = alias.as_str().trim().to_ascii_lowercase();
                if !trimmed.is_empty() {
                    return format!("antigravity.{}", trimmed);
                }
            }
        }
    }

    "antigravity.unknown".to_string()
}

fn should_enable_antigravity_signature(
    root: &Map<String, Value>,
    request_node: &Map<String, Value>,
    adapter_context: &AdapterContext,
) -> bool {
    let protocol = adapter_context
        .provider_protocol
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if protocol != "gemini-chat" {
        return false;
    }

    let provider_id_or_key = adapter_context
        .provider_id
        .as_ref()
        .or(adapter_context.provider_key.as_ref())
        .or(adapter_context.runtime_key.as_ref())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let effective_provider_id = provider_id_or_key.split('.').next().unwrap_or_default();
    if effective_provider_id == "antigravity" || effective_provider_id == "gemini-cli" {
        return true;
    }

    let req_user_agent = read_trimmed_string(request_node.get("userAgent"))
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    if req_user_agent == "antigravity" {
        return true;
    }
    let req_request_id = read_trimmed_string(request_node.get("requestId"))
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    if req_request_id.starts_with("agent-") {
        return true;
    }

    let root_user_agent = read_trimmed_string(root.get("userAgent"))
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    if root_user_agent == "antigravity" {
        return true;
    }
    let root_request_id = read_trimmed_string(root.get("requestId"))
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    root_request_id.starts_with("agent-")
}

fn should_enable_signature_recovery(adapter_context: &AdapterContext) -> bool {
    let Some(rt) = adapter_context.rt.as_ref().and_then(|v| v.as_object()) else {
        return false;
    };
    rt.get("antigravityThoughtSignatureRecovery")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn find_gemini_contents_node_in_map<'a>(
    root: &'a Map<String, Value>,
) -> Option<&'a Map<String, Value>> {
    if root.get("contents").and_then(|v| v.as_array()).is_some() {
        return Some(root);
    }
    if let Some(request) = root.get("request").and_then(|v| v.as_object()) {
        if let Some(hit) = find_gemini_contents_node_in_map(request) {
            return Some(hit);
        }
    }
    if let Some(data) = root.get("data").and_then(|v| v.as_object()) {
        if let Some(hit) = find_gemini_contents_node_in_map(data) {
            return Some(hit);
        }
    }
    None
}

fn locate_gemini_contents_node<'a>(payload: &'a Value) -> Option<&'a Map<String, Value>> {
    let root = payload.as_object()?;
    find_gemini_contents_node_in_map(root).or(Some(root))
}

fn find_gemini_contents_node_in_map_mut<'a>(
    root: &'a mut Map<String, Value>,
) -> Option<&'a mut Map<String, Value>> {
    #[derive(Clone, Debug)]
    enum GeminiNodePath {
        Here,
        Request(Box<GeminiNodePath>),
        Data(Box<GeminiNodePath>),
    }

    fn find_path(root: &Map<String, Value>) -> Option<GeminiNodePath> {
        if root.get("contents").and_then(|v| v.as_array()).is_some() {
            return Some(GeminiNodePath::Here);
        }
        if let Some(request) = root.get("request").and_then(|v| v.as_object()) {
            if let Some(path) = find_path(request) {
                return Some(GeminiNodePath::Request(Box::new(path)));
            }
        }
        if let Some(data) = root.get("data").and_then(|v| v.as_object()) {
            if let Some(path) = find_path(data) {
                return Some(GeminiNodePath::Data(Box::new(path)));
            }
        }
        None
    }

    fn get_by_path_mut<'a>(
        root: &'a mut Map<String, Value>,
        path: &GeminiNodePath,
    ) -> Option<&'a mut Map<String, Value>> {
        match path {
            GeminiNodePath::Here => Some(root),
            GeminiNodePath::Request(next) => {
                let child = root.get_mut("request").and_then(|v| v.as_object_mut())?;
                get_by_path_mut(child, next)
            }
            GeminiNodePath::Data(next) => {
                let child = root.get_mut("data").and_then(|v| v.as_object_mut())?;
                get_by_path_mut(child, next)
            }
        }
    }

    let path = find_path(root)?;
    get_by_path_mut(root, &path)
}

fn json_stringify_fallback(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)
}

pub(crate) fn extract_antigravity_gemini_session_id(payload: &Value) -> String {
    let node = locate_gemini_contents_node(payload)
        .cloned()
        .unwrap_or_default();
    let mut seed: Option<String> = None;
    let contents = node
        .get("contents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in contents {
        let Some(content) = entry.as_object() else {
            continue;
        };
        if read_trimmed_string(content.get("role"))
            .map(|v| v != "user")
            .unwrap_or(true)
        {
            continue;
        }
        let parts = content
            .get("parts")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let texts: Vec<String> = parts
            .iter()
            .filter_map(|part| part.as_object())
            .filter_map(|part| read_trimmed_string(part.get("text")))
            .collect();
        let combined = texts.join(" ").trim().to_string();
        if !combined.is_empty() && !combined.contains("<system-reminder>") {
            seed = Some(combined);
            break;
        }
    }
    let seed = seed.unwrap_or_else(|| json_stringify_fallback(&Value::Object(node)));
    let hash = sha256_hex(&seed);
    format!("sid-{}", &hash[..16.min(hash.len())])
}

