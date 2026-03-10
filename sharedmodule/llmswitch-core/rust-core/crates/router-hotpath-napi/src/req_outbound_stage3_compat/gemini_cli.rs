use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::AdapterContext;

const REQUEST_FIELDS: [&str; 6] = [
    "contents",
    "systemInstruction",
    "tools",
    "toolConfig",
    "generationConfig",
    "safetySettings",
];

const ROOT_ONLY_FIELDS: [&str; 6] = [
    "model",
    "project",
    "requestId",
    "requestType",
    "userAgent",
    "action",
];
const GEMINI_CLI_ALLOW_TOP_LEVEL: [&str; 7] = [
    "model",
    "project",
    "request",
    "requestId",
    "requestType",
    "userAgent",
    "action",
];
const ANTIGRAVITY_GLOBAL_ALIAS_KEY: &str = "antigravity.global";
const DUMMY_THOUGHT_SIGNATURE_SENTINEL: &str = "skip_thought_signature_validator";
const ANTIGRAVITY_SIGNATURE_RECOVERY_PROMPT: &str =
    "\n\n[System Recovery] Your previous output contained an invalid signature. Please regenerate the response without the corrupted signature block.";
const MIN_SIGNATURE_LENGTH: usize = 50;
const SESSION_CACHE_LIMIT: usize = 1000;
const SIGNATURE_TOUCH_INTERVAL_MS: u64 = 5 * 60 * 1000;
const REWIND_BLOCK_MS: u64 = 2 * 60 * 60 * 1000;

#[derive(Clone, Debug)]
struct RequestSessionMeta {
    alias_key: String,
    session_id: String,
    message_count: i64,
    timestamp_ms: u64,
}

#[derive(Clone, Debug)]
struct SessionSignatureEntry {
    signature: String,
    message_count: i64,
    timestamp_ms: u64,
}

#[derive(Clone, Debug)]
struct LatestSignatureEntry {
    session_id: String,
    timestamp_ms: u64,
}

#[derive(Clone, Debug)]
struct RewindBlockEntry {
    until_ms: u64,
    timestamp_ms: u64,
}

#[derive(Clone, Debug)]
struct PinnedAliasEntry {
    alias_key: String,
    timestamp_ms: u64,
}

#[derive(Clone, Debug)]
struct PinnedSessionEntry {
    session_id: String,
    timestamp_ms: u64,
}

fn request_session_meta_cache() -> &'static Mutex<HashMap<String, RequestSessionMeta>> {
    static CACHE: OnceLock<Mutex<HashMap<String, RequestSessionMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_signature_cache() -> &'static Mutex<HashMap<String, SessionSignatureEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SessionSignatureEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn latest_signature_cache() -> &'static Mutex<HashMap<String, LatestSignatureEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, LatestSignatureEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rewind_block_cache() -> &'static Mutex<HashMap<String, RewindBlockEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, RewindBlockEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pinned_alias_by_session_cache() -> &'static Mutex<HashMap<String, PinnedAliasEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PinnedAliasEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pinned_session_by_alias_cache() -> &'static Mutex<HashMap<String, PinnedSessionEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PinnedSessionEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

include!("gemini_cli/tooling.rs");
include!("gemini_cli/signature.rs");

include!("gemini_cli/pipeline.rs");
