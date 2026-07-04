//! Rust MetadataCenter — request-scoped registry for Hub Pipeline control semantics.
//!
//! Feature ID: hub.metadata_center_rust_registry
//!
//! This module provides a typed, request-scoped alternative to reading control
//! fields from `metadata.runtime_control`, `metadata.__rt`, and top-level
//! projections. It is populated from the TS-side `metadataCenterSnapshot`
//! and then consumed by Rust pipeline blocks as the first read source while
//! transitional payload residue is still being migrated.

mod builder;
mod reader;
mod types;
pub(crate) mod write_plan;

pub(crate) use builder::build_metadata_center_from_snapshot;
pub(crate) use reader::MetadataCenterReader;
pub(crate) use types::{
    CloseoutStatus, ContinuationContext, DebugSnapshot, HubStageTopEntry, MetadataCenter,
    ProviderObservation, RequestTruth, ResponseObservation, RuntimeControl, StopMessageControl,
    StoplessControl, TrafficGovernorControl,
};
pub(crate) use write_plan::{
    build_stopless_metadata_center_reset_write_plan, build_stopless_metadata_center_write_plan,
    StoplessMetadataCenterWritePlan,
};
