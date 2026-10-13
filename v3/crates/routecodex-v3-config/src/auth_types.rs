use serde::{Deserialize, Serialize};
use std::fmt;

use crate::types::V3SelectionPolicy;
use routecodex_v3_oauth::{V3OAuthDeclaration, V3OAuthSource, V3OAuthStore};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthAuthoringConfig {
    #[serde(rename = "type")]
    pub auth_type: V3ProviderAuthType,
    #[serde(default)]
    pub selection: V3SelectionPolicy,
    pub entries: Vec<V3ProviderAuthEntryAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3ProviderAuthType {
    #[serde(alias = "apikey")]
    ApiKey,
    #[serde(rename = "oauth", alias = "o_auth")]
    OAuth,
    TokenFile,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthEntryAuthoringConfig {
    pub alias: String,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub weight: Option<u32>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default, alias = "tokenFile")]
    pub token_file: Option<String>,
    #[serde(default, alias = "apiKey")]
    pub api_key: Option<String>,
    /// 集中 secret 文件（一个文件管理该 provider 的全部 key，每行 `name = value`）。
    /// 与 `secret_key` 成对使用：读取文件后按 name 取对应值。
    #[serde(default, alias = "secretFile")]
    pub secret_file: Option<String>,
    /// 集中 secret 文件内本 entry 对应的 key 名（`name` 行）。
    #[serde(default, alias = "secretKey")]
    pub secret_key: Option<String>,
    #[serde(default)]
    pub oauth_source: Option<V3OAuthSource>,
    #[serde(default)]
    pub refresh_endpoint: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub refresh_before_seconds: Option<u64>,
    #[serde(default)]
    pub oauth_store: Option<V3OAuthStore>,
}

impl fmt::Debug for V3ProviderAuthEntryAuthoringConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("V3ProviderAuthEntryAuthoringConfig")
            .field("alias", &self.alias)
            .field("env", &self.env)
            .field("token_file", &self.token_file)
            .field("secret_file", &self.secret_file)
            .field("secret_key", &self.secret_key)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("oauth_source", &self.oauth_source)
            .field(
                "refresh_endpoint",
                &self.refresh_endpoint.as_ref().map(|_| "[REDACTED]"),
            )
            .field("client_id", &self.client_id.as_ref().map(|_| "[REDACTED]"))
            .field("refresh_before_seconds", &self.refresh_before_seconds)
            .field("oauth_store", &self.oauth_store)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthManifest {
    pub auth_type: V3ProviderAuthType,
    pub selection: V3SelectionPolicy,
    pub entries: Vec<V3ProviderAuthEntryManifest>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct V3ProviderAuthEntryManifest {
    pub alias: String,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
    pub env: Option<String>,
    pub token_file: Option<String>,
    pub secret_file: Option<String>,
    pub secret_key: Option<String>,
    pub api_key: Option<String>,
    pub oauth_declaration: Option<V3OAuthDeclaration>,
}

impl fmt::Debug for V3ProviderAuthEntryManifest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("V3ProviderAuthEntryManifest")
            .field("alias", &self.alias)
            .field("env", &self.env)
            .field("token_file", &self.token_file)
            .field("secret_file", &self.secret_file)
            .field("secret_key", &self.secret_key)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("oauth_declaration", &self.oauth_declaration)
            .finish()
    }
}
