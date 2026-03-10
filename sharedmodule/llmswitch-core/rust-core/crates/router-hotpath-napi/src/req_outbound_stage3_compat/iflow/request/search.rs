use serde_json::{json, Map, Value};

use super::super::super::AdapterContext;

const SEARCH_ROUTE_PREFIXES: [&str; 2] = ["web_search", "search"];

fn is_search_route(adapter_context: &AdapterContext) -> bool {
    let route_id = adapter_context
        .route_id
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    SEARCH_ROUTE_PREFIXES
        .iter()
        .any(|prefix| route_id.starts_with(prefix))
}

pub(super) fn apply_iflow_web_search_request_transform(
    root: &mut Map<String, Value>,
    adapter_context: &AdapterContext,
) {
    if !is_search_route(adapter_context) {
        return;
    }

    let Some(web_search) = root.get("web_search").and_then(|v| v.as_object()) else {
        return;
    };

    let query = web_search
        .get("query")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if query.is_empty() {
        root.remove("web_search");
        return;
    }

    root.insert(
        "tools".to_string(),
        Value::Array(vec![json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Perform web search over the public internet and return up-to-date results.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query string."
                        },
                        "recency": {
                            "type": "string",
                            "description": "Optional recency filter such as \"day\", \"week\", or \"month\"."
                        },
                        "count": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 50,
                            "description": "Maximum number of search results to retrieve (1-50)."
                        }
                    },
                    "required": ["query"]
                }
            }
        })]),
    );
    root.remove("web_search");
}
