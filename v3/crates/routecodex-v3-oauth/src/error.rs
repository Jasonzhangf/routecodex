/// Typed OAuth credential failures. Variants carry no token, credential JSON,
/// refresh body, or provider response body.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum V3OAuthError {
    #[error("OAuth credential source could not be read")]
    SourceRead,
    #[error("OAuth credential source format is invalid")]
    SourceFormat,
    #[error("OAuth credential is missing a required token")]
    MissingCredential,
    #[error("OAuth refresh transport failed")]
    RefreshTransport,
    #[error("OAuth refresh endpoint rejected the credential")]
    RefreshRejected { status: u16 },
    #[error("OAuth refresh response is invalid")]
    RefreshResponse,
    #[error("OAuth credential store could not be read")]
    StoreRead,
    #[error("OAuth credential store could not be written")]
    StoreWrite,
    #[error("OAuth credential store is locked by another writer")]
    StoreLocked,
    #[error("OAuth credential store and source must not be the same file")]
    StoreSourceConflict,
}
