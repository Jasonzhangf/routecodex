use super::{normalize_v3_history_image_placeholders, V3HubReqInbound02Normalized};
use crate::operation_runner::{
    apply_canonical_field_edit, CanonicalFieldEdit, CurrentFieldAssociations,
    RequestInvocationContext, RequestOriginKind,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    pub(crate) previous: V3HubReqInbound02Normalized,
}

impl V3HubReqChatProcess04Governed {
    /// 治理后的 Chat canonical payload（Req04 治理原地修改 Req02 payload）。
    pub(crate) fn governed_payload(&self) -> &Value {
        self.previous.payload()
    }
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(
    mut input: V3HubReqInbound02Normalized,
) -> V3HubReqChatProcess04Governed {
    normalize_v3_history_image_placeholders(Arc::make_mut(&mut input.previous.payload.0));
    V3HubReqChatProcess04Governed { previous: input }
}

/// Apply registered structural edits and publish the request's current
/// source-reference associations exactly once.
pub fn govern_v3_operation_runner_current_request_fields(
    canonical: &Value,
    invocation: &RequestInvocationContext,
    edits: &[CanonicalFieldEdit],
) -> Result<Value, String> {
    let handle = invocation.request_handle();
    let mut data = canonical.clone();
    let mut current = match invocation.origin_kind() {
        RequestOriginKind::ClientEntry => match handle.current_field_associations_option()? {
            Some(current) => current,
            None => {
                let pair = handle.original_pair()?;
                CurrentFieldAssociations::from_normalization(&pair.inverse_context)
            }
        },
        RequestOriginKind::Retry
        | RequestOriginKind::InternalFollowup
        | RequestOriginKind::DirectRelayHandoff => {
            handle.current_field_associations_option()?.ok_or_else(|| {
                format!(
                    "request {} has no published current field associations for reentry",
                    handle.request_id()
                )
            })?
        }
    };

    for edit in edits {
        let (edited, edited_current) = apply_canonical_field_edit(&data, &current, edit)?;
        data = edited;
        current = edited_current;
    }

    handle.publish_current_field_associations(current)?;
    Ok(data)
}
