//! Request Executor Pipeline Attempt — Route Pool normalization utilities.
//!
//! These are pure transformation functions extracted from the TS-side
//! `request-executor-pipeline-attempt.ts` as the first step in the
//! Hub Pipeline Rust migration batch #1.
//!
//! The public API is the NAPI JSON-boundary entry point; internal helpers
//! are unit-testable without serialization overhead.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Public NAPI boundary
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeRoutePoolOutput {
    pub pool: Vec<String>,
}

/// Normalize a raw value into a deduplicated, whitespace-trimmed string array.
///
/// Input is passed as a JSON value (any type); the TS caller passes the raw
/// argument so we handle `null`, numbers, strings, etc. gracefully.
pub fn normalize_explicit_route_pool_json(raw: Value) -> Result<NormalizeRoutePoolOutput, String> {
    let pool = normalize_explicit_route_pool(raw);
    Ok(NormalizeRoutePoolOutput { pool })
}

/// Merge an existing route pool chain with an observed pool, deduplicating
/// entries that already appear in the existing chain.
pub fn merge_observed_route_pool_chain_json(
    existing_json: Option<String>,
    observed_json: String,
) -> Result<Option<String>, String> {
    let existing: Option<Vec<String>> = existing_json.as_ref().and_then(|s| {
        if s.trim().is_empty() {
            None
        } else {
            serde_json::from_str(s).ok()
        }
    });

    let observed: Vec<String> = serde_json::from_str(&observed_json).map_err(|e| {
        format!(
            "merge_observed_route_pool_chain: failed to parse observed pool: {}",
            e
        )
    })?;

    let result = merge_observed_route_pool_chain(existing, observed);

    if result.is_empty() {
        // Return null to match TS semantics: empty result is represented as null
        Ok(None)
    } else {
        Ok(Some(serde_json::to_string(&result).unwrap()))
    }
}

// ---------------------------------------------------------------------------
// Internal pure helpers
// ---------------------------------------------------------------------------

/// Normalize a raw value into a deduplicated, whitespace-trimmed string array.
///
/// Mirrors TS `normalizeExplicitRoutePool`:
/// - Returns empty Vec for non-array input
/// - Skips non-string entries
/// - Trims whitespace; skips empty strings after trim
/// - Deduplicates (preserving first-occurrence order)
pub fn normalize_explicit_route_pool(raw: Value) -> Vec<String> {
    let arr = match raw {
        Value::Array(a) => a,
        _ => return Vec::new(),
    };

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in arr {
        let s = match entry {
            Value::String(s) => s,
            _ => continue,
        };
        let trimmed = s.trim();
        if trimmed.is_empty() || seen.contains(trimmed) {
            continue;
        }
        seen.insert(trimmed.to_string());
        out.push(trimmed.to_string());
    }

    out
}

/// Merge an existing route pool chain with an observed pool.
///
/// Mirrors TS `mergeObservedRoutePoolChain`:
/// - If observed is empty, return existing unchanged
/// - If existing is empty/None, return observed as a new Vec
/// - Otherwise append unique observed entries to existing (preserving order)
pub fn merge_observed_route_pool_chain(
    existing: Option<Vec<String>>,
    observed: Vec<String>,
) -> Vec<String> {
    if observed.is_empty() {
        return existing.unwrap_or_default();
    }

    let existing = match existing {
        Some(e) if !e.is_empty() => e,
        _ => return observed,
    };

    let mut merged = existing;
    let mut seen: std::collections::HashSet<String> = merged.iter().cloned().collect();

    for entry in observed {
        if seen.contains(&entry) {
            continue;
        }
        seen.insert(entry.clone());
        merged.push(entry);
    }

    merged
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- normalizeExplicitRoutePool ---

    #[test]
    fn normalize_route_pool_normal() {
        let input: Value = serde_json::json!(["deepseek-web.default", "anthropic.default"]);
        let result = normalize_explicit_route_pool(input);
        assert_eq!(result, vec!["deepseek-web.default", "anthropic.default"]);
    }

    #[test]
    fn normalize_route_pool_whitespace_trim() {
        // Input: second element is whitespace → should be filtered
        let input: Value =
            serde_json::json!(["  deepseek-web.default  ", "  ", "anthropic.default"]);
        let result = normalize_explicit_route_pool(input);
        assert_eq!(result, vec!["deepseek-web.default", "anthropic.default"]);
    }

    #[test]
    fn normalize_route_pool_dedup() {
        let input: Value = serde_json::json!(["a", "b", "a", "c"]);
        let result = normalize_explicit_route_pool(input);
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn normalize_route_pool_null_input() {
        let input: Value = serde_json::Value::Null;
        let result = normalize_explicit_route_pool(input);
        assert!(result.is_empty());
    }

    #[test]
    fn normalize_route_pool_non_array_input() {
        let input: Value = serde_json::json!(123);
        let result = normalize_explicit_route_pool(input);
        assert!(result.is_empty());
    }

    #[test]
    fn normalize_route_pool_empty_string_filter() {
        let input: Value = serde_json::json!(["", "  ", "a"]);
        let result = normalize_explicit_route_pool(input);
        assert_eq!(result, vec!["a"]);
    }

    #[test]
    fn normalize_route_pool_all_whitespace_filtered() {
        let input: Value = serde_json::json!(["  ", "\t", "\n"]);
        let result = normalize_explicit_route_pool(input);
        assert!(result.is_empty());
    }

    #[test]
    fn normalize_route_pool_preserves_order() {
        let input: Value = serde_json::json!(["z", "y", "x"]);
        let result = normalize_explicit_route_pool(input);
        assert_eq!(result, vec!["z", "y", "x"]);
    }

    // --- mergeObservedRoutePoolChain ---

    #[test]
    fn merge_existing_null_observed_populated() {
        // existing=None, observed=["a","b"] → ["a","b"]
        let existing: Option<Vec<String>> = None;
        let observed = vec!["a".to_string(), "b".to_string()];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn merge_existing_empty_observed_populated() {
        // existing=[], observed=["a","b"] → ["a","b"]
        let existing: Option<Vec<String>> = Some(vec![]);
        let observed = vec!["a".to_string(), "b".to_string()];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn merge_existing_populated_observed_empty() {
        // existing=["a"], observed=[] → ["a"]
        let existing: Option<Vec<String>> = Some(vec!["a".to_string()]);
        let observed = vec![];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a"]);
    }

    #[test]
    fn merge_existing_populated_observed_dedup() {
        // existing=["a"], observed=["a","b"] → ["a","b"]
        let existing: Option<Vec<String>> = Some(vec!["a".to_string()]);
        let observed = vec!["a".to_string(), "b".to_string()];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn merge_both_populated_dedup() {
        // existing=["a","b"], observed=["b","c"] → ["a","b","c"]
        let existing: Option<Vec<String>> = Some(vec!["a".to_string(), "b".to_string()]);
        let observed = vec!["b".to_string(), "c".to_string()];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn merge_existing_populated_observed_exact_dup() {
        // existing=["a"], observed=["a"] → ["a"]
        let existing: Option<Vec<String>> = Some(vec!["a".to_string()]);
        let observed = vec!["a".to_string()];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert_eq!(result, vec!["a"]);
    }

    #[test]
    fn merge_both_empty() {
        // existing=[], observed=[] → []
        let existing: Option<Vec<String>> = Some(vec![]);
        let observed = vec![];
        let result = merge_observed_route_pool_chain(existing, observed);
        assert!(result.is_empty());
    }
}
