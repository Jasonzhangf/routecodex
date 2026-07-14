import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// feature_id: hub.pipeline_rust_residual_reference_closeout
// Gate owner: verifyArchitectureThinWrapperOnly

const root = process.cwd();
const scanRoot = process.env.ROUTECODEX_ARCHITECTURE_THIN_WRAPPER_SCAN_ROOT
  ? path.resolve(root, process.env.ROUTECODEX_ARCHITECTURE_THIN_WRAPPER_SCAN_ROOT)
  : root;
const packageJsonPath = process.env.ROUTECODEX_PACKAGE_JSON_PATH ?? 'package.json';

const targetRoots = [
  'sharedmodule/llmswitch-core/src/conversion/hub/process',
  'sharedmodule/llmswitch-core/src/native/router-hotpath',
];

const rootHostRoots = [
  'src/modules/llmswitch/bridge',
];

const rootHostFiles = [
  'src/server/runtime/http-server/executor-pipeline.ts',
  'src/server/runtime/http-server/request-executor.ts',
  'src/server/runtime/http-server/executor/provider-response-converter.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts',
  'src/server/runtime/http-server/executor/request-executor-provider-failure.ts',
  'src/server/handlers/responses-handler.ts',
  'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  'src/modules/llmswitch/bridge/responses-conversation-store-host.ts',
];

const exts = new Set(['.ts']);

const allowedFiles = new Set([
  'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-web-search.ts',
]);

const legacyMutationPatterns = [
  /\b(messages|tool_calls|toolCalls)\s*\.\s*(push|splice|pop|shift|unshift)\s*\(/u,
  /\b(messages|tool_calls|toolCalls)\s*\[[^\]]+\]\s*=/u,
  /\b[A-Za-z0-9_.[\]'"]+\.(messages|tool_calls|toolCalls|content|payload)\s*=\s*(?![=])/u,
  /\bdelete\s+[A-Za-z0-9_.\[\]'"]*(messages|tool_calls|toolCalls|content|payload)\b/u,
];

const rootHostForbiddenRules = [
  {
    id: 'handler_second_save_writer',
    description: 'handler/request bridge must not own response-side relay continuation save',
    include: [
      'src/server/handlers/responses-handler.ts',
      'src/modules/llmswitch/bridge/responses-request-bridge.ts',
    ],
    patterns: [
      /\bfinalizeResponsesPipelineResultForHttp\b/u,
      /\bseedResponsesToolCallResponseForHttp\b/u,
      /\brecordResponsesResponseForHttp\b/u,
      /\brecordResponsesResponseForRequest\b/u,
      /\brecordResponsesResponse\s*\(/u,
    ],
  },
  {
    id: 'root_host_flat_provider_protocol_fallback',
    description: 'root host must not rebuild providerProtocol from flat metadata or fallback operators',
    include: [
      'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      'src/server/runtime/http-server/executor-pipeline.ts',
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    ],
    patterns: [
      /\bmetadata\s*\.\s*providerProtocol\b/u,
      /\bmetadata\s*\?\.\s*providerProtocol\b/u,
      /\bmetadata\s*\[[`'"]providerProtocol[`'"]\]/u,
      /\bproviderProtocol\b[^;\n]*(?:\|\||\?\?)[^;\n]*/u,
    ],
  },
  {
    id: 'root_host_flat_retry_exclusion_fallback',
    description: 'root host must not restore retry exclusion truth from flat metadata',
    include: [
      'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      'src/server/runtime/http-server/executor-pipeline.ts',
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    ],
    patterns: [
      /\bmetadata\s*\.\s*excludedProviderKeys\b/u,
      /\bmetadata\s*\?\.\s*excludedProviderKeys\b/u,
      /\bmetadata\s*\[[`'"]excludedProviderKeys[`'"]\]/u,
    ],
  },
  {
    id: 'provider_response_errorerr_ts_classifier',
    description: 'provider response host must not own ErrorErr retry/status/message classification',
    include: [
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
    ],
    patterns: [
      /\bretryable\s*=\s*(?:true|false)\b/u,
      /\bstatusCode\s*=\s*(?:\d+|extractStatusCodeFromError|[^;\n]*message[^;\n]*)(?!=)/u,
      /\bcode\s*=\s*['"][A-Z0-9_]+['"](?!=)/u,
      /\bmessage\s*\.(?:includes|match|startsWith|toLowerCase)\s*\(/u,
      /\b(?:rate[_-]?limit|quota|unauthorized|forbidden|network|timeout)\b[^;\n]*(?:retryable|statusCode|errorCode|upstreamCode)/iu,
    ],
  },
  {
    id: 'provider_response_semantic_payload_fallback',
    description: 'provider response host must not fallback to runtime output or original payload semantics',
    include: [
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
    ],
    patterns: [
      /\bruntimeOutput\s*\.\s*chatResponse\b/u,
      /\boriginal(?:Payload|Response|Body)\b[^;\n]*(?:\|\||\?\?|:)/u,
      /\b(?:payload|body|response)\s*(?:\|\||\?\?)\s*original(?:Payload|Response|Body)\b/u,
    ],
  },
  {
    id: 'malformed_native_plan_downgrade',
    description: 'malformed native/Rust plan must fail fast, not downgrade to success/empty/unchanged',
    include: [
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
      'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
      'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      'src/server/runtime/http-server/executor/provider-response-converter.ts',
    ],
    patterns: [
      /\bcatch\s*\([^)]*\)\s*\{[^}]*return\s+\{\s*\}/su,
      /\bcatch\s*\([^)]*\)\s*\{[^}]*return\s+(?:payload|body|response|options\.response)/su,
      /\bcatch\s*\([^)]*\)\s*\{[^}]*success\s*:\s*true/su,
      /\bmalformed\b[^;\n]*(?:return\s+\{\s*\}|unchanged|success\s*:\s*true)/iu,
      /\b(?:action|stage|kind)\s*:\s*['"]unchanged['"]/u,
    ],
  },
  {
    id: 'dead_broad_native_facade_owner',
    description: 'root host runtime must not import broad native-exports except owner-specific narrow host files',
    includePrefixes: [
      'src/server/runtime/http-server/',
      'src/server/handlers/',
    ],
    patterns: [
      /from\s+['"][^'"]*modules\/llmswitch\/bridge\/native-exports(?:\.js|\.ts)?['"]/u,
      /import\s*\([^)]*['"][^'"]*modules\/llmswitch\/bridge\/native-exports(?:\.js|\.ts)?['"][^)]*\)/u,
    ],
  },
  {
    id: 'dead_provider_response_metadata_wrapper',
    description: 'deleted provider-response metadata wrapper/fallback surface must not revive',
    include: [
      'src/modules/llmswitch/bridge/provider-response-converter-host.ts',
      'src/modules/llmswitch/bridge/provider-response-native-calls.ts',
      'src/modules/llmswitch/bridge/provider-response-effects.ts',
    ],
    patterns: [
      /\bprojectNativeMetadataWritePlanToRuntimeControlWritePlan\b/u,
      /\bprojectMetadataWritePlanToRuntimeControlWritePlanWithNative\b/u,
      /\bexecuteProviderResponseNativeServertoolEffects\b[^;\n]*\bHubRespChatProcess03Governed\b/u,
    ],
  },
];

function normalizeRel(absPath) {
  return path.relative(scanRoot, absPath).split(path.sep).join('/');
}

function isGeneratedOrExternal(relPath) {
  return /(^|\/)(dist|node_modules|coverage|target|\.git|\.mempalace|\.local-index)\//u.test(relPath);
}

function listFiles(relRoot) {
  const absRoot = path.join(scanRoot, relRoot);
  if (!fs.existsSync(absRoot)) return [];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      const rel = normalizeRel(next);
      if (entry.isDirectory()) {
        if (!isGeneratedOrExternal(`${rel}/`)) stack.push(next);
      } else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts') && !isGeneratedOrExternal(rel)) {
        out.push(next);
      }
    }
  }
  return out;
}

function listRootHostFiles() {
  const files = new Map();
  for (const relRoot of rootHostRoots) {
    for (const file of listFiles(relRoot)) {
      files.set(normalizeRel(file), file);
    }
  }
  for (const relFile of rootHostFiles) {
    const abs = path.join(scanRoot, relFile);
    if (fs.existsSync(abs)) files.set(relFile, abs);
  }
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function isLegacyMutationLine(line) {
  return legacyMutationPatterns.some((pattern) => pattern.test(line));
}

function ruleApplies(rule, relFile) {
  if (rule.include?.includes(relFile)) return true;
  if (rule.includePrefixes?.some((prefix) => relFile.startsWith(prefix))) return true;
  return false;
}

function stripCommentLines(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\*)/u.test(line) ? '' : line))
    .join('\n');
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split('\n').length;
}

function checkPackageScript(failures) {
  const packagePath = path.resolve(root, packageJsonPath);
  if (!fs.existsSync(packagePath)) {
    failures.push('package.json: missing package.json for thin-wrapper gate script wiring');
    return;
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = packageJson.scripts ?? {};
  if (!Object.hasOwn(scripts, 'verify:architecture-thin-wrapper-only')) {
    failures.push('package.json: missing verify:architecture-thin-wrapper-only script');
  }
  if (!Object.hasOwn(scripts, 'test:architecture-thin-wrapper-only-red-fixtures')) {
    failures.push('package.json: missing test:architecture-thin-wrapper-only-red-fixtures script');
  }
  if (
    typeof scripts['verify:architecture-ci-longtail'] === 'string'
    && !scripts['verify:architecture-ci-longtail'].includes('test:architecture-thin-wrapper-only-red-fixtures')
  ) {
    failures.push('package.json: verify:architecture-ci-longtail must include test:architecture-thin-wrapper-only-red-fixtures');
  }
}

function trackedSourceExists(relPath) {
  if (scanRoot !== root) return fs.existsSync(path.join(scanRoot, relPath));
  const result = spawnSync('git', ['ls-files', '--error-unmatch', relPath], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0 && fs.existsSync(path.join(root, relPath));
}

const failures = [];
let checkedFiles = 0;
let rootHostCheckedFiles = 0;

for (const relRoot of targetRoots) {
  for (const file of listFiles(relRoot)) {
    const relFile = normalizeRel(file);
    if (allowedFiles.has(relFile)) continue;
    checkedFiles += 1;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!isLegacyMutationLine(line)) return;
      failures.push(`${relFile}:${idx + 1}: legacy Hub Pipeline mutation remains: ${line.trim()}`);
    });
  }
}

for (const [relFile, absFile] of listRootHostFiles()) {
  rootHostCheckedFiles += 1;
  const source = fs.readFileSync(absFile, 'utf8');
  const codeOnly = stripCommentLines(source);
  for (const rule of rootHostForbiddenRules) {
    if (!ruleApplies(rule, relFile)) continue;
    for (const pattern of rule.patterns) {
      for (const match of codeOnly.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
        const lineNo = lineNumberForIndex(codeOnly, match.index ?? 0);
        failures.push(`${relFile}:${lineNo}: ${rule.description} (${rule.id})`);
      }
    }
  }
}

for (const relFile of rootHostFiles) {
  if (!trackedSourceExists(relFile)) {
    failures.push(`${relFile}: required root host scan target is missing`);
  }
}

if (rootHostCheckedFiles === 0) {
  failures.push('root host checked files: 0; thin-wrapper gate must scan root bridge/handler/converter/executor surface');
}

checkPackageScript(failures);

if (failures.length > 0) {
  console.error('[verify:architecture-thin-wrapper-only] failed');
  failures.slice(0, 160).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 160) console.error(`- ... ${failures.length - 160} more`);
  process.exit(1);
}

console.log('[verify:architecture-thin-wrapper-only] ok');
console.log(`- checked files: ${checkedFiles + rootHostCheckedFiles}`);
console.log(`- legacy sharedmodule checked files: ${checkedFiles}`);
console.log(`- root host checked files: ${rootHostCheckedFiles}`);
console.log(`- target roots: ${targetRoots.length}`);
console.log(`- root host roots: ${rootHostRoots.length}`);
console.log(`- explicit root host files: ${rootHostFiles.length}`);
console.log(`- allowlisted files: ${allowedFiles.size}`);
