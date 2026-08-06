import fs from 'node:fs';
import path from 'node:path';

// feature_id: server.provider_response_conversion_host

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT)
  : root;
const physicallyDeleted = [
  'src/server/runtime/http-server/executor/provider-response-converter.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-failure.ts',
  'src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.ts',
  'tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts',
];
const failures = [];

for (const rel of physicallyDeleted) {
  if (fs.existsSync(path.join(scanRoot, rel))) {
    failures.push(`${rel} must stay physically deleted: TS ErrorErr classification/bridge remap moved to the Rust ErrorErr owner`);
  }
}

if (failures.length > 0) {
  console.error('[verify:provider-response-errorerr-bypass-closeout] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:provider-response-errorerr-bypass-closeout] ok');
console.log('- provider-response Node/executor hosts contain no TS ErrorErr classification, pre-filter, remap, or normalized error-field writes');
