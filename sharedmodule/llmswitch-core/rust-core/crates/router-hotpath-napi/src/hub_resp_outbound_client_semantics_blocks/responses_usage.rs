use serde_json::{Map, Value};

fn read_number_field(value: Option<&Value>) -> Option<f64> {
    let number = value.and_then(|v| v.as_f64())?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

pub(crate) fn normalize_responses_usage(usage_raw: &Value) -> Value {
    let Some(usage_row) = usage_raw.as_object() else {
        return usage_raw.clone();
    };
    let mut usage = usage_row.clone();

    let input_tokens = read_number_field(usage.get("input_tokens"))
        .or_else(|| read_number_field(usage.get("prompt_tokens")));
    let output_tokens = read_number_field(usage.get("output_tokens"))
        .or_else(|| read_number_field(usage.get("completion_tokens")));
    let cache_read_tokens = read_number_field(usage.get("cache_read_input_tokens"))
        .or_else(|| {
            usage
                .get("input_tokens_details")
                .and_then(|v| v.as_object())
                .and_then(|row| read_number_field(row.get("cached_tokens")))
        })
        .or_else(|| {
            usage
                .get("prompt_tokens_details")
                .and_then(|v| v.as_object())
                .and_then(|row| read_number_field(row.get("cached_tokens")))
        });

    let mut total_tokens = read_number_field(usage.get("total_tokens"));
    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        return Value::Object(usage);
    }
    if total_tokens.is_none() {
        if let (Some(input), Some(output)) = (input_tokens, output_tokens) {
            let total = input + output;
            if total.is_finite() {
                total_tokens = Some(total);
            }
        }
    }

    usage.remove("prompt_tokens");
    usage.remove("completion_tokens");
    usage.remove("prompt_tokens_details");
    usage.remove("completion_tokens_details");
    usage.remove("cache_read_input_tokens");
    usage.remove("cache_creation_input_tokens");

    if let Some(input_tokens) = input_tokens {
        usage.insert("input_tokens".to_string(), Value::from(input_tokens));
    }
    if let Some(output_tokens) = output_tokens {
        usage.insert("output_tokens".to_string(), Value::from(output_tokens));
    }
    if let Some(total_tokens) = total_tokens {
        usage.insert("total_tokens".to_string(), Value::from(total_tokens));
    }

    if let Some(cache_read_tokens) = cache_read_tokens {
        let details = usage
            .entry("input_tokens_details".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(details_row) = details {
            details_row
                .entry("cached_tokens".to_string())
                .or_insert_with(|| Value::from(cache_read_tokens));
        }
    }

    Value::Object(usage)
}
