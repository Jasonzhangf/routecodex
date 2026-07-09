import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function stripRustTestModule(source) {
  const marker = source.indexOf('\n#[cfg(test)]');
  if (marker >= 0) {
    return source.slice(0, marker);
  }
  const headMarker = source.indexOf('#[cfg(test)]');
  return headMarker >= 0 ? source.slice(0, headMarker) : source;
}

function forbid(relPath, pattern, message) {
  const source = read(relPath);
  if (pattern.test(source)) {
    failures.push(`${relPath}: ${message}`);
  }
}

function forbidRustSource(relPath, pattern, message) {
  const source = stripRustTestModule(read(relPath));
  if (pattern.test(source)) {
    failures.push(`${relPath}: ${message}`);
  }
}

function requireContains(relPath, marker, message) {
  const source = read(relPath);
  if (!source.includes(marker)) {
    failures.push(`${relPath}: ${message}`);
  }
}

if (fs.existsSync(path.join(root, 'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts'))) {
  failures.push('sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts: retired TS request-stage bridge must stay physically deleted');
}
forbid(
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  /providerProtocol:\s*['"]openai-responses['"]/,
  'Responses request bridge must not write providerProtocol endpoint constants into pipeline metadata'
);
forbid(
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  /writeRuntimeControl\(\s*['"]routeHint['"]|writeRuntimeControl\(\s*['"]retryProviderKey['"]/,
  'Responses request bridge must not derive routeHint/retryProviderKey runtime control from resume metadata'
);
forbid(
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  /resumeMeta\?\.(?:fullInput|restoredTools)|relayResumeFullInput|relayResumeTools/,
  'Responses request bridge must not read fullInput/restoredTools or assemble relay resume payload history; restore belongs to Rust Chat Process continuation owner'
);
forbid(
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  /function\s+sanitizeResponsesResumeForContinuationContextForHttp[\s\S]*?return\s+sanitized;/,
  'Responses request bridge must not pass an open-ended responsesResume object into MetadataCenter; continuation_context.responsesResume must use an explicit control-only allowlist'
);
forbid(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs',
  /row\.get\("providerProtocol"\)|row\.get\("routeHint"\)|row\.get\("sessionId"\)|row\.get\("conversationId"\)|metadata_node\.as_object\(\)\.and_then\(\|metadata_obj\|[\s\S]*?retryProviderKey/,
  'Rust route metadata owner must not read top-level route fallback fields; use metadataCenterSnapshot and typed semantics only'
);
forbidRustSource(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs',
  /cont\.get\("routeHint"\)|resume\.get\("routeHint"\)|cont\.get\("sessionId"\)|resume\.get\("sessionId"\)|cont\.get\("conversationId"\)|resume\.get\("conversationId"\)|cont\.get\("providerKey"\)|resume\.get\("providerKey"\)/,
  'Rust route metadata owner must not restore route/session/provider control from continuation/responsesResume residue; use MetadataCenter runtimeControl/requestTruth/continuationContext slots'
);
forbidRustSource(
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/metadata.rs',
  /metadata_center_snapshot\.get\("providerProtocol"\)|metadata_center_snapshot\.get\("responsesResume"\)/,
  'VR metadata surface must not restore route scope from top-level providerProtocol or legacy responsesResume'
);
requireContains(
  'src/server/runtime/http-server/executor/request-executor-error-shared.ts',
  'export function isProviderProtocolBoundaryError(',
  'providerProtocol boundary conflicts must remain explicitly classified outside provider availability'
);
requireContains(
  'src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts',
  'if (protocolBoundaryFailure) {',
  'providerProtocol boundary conflicts must not produce retry/reroute/excludedProviderKeys plans'
);
requireContains(
  'src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts',
  'excludedCurrentProvider: false,',
  'providerProtocol boundary conflicts must keep excludedCurrentProvider=false'
);
requireContains(
  'tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts',
  'protocol boundary conflicts never exclude providers from VR route hits',
  'protocol boundary conflicts need a regression test proving no VR route-hit exclusion'
);

if (failures.length > 0) {
  console.error('[verify:route-metadata-preselected-route-owner] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:route-metadata-preselected-route-owner] ok');
