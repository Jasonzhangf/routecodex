use serde_json::{json, Value};

use super::VirtualRouterEngineCore;

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
        json!({
            "routes": routes,
            "health": self.health_manager.snapshot(),
        })
    }
}
