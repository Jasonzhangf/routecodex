use serde_json::{Map, Value};

fn read_number_field(value: Option<&Value>) -> Option<f64> {
    let number = value.and_then(|v| v.as_f64())?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

fn read_non_negative_integer_field(
    row: &Map<String, Value>,
    keys: &[&str],
    field_name: &str,
) -> Result<Option<i64>, String> {
    for key in keys {
        let Some(value) = row.get(*key) else {
            continue;
        };
        let parsed = match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    trimmed.parse::<f64>().ok()
                }
            }
            _ => None,
        };
        let Some(number) = parsed else {
            return Err(format!("Invalid Chat usage.{}", field_name));
        };
        if !number.is_finite() || number < 0.0 {
            return Err(format!("Invalid Chat usage.{}", field_name));
        }
        return Ok(Some(number.round() as i64));
    }
    Ok(None)
}

fn read_nested_non_negative_integer_field(
    row: &Map<String, Value>,
    parent_key: &str,
    child_key: &str,
    field_name: &str,
) -> Result<Option<i64>, String> {
    let Some(parent) = row.get(parent_key) else {
        return Ok(None);
    };
    if parent.is_null() {
        return Ok(None);
    }
    let Some(parent_row) = parent.as_object() else {
        return Err(format!("Invalid Chat usage.{}", field_name));
    };
    read_non_negative_integer_field(parent_row, &[child_key], field_name)
}

pub(crate) fn normalize_chat_usage(usage_raw: &Value) -> Result<Value, String> {
    if usage_raw.is_null() {
        return Ok(Value::Null);
    }
    let Some(row) = usage_raw.as_object() else {
        return Err("Invalid Chat usage: expected object".to_string());
    };

    let prompt_tokens = read_non_negative_integer_field(
        row,
        &[
            "prompt_tokens",
            "input_tokens",
            "promptTokens",
            "inputTokens",
        ],
        "prompt_tokens",
    )?;
    let completion_tokens = read_non_negative_integer_field(
        row,
        &[
            "completion_tokens",
            "output_tokens",
            "completionTokens",
            "outputTokens",
        ],
        "completion_tokens",
    )?;
    let total_tokens =
        read_non_negative_integer_field(row, &["total_tokens", "totalTokens"], "total_tokens")?
            .or_else(|| {
                let total = prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0);
                if total > 0 {
                    Some(total)
                } else {
                    None
                }
            });

    let (Some(prompt_tokens), Some(completion_tokens), Some(total_tokens)) =
        (prompt_tokens, completion_tokens, total_tokens)
    else {
        return Err("Invalid Chat usage: missing token fields".to_string());
    };

    let cached_tokens = read_non_negative_integer_field(
        row,
        &["prompt_cache_hit_tokens"],
        "prompt_cache_hit_tokens",
    )?
    .or(read_nested_non_negative_integer_field(
        row,
        "input_tokens_details",
        "cached_tokens",
        "input_tokens_details.cached_tokens",
    )?)
    .or(read_nested_non_negative_integer_field(
        row,
        "prompt_tokens_details",
        "cached_tokens",
        "prompt_tokens_details.cached_tokens",
    )?);

    let mut out = Map::new();
    out.insert("prompt_tokens".to_string(), Value::from(prompt_tokens));
    out.insert(
        "completion_tokens".to_string(),
        Value::from(completion_tokens),
    );
    out.insert("total_tokens".to_string(), Value::from(total_tokens));

    if let Some(cached_tokens) = cached_tokens.filter(|value| *value > 0) {
        let mut details = Map::new();
        details.insert("cached_tokens".to_string(), Value::from(cached_tokens));
        out.insert("prompt_tokens_details".to_string(), Value::Object(details));
    }

    Ok(Value::Object(out))
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
    usage.remove("input_tokens_details");
    usage.remove("output_tokens_details");
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
