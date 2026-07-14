import fs from 'node:fs';
import path from 'node:path';

// feature_id: server.provider_response_conversion_host

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_PROVIDER_RESPONSE_ERRORERR_SCAN_ROOT)
  : root;
const converterPath = path.join(
  scanRoot,
  'src/server/runtime/http-server/executor/provider-response-converter.ts'
);
const sendFailurePath = path.join(
  scanRoot,
  'src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts'
);
const providerFailurePath = path.join(
  scanRoot,
  'src/server/runtime/http-server/executor/request-executor-provider-failure.ts'
);
const deadSseNormalizerPath = path.join(
  scanRoot,
  'src/server/runtime/http-server/executor/provider-response-sse-error-normalizer.ts'
);
const deadEmptySseSpecPath = path.join(
  scanRoot,
  'tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts'
);
const failures = [];

if (fs.existsSync(deadSseNormalizerPath)) {
  failures.push('dead TS bridge SSE remapper module provider-response-sse-error-normalizer.ts must remain deleted');
}

if (fs.existsSync(deadEmptySseSpecPath)) {
  failures.push('legacy empty-SSE TS remap Jest provider-response-converter-empty-sse.spec.ts must remain deleted');
}

if (!fs.existsSync(converterPath)) {
  failures.push('provider-response-converter.ts is missing');
} else {
  const source = fs.readFileSync(converterPath, 'utf8');
  const forbidden = [
    ['TS rate-limit classifier', /\bisRateLimitLikeError\b/u],
    ['TS provider-configured error mapper', /\bapplyProviderConfiguredErrorMapping\b/u],
    ['TS bridge SSE remapper', /\bremapBridgeSseErrorToHttp\b/u],
    ['TS empty-SSE message classifier', /\bisEmptyOpenAiChatSseBridgeError\b/u],
    ['TS context-length classifier', /\bisContextLengthExceededError\b/u],
    ['TS network SSE classifier', /\bisRetryableNetworkSseWrapperError\b/u],
    ['TS recoverable SSE classifier', /\bisRecoverableSseDecodeBridgeError\b/u],
    ['TS ProviderContext error-classification builder', /\bbuildProviderContextForResponseConversion\b/u],
    ['TS normalized code write', /\b(?:error|errRecord)\.code\s*=(?!=)/u],
    ['TS normalized status write', /\b(?:error|errRecord)\.status\s*=(?!=)/u],
    ['TS normalized statusCode write', /\b(?:error|errRecord)\.statusCode\s*=(?!=)/u],
    ['TS normalized retryable write', /\b(?:error|errRecord)\.retryable\s*=(?!=)/u],
    ['TS normalized upstreamCode write', /\b(?:error|errRecord)\.upstreamCode\s*=(?!=)/u],
    ['TS provider SSE stage classification write', /\b(?:error|errRecord)\.requestExecutorProviderErrorStage\s*=\s*['"]provider\.sse_decode['"]/u],
    ['TS bridge error classification predicate', /\bisSseDecodeError\b/u],
    ['TS normalized message classifier', /\bnormalizedMessage\b/u],
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) {
      failures.push(`${label} must move to the Rust ErrorErr owner`);
    }
  }
}

if (!fs.existsSync(sendFailurePath)) {
  failures.push('request-executor-provider-send-failure.ts is missing');
} else {
  const source = fs.readFileSync(sendFailurePath, 'utf8');
  for (const [label, pattern] of [
    ['executor TS bridge SSE remapper', /\bremapBridgeSseErrorToHttp\b/u],
    ['executor TS provider-response retry classifier', /\bisRetryableProviderResponseProcessingFailure\b/u],
    ['executor TS retryable field decision', /\brecord\.retryable\s*===\s*true/u],
    ['executor TS SSE stage decision', /requestExecutorProviderErrorStage\s*===\s*['"]provider\.sse_decode['"]/u],
  ]) {
    if (pattern.test(source)) {
      failures.push(`${label} must move to the Rust ErrorErr owner`);
    }
  }
}

if (!fs.existsSync(providerFailurePath)) {
  failures.push('request-executor-provider-failure.ts is missing');
} else {
  const source = fs.readFileSync(providerFailurePath, 'utf8');
  for (const [label, pattern] of [
    ['report-plan TS SSE rate-limit classifier', /\bisSseDecodeRateLimitError\b/u],
    ['report-plan TS SSE network classifier', /\bisSseDecodeRetryableNetworkError\b/u],
  ]) {
    if (pattern.test(source)) {
      failures.push(`${label} must move to the Rust ErrorErr owner`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:provider-response-errorerr-bypass-closeout] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:provider-response-errorerr-bypass-closeout] ok');
console.log('- provider-response Node/executor hosts contain no TS ErrorErr classification, pre-filter, remap, or normalized error-field writes');
