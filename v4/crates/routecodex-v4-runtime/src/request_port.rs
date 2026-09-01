use crate::{execution_binding, ExecutionBinding, ExecutionContext, RuntimeFault};
use routecodex_v4_node_container::{ActiveEpochStore, EpochLease};
use routecodex_v4_skeleton::SkeletonPlan;
use std::sync::atomic::{AtomicBool, Ordering};

/// Request-local admission carrier. Lease and immutable binding are acquired
/// together; consumers cannot reacquire the active epoch through this type.
/// The port owns the request-to-epoch pin; response/error ports may only
/// consume the binding carried by this lease, and admission never consults a
/// second runtime configuration source.
pub struct RequestPortLease {
    request_id: String,
    binding: ExecutionBinding,
    lease: EpochLease,
    terminal_claimed: AtomicBool,
}

impl RequestPortLease {
    pub fn admit(
        store: &ActiveEpochStore,
        request_id: &str,
        plan: &SkeletonPlan,
    ) -> Result<Self, RuntimeFault> {
        if request_id.is_empty() {
            return Err(RuntimeFault::new(
                "request_identity",
                "request admission requires a non-empty request identity",
            ));
        }
        let lease = store
            .admit()
            .map_err(|error| RuntimeFault::new("request_epoch_admission", error.to_string()))?;
        let binding = execution_binding(plan);
        let snapshot = lease.snapshot();
        if snapshot.plan_epoch != binding.plan_epoch
            || snapshot.manifest_hash != binding.manifest_hash
        {
            return Err(RuntimeFault::new(
                "request_epoch_binding",
                "active epoch does not match immutable execution binding",
            ));
        }
        Ok(Self {
            request_id: request_id.to_string(),
            binding,
            lease,
            terminal_claimed: AtomicBool::new(false),
        })
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn binding(&self) -> &ExecutionBinding {
        &self.binding
    }
    pub fn lease_snapshot(&self) -> routecodex_v4_node_container::ExecutionEpochSnapshot {
        self.lease.snapshot()
    }

    pub(crate) fn claim_terminal(&self) -> Result<(), RuntimeFault> {
        self.terminal_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| RuntimeFault::new(
                "response_error_terminal",
                "request response/error terminal was already consumed",
            ))
    }

    pub fn context(&self, port: u16, session: &str, conversation: &str) -> ExecutionContext {
        ExecutionContext::with_scope(
            &self.request_id,
            self.binding.clone(),
            port,
            session,
            conversation,
        )
    }
}
