#!/usr/bin/env node
import { readFileSync } from 'node:fs';

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
const combined = docs.map((file) => readFileSync(file, 'utf8')).join('\n');
const missing = nodes.filter((node) => !combined.includes(node));
if (missing.length) {
  console.error('[verify:v3-resource-map] failed');
  for (const node of missing) console.error(`- missing ${node}`);
  process.exit(1);
}
console.log('[verify:v3-resource-map] ok');
