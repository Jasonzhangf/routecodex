use napi::bindgen_prelude::Result as NapiResult;
use serde::{de::DeserializeOwned, Serialize};

pub(crate) fn parse_napi_json<T: DeserializeOwned>(input_json: &str) -> NapiResult<T> {
    serde_json::from_str(input_json).map_err(|error| napi::Error::from_reason(error.to_string()))
}

pub(crate) fn stringify_napi_json<T: Serialize>(value: &T) -> NapiResult<String> {
    serde_json::to_string(value).map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{parse_napi_json, stringify_napi_json};
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, PartialEq)]
    struct TestInput {
        value: String,
    }

    #[derive(Debug, Serialize)]
    struct TestOutput<'a> {
        value: &'a str,
    }

    #[test]
    fn napi_json_parses_typed_input() {
        let parsed: TestInput = parse_napi_json(r#"{"value":"ok"}"#).expect("parse typed input");
        assert_eq!(
            parsed,
            TestInput {
                value: "ok".to_string()
            }
        );
    }

    #[test]
    fn napi_json_projects_parse_errors() {
        let error = parse_napi_json::<TestInput>("{").expect_err("invalid json should fail");
        assert!(error.reason.contains("EOF") || error.reason.contains("expected"));
    }

    #[test]
    fn napi_json_serializes_output() {
        let serialized =
            stringify_napi_json(&TestOutput { value: "ok" }).expect("serialize output");
        assert_eq!(serialized, r#"{"value":"ok"}"#);
    }
}
