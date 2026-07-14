use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderResp09Raw {
    pub provider_id: String,
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}
