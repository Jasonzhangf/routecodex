#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..', '..');
const codecPath = resolve(
  repo,
  'v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs',
);
const source = readFileSync(codecPath, 'utf8');
const failures = [];

const requiredMarkers = [
  [
    'provider response codec owns the normalization',
    'normalize_v3_responses_function_call_arguments_for_event',
  ],
  [
    'scalar JSON values are serialized at the provider boundary',
    'else if !arguments.is_string()',
  ],
  [
    'partial null arguments remain an empty string',
    'partial_function_call && arguments.is_null()',
  ],
  [
    'scalar regression test remains present',
    'responses_function_call_scalar_arguments_are_projected_as_json_string',
  ],
  [
    'terminal missing arguments stays strict',
    'responses_terminal_function_call_missing_arguments_still_fails',
  ],
];

for (const [label, marker] of requiredMarkers) {
  if (!source.includes(marker)) failures.push(`${label}: missing ${marker}`);
}

const scalarBranch = source.indexOf('else if !arguments.is_string()');
const strictTest = source.indexOf('responses_terminal_function_call_missing_arguments_still_fails');
if (scalarBranch === -1 || strictTest === -1 || scalarBranch > strictTest) {
  failures.push('normalization branch/test ordering is not anchored in the codec owner');
}

if (failures.length) {
  console.error('[test:v3-responses-function-call-arguments-regression] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[test:v3-responses-function-call-arguments-regression] PASS');
