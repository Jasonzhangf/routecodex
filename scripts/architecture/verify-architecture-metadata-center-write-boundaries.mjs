import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();

const files = {
  manifest: 'docs/architecture/metadata-center-manifest.yml',
  wiki: 'docs/architecture/wiki/metadata-center-mainline-source.md',
  functionMap: 'docs/architecture/function-map.yml',
  verificationMap: 'docs/architecture/verification-map.yml',
  mainlineCallMap: 'docs/architecture/mainline-call-map.yml',
  packageJson: 'package.json',
};

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function fail(message, failures) {
  failures.push(message);
}

const failures = [];
const manifestSource = read(files.manifest);
const wikiSource = read(files.wiki);
const functionMapSource = read(files.functionMap);
const verificationMapSource = read(files.verificationMap);
const mainlineCallMapSource = read(files.mainlineCallMap);
const packageJson = JSON.parse(read(files.packageJson));
const manifest = YAML.parse(manifestSource);

const requiredFamilies = [
  'request_truth',
  'continuation_context',
  'runtime_control',
  'provider_observation',
  'response_observation',
  'closeout_status',
  'debug_snapshot',
];

const requiredFamilyPolicies = {
  request_truth: 'write_once',
  continuation_context: 'replaceable_by_owner_only',
  runtime_control: 'replaceable_by_owner_only',
  provider_observation: 'append_only',
  response_observation: 'append_only',
  closeout_status: 'finalize_only',
  debug_snapshot: 'append_only',
};

for (const family of requiredFamilies) {
  if (!manifest?.families?.[family]) {
    fail(`${files.manifest}: missing required family ${family}`, failures);
  }
}

for (const [family, expectedPolicy] of Object.entries(requiredFamilyPolicies)) {
  if (manifest?.families?.[family]?.write_policy !== expectedPolicy) {
    fail(
      `${files.manifest}: family ${family} write_policy must be ${expectedPolicy}`,
      failures,
    );
  }
}

const requiredPolicies = ['write_once', 'replaceable_by_owner_only', 'append_only', 'finalize_only'];
const policyValues = manifest?.provenance?.write_policies;
for (const policy of requiredPolicies) {
  if (!Array.isArray(policyValues) || !policyValues.includes(policy)) {
    fail(`${files.manifest}: provenance.write_policies missing ${policy}`, failures);
  }
}

const requiredGate = 'npm run verify:architecture-metadata-center-write-boundaries';
const manifestRequiredGates = manifest?.verification?.required_gates;
if (!Array.isArray(manifestRequiredGates) || !manifestRequiredGates.includes(requiredGate)) {
  fail(`${files.manifest}: verification.required_gates missing ${requiredGate}`, failures);
}

if (!packageJson.scripts?.['verify:architecture-metadata-center-write-boundaries']) {
  fail(`${files.packageJson}: missing script verify:architecture-metadata-center-write-boundaries`, failures);
}

if (packageJson.scripts?.['verify:architecture-metadata-center-write-boundaries']?.includes('verify:metadata-center-dualwrite-api')) {
  fail(
    `${files.packageJson}: verify:architecture-metadata-center-write-boundaries still points at legacy dualwrite gate instead of a dedicated boundary verifier`,
    failures,
  );
}

if (!packageJson.scripts?.['verify:architecture-review-surface-light']?.includes('verify:architecture-metadata-center-write-boundaries')) {
  fail(`${files.packageJson}: verify:architecture-review-surface-light must include verify:architecture-metadata-center-write-boundaries`, failures);
}

const sameCenterNeedles = [
  'same request-scoped `MetadataCenter`',
  'server -> Hub Pipeline -> provider/runtime -> response closeout',
  'not session-scoped',
];
for (const needle of sameCenterNeedles) {
  if (!wikiSource.includes(needle)) {
    fail(`${files.wiki}: missing same-center rule text: ${needle}`, failures);
  }
}

const forbiddenRewriteNeedles = [
  'must not be restored from continuation history',
  'must not be derived from tmux/client attachment scope',
  'must not be promoted back into request identity',
  'must not repair or backfill prior families',
];
for (const needle of forbiddenRewriteNeedles) {
  if (!wikiSource.includes(needle) && !functionMapSource.includes(needle) && !verificationMapSource.includes(needle)) {
    fail(`contract docs: missing forbidden rewrite rule text: ${needle}`, failures);
  }
}

const mainlineBoundaryNeedles = [
  'Later stages must not rewrite these fields from continuation or attachment scope.',
  'continuation fields must not be promoted back into request identity.',
  'Closeout may mark release only; it must not repair or backfill prior families.',
];
for (const needle of mainlineBoundaryNeedles) {
  if (!mainlineCallMapSource.includes(needle)) {
    fail(`${files.mainlineCallMap}: missing boundary note: ${needle}`, failures);
  }
}

const verificationNeedles = [
  'one request uses one bound MetadataCenter across server -> Hub Pipeline -> provider/runtime -> response closeout',
  '`request_truth.sessionId/conversationId` are written only at inbound request capture',
  'are never restored from continuation context, tmux/client attachment scope, or response-side metadata',
];
for (const needle of verificationNeedles) {
  if (!verificationMapSource.includes(needle)) {
    fail(`${files.verificationMap}: missing verification note: ${needle}`, failures);
  }
}

if (!functionMapSource.includes('single request-scoped metadata center remains the only carrier across server -> Hub Pipeline -> provider/runtime -> response closeout')) {
  fail(`${files.functionMap}: missing feature summary for single request-scoped metadata center`, failures);
}

const runtimeControlBoundary = manifest?.boundaries?.runtime_control;
const forbiddenRuntimeStages = [
  'HubRespInbound02Parsed',
  'HubRespChatProcess03Governed',
  'HubRespOutbound04ClientSemantic',
  'ServerRespOutbound05ClientFrame',
];
for (const stage of forbiddenRuntimeStages) {
  if (!Array.isArray(runtimeControlBoundary?.must_not_be_written_by_stages)
    || !runtimeControlBoundary.must_not_be_written_by_stages.includes(stage)) {
    fail(
      `${files.manifest}: runtime_control.must_not_be_written_by_stages missing ${stage}`,
      failures,
    );
  }
}

const responseProjectionStage = Array.isArray(manifest?.stages)
  ? manifest.stages.find((stage) => stage?.node_id === 'MetaResp07ServertoolContextProjected')
  : undefined;
if (!responseProjectionStage) {
  fail(`${files.manifest}: missing stage MetaResp07ServertoolContextProjected`, failures);
} else if (Array.isArray(responseProjectionStage.write_families) && responseProjectionStage.write_families.length > 0) {
  fail(
    `${files.manifest}: MetaResp07ServertoolContextProjected must stay read-only and have no write_families`,
    failures,
  );
}

if (failures.length > 0) {
  console.error('[verify:architecture-metadata-center-write-boundaries] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[verify:architecture-metadata-center-write-boundaries] ok');
console.log(`- verified families: ${requiredFamilies.length}`);
console.log(`- verified policies: ${requiredPolicies.join(', ')}`);
