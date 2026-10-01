// feature_id: v3.admin_api
//! Local admin token provisioning and request admission for the admin control plane.
//!
//! Trust boundary: the admin listener is loopback-only, so the real boundary to enforce is
//! "a browser page from another origin must not be able to drive this control plane".
//!
//! Frozen contract:
//! - `AdminToken::load_or_create(config_dir)` provisions `<config_dir>/state/admin-token`
//!   (0600) on first use and returns the value.
//! - `require_admin` is mounted as an axum middleware over the whole admin router. It must
//!   reject non-loopback `Host`, cross-site `Origin`, and token-less mutating requests, and
//!   fail closed when no token is provisioned.
//!
//! Admission rules (one rule, no path exceptions):
//! - every request must carry a loopback `Host` (127.0.0.1 / localhost / [::1], optional port);
//! - a present `Origin` must be a loopback origin;
//! - every POST/PUT/DELETE/PATCH requires `x-routecodex-admin-token`;
//! - when no token is provisioned, every mutating request fails closed with 503.

use crate::AppState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode};
use axum::response::Response;
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Request header carrying the local admin token on mutating requests.
pub const ADMIN_TOKEN_HEADER: &str = "x-routecodex-admin-token";

const ADMIN_TOKEN_DIR: &str = "state";
const ADMIN_TOKEN_FILE_NAME: &str = "admin-token";
/// 32 random bytes rendered as 64 hex characters.
const ADMIN_TOKEN_RANDOM_BYTES: usize = 32;
const ADMIN_TOKEN_FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone)]
pub struct AdminToken {
    pub value: String,
    pub path: PathBuf,
}

impl AdminToken {
    /// Provision `<config_dir>/state/admin-token` (0600, 32 random hex bytes) on first use.
    /// An existing token is reused; an empty or unreadable token is an explicit error
    /// (callers then fail closed rather than silently minting a second token).
    pub fn load_or_create(config_dir: &Path) -> std::io::Result<AdminToken> {
        let path = config_dir.join(ADMIN_TOKEN_DIR).join(ADMIN_TOKEN_FILE_NAME);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if path.exists() {
            return read_token(&path);
        }
        let value = generate_token()?;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(ADMIN_TOKEN_FILE_MODE)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(value.as_bytes())?;
                file.write_all(b"\n")?;
                file.sync_all()?;
                Ok(AdminToken { value, path })
            }
            // Lost a race with another provisioner: adopt the file that won.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_token(&path),
            Err(error) => Err(error),
        }
    }
}

fn read_token(path: &Path) -> std::io::Result<AdminToken> {
    let raw = std::fs::read_to_string(path)?;
    let value = raw.trim().to_string();
    if value.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("admin token {} is empty", path.display()),
        ));
    }
    let metadata = std::fs::metadata(path)?;
    if metadata.permissions().mode() & 0o777 != ADMIN_TOKEN_FILE_MODE {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(ADMIN_TOKEN_FILE_MODE))?;
    }
    Ok(AdminToken {
        value,
        path: path.to_path_buf(),
    })
}

fn generate_token() -> std::io::Result<String> {
    let mut bytes = [0u8; ADMIN_TOKEN_RANDOM_BYTES];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    Ok(value)
}

pub async fn require_admin(
    State(state): State<AppState>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    if let Some(rejection) = reject(&state, &request) {
        return rejection;
    }
    next.run(request).await
}

fn reject(state: &AppState, request: &Request) -> Option<Response> {
    let headers = request.headers();
    match headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        Some(host) if host_is_loopback(host) => {}
        Some(host) => {
            return Some(rejection(
                StatusCode::FORBIDDEN,
                "host_not_loopback",
                &format!("admin control plane rejects non-loopback Host `{host}`"),
            ))
        }
        None => {
            return Some(rejection(
                StatusCode::FORBIDDEN,
                "host_missing",
                "admin control plane requires a loopback Host header",
            ))
        }
    }
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        if !origin_is_loopback(origin) {
            return Some(rejection(
                StatusCode::FORBIDDEN,
                "origin_not_loopback",
                &format!("admin control plane rejects cross-site Origin `{origin}`"),
            ));
        }
    }
    if !is_mutating_method(request.method()) {
        return None;
    }
    let Some(expected) = state.admin_token.as_deref() else {
        return Some(rejection(
            StatusCode::SERVICE_UNAVAILABLE,
            "admin_token_unavailable",
            "local admin token is not provisioned; mutating admin endpoints fail closed",
        ));
    };
    match headers
        .get(ADMIN_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        Some(provided) if tokens_match(expected, provided) => None,
        Some(_) => Some(rejection(
            StatusCode::UNAUTHORIZED,
            "admin_token_mismatch",
            "invalid local admin token",
        )),
        None => Some(rejection(
            StatusCode::UNAUTHORIZED,
            "admin_token_required",
            &format!("mutating admin requests require the {ADMIN_TOKEN_HEADER} header"),
        )),
    }
}

fn is_mutating_method(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::DELETE | Method::PATCH
    )
}

/// `host[:port]`, `[v6]:port` or bare IPv6 literal -> host only. A malformed authority is
/// returned unchanged so it can never compare equal to a loopback host.
fn host_only(value: &str) -> &str {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return value;
        };
        let host = &value[..end + 2];
        let remainder = &value[end + 2..];
        let valid_remainder = remainder.is_empty()
            || (remainder.len() > 1
                && remainder.starts_with(':')
                && remainder[1..].chars().all(|ch| ch.is_ascii_digit()));
        return if valid_remainder { host } else { value };
    }
    // A bare IPv6 literal contains more than one colon and has no port suffix.
    if value.matches(':').count() > 1 {
        return value;
    }
    match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) => {
            host
        }
        _ => value,
    }
}

fn host_is_loopback(value: &str) -> bool {
    matches!(
        host_only(value),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

fn origin_is_loopback(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    !authority.is_empty() && host_is_loopback(authority)
}

fn tokens_match(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.len() != provided.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.iter().zip(provided.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn rejection(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error_code": code, "error": message }).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("rejection response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_accept_optional_ports_and_ipv6_brackets() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:8777",
            "localhost",
            "localhost:8777",
            "::1",
            "[::1]",
            "[::1]:8777",
        ] {
            assert!(host_is_loopback(host), "{host} should be loopback");
        }
        for host in [
            "example.com",
            "example.com:8777",
            "10.0.0.5:8777",
            "0.0.0.0:8777",
            "127.0.0.1.evil.com",
            "[::1].evil.com",
            "[::1].evil.com:8777",
            "127.0.0.1:8777:extra",
            "127.0.0.1:",
            "",
        ] {
            assert!(!host_is_loopback(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn origins_must_be_loopback_http() {
        assert!(origin_is_loopback("http://127.0.0.1:8777"));
        assert!(origin_is_loopback("http://localhost"));
        assert!(origin_is_loopback("https://[::1]:8777"));
        assert!(!origin_is_loopback("http://evil.example"));
        assert!(!origin_is_loopback("null"));
        assert!(!origin_is_loopback("file://127.0.0.1"));
    }

    #[test]
    fn token_comparison_is_exact() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("abc", "abcd"));
        assert!(!tokens_match("abc", ""));
    }

    #[test]
    fn mutating_methods_are_gated() {
        assert!(is_mutating_method(&Method::POST));
        assert!(is_mutating_method(&Method::PUT));
        assert!(is_mutating_method(&Method::DELETE));
        assert!(is_mutating_method(&Method::PATCH));
        assert!(!is_mutating_method(&Method::GET));
        assert!(!is_mutating_method(&Method::HEAD));
    }
}
