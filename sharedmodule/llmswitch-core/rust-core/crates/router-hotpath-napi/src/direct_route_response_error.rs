use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Value};

// feature_id: hub.router_direct_response_error_projection
fn plan_response_error(status: Option<i64>) -> Value {
    let should_raise =
        matches!(status, Some(401 | 402 | 403 | 429)) || status.is_some_and(|value| value >= 500);
    let Some(status) = status.filter(|_| should_raise) else {
        return json!({ "shouldRaise": false });
    };
    json!({
        "shouldRaise": true,
        "message": format!("router-direct provider returned recoverable HTTP {status}"),
        "status": status,
        "statusCode": status,
        "code": format!("HTTP_{status}"),
    })
}

#[napi(js_name = "planDirectRouteResponseErrorJson")]
pub fn plan_direct_route_response_error_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json).map_err(|error| {
        napi::Error::from_reason(format!("direct response error input parse failed: {error}"))
    })?;
    let status = input.get("status").and_then(Value::as_i64);
    serde_json::to_string(&plan_response_error(status)).map_err(|error| {
        napi::Error::from_reason(format!(
            "direct response error output serialize failed: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raises_all_router_recoverable_statuses() {
        for status in [401, 402, 403, 429, 500, 502, 599] {
            let plan = plan_response_error(Some(status));
            assert_eq!(plan["shouldRaise"], true, "status={status}");
            assert_eq!(plan["code"], format!("HTTP_{status}"));
        }
    }

    #[test]
    fn keeps_success_client_and_non_status_values_non_error() {
        for status in [None, Some(0), Some(200), Some(400), Some(404), Some(499)] {
            assert_eq!(
                plan_response_error(status)["shouldRaise"],
                false,
                "status={status:?}"
            );
        }
    }
}
