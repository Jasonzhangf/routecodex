import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-provider-response-errorerr-'));
const converterRelative = 'src/server/runtime/http-server/executor/provider-response-converter.ts';
const sendFailureRelative = 'src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts';
const providerFailureRelative = 'src/server/runtime/http-server/executor/request-executor-provider-failure.ts';
const deadSseNormalizerRelative = 'src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.ts';
const deadEmptySseSpecRelative = 'tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts';

function writeSource(relativePath, source) {
  const target = path.join(tmpRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
}

function seedCleanFixture() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  writeSource(converterRelative, 'export const providerResponseErrorBoundaryFixture = true;\n');
  writeSource(sendFailureRelative, 'export const providerResponseFailureBoundaryFixture = true;\n');
  writeSource(providerFailureRelative, 'export const providerFailureReportBoundaryFixture = true;\n');
}

function runVerifier(name, relativePath, source, expectedSubstring) {
  seedCleanFixture();
  writeSource(relativePath, source);
  const result = spawnSync(
    process.execPath,
    ['scripts/architecture/verify-provider-response-errorerr-bypass-closeout.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT: tmpRoot,
      },
      encoding: 'utf8',
    }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    throw new Error(`${name}: expected verifier failure, got success\n${output}`);
  }
  if (!output.includes(expectedSubstring)) {
    throw new Error(`${name}: expected ${JSON.stringify(expectedSubstring)}\n${output}`);
  }
  return name;
}

seedCleanFixture();
const clean = spawnSync(
  process.execPath,
  ['scripts/architecture/verify-provider-response-errorerr-bypass-closeout.mjs'],
  {
    cwd: root,
    env: {
      ...process.env,
      ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT: tmpRoot,
    },
    encoding: 'utf8',
  }
);
if (clean.status !== 0) {
  throw new Error(`clean fixture must pass\n${clean.stdout}\n${clean.stderr}`);
}

const cases = [
  runVerifier(
    'status-retryable-write',
    converterRelative,
    'function classify(error) { error.statusCode = 429; error.retryable = true; }\n',
    'TS normalized statusCode write'
  ),
  runVerifier(
    'rate-limit-classifier',
    converterRelative,
    'function classify(message, code) { return isRateLimitLikeError(message, code); }\n',
    'TS rate-limit classifier'
  ),
  runVerifier(
    'provider-configured-mapping',
    converterRelative,
    'function classify(input) { return applyProviderConfiguredErrorMapping(input); }\n',
    'TS provider-configured error mapper'
  ),
  runVerifier(
    'message-based-sse-classification',
    converterRelative,
    'const normalizedMessage = message.toLowerCase(); const isSseDecodeError = normalizedMessage.includes("sse");\n',
    'TS bridge error classification predicate'
  ),
  runVerifier(
    'provider-sse-stage-write',
    converterRelative,
    "function classify(errRecord) { errRecord.requestExecutorProviderErrorStage = 'provider.sse_decode'; }\n",
    'TS provider SSE stage classification write'
  ),
  runVerifier(
    'executor-response-retry-classifier',
    sendFailureRelative,
    'function isRetryableProviderResponseProcessingFailure(record) { return record.retryable === true; }\n',
    'executor TS provider-response retry classifier'
  ),
  runVerifier(
    'report-plan-sse-stage-classifier',
    providerFailureRelative,
    'const stage = isSseDecodeRateLimitError(error, 429) ? "provider.sse_decode" : "provider.send";\n',
    'report-plan TS SSE rate-limit classifier'
  ),
  runVerifier(
    'dead-sse-normalizer-module',
    deadSseNormalizerRelative,
    'export function remapBridgeSseErrorToHttp() { return true; }\n',
    'dead TS bridge SSE remapper module'
  ),
  runVerifier(
    'dead-empty-sse-remap-jest',
    deadEmptySseSpecRelative,
    'import { remapBridgeSseErrorToHttp } from "../../../../../src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.js";\n',
    'legacy empty-SSE TS remap Jest'
  ),
];

console.log('[test:provider-response-errorerr-bypass-closeout-red-fixtures] ok');
for (const name of cases) console.log(`- ${name}`);
