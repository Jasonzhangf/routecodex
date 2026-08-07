import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyResponsesContinuationImmutableBoundary } from '../architecture/verify-responses-continuation-immutable-boundary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requiredFiles = [
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
  'docs/architecture/verification-map.yml',
];

function copyFixtureRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-continuation-immutable-'));
  for (const relativePath of requiredFiles) {
    const source = path.join(repoRoot, relativePath);
    const target = path.join(tmp, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return tmp;
}

function mutate(root, relativePath, marker, replacement) {
  const target = path.join(root, relativePath);
  const source = fs.readFileSync(target, 'utf8');
  if (!source.includes(marker)) throw new Error(relativePath + ': mutation marker missing');
  fs.writeFileSync(target, source.replace(marker, replacement));
}

function expectFailure(name, mutateFixture, expectedText) {
  const root = copyFixtureRoot();
  try {
    mutateFixture(root);
    const failures = verifyResponsesContinuationImmutableBoundary(root);
    if (!failures.some((failure) => failure.includes(expectedText))) {
      console.error(name + ': expected failure containing ' + expectedText);
      console.error(failures.join('\n'));
      process.exit(1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

expectFailure(
  'ReqInbound cannot rebuild saved history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs',
    'previous: input,',
    'let _ = capturedChatRequest;\n        previous: input,',
  ),
  'capturedChatRequest',
);

expectFailure(
  'RespOutbound cannot repair tool output history',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs',
    'previous: input,',
    'let _ = function_call_output;\n        previous: input,',
  ),
  'function_call_output',
);

expectFailure(
  'Server frame cannot restore continuation context',
  (root) => mutate(
    root,
    'v3/crates/routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs',
    'V3ServerRespOutbound06ClientFrame { previous: input }',
    '{ let _ = restore_local_context; V3ServerRespOutbound06ClientFrame { previous: input } }',
  ),
  'restore_local_context',
);

console.log('Responses continuation immutable boundary red fixtures passed (3 mutations rejected).');
