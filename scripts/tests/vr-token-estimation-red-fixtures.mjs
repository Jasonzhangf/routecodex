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
];

const misses = forbiddenSourceFixtures.filter(({ source, pattern }) => !pattern.test(source));
if (misses.length) {
  console.error('[test:vr-token-estimation-red-fixtures] failed');
  for (const miss of misses) console.error(`- fixture did not trip: ${miss.label}`);
  process.exit(1);
}

console.log(`[test:vr-token-estimation-red-fixtures] ok (${forbiddenSourceFixtures.length} fixtures)`);
