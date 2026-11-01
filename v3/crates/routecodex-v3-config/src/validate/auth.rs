use crate::auth_types::*;
use crate::types::V3SelectionStrategy;
use crate::{looks_like_secret_literal, validation, V3ConfigError};
use std::collections::BTreeSet;

use routecodex_v3_oauth::{V3OAuthDeclaration, V3OAuthSource, V3OAuthStore};

pub(super) fn compile_auth(
    provider_id: &str,
    authoring: V3ProviderAuthAuthoringConfig,
) -> Result<V3ProviderAuthManifest, V3ConfigError> {
    if matches!(
        authoring.selection.strategy,
        V3SelectionStrategy::RoundRobin | V3SelectionStrategy::Sticky
    ) {
        return Err(validation(format!(
            "provider {provider_id} auth only supports priority or weighted selection"
        )));
    }
    if authoring.entries.is_empty() {
        return Err(validation(format!(
            "provider {provider_id} auth entries are empty"
        )));
    }
    let mut aliases = BTreeSet::new();
    let mut entries = Vec::new();
    for entry in authoring.entries {
        if entry.priority.is_some_and(|priority| priority < 0) {
            return Err(validation(format!(
                "provider {provider_id} auth {} priority cannot be negative",
                entry.alias
            )));
        }
        if entry.weight.is_some_and(|weight| weight == 0) {
            return Err(validation(format!(
                "provider {provider_id} auth {} weight must be positive",
                entry.alias
            )));
        }
        super::require_id("auth alias", &entry.alias)?;
        if !aliases.insert(entry.alias.clone()) {
            return Err(validation(format!(
                "provider {provider_id} has duplicate auth alias {}",
                entry.alias
            )));
        }
        if authoring.auth_type == V3ProviderAuthType::OAuth {
            entries.push(compile_oauth_auth_entry(provider_id, entry)?);
            continue;
        }
        entries.push(compile_legacy_auth_entry(provider_id, entry)?);
    }
    Ok(V3ProviderAuthManifest {
        auth_type: authoring.auth_type,
        selection: authoring.selection.clone(),
        entries,
    })
}

fn compile_oauth_auth_entry(
    provider_id: &str,
    entry: V3ProviderAuthEntryAuthoringConfig,
) -> Result<V3ProviderAuthEntryManifest, V3ConfigError> {
    if entry.env.is_some()
        || entry.token_file.is_some()
        || entry.secret_file.is_some()
        || entry.secret_key.is_some()
        || entry.api_key.is_some()
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} OAuth must not mix env, token_file, secret_file, secret_key, or api_key",
            entry.alias
        )));
    }
    if entry.oauth_source.is_none()
        || entry.refresh_endpoint.is_none()
        || entry.client_id.is_none()
        || entry.oauth_store.is_none()
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} must declare oauth_source, refresh_endpoint, client_id, and oauth_store",
            entry.alias
        )));
    }
    let oauth_source = entry.oauth_source.expect("checked oauth_source");
    let V3OAuthSource::CodexAuthJson { path: source_path } = &oauth_source;
    if source_path.trim().is_empty() {
        return Err(validation(format!(
            "provider {provider_id} auth {} oauth_source path must not be empty",
            entry.alias
        )));
    }
    let refresh_endpoint = entry
        .refresh_endpoint
        .as_deref()
        .expect("checked refresh_endpoint")
        .trim()
        .to_string();
    if !is_absolute_http_url(&refresh_endpoint) {
        return Err(validation(format!(
            "provider {provider_id} auth {} refresh_endpoint must be an absolute http(s) URL",
            entry.alias
        )));
    }
    let client_id = entry
        .client_id
        .as_deref()
        .expect("checked client_id")
        .trim()
        .to_string();
    if client_id.is_empty() {
        return Err(validation(format!(
            "provider {provider_id} auth {} client_id must not be empty",
            entry.alias
        )));
    }
    let oauth_store = entry.oauth_store.expect("checked oauth_store");
    if let V3OAuthStore::File { path } = &oauth_store {
        if path.trim().is_empty() {
            return Err(validation(format!(
                "provider {provider_id} auth {} oauth_store path must not be empty",
                entry.alias
            )));
        }
    }
    if let (V3OAuthSource::CodexAuthJson { path: source_path }, V3OAuthStore::File { path }) =
        (&oauth_source, &oauth_store)
    {
        if source_path == path {
            return Err(validation(format!(
                "provider {provider_id} auth {} oauth_store must not be the oauth_source file",
                entry.alias
            )));
        }
    }
    Ok(V3ProviderAuthEntryManifest {
        alias: entry.alias,
        priority: entry.priority,
        weight: entry.weight,
        env: None,
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        oauth_declaration: Some(V3OAuthDeclaration {
            oauth_source,
            refresh_endpoint,
            client_id,
            refresh_before_seconds: entry
                .refresh_before_seconds
                .unwrap_or_else(routecodex_v3_oauth::default_refresh_before_seconds),
            oauth_store,
        }),
    })
}

fn compile_legacy_auth_entry(
    provider_id: &str,
    entry: V3ProviderAuthEntryAuthoringConfig,
) -> Result<V3ProviderAuthEntryManifest, V3ConfigError> {
    if entry.oauth_source.is_some()
        || entry.refresh_endpoint.is_some()
        || entry.client_id.is_some()
        || entry.refresh_before_seconds.is_some()
        || entry.oauth_store.is_some()
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} declares OAuth fields without auth.type = oauth",
            entry.alias
        )));
    }
    let handle_count = usize::from(entry.env.is_some())
        + usize::from(entry.token_file.is_some())
        + usize::from(entry.secret_file.is_some())
        + usize::from(entry.api_key.is_some());
    if handle_count != 1 {
        return Err(validation(format!(
            "provider {provider_id} auth {} must define exactly one of env, token_file, secret_file, or api_key", entry.alias
        )));
    }
    if entry.secret_file.is_some() != entry.secret_key.is_some() {
        return Err(validation(format!(
            "provider {provider_id} auth {} secret_file and secret_key must be declared together",
            entry.alias
        )));
    }
    if entry
        .secret_file
        .as_deref()
        .is_some_and(|path| path.trim().is_empty())
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} secret_file cannot be empty",
            entry.alias
        )));
    }
    if entry
        .secret_key
        .as_deref()
        .is_some_and(|key| key.trim().is_empty())
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} secret_key cannot be empty",
            entry.alias
        )));
    }
    if let (Some(secret_file), Some(secret_key)) = (&entry.secret_file, &entry.secret_key) {
        // 集中 secret 文件在编译期解析校验：文件可读、key 存在、值非空——fail-fast
        // 在 config check / 启动阶段暴露；值不写入 manifest（避免明文进快照）。
        crate::read_v3_secret_file_key(secret_file, secret_key).map_err(|error| {
            validation(format!(
                "provider {provider_id} auth {} secret_file validation failed: {error}",
                entry.alias
            ))
        })?;
    }
    if let Some(env) = &entry.env {
        if env.trim().is_empty() || looks_like_secret_literal(env) {
            return Err(validation(format!(
                "provider {provider_id} auth {} env must be a secret handle name",
                entry.alias
            )));
        }
    }
    if entry
        .token_file
        .as_deref()
        .is_some_and(|path| path.trim().is_empty())
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} token_file cannot be empty",
            entry.alias
        )));
    }
    if entry
        .api_key
        .as_deref()
        .is_some_and(|secret| secret.trim().is_empty())
    {
        return Err(validation(format!(
            "provider {provider_id} auth {} api_key cannot be empty",
            entry.alias
        )));
    }
    Ok(V3ProviderAuthEntryManifest {
        alias: entry.alias,
        priority: entry.priority,
        weight: entry.weight,
        env: entry.env,
        token_file: entry.token_file,
        secret_file: entry.secret_file,
        secret_key: entry.secret_key,
        api_key: entry.api_key,
        oauth_declaration: None,
    })
}

/// An absolute http(s) URL: the scheme, then a non-empty authority, and no
/// whitespace anywhere. Rejects `http://`, `https:// ` and `http://a b`.
fn is_absolute_http_url(value: &str) -> bool {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    let Some(rest) = rest else {
        return false;
    };
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
}
