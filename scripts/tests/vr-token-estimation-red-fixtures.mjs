#!/usr/bin/env node
const forbiddenSourceFixtures = [
  {
    label: 'character-ratio token estimator',
    source: 'let structured_estimate = (structured_chars as f64 / 3.2).ceil() as i64;',
    pattern: /as f64\s*\/\s*(?:3\.2|4\.0|3\.0)/,
  },
  {
    label: 'prefix-based tiktoken model matching',
    source: 'let encoder = tiktoken_rs::bpe_for_model(model)?;',
    pattern: /bpe_for_model\(/,
  },
  {
    label: 'fixed Hub semantic byte cap',
    source: 'const MAX_PAYLOAD_SIZE_BYTES: usize = 50 * 1024 * 1024;',
    pattern: /MAX_PAYLOAD_SIZE_BYTES/,
  },
  {
    label: 'dead serialized size helper',
    source: 'pub(crate) fn serialized_json_size<T: Serialize>(value: &T) -> Result<usize, serde_json::Error> { todo!() }',
    pattern: /serialized_json_size/,
  },
  {
    label: 'client metadata estimated token override',
    source: 'let estimated_tokens = read_finite_floor_i64(metadata.get("estimatedInputTokens")).unwrap_or_else(|| estimate_request_tokens(request));',
    pattern: /read_finite_floor_i64\s*\(\s*metadata\.get\(\s*["\']estimated(?:InputTokens|Tokens|_tokens)["\']/,
  },
];

const misses = forbiddenSourceFixtures.filter(({ source, pattern }) => !pattern.test(source));
if (misses.length) {
  console.error('[test:vr-token-estimation-red-fixtures] failed');
  for (const miss of misses) console.error(`- fixture did not trip: ${miss.label}`);
  process.exit(1);
}

console.log(`[test:vr-token-estimation-red-fixtures] ok (${forbiddenSourceFixtures.length} fixtures)`);
