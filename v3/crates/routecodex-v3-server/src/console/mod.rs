// V3 server console projection and human-readable observability side-channel.
// This module formats/emits logs only; it must not own request/response/provider semantics.

mod color;
mod emit;
mod error;
mod finalizer;
mod format;

pub(super) use color::*;
pub(super) use emit::*;
pub(super) use error::*;
pub(super) use finalizer::*;
pub(super) use format::*;
