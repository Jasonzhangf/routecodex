import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'docs/loops/rustification/minimal-ts-surface.json');
const FUNCTION_MAP_PATH = path.join(ROOT, 'docs/architecture/function-map.yml');
const VERIFICATION_MAP_PATH = path.join(ROOT, 'docs/architecture/verification-map.yml');
const SRC_PREFIX = 'sharedmodule/llmswitch-core/src/';
const GENERATED_DIR_NAMES = new Set([
  'dist',
  'target',
  'coverage',
  'node_modules',
  '.mempalace',
  '.local-index',
  'mempalace',
  '__snapshots__',
  'snapshots',
  'reports',
]);
const ALLOWED_CLASSIFICATIONS = new Set([
  'native_shell_ok',
  'type_shell_ok',
  'ts_io_shell_ok',
  'parser_io_ok',
  'diagnostic_io_ok',
]);
const SEMANTIC_TOKEN_PATTERNS = {
  'provider response parsing': [
    /\bprovider\s+response\s+parsing\b/iu,
    /\brunRespInboundStage2FormatParse\b/u,
    /\brunRespInboundStage3SemanticMap\b/u,
    /\bOpenAIChatResponseMapper\b/u,
    /\bPROVIDER_RESPONSE_REGISTRY\b/u,
  ],
  'response governance': [
    /\bresponse\s+governance\b/iu,
    /\brunRespProcessStage1ToolGovernance\b/u,
    /\brunRespProcessStage2Finalize\b/u,
    /\brunRespProcessStage3ServerToolOrchestration\b/u,
  ],
  'client projection': [
    /\bclient\s+projection\b/iu,
    /\brunRespOutboundStage1ClientRemap\b/u,
    /\bbuild[A-Za-z0-9_]*(?:Client|Responses|Chat)[A-Za-z0-9_]*Payload\b/u,
  ],
  'effect planning': [
    /\beffect\s+planning\b/iu,
    /\binterface\s+ProviderResponsePlan\b/u,
    /\btype\s+ProviderResponsePlan\b/u,
    /\bswitch\s*\([^)]*(?:effect|runtimeEffect)[^)]*(?:kind|action)[^)]*\)/u,
    /(?:effect|runtimeEffect)\.(?:kind|action)\s*===/u,
  ],
  fallback: [/\bfallback\b/iu, /\bcompat\b/iu, /best[- ]?effort/iu],
  'pipeline execution': [/\bexecuteHubPipeline\b/u, /\bexecuteHubPipelineWithNative\b/u],
  'route selection': [/\bselectProvider\b/u, /\bselectRoute\b/u],
  'payload mutation': [/\bpayload\s+mutation\b/iu, /\bpayload\s*=/u],
  'request shaping': [/\brequest\s+shaping\b/iu],
  'response shaping': [/\bresponse\s+shaping\b/iu],
  'route policy': [/\broute\s+policy\b/iu],
  'tool governance': [/\btool\s+governance\b/iu],
  'continuation policy': [/\bcontinuation\s+policy\b/iu],
  'runtime routing': [/\bruntime\s+routing\b/iu],
  'provider selection': [/\bprovider\s+selection\b/iu],
  'payload policy': [/\bpayload\s+policy\b/iu],
  'provider policy': [/\bprovider\s+policy\b/iu],
  'client response projection': [/\bproject[A-Za-z0-9_]*Client[A-Za-z0-9_]*Response\b/u, /\bclientResponse[A-Za-z0-9_]*\s*=/u],
  'Hub stage policy': [/\bresolveHubStage[A-Za-z0-9_]*Policy\b/u, /\bplanHubStage[A-Za-z0-9_]*Policy\b/u],
  'VR policy': [/\bresolveVirtualRouter[A-Za-z0-9_]*Policy\b/u, /\bplanVirtualRouter[A-Za-z0-9_]*Policy\b/u],
  'request repair': [/\brepair[A-Za-z0-9_]*Request\b/u, /\brequestRepair[A-Za-z0-9_]*\b/u],
  'response repair': [/\brepair[A-Za-z0-9_]*Response\b/u, /\bresponseRepair[A-Za-z0-9_]*\b/u],
  'routing policy': [/\bresolve[A-Za-z0-9_]*RoutingPolicy\b/u, /\bplan[A-Za-z0-9_]*RoutingPolicy\b/u],
  'metadata control truth': [/\bmetadata\s+control\s+truth\b/iu],
  'request/response semantic conversion': [/\brequest\/response\s+semantic\s+conversion\b/iu],
  'message normalization': [/\bmessage\s+normalization\b/iu],
  'payload repair': [/\bpayload\s+repair\b/iu],
  'runtime JSON guards': [/\bfunction\s+isJson[A-Za-z0-9_]*\b/u],
  'clone helpers': [/\bfunction\s+jsonClone\b/u, /\bstructuredClone\b/u],
  'protocol validation': [/\bprotocol\s+validation\b/iu],
  'payload sanitization': [/\bsanitiz(?:e|ation)\b/iu],
  'standardization execution': [/\bstandardization\s+execution\b/iu],
  'route decision': [/\broute\s+decision\b/iu],
  'provider wire build': [/\bprovider\s+wire\s+build\b/iu],
  'manual continuation owner branches': [/\bcontinuationOwner\s*===/u, /\bconst\s+owners\s*:\s*Array\b/u],
  'manual scope-key builder': [
    /entry:\$\{[^`]+owner:\$\{/u,
    /owner:\$\{[^`]+session:\$\{/u,
    /owner:\$\{[^`]+conversation:\$\{/u,
  ],
  'payload materialization': [/\bpayload\s+materialization\b/iu],
  'allowContinuation policy': [/\ballowContinuation\s*[:=]\s*(?:true|false)/u],
  'output-to-input conversion': [/\boutput[-_ ]to[-_ ]input\b/iu],
  'retry policy': [/\bretry\s+policy\b/iu],
  'reroute policy': [/\breroute\s+policy\b/iu],
  'provider error classification': [/\bprovider\s+error\s+classification\b/iu],
  'load balancing': [/\bload\s+balancing\b/iu],
  'provider availability': [/\bprovider\s+availability\b/iu],
  'error classes': [/\berror\s+classes\b/iu],
  'runtime constants': [/\bruntime\s+constants\b/iu],
  routing: [/\brouting\b/iu],
  'Hub payload policy': [/\bHub\s+payload\s+policy\b/u],
  'servertool execution policy': [/\bservertool\s+execution\s+policy\b/iu],
  'followup orchestration': [/\bfollowup\s+orchestration\b/iu],
  'handler selection': [/\bhandler\s+selection\b/iu],
  'execution dispatch': [/\bexecution\s+dispatch\b/iu],
  'followup policy': [/\bfollowup\s+policy\b/iu],
  'hit reason build': [/\bhit\s+reason\s+build\b/iu],
  'client response policy': [/\bclient\s+response\s+policy\b/iu],
};

function readGitTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'))
    .sort();
}

function isGeneratedOrLocalIndexPath(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => GENERATED_DIR_NAMES.has(part))) return true;
  if (rel.endsWith('.html')) return true;
  if (/\.(bak|backup|orig|tmp)$/u.test(rel)) return true;
  if (rel.endsWith('~')) return true;
  if (/generated[-_/].*report|report[-_/].*generated/u.test(rel)) return true;
  return false;
}

function isProdTs(rel) {
  if (rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) return false;
  if (rel.includes('/tests/')) return false;
  if (rel.includes('/test/')) return false;
  if (rel.includes('/archive/')) return false;
  return true;
}

function isNativeLinked(content) {
  return [
    /native-router-hotpath/,
    /WithNative/,
    /loadNativeRouterHotpathBinding/,
    /router_hotpath_napi/,
  ].some((pattern) => pattern.test(content));
}

function listCurrentNonNativeProdTsFiles() {
  return readGitTrackedFiles()
    .filter((rel) => rel.startsWith(SRC_PREFIX))
    .filter((rel) => !isGeneratedOrLocalIndexPath(rel))
    .filter((rel) => rel.endsWith('.ts'))
    .filter((rel) => isProdTs(rel))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .filter((rel) => !isNativeLinked(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
}

function isCurrentTrackedProdTsFile(rel) {
  if (typeof rel !== 'string') return false;
  if (!rel.startsWith(SRC_PREFIX)) return false;
  if (!rel.endsWith('.ts')) return false;
  if (isGeneratedOrLocalIndexPath(rel)) return false;
  if (!isProdTs(rel)) return false;
  return fs.existsSync(path.join(ROOT, rel));
}

function isCurrentNativeLinkedProdTsFile(rel) {
  if (!isCurrentTrackedProdTsFile(rel)) return false;
  return isNativeLinked(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`missing minimal TS manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function readFeatureIds(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing feature map: ${path.relative(ROOT, filePath)}`);
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const ids = new Set();
  const featureIdPattern = /^\s*-\s+feature_id:\s*([^\s#]+)/gmu;
  let match;
  while ((match = featureIdPattern.exec(source))) {
    ids.add(match[1]);
  }
  return ids;
}

function hasFeatureOrDescendant(featureIds, ownerFeature) {
  if (featureIds.has(ownerFeature)) return true;
  const childPrefix = `${ownerFeature}.`;
  return Array.from(featureIds).some((featureId) => featureId.startsWith(childPrefix));
}

function hasUsefulReason(value) {
  return typeof value === 'string' && value.trim().length >= 40;
}

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withoutManifestCommentLines(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
  return withoutComments
    .split('\n')
    .filter((line) => !line.includes('forbiddenSemantics') && !line.includes('cannotShrinkFurtherBecause'))
    .join('\n');
}

function findForbiddenSemanticHits(source, forbiddenSemantics) {
  const searchable = withoutManifestCommentLines(source);
  const hits = [];
  for (const semantic of forbiddenSemantics) {
    const patterns = SEMANTIC_TOKEN_PATTERNS[semantic];
    if (!patterns) {
      hits.push(`unmapped forbiddenSemantics token: ${semantic}`);
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.test(searchable)) {
        hits.push(`${semantic} matched ${String(pattern)}`);
      }
    }
  }
  return hits;
}

function main() {
  const manifest = readManifest();
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const errors = [];
  const current = new Set(listCurrentNonNativeProdTsFiles());
  const functionMapFeatureIds = readFeatureIds(FUNCTION_MAP_PATH);
  const verificationMapFeatureIds = readFeatureIds(VERIFICATION_MAP_PATH);
  const explicitNativeLinkedShells = new Set();
  const manifestPaths = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      errors.push('manifest contains a non-object entry');
      continue;
    }
    const rel = entry.path;
    if (typeof rel !== 'string' || !rel.startsWith(SRC_PREFIX)) {
      errors.push(`invalid path entry: ${String(rel)}`);
      continue;
    }
    if (manifestPaths.has(rel)) {
      errors.push(`duplicate manifest path: ${rel}`);
    }
    manifestPaths.add(rel);
    const isExplicitNativeLinkedShell = isCurrentNativeLinkedProdTsFile(rel);
    if (isExplicitNativeLinkedShell) {
      explicitNativeLinkedShells.add(rel);
    }
    if (!current.has(rel) && !isExplicitNativeLinkedShell) {
      errors.push(`manifest path is neither current non-native prod TS nor explicit native-linked shell: ${rel}`);
    }
    if (!ALLOWED_CLASSIFICATIONS.has(entry.classification)) {
      errors.push(`invalid classification for ${rel}: ${String(entry.classification)}`);
    }
    if (!hasUsefulReason(entry.cannotShrinkFurtherBecause)) {
      errors.push(`missing hard cannotShrinkFurtherBecause for ${rel}`);
    }
    if (!hasUsefulReason(entry.minimumTsRole)) {
      errors.push(`missing minimumTsRole for ${rel}`);
    }
    if (typeof entry.ownerFeature !== 'string' || !entry.ownerFeature.trim()) {
      errors.push(`missing ownerFeature for ${rel}`);
    } else {
      if (!hasFeatureOrDescendant(functionMapFeatureIds, entry.ownerFeature)) {
        errors.push(`ownerFeature is missing from function-map feature ids: ${rel} -> ${entry.ownerFeature}`);
      }
      if (!hasFeatureOrDescendant(verificationMapFeatureIds, entry.ownerFeature)) {
        errors.push(`ownerFeature is missing from verification-map feature ids: ${rel} -> ${entry.ownerFeature}`);
      }
    }
    if (!Array.isArray(entry.forbiddenSemantics) || entry.forbiddenSemantics.length === 0) {
      errors.push(`missing forbiddenSemantics for ${rel}`);
    } else if (isCurrentTrackedProdTsFile(rel)) {
      const hits = findForbiddenSemanticHits(readSource(rel), entry.forbiddenSemantics);
      for (const hit of hits) {
        errors.push(`forbidden semantic residue in ${rel}: ${hit}`);
      }
    }
  }

  for (const rel of current) {
    if (!manifestPaths.has(rel)) {
      errors.push(`current non-native prod TS file lacks minimal-surface classification: ${rel}`);
    }
  }

  if (errors.length > 0) {
    console.error('[verify-llmswitch-minimal-ts-surface] FAILED');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(2);
  }

  console.log('[verify-llmswitch-minimal-ts-surface] ok');
  console.log(`- entries: ${entries.length}`);
  console.log(`- current non-native prod TS files: ${current.size}`);
  console.log(`- explicit native-linked TS shells: ${explicitNativeLinkedShells.size}`);
}

main();
