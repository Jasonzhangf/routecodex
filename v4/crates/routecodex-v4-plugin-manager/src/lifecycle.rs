//! Strict-fake lifecycle port used by tests while the M8 JS host-to-Rust
//! binding remains pending. Performs in-memory mount/drain/dispose so the
//! Manager can be tested without pulling Cordis internals into this crate.

use std::collections::BTreeMap;

use crate::manager::LifecyclePort;

#[derive(Debug, Default)]
pub struct NullLifecyclePort {
    mounted: BTreeMap<String, MountedNode>,
    rejected: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MountedNode {
    pub node_id: String,
    pub plan_hash: String,
    pub graph_hash: String,
}

impl NullLifecyclePort {
    pub fn mounted_nodes(&self) -> Vec<MountedNode> {
        self.mounted.values().cloned().collect()
    }

    pub fn rejected_nodes(&self) -> Vec<String> {
        self.rejected.clone()
    }
}

impl LifecyclePort for NullLifecyclePort {
    fn mount_candidate(
        &mut self,
        node_id: &str,
        plan_hash: &str,
        graph_hash: &str,
    ) -> Result<(), String> {
        if plan_hash.is_empty() || graph_hash.is_empty() {
            self.rejected.push(node_id.to_string());
            return Err(format!(
                "null lifecycle rejected mount for {node_id}: hash mismatch plan={plan_hash} graph={graph_hash}"
            ));
        }
        self.mounted.insert(
            node_id.to_string(),
            MountedNode {
                node_id: node_id.to_string(),
                plan_hash: plan_hash.to_string(),
                graph_hash: graph_hash.to_string(),
            },
        );
        Ok(())
    }

    fn drain(&mut self, node_id: &str) -> Result<(), String> {
        if self.mounted.remove(node_id).is_none() {
            return Err(format!("null lifecycle drain missing node {node_id}"));
        }
        Ok(())
    }

    fn dispose(&mut self, node_id: &str) -> Result<(), String> {
        self.mounted.remove(node_id);
        Ok(())
    }

    fn mounted_node_ids(&self) -> Vec<String> {
        self.mounted.keys().cloned().collect()
    }

    fn rejected_node_ids(&self) -> Vec<String> {
        self.rejected.clone()
    }
}
