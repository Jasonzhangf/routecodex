// RED TEST: Verify that expand_routing_table creates individual targets
// for each auth entry (not collapsed into pool alias).
//
// This test MUST FAIL with the current pool alias behavior where
// a provider with 2 auth entries (key1, key2) gets collapsed into
// a single "pool" target instead of 2 individual targets.
//
// After the fix (removing PROVIDER_LEVEL_POOL_ALIAS check),
// this test should PASS (GREEN).
//
// Run: cd sharedmodule/llmswitch-core/rust-core && cargo test --package router-hotpath-napi expand_routing_table_alias_expansion -- --nocapture

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};
    use crate::virtual_router_engine::routing::bootstrap::expand_routing_table;
    
    #[test]
    fn expand_routing_table_alias_expansion() {
        // Setup: provider "mimo" with 2 auth entries (key1, key2)
        let mut alias_index = BTreeMap::new();
        alias_index.insert(
            "mimo".to_string(),
            vec!["key1".to_string(), "key2".to_string()],
        );
        
        let mut model_index = BTreeMap::new();
        let model_entry = serde_json::from_str(r#"{"declared": true, "models": ["mimo-v2.5"]}"#).unwrap();
        model_index.insert("mimo".to_string(), model_entry);
        
        // Setup routing: search route with target "mimo.mimo-v2.5"
        let routing_source_json = r#"{
            "search": [{
                "id": "test-search",
                "priority": 200,
                "backup": false,
                "targets": ["mimo.mimo-v2.5"],
                "loadBalancing": {
                    "strategy": "weighted",
                    "weights": { "mimo.mimo-v2.5": 1 }
                }
            }]
        }"#;
        
        let normalized_routing: BTreeMap<String, Vec<crate::virtual_router_engine::routing::bootstrap::NormalizedRoutePoolConfig>> =
            serde_json::from_str(routing_source_json).unwrap();
        
        let (routing, _target_keys) = expand_routing_table(
            &normalized_routing,
            &alias_index,
            &model_index,
        ).unwrap();
        
        let search_pools = routing.get("search").unwrap();
        assert_eq!(search_pools.len(), 1, "should have 1 pool");
        
        let pool = &search_pools[0];
        
        // RED: This assertion SHOULD FAIL with current pool alias behavior
        // Expected: 2 individual targets (key1, key2)
        // Actual (red): 1 pool target ("mimo.pool.mimo-v2.5")
        assert_eq!(
            pool.targets.len(),
            2,
            "RED: Provider with 2 auth entries should expand to 2 targets, not 1 pool target"
        );
        
        // Verify both key1 and key2 are present as individual targets
        assert!(
            pool.targets.contains(&"mimo.key1.mimo-v2.5".to_string()),
            "RED: mimo.key1.mimo-v2.5 should be a target"
        );
        assert!(
            pool.targets.contains(&"mimo.key2.mimo-v2.5".to_string()),
            "RED: mimo.key2.mimo-v2.5 should be a target"
        );
        
        // Verify the pool alias target is NOT present
        assert!(
            !pool.targets.contains(&"mimo.pool.mimo-v2.5".to_string()),
            "RED: mimo.pool.mimo-v2.5 should NOT be a target when individual keys exist"
        );
        
        // Verify weight keys are also expanded
        if let Some(ref lb) = pool.load_balancing {
            if let Some(ref weights) = lb.weights {
                assert!(
                    weights.contains_key("mimo.key1.mimo-v2.5"),
                    "RED: weight key mimo.key1.mimo-v2.5 should exist"
                );
                assert!(
                    weights.contains_key("mimo.key2.mimo-v2.5"),
                    "RED: weight key mimo.key2.mimo-v2.5 should exist"
                );
                assert!(
                    !weights.contains_key("mimo.mimo-v2.5"),
                    "RED: unexpanded weight key mimo.mimo-v2.5 should NOT exist"
                );
            }
        }
    }
}
