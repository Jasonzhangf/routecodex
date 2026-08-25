use crate::{ExecutionBinding, RuntimeFault};
use super::request_port::RequestPortLease;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponsePortReceipt {
    pub request_id: String,
    pub binding: ExecutionBinding,
    pub terminal: bool,
}

/// Response and error consumption is terminal only after the request lease
/// proves the same immutable execution binding; no active epoch is reselected
/// and no response payload is used to reconstruct control state.
pub fn consume_response(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
) -> Result<ResponsePortReceipt, RuntimeFault> {
    validate_binding(request, binding, "response")?;
    Ok(ResponsePortReceipt {
        request_id: request.request_id().to_string(),
        binding: request.binding().clone(),
        terminal: true,
    })
}

pub fn consume_error(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
) -> Result<ResponsePortReceipt, RuntimeFault> {
    validate_binding(request, binding, "error")?;
    Ok(ResponsePortReceipt {
        request_id: request.request_id().to_string(),
        binding: request.binding().clone(),
        terminal: true,
    })
}

fn validate_binding(
    request: &RequestPortLease,
    binding: &ExecutionBinding,
    stage: &str,
) -> Result<(), RuntimeFault> {
    let snapshot = request.lease_snapshot();
    if request.binding() != binding
        || snapshot.plan_epoch != binding.plan_epoch
        || snapshot.manifest_hash != binding.manifest_hash
    {
        return Err(RuntimeFault::new(
            "response_error_epoch_binding",
            format!("{stage} port binding differs from request admission lease"),
        ));
    }
    Ok(())
}
