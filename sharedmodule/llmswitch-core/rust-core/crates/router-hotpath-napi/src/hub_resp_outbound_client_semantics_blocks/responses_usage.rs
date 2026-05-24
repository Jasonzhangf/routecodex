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
    let cache_read_tokens = read_number_field(usage.get("cache_read_input_tokens")).or_else(|| {
        usage
            .get("input_tokens_details")
            .and_then(|v| v.as_object())
            .and_then(|row| read_number_field(row.get("cached_tokens")))
    });

    let mut total_tokens = read_number_field(usage.get("total_tokens"));
    let prompt_tokens_raw = read_number_field(usage.get("prompt_tokens"));
    let prompt_tokens = match (prompt_tokens_raw, input_tokens, cache_read_tokens) {
        (Some(prompt), Some(input), Some(cache)) => {
            let with_cache = input + cache;
            if prompt >= with_cache {
                prompt
            } else {
                with_cache
            }
        }
        (Some(prompt), _, _) => prompt,
        (None, Some(input), Some(cache)) => input + cache,
        (None, Some(input), None) => input,
        (None, None, Some(cache)) => cache,
        _ => return Value::Object(usage),
    };
    if total_tokens.is_none() {
        if let (Some(prompt), Some(output)) = (Some(prompt_tokens), output_tokens) {
            let total = prompt + output;
            if total.is_finite() {
                total_tokens = Some(total);
            }
        }
    }

    if let Some(input_tokens) = input_tokens {
        usage.insert("input_tokens".to_string(), Value::from(input_tokens));
    }
    if let Some(output_tokens) = output_tokens {
        usage.insert("output_tokens".to_string(), Value::from(output_tokens));
    }
    if let Some(total_tokens) = total_tokens {
        usage.insert("total_tokens".to_string(), Value::from(total_tokens));
    }

    if !usage.contains_key("prompt_tokens") {
        usage.insert("prompt_tokens".to_string(), Value::from(prompt_tokens));
    } else if let Some(prompt_tokens_raw) = read_number_field(usage.get("prompt_tokens")) {
        if let (Some(input_tokens), Some(cache_read_tokens)) = (input_tokens, cache_read_tokens) {
            let with_cache = input_tokens + cache_read_tokens;
            if prompt_tokens_raw < with_cache {
                usage.insert("prompt_tokens".to_string(), Value::from(with_cache));
            }
        }
    }
    if !usage.contains_key("completion_tokens") {
        if let Some(output_tokens) = output_tokens {
            usage.insert("completion_tokens".to_string(), Value::from(output_tokens));
        }
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
