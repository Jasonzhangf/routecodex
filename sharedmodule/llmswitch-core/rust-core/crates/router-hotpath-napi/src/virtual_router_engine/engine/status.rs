use serde_json::{json, Value};

use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::engine::selection::quota_state_blocks_provider;
use crate::virtual_router_engine::time_utils::now_ms;

impl VirtualRouterEngineCore {
    pub(crate) fn get_status(&self) -> Value {
        let mut routes = serde_json::Map::new();
        for (route, pools) in &self.routing.pools {
            routes.insert(
                route.clone(),
                json!({
                    "providers": self.routing.flatten_targets(pools),
                    "hits": 0,
                }),
            );
        }
        let now = now_ms();
        json!({
            "routes": routes,
            "health": self.health_manager.snapshot(),
            "quota": self.quota_manager.snapshot(),
            "quotaHostSnapshot": self.quota_manager.host_snapshot(),
            "forwarders": self.forwarder_status_snapshot(now),
        })
    }

    fn forwarder_status_snapshot(&self, now: i64) -> Value {
        let forwarders = self
            .forwarder_registry
            .list_entries()
            .into_iter()
            .map(|entry| {
                let targets = entry
                    .targets
                    .iter()
                    .map(|target| self.forwarder_target_status_snapshot(target, now))
                    .collect::<Vec<Value>>();
                json!({
                    "forwarderId": entry.forwarder_id,
                    "protocol": entry.protocol,
                    "modelId": entry.model_id,
                    "strategy": serde_json::to_value(entry.strategy)
                        .unwrap_or_else(|_| Value::String("unknown".to_string())),
                    "stickyKey": serde_json::to_value(entry.sticky_key)
                        .unwrap_or_else(|_| Value::String("unknown".to_string())),
                    "targets": targets,
                })
            })
            .collect::<Vec<Value>>();
        Value::Array(forwarders)
    }

    fn forwarder_target_status_snapshot(
        &self,
        target: &crate::virtual_router_engine::forwarder::ForwarderTarget,
        now: i64,
    ) -> Value {
        let profile = self.provider_registry.get(&target.provider_key);
        let provider_enabled = profile.map(|item| item.enabled).unwrap_or(false);
        let runtime_key = profile.and_then(|item| item.runtime_key.clone());
        let concurrency_busy_remaining_ms =
            self.concurrency_busy_remaining_for_provider(&target.provider_key, now);
        let quota_blocker = self.quota_manager.active_blocker(&target.provider_key, now);
        let quota_blocks = quota_blocker
            .as_ref()
            .map(|state| quota_state_blocks_provider(state, now))
            .unwrap_or(false);
        let health_cooldown_remaining_ms = self
            .health_manager
            .cooldown_remaining_ms(&target.provider_key, now);
        let health_state = self.health_manager.describe_state(&target.provider_key);
        let health_available = health_cooldown_remaining_ms.is_none()
            && health_state
                .as_ref()
                .and_then(|state| state.get("state").and_then(|value| value.as_str()))
                .map(|state| state == "healthy")
                .unwrap_or(true);
        let available = !target.disabled
            && provider_enabled
            && concurrency_busy_remaining_ms.is_none()
            && !quota_blocks
            && health_available;
        json!({
            "providerKey": target.provider_key,
            "disabled": target.disabled,
            "providerRegistered": profile.is_some(),
            "providerEnabled": provider_enabled,
            "runtimeKey": runtime_key,
            "concurrencyBusyRemainingMs": concurrency_busy_remaining_ms,
            "quotaBlocker": quota_blocker,
            "quotaBlocks": quota_blocks,
            "healthState": health_state,
            "healthCooldownRemainingMs": health_cooldown_remaining_ms,
            "available": available,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn build_forwarder_status_test_config() -> Value {
        json!({
            "routing": {
                "default": [
                    {
                        "id": "default-primary",
                        "targets": ["fwd.gpt.gpt-test"],
                        "priority": 100
                    }
                ]
            },
            "providers": {
                "sdfv.key1.gpt-test": {
                    "providerKey": "sdfv.key1.gpt-test",
                    "providerType": "openai-responses",
                    "enabled": true,
                    "outboundProfile": "openai-responses",
                    "runtimeKey": "sdfv.key1",
                    "modelId": "gpt-test"
                },
                "1token.key1.gpt-test": {
                    "providerKey": "1token.key1.gpt-test",
                    "providerType": "openai-responses",
                    "enabled": true,
                    "outboundProfile": "openai-responses",
                    "runtimeKey": "1token.key1",
                    "modelId": "gpt-test"
                }
            },
            "forwarders": {
                "fwd.gpt.gpt-test": {
                    "forwarderId": "fwd.gpt.gpt-test",
                    "protocol": "openai-responses",
                    "modelId": "gpt-test",
                    "resolutionMode": "model-first",
                    "strategy": "round-robin",
                    "targets": [
                        {
                            "providerKey": "sdfv.key1.gpt-test",
                            "weight": null,
                            "priority": null,
                            "disabled": false
                        },
                        {
                            "providerKey": "1token.key1.gpt-test",
                            "weight": null,
                            "priority": null,
                            "disabled": false
                        }
                    ],
                    "stickyKey": "none"
                }
            }
        })
    }

    fn find_target<'a>(status: &'a Value, provider_key: &str) -> &'a Value {
        status["forwarders"]
            .as_array()
            .expect("forwarders")
            .iter()
            .flat_map(|forwarder| forwarder["targets"].as_array().expect("targets").iter())
            .find(|target| target["providerKey"].as_str() == Some(provider_key))
            .expect("target")
    }

    #[test]
    fn forwarder_status_reports_registered_available_targets() {
        let mut core = VirtualRouterEngineCore::new();
        core.initialize(&build_forwarder_status_test_config())
            .expect("initialize");

        let status = core.get_status();
        let forwarder = &status["forwarders"].as_array().expect("forwarders")[0];
        assert_eq!(forwarder["forwarderId"].as_str(), Some("fwd.gpt.gpt-test"));
        assert_eq!(forwarder["strategy"].as_str(), Some("round-robin"));
        assert_eq!(forwarder["stickyKey"].as_str(), Some("none"));

        let sdfv = find_target(&status, "sdfv.key1.gpt-test");
        assert_eq!(sdfv["providerRegistered"].as_bool(), Some(true));
        assert_eq!(sdfv["providerEnabled"].as_bool(), Some(true));
        assert_eq!(sdfv["runtimeKey"].as_str(), Some("sdfv.key1"));
        assert_eq!(sdfv["quotaBlocks"].as_bool(), Some(false));
        assert_eq!(sdfv["available"].as_bool(), Some(true));
    }

    #[test]
    fn forwarder_status_reports_runtime_concurrency_blocker() {
        let mut core = VirtualRouterEngineCore::new();
        core.initialize(&build_forwarder_status_test_config())
            .expect("initialize");
        core.mark_concurrency_scope_busy("sdfv.key1");

        let status = core.get_status();
        let sdfv = find_target(&status, "sdfv.key1.gpt-test");
        assert_eq!(sdfv["available"].as_bool(), Some(false));
        assert!(sdfv["concurrencyBusyRemainingMs"]
            .as_i64()
            .is_some_and(|value| value > 0));

        let one_token = find_target(&status, "1token.key1.gpt-test");
        assert_eq!(one_token["available"].as_bool(), Some(true));
    }
}
