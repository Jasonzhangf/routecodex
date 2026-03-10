use regex::Regex;
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub(super) struct MediaAttachmentSignals {
    pub has_any_media: bool,
    pub has_image: bool,
    pub has_video: bool,
    pub has_remote_video: bool,
    pub has_local_video: bool,
}

pub(super) fn analyze_media_attachments(message: Option<&Value>) -> MediaAttachmentSignals {
    let mut result = MediaAttachmentSignals::default();
    let message = match message {
        Some(msg) => msg,
        None => return result,
    };
    if let Some(content) = message.get("content") {
        if let Some(text) = content.as_str() {
            let raw = text;
            let has_image_block = Regex::new(r#"\"type\"\s*:\s*\"(?:input_)?image(?:_url)?\""#)
                .unwrap()
                .is_match(raw);
            let has_video_block = Regex::new(r#"\"type\"\s*:\s*\"(?:input_)?video(?:_url)?\""#)
                .unwrap()
                .is_match(raw);
            let has_data_video = Regex::new(r"data:video/").unwrap().is_match(raw);
            let has_remote_video = Regex::new(r#"https?://[^\s"'\\]+"#).unwrap().is_match(raw);
            if has_image_block || has_video_block {
                result.has_any_media = true;
            }
            if has_image_block {
                result.has_image = true;
            }
            if has_video_block {
                result.has_video = true;
                if has_data_video {
                    result.has_local_video = true;
                }
                if has_remote_video {
                    result.has_remote_video = true;
                }
                if !has_data_video && !has_remote_video {
                    result.has_local_video = true;
                }
            }
            if result.has_any_media {
                return result;
            }
        }
        if let Some(items) = content.as_array() {
            for part in items {
                if let Some(map) = part.as_object() {
                    let type_value = map
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let media_kind = if type_value.contains("video") {
                        Some("video")
                    } else if type_value.contains("image") {
                        Some("image")
                    } else if map.contains_key("video_url") {
                        Some("video")
                    } else if map.contains_key("image_url") {
                        Some("image")
                    } else {
                        None
                    };
                    let media_kind = match media_kind {
                        Some(kind) => kind,
                        None => continue,
                    };
                    let media_url = extract_media_url_candidate(map);
                    if media_url.is_empty() {
                        continue;
                    }
                    result.has_any_media = true;
                    if media_kind == "image" {
                        result.has_image = true;
                        continue;
                    }
                    result.has_video = true;
                    if is_remote_public_http_url(&media_url) {
                        result.has_remote_video = true;
                    } else {
                        result.has_local_video = true;
                    }
                }
            }
        }
    }
    result
}

fn extract_media_url_candidate(record: &serde_json::Map<String, Value>) -> String {
    if let Some(url) = record.get("image_url").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(url) = record.get("video_url").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(map) = record.get("image_url").and_then(|v| v.as_object()) {
        if let Some(url) = map.get("url").and_then(|v| v.as_str()) {
            return url.to_string();
        }
    }
    if let Some(map) = record.get("video_url").and_then(|v| v.as_object()) {
        if let Some(url) = map.get("url").and_then(|v| v.as_str()) {
            return url.to_string();
        }
    }
    if let Some(url) = record.get("url").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(url) = record.get("uri").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(url) = record.get("data").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    "".to_string()
}

fn is_remote_public_http_url(raw: &str) -> bool {
    let value = raw.trim();
    if value.is_empty() {
        return false;
    }
    let lowered = value.to_lowercase();
    for prefix in ["data:", "file:", "blob:"] {
        if lowered.starts_with(prefix) {
            return false;
        }
    }
    if !(lowered.starts_with("http://") || lowered.starts_with("https://")) {
        return false;
    }
    let without_scheme = if lowered.starts_with("http://") {
        &value[7..]
    } else {
        &value[8..]
    };
    let host_port = without_scheme
        .split(|ch| ch == '/' || ch == '?' || ch == '#')
        .next()
        .unwrap_or("");
    let host = host_port
        .split('@')
        .last()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    if host.is_empty() {
        return false;
    }
    !is_private_host(host)
}

fn is_private_host(host: &str) -> bool {
    let normalized = host.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    if normalized == "localhost" || normalized.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = normalized.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(addr) => {
                let octets = addr.octets();
                if octets[0] == 10 {
                    return true;
                }
                if octets[0] == 127 {
                    return true;
                }
                if octets[0] == 0 {
                    return true;
                }
                if octets[0] == 169 && octets[1] == 254 {
                    return true;
                }
                if octets[0] == 172 && (16..=31).contains(&octets[1]) {
                    return true;
                }
                if octets[0] == 192 && octets[1] == 168 {
                    return true;
                }
                false
            }
            std::net::IpAddr::V6(addr) => {
                if addr.is_loopback() {
                    return true;
                }
                let segments = addr.segments();
                let first = segments[0];
                if (first & 0xfe00) == 0xfc00 {
                    return true;
                }
                if (first & 0xffc0) == 0xfe80 {
                    return true;
                }
                false
            }
        }
    } else {
        false
    }
}
