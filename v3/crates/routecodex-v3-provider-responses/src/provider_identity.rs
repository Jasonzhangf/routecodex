#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ProviderIdentityRef<'a> {
    pub provider_id: &'a str,
    pub auth_alias: Option<&'a str>,
    pub model_id: Option<&'a str>,
}

impl<'a> V3ProviderIdentityRef<'a> {
    pub fn new(
        provider_id: &'a str,
        auth_alias: Option<&'a str>,
        model_id: Option<&'a str>,
    ) -> Self {
        Self {
            provider_id,
            auth_alias,
            model_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ProviderKeyRef<'a> {
    pub provider_id: &'a str,
    pub auth_alias: &'a str,
    pub model_id: &'a str,
}

impl<'a> V3ProviderKeyRef<'a> {
    pub fn new(provider_id: &'a str, auth_alias: &'a str, model_id: &'a str) -> Self {
        Self {
            provider_id,
            auth_alias,
            model_id,
        }
    }
}
