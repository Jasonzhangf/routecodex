//! Canonical usage 归一化唯一真源。
//!
//! 契约见 `docs/protocol-compatibility-matrix.md`「Usage 字段矩阵」与
//! `docs/design/v3-usage-normalization-matrix.md`：canonical usage 允许三种输入侧语义，
//! 投影到各 client wire 前必须择一，不得同时套用。
//!
//! 本模块是**唯一**分类实现；各 client 协议只允许在此之上做字段名投影，
//! 禁止在投影层各自复制一份 `effective_input` / `cached` 推导。

use serde_json::{json, Map, Value};

/// canonical usage 的缓存拆分结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3CanonicalUsageCache {
    /// 含缓存的完整输入 token（OpenAI/Responses/Gemini wire 的 `input_tokens` / `prompt_tokens` 语义）。
    pub effective_input_tokens: u64,
    /// 缓存命中子计数（Anthropic wire 的 `cache_read_input_tokens`）。
    pub cached_tokens: Option<u64>,
    /// 缓存写入计数；只在 Anthropic 语义下存在，且必须计入分母。
    pub cache_creation_input_tokens: Option<u64>,
}

/// 唯一分类规则。
///
/// 判定优先级固定为：OpenAI 子计数 -> Anthropic read/creation -> 无缓存字段。
/// creation-only 的 Anthropic payload（只有 `cache_creation_input_tokens`）必须判为 Anthropic 语义，
/// 不得回退成 OpenAI 语义而丢弃 creation。
pub fn split_v3_canonical_usage_cache(
    input_tokens: Option<u64>,
    cached_subcount: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
) -> V3CanonicalUsageCache {
    let input = input_tokens.unwrap_or(0);
    if let Some(cached) = cached_subcount {
        // OpenAI / Responses / Gemini：`input_tokens` 已含缓存，cached 只是它的子计数。
        return V3CanonicalUsageCache {
            effective_input_tokens: input,
            cached_tokens: Some(cached),
            cache_creation_input_tokens: None,
        };
    }
    if cache_read_input_tokens.is_some() || cache_creation_input_tokens.is_some() {
        // Anthropic / MiniMax / glm：`input_tokens` 只记未命中增量，read/creation 独立计数。
        let read = cache_read_input_tokens.unwrap_or(0);
        let creation = cache_creation_input_tokens.unwrap_or(0);
        return V3CanonicalUsageCache {
            effective_input_tokens: input.saturating_add(read).saturating_add(creation),
            cached_tokens: cache_read_input_tokens,
            cache_creation_input_tokens,
        };
    }
    V3CanonicalUsageCache {
        effective_input_tokens: input,
        cached_tokens: None,
        cache_creation_input_tokens: None,
    }
}

/// 从 usage 对象读取 canonical 缓存四要素（覆盖 OpenAI / Responses / Anthropic / Gemini 命名）。
///
/// 返回 `(input_tokens, cached_subcount, cache_read_input_tokens, cache_creation_input_tokens)`。
pub fn read_v3_canonical_usage_cache_fields(
    usage: &Map<String, Value>,
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .or_else(|| usage.get("promptTokenCount"))
        .and_then(Value::as_u64);
    let cached_subcount = usage
        .get("input_tokens_details")
        .or_else(|| usage.get("prompt_tokens_details"))
        .and_then(Value::as_object)
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        // Gemini 的 `cachedContentTokenCount` 同样是 `promptTokenCount` 的子计数。
        .or_else(|| usage.get("cachedContentTokenCount").and_then(Value::as_u64));
    let cache_read = usage.get("cache_read_input_tokens").and_then(Value::as_u64);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64);
    (input, cached_subcount, cache_read, cache_creation)
}

pub(crate) fn read_v3_canonical_usage_output_tokens(usage: &Map<String, Value>) -> Option<u64> {
    usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .or_else(|| usage.get("candidatesTokenCount"))
        .and_then(Value::as_u64)
}

pub(crate) fn read_v3_canonical_usage_reasoning_tokens(usage: &Map<String, Value>) -> Option<u64> {
    usage
        .get("output_tokens_details")
        .or_else(|| usage.get("completion_tokens_details"))
        .and_then(Value::as_object)
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_u64)
}

/// usage 对象是否携带任何本模块能识别的计数字段。
///
/// 三个 client 投影共用本判定：provider 只回了非计数字段（或空对象）时，不得
/// 伪造 `input_tokens:0 / output_tokens:0` 之类的假 usage；此时投影返回 `None`，
/// 由调用方决定是否保留原始 usage。判定复用读取器本身，不另立字段名单。
pub(crate) fn has_v3_canonical_usage_tokens(usage: &Map<String, Value>) -> bool {
    let (input, cached_subcount, cache_read, cache_creation) =
        read_v3_canonical_usage_cache_fields(usage);
    input.is_some()
        || cached_subcount.is_some()
        || cache_read.is_some()
        || cache_creation.is_some()
        || read_v3_canonical_usage_output_tokens(usage).is_some()
        || read_v3_canonical_usage_reasoning_tokens(usage).is_some()
}

pub(crate) fn canonical_usage_cache_for_value(usage: &Value) -> Option<V3CanonicalUsageCache> {
    let source = usage.as_object()?;
    let (input, cached_subcount, cache_read, cache_creation) =
        read_v3_canonical_usage_cache_fields(source);
    Some(split_v3_canonical_usage_cache(
        input,
        cached_subcount,
        cache_read,
        cache_creation,
    ))
}

/// Canonical usage -> OpenAI Chat client wire usage 唯一归一化入口（JSON 响应与 SSE 终帧共用）。
pub(crate) fn project_v3_chat_usage_from_canonical(usage: &Value) -> Option<Value> {
    let source = usage.as_object()?;
    if !has_v3_canonical_usage_tokens(source) {
        return None;
    }
    let cache = canonical_usage_cache_for_value(usage)?;
    let output_tokens = read_v3_canonical_usage_output_tokens(source).unwrap_or(0);
    let mut projected = Map::new();
    projected.insert(
        "prompt_tokens".to_string(),
        Value::from(cache.effective_input_tokens),
    );
    projected.insert("completion_tokens".to_string(), Value::from(output_tokens));
    projected.insert(
        "total_tokens".to_string(),
        Value::from(cache.effective_input_tokens.saturating_add(output_tokens)),
    );
    if let Some(cached) = cache.cached_tokens {
        projected.insert(
            "prompt_tokens_details".to_string(),
            json!({"cached_tokens": cached}),
        );
    }
    if let Some(reasoning) = read_v3_canonical_usage_reasoning_tokens(source) {
        projected.insert(
            "completion_tokens_details".to_string(),
            json!({"reasoning_tokens": reasoning}),
        );
    }
    Some(Value::Object(projected))
}

/// Canonical usage -> Responses client wire usage 唯一归一化入口（JSON 响应与 SSE 终帧共用）。
///
/// Anthropic 私有字段（`cache_read_input_tokens` / `cache_creation_input_tokens`）不得出现在
/// Responses client payload；命中信息只经 `input_tokens_details.cached_tokens` 表达。
pub(crate) fn project_v3_responses_usage_from_canonical(usage: &Value) -> Option<Value> {
    let source = usage.as_object()?;
    if !has_v3_canonical_usage_tokens(source) {
        return None;
    }
    let cache = canonical_usage_cache_for_value(usage)?;
    let output_tokens = read_v3_canonical_usage_output_tokens(source).unwrap_or(0);
    let mut projected = Map::new();
    projected.insert(
        "input_tokens".to_string(),
        Value::from(cache.effective_input_tokens),
    );
    projected.insert("output_tokens".to_string(), Value::from(output_tokens));
    projected.insert(
        "total_tokens".to_string(),
        Value::from(cache.effective_input_tokens.saturating_add(output_tokens)),
    );
    if let Some(cached) = cache.cached_tokens {
        projected.insert(
            "input_tokens_details".to_string(),
            json!({"cached_tokens": cached}),
        );
    }
    if let Some(reasoning) = read_v3_canonical_usage_reasoning_tokens(source) {
        projected.insert(
            "output_tokens_details".to_string(),
            json!({"reasoning_tokens": reasoning}),
        );
    }
    Some(Value::Object(projected))
}

/// Canonical usage -> Anthropic Messages client wire usage 唯一归一化入口。
///
/// Anthropic wire 的 `input_tokens` 只记未命中增量，命中/写入各自独立计数，
/// 且没有 `total_tokens`；OpenAI 形状的 `input_tokens_details` 不得泄漏给 Anthropic client。
pub(crate) fn project_v3_anthropic_usage_from_canonical(usage: &Value) -> Option<Value> {
    let source = usage.as_object()?;
    if !has_v3_canonical_usage_tokens(source) {
        return None;
    }
    let cache = canonical_usage_cache_for_value(usage)?;
    let cached = cache.cached_tokens.unwrap_or(0);
    let creation = cache.cache_creation_input_tokens.unwrap_or(0);
    let uncached_input = cache
        .effective_input_tokens
        .saturating_sub(cached)
        .saturating_sub(creation);
    let output_tokens = read_v3_canonical_usage_output_tokens(source).unwrap_or(0);
    let mut projected = Map::new();
    projected.insert("input_tokens".to_string(), Value::from(uncached_input));
    projected.insert("output_tokens".to_string(), Value::from(output_tokens));
    if cache.cached_tokens.is_some() {
        projected.insert("cache_read_input_tokens".to_string(), Value::from(cached));
    }
    if cache.cache_creation_input_tokens.is_some() {
        projected.insert(
            "cache_creation_input_tokens".to_string(),
            Value::from(creation),
        );
    }
    Some(Value::Object(projected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_subcount_input_already_includes_cache() {
        let cache = split_v3_canonical_usage_cache(Some(132_417), Some(132_032), None, None);
        assert_eq!(cache.effective_input_tokens, 132_417);
        assert_eq!(cache.cached_tokens, Some(132_032));
    }

    #[test]
    fn anthropic_read_and_creation_are_added_to_input() {
        let cache = split_v3_canonical_usage_cache(Some(3_748), None, Some(217_088), Some(0));
        assert_eq!(cache.effective_input_tokens, 220_836);
        assert_eq!(cache.cached_tokens, Some(217_088));
        assert_eq!(cache.cache_creation_input_tokens, Some(0));
    }

    #[test]
    fn anthropic_creation_only_payload_stays_anthropic_semantics() {
        let cache = split_v3_canonical_usage_cache(Some(1_000), None, None, Some(200));
        assert_eq!(cache.effective_input_tokens, 1_200);
        assert_eq!(cache.cached_tokens, None);
        assert_eq!(cache.cache_creation_input_tokens, Some(200));
    }

    #[test]
    fn gemini_cached_content_is_a_subcount_of_prompt_tokens() {
        let usage = json!({"promptTokenCount": 1_000, "cachedContentTokenCount": 400});
        let cache = canonical_usage_cache_for_value(&usage).unwrap();
        assert_eq!(cache.effective_input_tokens, 1_000);
        assert_eq!(cache.cached_tokens, Some(400));
    }

    #[test]
    fn responses_projection_folds_anthropic_cache_and_drops_private_fields() {
        let projected = project_v3_responses_usage_from_canonical(&json!({
            "input_tokens": 3_748,
            "output_tokens": 707,
            "cache_read_input_tokens": 217_088,
            "cache_creation_input_tokens": 0,
            "total_tokens": 4_455
        }))
        .unwrap();
        assert_eq!(projected["input_tokens"], json!(220_836));
        assert_eq!(projected["output_tokens"], json!(707));
        assert_eq!(projected["total_tokens"], json!(221_543));
        assert_eq!(
            projected["input_tokens_details"]["cached_tokens"],
            json!(217_088)
        );
        assert!(projected.get("cache_read_input_tokens").is_none());
        assert!(projected.get("cache_creation_input_tokens").is_none());
    }

    #[test]
    fn responses_projection_keeps_openai_subcount_shape() {
        let projected = project_v3_responses_usage_from_canonical(&json!({
            "input_tokens": 132_417,
            "output_tokens": 97,
            "input_tokens_details": {"cached_tokens": 132_032}
        }))
        .unwrap();
        assert_eq!(projected["input_tokens"], json!(132_417));
        assert_eq!(projected["total_tokens"], json!(132_514));
        assert_eq!(
            projected["input_tokens_details"]["cached_tokens"],
            json!(132_032)
        );
    }

    #[test]
    fn responses_projection_does_not_fabricate_cache_subcount() {
        let projected = project_v3_responses_usage_from_canonical(&json!({
            "input_tokens": 10,
            "output_tokens": 2
        }))
        .unwrap();
        assert!(projected.get("input_tokens_details").is_none());
        assert_eq!(projected["total_tokens"], json!(12));
    }

    #[test]
    fn anthropic_projection_unfolds_cache_and_omits_responses_only_fields() {
        let projected = project_v3_anthropic_usage_from_canonical(&json!({
            "input_tokens": 132_417,
            "output_tokens": 97,
            "input_tokens_details": {"cached_tokens": 132_032}
        }))
        .unwrap();
        assert_eq!(projected["input_tokens"], json!(385));
        assert_eq!(projected["output_tokens"], json!(97));
        assert_eq!(projected["cache_read_input_tokens"], json!(132_032));
        assert!(projected.get("total_tokens").is_none());
        assert!(projected.get("input_tokens_details").is_none());
    }

    #[test]
    fn chat_projection_matches_responses_input_semantics() {
        let projected = project_v3_chat_usage_from_canonical(&json!({
            "input_tokens": 3_748,
            "output_tokens": 707,
            "cache_read_input_tokens": 217_088
        }))
        .unwrap();
        assert_eq!(projected["prompt_tokens"], json!(220_836));
        assert_eq!(projected["completion_tokens"], json!(707));
        assert_eq!(projected["total_tokens"], json!(221_543));
        assert_eq!(
            projected["prompt_tokens_details"]["cached_tokens"],
            json!(217_088)
        );
    }

    #[test]
    fn projections_skip_usage_without_recognizable_tokens() {
        // A provider usage object carrying no recognizable counter must not be
        // turned into a fabricated zeroed usage by any client projection.
        for usage in [json!({}), json!({"service_tier": "standard"})] {
            assert!(
                project_v3_responses_usage_from_canonical(&usage).is_none(),
                "responses projection fabricated usage for {usage}"
            );
            assert!(
                project_v3_chat_usage_from_canonical(&usage).is_none(),
                "chat projection fabricated usage for {usage}"
            );
            assert!(
                project_v3_anthropic_usage_from_canonical(&usage).is_none(),
                "anthropic projection fabricated usage for {usage}"
            );
        }
    }

    #[test]
    fn responses_projection_skips_total_only_usage_instead_of_zeroing_it() {
        // `total_tokens` alone carries no input/output split; recomputing the
        // total from zeroed input/output would discard the provider's number.
        assert!(
            project_v3_responses_usage_from_canonical(&json!({"total_tokens": 4_455})).is_none()
        );
    }
}
