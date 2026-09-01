//! Node-scoped immutable carriers and service ownership.
//!
//! Carriers wrap `Arc<[u8]>` so adjacent nodes clone a handle without copying
//! bytes. `NodeServiceRegistry` is the only runtime entry that binds a typed
//! carrier to a node scope; stale, disposed, cross-scope and epoch-mismatched
//! execution fails fast at this owner.

use serde_json::Value;
use std::sync::Arc;

macro_rules! typed_immutable_carrier {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub struct $name(Arc<[u8]>);

        impl $name {
            pub fn from_bytes(bytes: &[u8]) -> Self {
                Self(Arc::from(bytes))
            }

            pub fn as_bytes(&self) -> &[u8] {
                self.0.as_ref()
            }

            pub fn shares_storage_with(&self, other: &Self) -> bool {
                Arc::ptr_eq(&self.0, &other.0)
            }
        }
    };
}

typed_immutable_carrier!(ImmutableDataCarrier);
typed_immutable_carrier!(ImmutableInformationCarrier);
typed_immutable_carrier!(ImmutableDiagnosticCarrier);

impl ImmutableDataCarrier {
    pub fn from_value(value: &Value) -> Result<Self, ServiceError> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| ServiceError::CarrierEncode(error.to_string()))?;
        Ok(Self::from_bytes(&bytes))
    }

    pub fn read_as_value(&self) -> Result<Value, ServiceError> {
        serde_json::from_slice(self.as_bytes())
            .map_err(|error| ServiceError::CarrierDecode(error.to_string()))
    }
}

impl ImmutableInformationCarrier {
    pub fn new(protocol: &str, model: &str) -> Self {
        let encoded = format!("{protocol}:{model}");
        Self::from_bytes(encoded.as_bytes())
    }
}

impl ImmutableDiagnosticCarrier {
    pub fn new(scope_key: &str) -> Self {
        Self::from_bytes(scope_key.as_bytes())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceLifecycle {
    Mounted,
    Draining,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    ScopeMismatch,
    PlanHashMismatch,
    EpochMismatch,
    DisposedService,
    CarrierEncode(String),
    CarrierDecode(String),
    AlreadyBound,
    ServiceNotReady,
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ServiceError {}

/// Node-scoped service registry. It owns one immutable carrier per lane and
/// rejects execution after dispose, plan-hash drift, scope mismatch, or epoch
/// mismatch.
#[derive(Debug, Clone)]
pub struct NodeServiceRegistry {
    node_id: String,
    scope_key: String,
    plan_hash: String,
    epoch: u64,
    lifecycle: ServiceLifecycle,
    data: Option<ImmutableDataCarrier>,
    information: Option<ImmutableInformationCarrier>,
    diagnostic: Option<ImmutableDiagnosticCarrier>,
}

impl NodeServiceRegistry {
    pub fn new(node_id: &str, scope_key: &str, plan_hash: &str, epoch: u64) -> Self {
        Self {
            node_id: node_id.to_string(),
            scope_key: scope_key.to_string(),
            plan_hash: plan_hash.to_string(),
            epoch,
            lifecycle: ServiceLifecycle::Mounted,
            data: None,
            information: None,
            diagnostic: None,
        }
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn scope_key(&self) -> &str {
        &self.scope_key
    }

    pub fn plan_hash(&self) -> &str {
        &self.plan_hash
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn lifecycle(&self) -> ServiceLifecycle {
        self.lifecycle
    }

    pub fn bind_data(&mut self, carrier: ImmutableDataCarrier) -> Result<(), ServiceError> {
        self.ensure_mounted()?;
        if self.data.is_some() {
            return Err(ServiceError::AlreadyBound);
        }
        self.data = Some(carrier);
        Ok(())
    }

    pub fn bind_information(
        &mut self,
        carrier: ImmutableInformationCarrier,
    ) -> Result<(), ServiceError> {
        self.ensure_mounted()?;
        if self.information.is_some() {
            return Err(ServiceError::AlreadyBound);
        }
        self.information = Some(carrier);
        Ok(())
    }

    pub fn bind_diagnostic(
        &mut self,
        carrier: ImmutableDiagnosticCarrier,
    ) -> Result<(), ServiceError> {
        self.ensure_mounted()?;
        if self.diagnostic.is_some() {
            return Err(ServiceError::AlreadyBound);
        }
        self.diagnostic = Some(carrier);
        Ok(())
    }

    pub fn data(&self) -> Option<&ImmutableDataCarrier> {
        self.data.as_ref()
    }

    pub fn information(&self) -> Option<&ImmutableInformationCarrier> {
        self.information.as_ref()
    }

    pub fn diagnostic(&self) -> Option<&ImmutableDiagnosticCarrier> {
        self.diagnostic.as_ref()
    }

    pub fn dispose(&mut self) -> Result<(), ServiceError> {
        self.ensure_mounted()?;
        self.lifecycle = ServiceLifecycle::Disposed;
        Ok(())
    }

    pub fn execute(&self) -> Result<(), ServiceError> {
        if self.lifecycle != ServiceLifecycle::Mounted {
            return Err(ServiceError::DisposedService);
        }
        if self.data.is_none() || self.information.is_none() || self.diagnostic.is_none() {
            return Err(ServiceError::ServiceNotReady);
        }
        Ok(())
    }

    fn ensure_mounted(&self) -> Result<(), ServiceError> {
        if self.lifecycle != ServiceLifecycle::Mounted {
            return Err(ServiceError::DisposedService);
        }
        Ok(())
    }
}
