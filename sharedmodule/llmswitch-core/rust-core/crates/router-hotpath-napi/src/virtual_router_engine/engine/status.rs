// feature_id: vr.online_diagnostics
use napi::Env;
use serde_json::{json, Value};

use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::error::VIRTUAL_ROUTER_ERROR_PREFIX;
use crate::virtual_router_engine::forwarder::ForwarderRegistry;
use crate::virtual_router_engine::routing_state_store::with_session_dir_persistence_disabled;
use crate::virtual_router_engine::time_utils::now_ms;

impl VirtualRouterEngineCore {
    pub(crate) fn get_status(&mut self) -> Value {
        let mut routes = serde_json::Map::new();
        for (route, pools) in &self.routing.pools {
            let expanded_pools = pools
                .iter()
                .map(|pool| self.route_pool_status_snapshot(route, pool, now_ms()))
                .collect::<Vec<Value>>();
            routes.insert(
                route.clone(),
                json!({
                    "providers": self.routing.flatten_targets(pools),
                    "pools": expanded_pools,
                    "hits": 0,
                }),
            );
        }
        let now = now_ms();
        json!({
            "routes": routes,
            "health": self.health_manager.snapshot(),
            "forwarders": self.forwarder_status_snapshot(now),
        })
    }

    pub(crate) fn diagnose_route(&mut self, env: Env, request: &Value, metadata: &Value) -> Value {
        let mut dry_run_core = self.clone();
        let result =
            with_session_dir_persistence_disabled(|| dry_run_core.route(env, request, metadata));
        match result {
            Ok(route_result) => json!({
                "ok": true,
                "status": self.get_status(),
                "target": route_result.get("target").cloned().unwrap_or(Value::Null),
                "routeResult": route_result,
                "decision": self.build_dry_run_decision(route_result.get("diagnostics"))
            }),
            Err(error) => json!({
                "ok": false,
                "status": self.get_status(),
                "error": parse_virtual_router_error_for_diagnostics(&error)
            }),
        }
    }

    fn build_dry_run_decision(&self, diagnostics: Option<&Value>) -> Value {
        let Some(diagnostics) = diagnostics else {
            return json!({
                "wouldReturnProviderNotAvailable": false
            });
        };
        json!({
            "selectedRouteName": diagnostics.get("routeName").cloned().unwrap_or(Value::Null),
            "selectedProviderKey": diagnostics.get("providerKey").cloned().unwrap_or(Value::Null),
            "selectedPoolId": diagnostics.get("poolId").cloned().unwrap_or(Value::Null),
            "candidateProviderKeys": diagnostics.get("routePool")
                .or_else(|| diagnostics.get("pool"))
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            "candidatePools": diagnostics.get("routePool").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "defaultFloorProtected": diagnostics.get("defaultFloorProtected").cloned().unwrap_or(Value::Bool(false)),
            "unavailableRoutePools": diagnostics.get("unavailableRoutePools").cloned().unwrap_or(Value::Null),
            "reasoning": diagnostics.get("reasoning").cloned().unwrap_or(Value::Null),
            "wouldReturnProviderNotAvailable": false
        })
    }

    fn route_pool_status_snapshot(
        &self,
        route_name: &str,
        pool: &crate::virtual_router_engine::routing::RoutePoolTier,
        now: i64,
    ) -> Value {
        let mut resolved_targets = Vec::new();
        let mut available_targets = Vec::new();
        let mut unavailable_providers = Vec::new();
        let mut resolved_forwarders = Vec::new();
        for target in &pool.targets {
            if ForwarderRegistry::is_forwarder_id(target) {
                if let Some(entry) = self.forwarder_registry.get(target) {
                    let target_provider_keys = entry
                        .targets
                        .iter()
                        .map(|item| item.provider_key.clone())
                        .collect::<Vec<String>>();
                    let mut forwarder_available = Vec::new();
                    let mut forwarder_unavailable = Vec::new();
                    for forwarder_target in &entry.targets {
                        if !resolved_targets.contains(&forwarder_target.provider_key) {
                            resolved_targets.push(forwarder_target.provider_key.clone());
                        }
                        let status = self.forwarder_target_status_snapshot(forwarder_target, now);
                        if status
                            .get("available")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                        {
                            if !available_targets.contains(&forwarder_target.provider_key) {
                                available_targets.push(forwarder_target.provider_key.clone());
                            }
                            forwarder_available.push(forwarder_target.provider_key.clone());
                        } else {
                            unavailable_providers.push(status.clone());
                            forwarder_unavailable.push(status);
                        }
                    }
                    resolved_forwarders.push(json!({
                        "forwarderId": entry.forwarder_id,
                        "protocol": entry.protocol,
                        "modelId": entry.model_id,
                        "strategy": serde_json::to_value(entry.strategy).unwrap_or(Value::Null),
                        "stickyKey": serde_json::to_value(entry.sticky_key).unwrap_or(Value::Null),
                        "targetProviderKeys": target_provider_keys,
                        "availableProviderKeys": forwarder_available,
                        "unavailableProviders": forwarder_unavailable,
                        "available": !forwarder_available.is_empty()
                    }));
                } else {
                    unavailable_providers.push(json!({
                        "providerKey": target,
                        "available": false,
                        "reasons": [{ "type": "forwarder_not_registered" }]
                    }));
                }
                continue;
            }
            if !resolved_targets.contains(target) {
                resolved_targets.push(target.clone());
            }
            let status = self.provider_target_status_snapshot(target, false, now);
            if status
                .get("available")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                available_targets.push(target.clone());
            } else {
                unavailable_providers.push(status);
            }
        }
        json!({
            "routeName": route_name,
            "poolId": pool.id,
            "poolPriority": pool.priority,
            "poolMode": pool.mode,
            "backup": pool.backup,
            "force": pool.force,
            "routeParams": pool.route_params,
            "thinking": pool.thinking,
            "configuredTargets": pool.targets,
            "resolvedTargets": resolved_targets,
            "resolvedForwarders": resolved_forwarders,
            "availableTargets": available_targets,
            "unavailableProviders": unavailable_providers,
            "defaultFloor": route_name == "default" && !pool.targets.is_empty()
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

    fn provider_target_status_snapshot(
        &self,
        provider_key: &str,
        disabled: bool,
        now: i64,
    ) -> Value {
        let profile = self.provider_registry.get(provider_key);
        let provider_enabled = profile.map(|item| item.enabled).unwrap_or(false);
        let runtime_key = profile.and_then(|item| item.runtime_key.clone());
        let concurrency_busy_remaining_ms =
            self.concurrency_busy_remaining_for_provider(provider_key, now);
        let health_cooldown_remaining_ms =
            self.health_manager.cooldown_remaining_ms(provider_key, now);
        let health_state = self.health_manager.describe_state(provider_key);
        let health_available = health_cooldown_remaining_ms.is_none()
            && health_state
                .as_ref()
                .and_then(|state| state.get("state").and_then(|value| value.as_str()))
                .map(|state| state == "healthy")
                .unwrap_or(true);
        let mut reasons = Vec::new();
        if disabled {
            reasons.push(json!({ "type": "target_disabled" }));
        }
        if profile.is_none() {
            reasons.push(json!({ "type": "provider_not_registered" }));
        }
        if !provider_enabled {
            reasons.push(json!({ "type": "provider_disabled" }));
        }
        if let Some(wait_ms) = concurrency_busy_remaining_ms {
            reasons.push(json!({ "type": "concurrency_busy", "waitMs": wait_ms }));
        }
        if let Some(wait_ms) = health_cooldown_remaining_ms {
            reasons.push(json!({
                "type": "health_cooldown",
                "waitMs": wait_ms,
                "state": health_state
            }));
        } else if health_state
            .as_ref()
            .and_then(|state| state.get("state").and_then(|value| value.as_str()))
            .map(|state| state != "healthy")
            .unwrap_or(false)
        {
            reasons.push(json!({ "type": "health_unavailable", "state": health_state }));
        }
        let available = !disabled
            && provider_enabled
            && concurrency_busy_remaining_ms.is_none()
            && health_available;
        json!({
            "providerKey": provider_key,
            "disabled": disabled,
            "providerRegistered": profile.is_some(),
            "providerEnabled": provider_enabled,
            "runtimeKey": runtime_key,
            "concurrencyBusyRemainingMs": concurrency_busy_remaining_ms,
            "healthState": health_state,
            "healthCooldownRemainingMs": health_cooldown_remaining_ms,
            "available": available,
            "reasons": reasons
        })
    }

    fn forwarder_target_status_snapshot(
        &self,
        target: &crate::virtual_router_engine::forwarder::ForwarderTarget,
        now: i64,
    ) -> Value {
        self.provider_target_status_snapshot(&target.provider_key, target.disabled, now)
    }
}

fn parse_virtual_router_error_for_diagnostics(error: &str) -> Value {
    let Some(rest) = error.strip_prefix(VIRTUAL_ROUTER_ERROR_PREFIX) else {
        return json!({
            "code": "UNKNOWN",
            "message": error,
            "raw": error
        });
    };
    let (code, body) = rest
        .split_once(':')
        .map(|(code, body)| (code, body))
        .unwrap_or((rest, ""));
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| body.to_string());
    let details = parsed
        .as_ref()
        .and_then(|value| value.get("details"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "code": code,
        "message": message,
        "details": details,
        "raw": error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use napi::Env;
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

    fn build_route_metadata(request_id: &str) -> Value {
        json!({
            "requestId": request_id,
            "metadataCenterSnapshot": {
                "requestId": request_id,
                "runtimeControl": {}
            }
        })
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
        assert_eq!(sdfv["available"].as_bool(), Some(true));
    }

    #[test]
    fn status_expands_route_pools_for_online_diagnostics() {
        let mut core = VirtualRouterEngineCore::new();
        core.initialize(&build_forwarder_status_test_config())
            .expect("initialize");

        let status = core.get_status();
        let default_route = &status["routes"]["default"];
        let pool = &default_route["pools"].as_array().expect("pools")[0];
        assert_eq!(pool["routeName"].as_str(), Some("default"));
        assert_eq!(pool["poolId"].as_str(), Some("default-primary"));
        assert_eq!(
            pool["configuredTargets"].as_array().expect("configured")[0].as_str(),
            Some("fwd.gpt.gpt-test")
        );
        let forwarder = &pool["resolvedForwarders"].as_array().expect("forwarders")[0];
        assert_eq!(forwarder["forwarderId"].as_str(), Some("fwd.gpt.gpt-test"));
        assert_eq!(
            forwarder["targetProviderKeys"]
                .as_array()
                .expect("target keys")
                .len(),
            2
        );
        assert_eq!(
            pool["availableTargets"]
                .as_array()
                .expect("available")
                .len(),
            2
        );
    }

    #[test]
    fn diagnose_route_does_not_advance_round_robin_state() {
        let mut core = VirtualRouterEngineCore::new();
        core.initialize(&build_forwarder_status_test_config())
            .expect("initialize");
        let request = json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });

        let dry_run = core.diagnose_route(
            unsafe { Env::from_raw(std::ptr::null_mut()) },
            &request,
            &build_route_metadata("req-dry-run"),
        );
        assert_eq!(dry_run["ok"].as_bool(), Some(true));
        assert_eq!(
            dry_run["decision"]["selectedProviderKey"].as_str(),
            Some("sdfv.key1.gpt-test")
        );

        let first_live = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &build_route_metadata("req-live-1"),
            )
            .expect("first live route");
        let second_live = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &build_route_metadata("req-live-2"),
            )
            .expect("second live route");
        assert_eq!(
            first_live["target"]["providerKey"].as_str(),
            Some("sdfv.key1.gpt-test")
        );
        assert_eq!(
            second_live["target"]["providerKey"].as_str(),
            Some("1token.key1.gpt-test")
        );
    }

    #[test]
    fn diagnose_route_preserves_default_floor_when_snapshot_excludes_all_forwarder_targets() {
        let mut core = VirtualRouterEngineCore::new();
        core.initialize(&build_forwarder_status_test_config())
            .expect("initialize");
        let request = json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        let metadata = json!({
            "requestId": "req-dry-run-excluded",
            "metadataCenterSnapshot": {
                "requestId": "req-dry-run-excluded",
                "excludedProviderKeys": [
                    "sdfv.key1.gpt-test",
                    "1token.key1.gpt-test"
                ],
                "runtimeControl": {}
            }
        });
        let dry_run = core.diagnose_route(
            unsafe { Env::from_raw(std::ptr::null_mut()) },
            &request,
            &metadata,
        );

        assert_eq!(dry_run["ok"].as_bool(), Some(true));
        assert_eq!(
            dry_run["decision"]["selectedRouteName"].as_str(),
            Some("default")
        );
        assert_eq!(
            dry_run["decision"]["selectedProviderKey"].as_str(),
            Some("sdfv.key1.gpt-test")
        );
        assert_eq!(
            dry_run["decision"]["defaultFloorProtected"].as_bool(),
            Some(true)
        );
        assert_eq!(
            dry_run["decision"]["wouldReturnProviderNotAvailable"].as_bool(),
            Some(false)
        );
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
