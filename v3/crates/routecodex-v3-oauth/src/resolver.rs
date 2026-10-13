use crate::{
    V3OAuthCredential, V3OAuthDeclaration, V3OAuthError, V3OAuthRefreshResponse, V3OAuthSource,
    V3OAuthStore,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const CODEX_REFRESH_SCOPE: &str = "openid profile email offline_access https://api.openai.com/auth";

#[derive(Default)]
struct IdentityState {
    credential: Option<V3OAuthCredential>,
}

fn identity_registry() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<IdentityState>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<IdentityState>>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Credential identity excludes consumer policy such as `refresh_before_seconds`,
/// so two declarations that share one credential source also share one rotation
/// state and one in-process lock.
fn identity_key(declaration: &V3OAuthDeclaration) -> Result<String, V3OAuthError> {
    let source = match &declaration.oauth_source {
        V3OAuthSource::CodexAuthJson { path } => source_identity(path)?,
    };
    let store = match &declaration.oauth_store {
        V3OAuthStore::Memory => serde_json::json!({"kind": "memory"}),
        V3OAuthStore::File { path } => {
            let path = canonical_or_absolute(Path::new(path))?;
            serde_json::json!({"kind": "file", "path": path.to_string_lossy()})
        }
    };
    let identity = serde_json::json!({
        "oauth_source": source,
        "refresh_endpoint": declaration.refresh_endpoint,
        "client_id": declaration.client_id,
        "oauth_store": store,
    });
    Ok(serde_json::to_string(&identity)
        .unwrap_or_else(|_| format!("{:?}", declaration.oauth_store)))
}

fn identity_lock(
    declaration: &V3OAuthDeclaration,
) -> Result<Arc<tokio::sync::Mutex<IdentityState>>, V3OAuthError> {
    let key = identity_key(declaration)?;
    let mut registry = identity_registry()
        .lock()
        .expect("OAuth identity registry lock poisoned");
    Ok(registry
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(IdentityState::default())))
        .clone())
}

/// Cross-process exclusive lock over a file-backed credential store. The lock
/// is a sibling `<store>.lock` file held with `flock`, so two RCC processes
/// sharing one store serialize their read, refresh, and write and only one
/// consumes a rotating refresh token. Waiting is bounded and never blocks the
/// async runtime thread.
struct StoreFileLock {
    #[cfg(unix)]
    file: std::fs::File,
}

impl StoreFileLock {
    async fn acquire(store_path: &Path) -> Result<Self, V3OAuthError> {
        let lock_path = store_lock_path(store_path);
        if let Some(parent) = lock_path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| V3OAuthError::StoreRead)?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // The lock file carries no data; it exists only so that flock has an
            // fd to hold. Never truncate: the path is derived from the store and
            // must stay byte-neutral even if the source aliases it.
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|_| V3OAuthError::StoreRead)?;
            let deadline = std::time::Instant::now() + STORE_LOCK_WAIT;
            loop {
                let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
                if rc == 0 {
                    return Ok(Self { file });
                }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EWOULDBLOCK) {
                    return Err(V3OAuthError::StoreLocked);
                }
                if std::time::Instant::now() >= deadline {
                    return Err(V3OAuthError::StoreLocked);
                }
                tokio::time::sleep(STORE_LOCK_POLL).await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = &lock_path;
            Ok(Self {})
        }
    }
}

#[cfg(unix)]
impl Drop for StoreFileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

const STORE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(120);
const STORE_LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// Minimal injected refresh transport. Provider transport owns the production
/// HTTP implementation; tests can supply a controlled client without leaving
/// the OAuth credential module.
pub trait V3OAuthRefreshClient: Send + Sync {
    fn refresh(
        &self,
        endpoint: &str,
        body: &serde_json::Value,
    ) -> impl std::future::Future<Output = Result<(u16, Vec<u8>), V3OAuthError>> + Send;
}

pub async fn resolve_oauth_access_token_with_client<C>(
    declaration: &V3OAuthDeclaration,
    client: &C,
) -> Result<String, V3OAuthError>
where
    C: V3OAuthRefreshClient,
{
    let store_path = match &declaration.oauth_store {
        V3OAuthStore::File { path } => Some(canonical_or_absolute(Path::new(path))?),
        V3OAuthStore::Memory => None,
    };
    let identity = identity_lock(declaration)?;
    let mut state = identity.lock().await;
    // The in-process identity lock serializes callers of this process. A
    // file-backed store is shared between processes, so its read, refresh,
    // and write must also hold the cross-process store lock; otherwise two
    // processes each consume the same rotating refresh token.
    let _store_lock = match &store_path {
        Some(path) => Some(StoreFileLock::acquire(path).await?),
        None => None,
    };
    let mut credential = load_credential(declaration, &state, store_path.as_deref()).await?;
    if credential.access_token().is_empty() {
        return Err(V3OAuthError::MissingCredential);
    }
    if needs_refresh(credential.expires_at(), declaration.refresh_before_seconds) {
        credential = refresh_credential(declaration, client, &credential).await?;
        store_credential(declaration, &credential, store_path.as_deref()).await?;
        state.credential = Some(credential.clone());
    } else if state.credential.is_none() {
        state.credential = Some(credential.clone());
    }
    Ok(credential.access_token().to_string())
}

async fn load_credential(
    declaration: &V3OAuthDeclaration,
    state: &tokio::sync::MutexGuard<'_, IdentityState>,
    store_path: Option<&Path>,
) -> Result<V3OAuthCredential, V3OAuthError> {
    match &declaration.oauth_store {
        V3OAuthStore::Memory => match &state.credential {
            Some(credential) => Ok(credential.clone()),
            None => read_source(&declaration.oauth_source).await,
        },
        V3OAuthStore::File { .. } => {
            read_store_or_initialize(declaration, store_path.ok_or(V3OAuthError::StoreRead)?).await
        }
    }
}

async fn read_store_or_initialize(
    declaration: &V3OAuthDeclaration,
    store_path: &Path,
) -> Result<V3OAuthCredential, V3OAuthError> {
    ensure_distinct_source_and_store(declaration, store_path)?;
    match tokio::fs::read(store_path).await {
        Ok(bytes) => decode_credential(&bytes).map_err(|_| V3OAuthError::StoreRead),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let credential = read_source(&declaration.oauth_source).await?;
            write_store(store_path, &credential).await?;
            Ok(credential)
        }
        Err(_) => Err(V3OAuthError::StoreRead),
    }
}

async fn read_source(source: &V3OAuthSource) -> Result<V3OAuthCredential, V3OAuthError> {
    match source {
        V3OAuthSource::CodexAuthJson { path } => {
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|_| V3OAuthError::SourceRead)?;
            let auth: crate::credential::CodexAuthJson =
                serde_json::from_slice(&bytes).map_err(|_| V3OAuthError::SourceFormat)?;
            if auth.auth_mode.as_deref() == Some("apikey") {
                return Err(V3OAuthError::SourceFormat);
            }
            let access_token = auth
                .tokens
                .access_token
                .filter(|token| !token.is_empty())
                .ok_or(V3OAuthError::MissingCredential)?;
            // Codex `auth.json` may omit `expires_at`; the access token's own
            // `exp` claim is then the only refresh-scheduling metadata. Parsing
            // it is scheduling only, never signature authentication.
            let expires_at = auth.tokens.expires_at.or_else(|| jwt_exp(&access_token));
            Ok(V3OAuthCredential::new(
                access_token,
                auth.tokens.refresh_token,
                auth.tokens.id_token,
                expires_at,
            ))
        }
    }
}

fn decode_credential(bytes: &[u8]) -> Result<V3OAuthCredential, serde_json::Error> {
    let stored: StoredCredential = serde_json::from_slice(bytes)?;
    if stored.access_token.is_empty() {
        return Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "empty access token",
        )));
    }
    Ok(V3OAuthCredential::new(
        stored.access_token,
        stored.refresh_token,
        stored.id_token,
        stored.expires_at,
    ))
}

async fn store_credential(
    declaration: &V3OAuthDeclaration,
    credential: &V3OAuthCredential,
    store_path: Option<&Path>,
) -> Result<(), V3OAuthError> {
    match &declaration.oauth_store {
        V3OAuthStore::Memory => Ok(()),
        V3OAuthStore::File { .. } => {
            let store_path = store_path.ok_or(V3OAuthError::StoreRead)?;
            ensure_distinct_source_and_store(declaration, store_path)?;
            write_store(store_path, credential).await
        }
    }
}

async fn write_store(path: &Path, credential: &V3OAuthCredential) -> Result<(), V3OAuthError> {
    let parent = path.parent().ok_or(V3OAuthError::StoreWrite)?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| V3OAuthError::StoreWrite)?;
    let stored = StoredCredential {
        access_token: credential.access_token().to_string(),
        refresh_token: credential.refresh_token().map(ToOwned::to_owned),
        id_token: credential.id_token().map(ToOwned::to_owned),
        expires_at: credential.expires_at(),
    };
    let bytes = serde_json::to_vec(&stored).map_err(|_| V3OAuthError::StoreWrite)?;
    let temp_path = store_staging_path(path);
    write_store_with_temp_path(path, &bytes, &temp_path).await
}

fn store_staging_path(path: &Path) -> PathBuf {
    // A per-write nonce keeps two declarations that share one store, or two
    // concurrent writers in one process, from staging over the same temp file.
    static TEMP_NONCE: AtomicU64 = AtomicU64::new(0);
    let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("tmp-{}-{}", std::process::id(), nonce))
}

async fn write_store_with_temp_path(
    path: &Path,
    bytes: &[u8],
    temp_path: &Path,
) -> Result<(), V3OAuthError> {
    if write_private_file(temp_path, bytes).await.is_err() {
        return Err(V3OAuthError::StoreWrite);
    }
    if tokio::fs::rename(temp_path, path).await.is_err() {
        let _ = tokio::fs::remove_file(temp_path).await;
        return Err(V3OAuthError::StoreWrite);
    }
    Ok(())
}

/// Creates the staging file with owner-only permissions before any credential
/// byte is written. `tokio::fs::write` would create it world-readable first and
/// chmod afterwards, leaving a window where another user can read the tokens.
async fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    let result = async {
        file.write_all(bytes).await?;
        file.flush().await
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

fn ensure_distinct_source_and_store(
    declaration: &V3OAuthDeclaration,
    store_path: &Path,
) -> Result<(), V3OAuthError> {
    let V3OAuthSource::CodexAuthJson { path: source_path } = &declaration.oauth_source;
    let source = canonical_or_absolute(Path::new(source_path))?;
    let store = canonical_or_absolute(store_path)?;
    // The derived lock path is mutated only with flock, but aliasing it to the
    // credential source still couples a private persistence artifact to the
    // read-only source, so reject it up front.
    let lock = canonical_or_absolute(&store_lock_path(store_path))?;
    if source == store || source == lock {
        return Err(V3OAuthError::StoreSourceConflict);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let source_meta = std::fs::metadata(&source).ok();
        for internal in [&store, &lock] {
            if let (Some(source_meta), Ok(internal_meta)) =
                (&source_meta, std::fs::metadata(internal))
            {
                if source_meta.dev() == internal_meta.dev()
                    && source_meta.ino() == internal_meta.ino()
                {
                    return Err(V3OAuthError::StoreSourceConflict);
                }
            }
        }
    }
    Ok(())
}

fn canonical_or_absolute(path: &Path) -> Result<PathBuf, V3OAuthError> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| V3OAuthError::StoreRead)?
            .join(path)
    };
    resolve_path(&path, 0)
}

fn resolve_path(path: &Path, symlink_hops: usize) -> Result<PathBuf, V3OAuthError> {
    const MAX_SYMLINK_HOPS: usize = 40;
    if symlink_hops > MAX_SYMLINK_HOPS {
        return Err(V3OAuthError::StoreRead);
    }
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if std::fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false)
            {
                let target = std::fs::read_link(path).map_err(|_| V3OAuthError::StoreRead)?;
                let target = if target.is_absolute() {
                    target
                } else {
                    path.parent().unwrap_or_else(|| Path::new(".")).join(target)
                };
                return resolve_path(&target, symlink_hops + 1);
            }
            let parent = path.parent().ok_or(V3OAuthError::StoreRead)?;
            let name = path.file_name().ok_or(V3OAuthError::StoreRead)?;
            Ok(resolve_path(parent, symlink_hops)?.join(name))
        }
        Err(_) => Err(V3OAuthError::StoreRead),
    }
}

fn store_lock_path(store_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", store_path.display()))
}

fn source_identity(path: &str) -> Result<serde_json::Value, V3OAuthError> {
    let path = canonical_or_absolute(Path::new(path))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = std::fs::metadata(&path) {
            return Ok(serde_json::json!({"dev": metadata.dev(), "ino": metadata.ino()}));
        }
    }
    Ok(serde_json::json!({"path": path.to_string_lossy()}))
}

fn needs_refresh(expires_at: Option<i64>, refresh_before_seconds: u64) -> bool {
    let Some(expires_at) = expires_at else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    now.saturating_add(refresh_before_seconds as i64) >= expires_at
}

async fn refresh_credential<C>(
    declaration: &V3OAuthDeclaration,
    client: &C,
    current: &V3OAuthCredential,
) -> Result<V3OAuthCredential, V3OAuthError>
where
    C: V3OAuthRefreshClient,
{
    let refresh_token = current
        .refresh_token()
        .filter(|token| !token.is_empty())
        .ok_or(V3OAuthError::MissingCredential)?;
    let body = serde_json::json!({
        "client_id": declaration.client_id,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": CODEX_REFRESH_SCOPE,
    });
    let (status, bytes) = client.refresh(&declaration.refresh_endpoint, &body).await?;
    if !(200..300).contains(&status) {
        return Err(V3OAuthError::RefreshRejected { status });
    }
    let response: V3OAuthRefreshResponse =
        serde_json::from_slice(&bytes).map_err(|_| V3OAuthError::RefreshResponse)?;
    let access_token = response
        .access_token
        .filter(|token| !token.is_empty())
        .ok_or(V3OAuthError::RefreshResponse)?;
    // Never inherit the previous access token's expiry: an opaque replacement
    // with no parseable `exp` is explicitly unknown, not still old.
    let expires_at = jwt_exp(&access_token);
    Ok(V3OAuthCredential::new(
        access_token,
        response
            .refresh_token
            .filter(|token| !token.is_empty())
            .or_else(|| current.refresh_token().map(ToOwned::to_owned)),
        response
            .id_token
            .filter(|token| !token.is_empty())
            .or_else(|| current.id_token().map(ToOwned::to_owned)),
        expires_at,
    ))
}

fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("exp")?.as_i64()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredCredential {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockRefreshClient {
        calls: AtomicUsize,
        bodies: Mutex<Vec<serde_json::Value>>,
        responses: Mutex<Vec<(u16, Vec<u8>)>>,
        delay: std::time::Duration,
    }

    impl MockRefreshClient {
        fn with_response(status: u16, body: &[u8]) -> Self {
            Self {
                responses: Mutex::new(vec![(status, body.to_vec())]),
                ..Self::default()
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn bodies(&self) -> Vec<serde_json::Value> {
            self.bodies.lock().unwrap().clone()
        }
    }

    impl V3OAuthRefreshClient for MockRefreshClient {
        async fn refresh(
            &self,
            _endpoint: &str,
            body: &serde_json::Value,
        ) -> Result<(u16, Vec<u8>), V3OAuthError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.bodies.lock().unwrap().push(body.clone());
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop()
                .expect("mock refresh response");
            Ok(response)
        }
    }

    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(name)
            .tempdir()
            .expect("temp dir")
    }

    fn write_codex_auth(
        dir: &tempfile::TempDir,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
        expires_at: Option<i64>,
    ) -> std::path::PathBuf {
        let path = dir.path().join("auth.json");
        let mut tokens = json!({
            "access_token": access_token,
        });
        if let Some(refresh_token) = refresh_token {
            tokens["refresh_token"] = json!(refresh_token);
        }
        if let Some(id_token) = id_token {
            tokens["id_token"] = json!(id_token);
        }
        if let Some(expires_at) = expires_at {
            tokens["expires_at"] = json!(expires_at);
        }
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "auth_mode": "chatgpt",
                "tokens": tokens,
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    fn declaration(
        source: &std::path::Path,
        oauth_store: V3OAuthStore,
        refresh_before_seconds: u64,
    ) -> V3OAuthDeclaration {
        V3OAuthDeclaration {
            oauth_source: V3OAuthSource::CodexAuthJson {
                path: source.display().to_string(),
            },
            refresh_endpoint: "https://token.example/refresh".to_string(),
            client_id: "client-secret-sentinel".to_string(),
            refresh_before_seconds,
            oauth_store,
        }
    }

    fn fake_jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
        format!("{header}.{payload}.signature")
    }

    #[tokio::test]
    async fn oauth_source_reads_codex_tokens_without_modifying_source() {
        let dir = temp_dir("rcc-oauth-source");
        let path = write_codex_auth(&dir, "access-source", Some("refresh-source"), None, None);
        let before = std::fs::read(&path).unwrap();
        let declaration = declaration(&path, V3OAuthStore::Memory, 300);
        let client = MockRefreshClient::default();

        let token = resolve_oauth_access_token_with_client(&declaration, &client)
            .await
            .unwrap();

        assert_eq!(token, "access-source");
        assert_eq!(client.call_count(), 0);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[tokio::test]
    async fn oauth_source_uses_jwt_exp_when_tokens_expires_at_is_absent() {
        let dir = temp_dir("rcc-oauth-jwt-exp");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("refresh-source"), None, None);
        let declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let refreshed = fake_jwt(4_000_000_000_i64);
        let client = MockRefreshClient::with_response(
            200,
            &serde_json::to_vec(&json!({"access_token": refreshed})).unwrap(),
        );

        let token = resolve_oauth_access_token_with_client(&declaration, &client)
            .await
            .unwrap();

        assert_eq!(token, refreshed);
        assert_eq!(client.call_count(), 1);
    }

    #[tokio::test]
    async fn oauth_source_rejects_malformed_json_and_apikey_mode() {
        let dir = temp_dir("rcc-oauth-bad-source");
        let malformed = dir.path().join("malformed.json");
        std::fs::write(&malformed, b"not json").unwrap();
        let malformed_declaration = declaration(&malformed, V3OAuthStore::Memory, 300);
        let client = MockRefreshClient::default();
        assert_eq!(
            resolve_oauth_access_token_with_client(&malformed_declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::SourceFormat
        );

        let apikey = dir.path().join("apikey.json");
        std::fs::write(
            &apikey,
            br#"{"auth_mode":"apikey","tokens":{"access_token":"ignored"}}"#,
        )
        .unwrap();
        let apikey_declaration = declaration(&apikey, V3OAuthStore::Memory, 300);
        assert_eq!(
            resolve_oauth_access_token_with_client(&apikey_declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::SourceFormat
        );
    }

    #[tokio::test]
    async fn oauth_source_requires_access_token() {
        let dir = temp_dir("rcc-oauth-missing-token");
        let path = dir.path().join("auth.json");
        std::fs::write(&path, br#"{"auth_mode":"chatgpt","tokens":{}}"#).unwrap();
        let declaration = declaration(&path, V3OAuthStore::Memory, 300);
        let client = MockRefreshClient::default();

        assert_eq!(
            resolve_oauth_access_token_with_client(&declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::MissingCredential
        );
    }

    #[test]
    fn oauth_refresh_boundary_is_explicit() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(needs_refresh(Some(now + 9), 10));
        assert!(needs_refresh(Some(now + 10), 10));
        assert!(!needs_refresh(Some(now + 11), 10));
        assert!(!needs_refresh(None, 10));
    }

    #[tokio::test]
    async fn oauth_refresh_preserves_optional_rotated_fields() {
        let dir = temp_dir("rcc-oauth-refresh-merge");
        let source = write_codex_auth(
            &dir,
            "old-access",
            Some("old-refresh"),
            Some("old-id"),
            Some(0),
        );
        let declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let current = V3OAuthCredential::new(
            "old-access",
            Some("old-refresh".to_string()),
            Some("old-id".to_string()),
            Some(0),
        );
        let response = json!({
            "access_token": fake_jwt(4_000_000_000_i64),
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let refreshed = refresh_credential(&declaration, &client, &current)
            .await
            .unwrap();

        assert_eq!(refreshed.access_token(), fake_jwt(4_000_000_000_i64));
        assert_eq!(refreshed.refresh_token(), Some("old-refresh"));
        assert_eq!(refreshed.id_token(), Some("old-id"));
        let bodies = client.bodies();
        assert_eq!(bodies.len(), 1);
        assert_eq!(bodies[0]["client_id"], "client-secret-sentinel");
        assert_eq!(bodies[0]["grant_type"], "refresh_token");
        assert_eq!(bodies[0]["refresh_token"], "old-refresh");
        assert_eq!(bodies[0]["scope"], CODEX_REFRESH_SCOPE);
    }

    #[tokio::test]
    async fn oauth_refresh_does_not_inherit_expiry_for_an_opaque_replacement() {
        let dir = temp_dir("rcc-oauth-opaque-refresh");
        let source = write_codex_auth(&dir, "old-access", Some("old-refresh"), None, Some(0));
        let declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let current =
            V3OAuthCredential::new("old-access", Some("old-refresh".to_string()), None, Some(0));
        let client = MockRefreshClient::with_response(
            200,
            &serde_json::to_vec(&json!({"access_token": "opaque-refreshed"})).unwrap(),
        );

        let refreshed = refresh_credential(&declaration, &client, &current)
            .await
            .unwrap();

        assert_eq!(refreshed.access_token(), "opaque-refreshed");
        assert_eq!(refreshed.expires_at(), None);
    }

    #[tokio::test]
    async fn oauth_refresh_returns_typed_rejection_and_invalid_response() {
        let dir = temp_dir("rcc-oauth-refresh-errors");
        let source = write_codex_auth(&dir, "old-access", Some("old-refresh"), None, Some(0));
        let declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let current =
            V3OAuthCredential::new("old-access", Some("old-refresh".to_string()), None, Some(0));

        let rejected = MockRefreshClient::with_response(400, b"rejected");
        assert_eq!(
            refresh_credential(&declaration, &rejected, &current)
                .await
                .unwrap_err(),
            V3OAuthError::RefreshRejected { status: 400 }
        );

        let invalid = MockRefreshClient::with_response(200, b"not json");
        assert_eq!(
            refresh_credential(&declaration, &invalid, &current)
                .await
                .unwrap_err(),
            V3OAuthError::RefreshResponse
        );
    }

    #[tokio::test]
    async fn oauth_file_store_initializes_and_restores_without_source_fallback() {
        let dir = temp_dir("rcc-oauth-store");
        let source = write_codex_auth(&dir, "old-access", Some("old-refresh"), None, Some(0));
        let store_path = dir.path().join("oauth-store.json");
        let declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let first = resolve_oauth_access_token_with_client(&declaration, &client)
            .await
            .unwrap();
        assert_eq!(first, future_access);
        assert_eq!(client.call_count(), 1);
        assert!(store_path.exists());

        let restored = read_store_or_initialize(&declaration, &store_path)
            .await
            .unwrap();
        assert_eq!(restored.access_token(), future_access);
        assert_eq!(restored.refresh_token(), Some("rotated-refresh"));

        std::fs::write(&store_path, b"corrupt").unwrap();
        assert_eq!(
            read_store_or_initialize(&declaration, &store_path)
                .await
                .unwrap_err(),
            V3OAuthError::StoreRead
        );
    }

    #[tokio::test]
    async fn oauth_store_rejects_source_alias() {
        let dir = temp_dir("rcc-oauth-store-conflict");
        let source = write_codex_auth(&dir, "access", Some("refresh"), None, None);
        let declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: source.display().to_string(),
            },
            300,
        );
        let client = MockRefreshClient::default();

        assert_eq!(
            resolve_oauth_access_token_with_client(&declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::StoreSourceConflict
        );
        assert_eq!(client.call_count(), 0);
    }

    #[tokio::test]
    async fn oauth_store_rejects_source_aliasing_the_lock_sidecar() {
        let dir = temp_dir("rcc-oauth-lock-conflict");
        let store_path = dir.path().join("oauth-store.json");
        let source = dir.path().join("oauth-store.json.lock");
        write_codex_auth(&dir, "access", Some("refresh"), None, None);
        std::fs::rename(dir.path().join("auth.json"), &source).unwrap();
        let before = std::fs::read(&source).unwrap();
        let declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let client = MockRefreshClient::default();

        assert_eq!(
            resolve_oauth_access_token_with_client(&declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::StoreSourceConflict
        );
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(client.call_count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oauth_store_rejects_source_hard_linked_to_the_lock_sidecar() {
        let dir = temp_dir("rcc-oauth-lock-hardlink");
        let source = write_codex_auth(&dir, "access", Some("refresh"), None, None);
        let store_path = dir.path().join("oauth-store.json");
        std::fs::hard_link(&source, dir.path().join("oauth-store.json.lock")).unwrap();
        let before = std::fs::read(&source).unwrap();
        let declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let client = MockRefreshClient::default();

        assert_eq!(
            resolve_oauth_access_token_with_client(&declaration, &client)
                .await
                .unwrap_err(),
            V3OAuthError::StoreSourceConflict
        );
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert_eq!(client.call_count(), 0);
    }

    #[tokio::test]
    async fn oauth_private_store_creation_is_owner_only() {
        let dir = temp_dir("rcc-oauth-private-store");
        let path = dir.path().join("staging.json");
        write_private_file(&path, b"secret").await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(std::fs::read(&path).unwrap(), b"secret");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oauth_private_store_creation_refuses_an_existing_symlink() {
        let dir = temp_dir("rcc-oauth-private-symlink");
        let target = dir.path().join("target.json");
        std::fs::write(&target, b"unchanged").unwrap();
        let path = dir.path().join("staging.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();

        assert!(write_private_file(&path, b"secret").await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
    }

    #[tokio::test]
    async fn oauth_store_does_not_delete_a_preexisting_staging_path() {
        let dir = temp_dir("rcc-oauth-staging-collision");
        let source_path = dir.path().join("auth.json");
        let store_path = dir.path().join("oauth-store.json");
        std::fs::write(&source_path, b"source-bytes").unwrap();

        let result = write_store_with_temp_path(&store_path, b"store-bytes", &source_path).await;

        assert_eq!(result.unwrap_err(), V3OAuthError::StoreWrite);
        assert_eq!(std::fs::read(&source_path).unwrap(), b"source-bytes");
        assert!(!store_path.exists());
    }

    #[tokio::test]
    async fn oauth_concurrent_refresh_consumes_one_rotation() {
        let dir = temp_dir("rcc-oauth-concurrent");
        let source = write_codex_auth(&dir, "old-access", Some("old-refresh"), None, Some(0));
        let declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&declaration, &client),
            resolve_oauth_access_token_with_client(&declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(client.call_count(), 1);
    }

    #[tokio::test]
    async fn oauth_memory_identity_excludes_refresh_policy() {
        let dir = temp_dir("rcc-oauth-memory-identity");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("refresh-one"), None, None);
        let first_declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let second_declaration = declaration(&source, V3OAuthStore::Memory, 0);
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&first_declaration, &client),
            resolve_oauth_access_token_with_client(&second_declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(
            client.call_count(),
            1,
            "refresh policy must not split one credential identity"
        );
    }

    #[tokio::test]
    async fn oauth_memory_identity_canonicalizes_source_aliases() {
        let dir = temp_dir("rcc-oauth-memory-source-alias");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("refresh-one"), None, None);
        let alias = dir.path().join(".").join("auth.json");
        let first_declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let second_declaration = declaration(&alias, V3OAuthStore::Memory, 300);
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&first_declaration, &client),
            resolve_oauth_access_token_with_client(&second_declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(
            client.call_count(),
            1,
            "equivalent source paths must share one credential identity"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oauth_memory_identity_uses_the_source_inode_for_hard_links() {
        let dir = temp_dir("rcc-oauth-memory-hard-link");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("refresh-one"), None, None);
        let alias = dir.path().join("auth-alias.json");
        std::fs::hard_link(&source, &alias).unwrap();
        let first_declaration = declaration(&source, V3OAuthStore::Memory, 300);
        let second_declaration = declaration(&alias, V3OAuthStore::Memory, 300);
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&first_declaration, &client),
            resolve_oauth_access_token_with_client(&second_declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(
            client.call_count(),
            1,
            "hard-linked source names must share one credential identity"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oauth_file_store_uses_one_target_across_symlink_aliases() {
        let dir = temp_dir("rcc-oauth-store-symlink");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("source-refresh"), None, None);
        let store_path = dir.path().join("oauth-store.json");
        let alias_path = dir.path().join("oauth-store-alias.json");
        write_store(
            &store_path,
            &V3OAuthCredential::new(
                "stale-access",
                Some("stale-refresh".to_string()),
                None,
                Some(0),
            ),
        )
        .await
        .unwrap();
        std::os::unix::fs::symlink(&store_path, &alias_path).unwrap();
        let first_declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: alias_path.display().to_string(),
            },
            300,
        );
        let second_declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let first = resolve_oauth_access_token_with_client(&first_declaration, &client)
            .await
            .unwrap();
        let second = resolve_oauth_access_token_with_client(&second_declaration, &client)
            .await
            .unwrap();

        assert_eq!(first, future_access);
        assert_eq!(second, future_access);
        assert_eq!(client.call_count(), 1);
        assert!(std::fs::symlink_metadata(&alias_path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oauth_file_store_resolves_symlink_target_before_initialization() {
        let dir = temp_dir("rcc-oauth-store-dangling-symlink");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("source-refresh"), None, None);
        let store_path = dir.path().join("oauth-store.json");
        let alias_path = dir.path().join("oauth-store-alias.json");
        std::os::unix::fs::symlink(&store_path, &alias_path).unwrap();
        let first_declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: alias_path.display().to_string(),
            },
            300,
        );
        let second_declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&first_declaration, &client),
            resolve_oauth_access_token_with_client(&second_declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(
            client.call_count(),
            1,
            "a dangling store alias and its target must share one identity and lock"
        );
        assert!(std::fs::symlink_metadata(&alias_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(store_path.exists());
    }

    #[tokio::test]
    async fn oauth_file_store_allows_missing_parent_depth_without_symlink_hops() {
        let dir = temp_dir("rcc-oauth-store-deep-parents");
        let source = write_codex_auth(&dir, &fake_jwt(0), Some("source-refresh"), None, None);
        let mut store_path = dir.path().to_path_buf();
        for index in 0..42 {
            store_path.push(format!("missing-{index}"));
        }
        store_path.push("oauth-store.json");
        let declaration = declaration(
            &source,
            V3OAuthStore::File {
                path: store_path.display().to_string(),
            },
            300,
        );
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let token = resolve_oauth_access_token_with_client(&declaration, &client)
            .await
            .unwrap();

        assert_eq!(token, future_access);
        assert!(store_path.exists());
    }

    #[tokio::test]
    async fn oauth_shared_file_store_serializes_one_rotation_across_identities() {
        let dir = temp_dir("rcc-oauth-store-lock");
        let source = write_codex_auth(&dir, "old-access", Some("old-refresh"), None, Some(0));
        let store_path = dir.path().join("shared-store.json");
        let store = V3OAuthStore::File {
            path: store_path.display().to_string(),
        };
        let future_access = fake_jwt(4_000_000_000_i64);
        let response = json!({
            "access_token": future_access,
            "refresh_token": "rotated-refresh",
        });
        // Different client_id gives each declaration its own in-process identity
        // lock, so only the cross-process store lock can serialize the two
        // rotations that share one store.
        let mut first_declaration = declaration(&source, store.clone(), 300);
        first_declaration.client_id = "client-a".to_string();
        let mut second_declaration = declaration(&source, store, 300);
        second_declaration.client_id = "client-b".to_string();
        let client = MockRefreshClient::with_response(200, &serde_json::to_vec(&response).unwrap());

        let (first, second) = tokio::join!(
            resolve_oauth_access_token_with_client(&first_declaration, &client),
            resolve_oauth_access_token_with_client(&second_declaration, &client)
        );

        assert_eq!(first.unwrap(), future_access);
        assert_eq!(second.unwrap(), future_access);
        assert_eq!(
            client.call_count(),
            1,
            "a shared file store must consume one rotating refresh token once"
        );
    }

    #[test]
    fn oauth_declaration_debug_redacts_client_and_endpoint() {
        let declaration = V3OAuthDeclaration {
            oauth_source: V3OAuthSource::CodexAuthJson {
                path: "/tmp/auth.json".to_string(),
            },
            refresh_endpoint: "https://token.example/secret-endpoint".to_string(),
            client_id: "client-secret-sentinel".to_string(),
            refresh_before_seconds: 300,
            oauth_store: V3OAuthStore::Memory,
        };
        let debug = format!("{declaration:?}");

        assert!(!debug.contains("client-secret-sentinel"));
        assert!(!debug.contains("https://token.example/secret-endpoint"));
        assert!(debug.contains("[REDACTED]"));
    }
}
