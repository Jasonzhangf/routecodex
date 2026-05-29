// RED TEST: Verify that build_route_queue includes fallback routes
// when the classifier selects "default" but default has no available providers.
//
// Current behavior: when classifier selects "default", queue = ["default"].
// If default's provider (sdfv) is unavailable, VR fails immediately.
// Expected: VR should include "thinking", "coding", "tools" as fallback candidates.
//
// Run: cd sharedmodule/llmswitch-core/rust-core && cargo test --package router-hotpath-napi build_route_queue_default_fallback -- --nocapture

#[cfg(test)]
mod tests {
    use crate::virtual_router_engine::routing::config::build_route_queue;
    use crate::virtual_router_engine::routing::config::RoutingPools;
    use crate::virtual_router_engine::features::RoutingFeatures;
    use std::collections::HashMap;

    fn make_routing_with_pools(targets: Vec<(&str, Vec<&str>)>) -> RoutingPools {
        let mut routing_json = serde_json::json!({});
        for (route, providers) in targets {
            let pools = vec![serde_json::json!({
                "id": format!("pool-{}", route),
                "priority": 200,
                "backup": false,
                "targets": providers,
            })];
            routing_json[route] = serde_json::json!(pools);
        }
        let map = routing_json.as_object().unwrap().clone();
        RoutingPools::from_json_map(&map)
    }

    fn make_features(overrides: Option<serde_json::Value>) -> RoutingFeatures {
        let mut base = serde_json::json!({
            "requestId": "test-req",
            "model": "gpt-5.5",
            "totalMessages": 2,
            "userTextSample": "hello",
            "toolCount": 0,
            "hasTools": false,
            "hasToolCallResponses": false,
            "hasVisionTool": false,
            "hasImageAttachment": false,
            "hasVideoAttachment": false,
            "hasRemoteVideoAttachment": false,
            "hasLocalVideoAttachment": false,
            "hasWebTool": false,
            "hasWebSearchToolDeclared": false,
            "hasCodingTool": false,
            "hasThinkingKeyword": false,
            "hasExtendedThinkingKeyword": false,
            "estimatedTokens": 500,
            "latestMessageFromUser": true,
            "lastAssistantToolCategory": null,
            "lastAssistantToolLabel": null,
            "metadata": {
                "entryEndpoint": "/v1/responses",
                "processMode": "chat",
                "stream": true,
                "direction": "request",
                "requestId": "test-req"
            }
        });
        if let Some(o) = overrides {
            if let Some(obj) = o.as_object() {
                for (k, v) in obj {
                    base[k] = v.clone();
                }
            }
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn build_route_queue_default_fallback() {
        // Setup: default route has ONLY sdfv (unavailable)
        // thinking/coding/tools routes have mimo as fallback
        let routing = make_routing_with_pools(vec![
            ("default", vec!["sdfv.key1.gpt-5.5"]),
            ("thinking", vec!["mimo.key1.mimo-v2.5-pro", "mimo.key2.mimo-v2.5-pro"]),
            ("coding", vec!["mimo.key1.mimo-v2.5"]),
            ("tools", vec!["mimo.key1.mimo-v2.5"]),
        ]);

        // Classifier selects "default" (no specific route matched)
        let features = make_features(None);
        let candidates: Vec<String> = vec![]; // No specific route matched

        let queue = build_route_queue("default", &candidates, &features, &routing);

        // RED: Current behavior - queue is ["default"] only
        // When sdfv is unavailable, VR fails with NO fallback
        //
        // GREEN (expected): queue should include fallback routes
        // so the VR can try "thinking", "coding", or "tools" when
        // default's provider is unavailable.

        eprintln!("RED TEST: build_route_queue default_fallback");
        eprintln!("  classifier selected: default");
        eprintln!("  route queue: {:?}", queue);

        // This assertion FAILS (RED) with current code:
        // queue = ["default"] — no fallback
        //
        // After fix, this should PASS (GREEN):
        assert!(
            queue.len() > 1,
            "RED: When classifier selects 'default', queue should include fallback routes. Got: {:?}",
            queue
        );

        // Verify fallback routes are included
        assert!(
            queue.contains(&"thinking".to_string()) || queue.contains(&"coding".to_string()) || queue.contains(&"tools".to_string()),
            "RED: Queue should contain at least one fallback route (thinking/coding/tools). Got: {:?}",
            queue
        );
    }
}
