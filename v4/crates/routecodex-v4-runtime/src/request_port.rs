use crate::{execution_binding, ExecutionBinding, ExecutionContext, RuntimeFault};
use routecodex_v4_node_container::{ActiveEpochStore, EpochLease};
use routecodex_v4_skeleton::SkeletonPlan;

/// Request-local admission carrier. Lease and immutable binding are acquired
/// together; consumers cannot reacquire the active epoch through this type.
/// The port owns the request-to-epoch pin; response/error ports may only
/// consume the binding carried by this lease, and admission never consults a
/// second runtime configuration source.
pub struct RequestPortLease {
    request_id: String,
    binding: ExecutionBinding,
    lease: EpochLease,
}

impl RequestPortLease {
    pub fn admit(
        store: &ActiveEpochStore,
        request_id: &str,
        plan: &SkeletonPlan,
    ) -> Result<Self, RuntimeFault> {
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
        })
    }

    pub fn request_id(&self) -> &str { &self.request_id }
    pub fn binding(&self) -> &ExecutionBinding { &self.binding }
    pub fn lease_snapshot(&self) -> routecodex_v4_node_container::ExecutionEpochSnapshot {
        self.lease.snapshot()
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
