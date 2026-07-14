import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyResponsesContinuationImmutableBoundary } from '../architecture/verify-responses-continuation-immutable-boundary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requiredFiles = [
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  'src/modules/llmswitch/bridge/runtime-integrations.ts',
  'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
  'src/modules/llmswitch/bridge/provider-response-effects.ts',
  'src/server/handlers/responses-handler.ts',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs',
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

function mutate(root, relativePath, replacement) {
  const target = path.join(root, relativePath);
  fs.writeFileSync(target, replacement(fs.readFileSync(target, 'utf8')));
}

function expectFailure(name, mutateFixture, expectedText) {
  const root = copyFixtureRoot();
  mutateFixture(root);
  const failures = verifyResponsesContinuationImmutableBoundary(root);
  if (!failures.some((failure) => failure.includes(expectedText))) {
    console.error(name + ': expected failure containing ' + expectedText);
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

expectFailure(
  'handler cannot use saved origin request to rebuild context',
  (root) => {
    mutate(root, 'src/server/handlers/responses-handler.ts', (source) => source + '\nconst illegal = entryOriginRequest;\n');
  },
  'entryOriginRequest'
);

expectFailure(
  'release interval cannot repair tool outputs',
  (root) => {
    mutate(
      root,
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs',
      (source) => source.replace('"input": [],', '"input": [],\n        "tool_outputs": [],')
    );
  },
  'tool_outputs'
);

expectFailure(
  'runtime integration cannot rebuild submit payload',
  (root) => {
    mutate(root, 'src/modules/llmswitch/bridge/runtime-integrations.ts', (source) =>
      source.replace(
        'recordResponsesResponse(args);',
        'const payload = { input: [], previous_response_id: args.requestId }; recordResponsesResponse({ ...args, payload });'
      )
    );
  },
  'recordResponsesResponseForRequest'
);

console.log('Responses continuation immutable boundary red fixtures passed.');
