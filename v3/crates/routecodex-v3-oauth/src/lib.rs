// feature_id: v3.provider_oauth_credentials
//! Typed OAuth credential declarations, Codex auth.json reading, refresh,
//! and explicit memory/file credential stores for RouteCodex V3.

mod credential;
mod declaration;
mod error;
mod resolver;

pub use credential::{V3OAuthCredential, V3OAuthRefreshResponse};
pub use declaration::{
    default_refresh_before_seconds, V3OAuthDeclaration, V3OAuthSource, V3OAuthStore,
};
pub use error::V3OAuthError;
pub use resolver::{resolve_oauth_access_token_with_client, V3OAuthRefreshClient};
