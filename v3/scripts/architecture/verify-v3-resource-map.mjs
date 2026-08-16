#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const architectureRoot = process.env.ROUTECODEX_V3_SOURCE_ROOT
  ? resolve(process.env.ROUTECODEX_V3_SOURCE_ROOT)
  : resolve(v3Root, '..');

const docs = [
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-verification-map.yml',
  'docs/architecture/wiki/v3-responses-direct-mainline.md',
];
const nodes = [
  'V3Config01FileSource', 'V3Config02AuthoringParsed', 'V3Config03SchemaValidated',
  'V3Config04ResourceRegistryBuilt', 'V3Config05ManifestPublished',
  'V3Server03HttpRequestRaw', 'V3Req04StandardizedResponses',
  'V3Router05RequestClassified', 'V3Router06RoutePoolResolved',
  'V3Router07OpaqueTargetHitOnce', 'V3Target08KindClassified',
  'V3Target09CandidateSetExpanded', 'V3Target10ConcreteProviderSelected',
  'V3Execution11ProtocolDecision', 'v3.execution.protocol_decision',
  'V3ResponsesDirect11Policy', 'V3Provider12ResponsesWirePayload',
  'V3Transport13ResponsesHttpRequest', 'V3ProviderResp14Raw',
  'V3Resp15ClientPayload', 'V3Server16HttpFrame',
  'V3DebugTraceContextStarted', 'V3DebugEventLedgerRecorded',
  'V3DebugRawCaptureStored', 'V3DebugSnapshotSessionRegistered',
  'V3DryRunNoNetworkTerminalEffect',
  'V3Error01SourceRaised', 'V3Error02Classified',
  'V3Error03TargetLocalAction', 'V3Error04TargetExhaustionDecision',
  'V3Error05ExecutionDecision', 'V3Error06ClientProjected',
  'V3ProviderHealthStateMutated', 'V3ProviderAvailabilityProjected',
  'V3RouterRequestFacts', 'v3.route.selection_plan',
];
const combined = docs.map((file) => readFileSync(resolve(architectureRoot, file), 'utf8')).join('\n');
const missing = nodes.filter((node) => !combined.includes(node));
const resourceMapPath = resolve(architectureRoot, 'docs/architecture/v3-resource-operation-map.yml');
const resourceMap = YAML.parse(readFileSync(resourceMapPath, 'utf8'));
if (!Array.isArray(resourceMap?.resources) || resourceMap.resources.length === 0) {
  missing.push('v3-resource-operation-map.yml active resources array');
} else {
  const resourceIds = new Set();
  const crateNames = new Set();
  const declaredNonCrateOwners = new Set([
    'routecodex-v3-build-tools',
    'routecodex-v3-docs',
  ]);
  const cratesRoot = resolve(architectureRoot, 'v3/crates');
  if (!existsSync(cratesRoot)) {
    missing.push('live v3/crates source root');
  } else {
    for (const entry of readdirSync(cratesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(cratesRoot, entry.name, 'Cargo.toml');
      if (!existsSync(manifestPath)) continue;
      const packageName = readFileSync(manifestPath, 'utf8').match(/^name\s*=\s*"([^"]+)"/mu)?.[1];
      if (packageName) crateNames.add(packageName);
    }
  }
  for (const resource of resourceMap.resources) {
    if (typeof resource?.resource_id !== 'string' || resourceIds.has(resource.resource_id)) {
      missing.push(`unique resource_id ${resource?.resource_id ?? '<missing>'}`);
    } else {
      resourceIds.add(resource.resource_id);
    }
    if (typeof resource?.owner_crate !== 'string'
        || (!crateNames.has(resource.owner_crate) && !declaredNonCrateOwners.has(resource.owner_crate))) {
      missing.push(`live owner crate for ${resource?.resource_id ?? '<missing>'}: ${resource?.owner_crate ?? '<missing>'}`);
    }
  }
}
if (missing.length) {
  console.error('[verify:v3-resource-map] failed');
  for (const node of missing) console.error(`- missing ${node}`);
  process.exit(1);
}
console.log('[verify:v3-resource-map] ok');
