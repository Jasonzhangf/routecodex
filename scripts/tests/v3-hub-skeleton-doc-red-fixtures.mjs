#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-architecture-docs.mjs');
const fixtures = [
  {
    name: 'continuation classification node removed',
    file: 'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
    from: 'V3HubReqContinuation03Classified',
    to: 'V3HubReqContinuation03Removed',
    diagnostic: /missing invariant V3HubReqContinuation03Classified/,
  },
  {
    name: 'immutable interval equality removed',
    file: 'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
    from: 'restore(normalize(save(context))) == context',
    to: 'context may be reconstructed later',
    diagnostic: /missing invariant restore\(normalize\(save\(context\)\)\) == context/,
  },
  {
    name: 'old P6 physical deletion removed',
    file: 'docs/design/v3-hub-pipeline-static-skeleton-contract.md',
    from: 'Physically delete',
    to: 'Keep indefinitely',
    diagnostic: /missing invariant Physically delete/,
  },
  {
    name: 'bound Hub edge removed',
    file: 'docs/architecture/v3-mainline-call-map.yml',
    from: 'step_id: v3-hub-req-01, from_node: V3HubReqInbound01ClientRaw, to_node: V3HubReqInbound02Normalized',
    to: 'step_id: v3-hub-req-01, from_node: V3HubReqInbound01ClientRaw, to_node: V3HubReqInbound02Normalized_REMOVED',
    diagnostic: /v3-hub-req-01 must remain adjacent/,
  },
  {
    name: 'pending continuation truth falsely anchored',
    file: 'docs/architecture/v3-resource-operation-map.yml',
    resourceId: 'v3.continuation.local_context_truth',
    diagnostic: /unimplemented Hub v1 business resource must remain binding_pending/,
  },
  {
    name: 'relay worker split removed',
    file: 'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
    from: 'feature_id:v3.hub_relay_request_semantics',
    to: 'feature_id:v3.hub_relay_request_removed',
    diagnostic: /Relay contract docs: missing invariant feature_id:v3\.hub_relay_request_semantics/,
  },
  {
    name: 'relay immutable interval normalization rule removed',
    file: 'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
    from: 'semantic-equivalent normalization',
    to: 'arbitrary processing',
    diagnostic: /Relay contract docs: missing invariant semantic-equivalent normalization/,
  },
  {
    name: 'relay fractional node ID introduced',
    file: 'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
    from: 'V3HubReqChatProcess04Governed: restore local context',
    to: 'V3HubReqChatProcess03_1Governed: restore local context',
    diagnostic: /fractional\/reused Hub node ID is forbidden/,
  },
  {
    name: 'relay unbounded copy ban removed',
    file: 'docs/design/v3-hub-relay-fixed-pipeline-contract.md',
    from: 'unbounded deep copy',
    to: 'Unlimited cloning',
    diagnostic: /missing payload copy-budget invariant unbounded deep copy/,
  },
  {
    name: 'relay D worker function map removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: 'feature_id: v3.hub_relay_gate_review_surface',
    to: 'feature_id: v3.hub_relay_gate_review_surface_REMOVED',
    diagnostic: /function map missing v3\.hub_relay_gate_review_surface/,
  },
  {
    name: 'relay request mainline reverse binding removed',
    file: 'docs/architecture/v3-function-map.yml',
    from: '      - v3-hub-relay-req-03',
    to: '      - v3-hub-relay-req-03_REMOVED',
    diagnostic: /binds missing mainline step v3-hub-relay-req-03_REMOVED/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-hub-doc-red-'));
  try {
    cpSync(resolve(repoRoot, 'docs'), join(root, 'docs'), { recursive: true });
    cpSync(resolve(repoRoot, 'package.json'), join(root, 'package.json'));
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), {
      recursive: true,
      filter: (source) => !source.includes('/target/'),
    });
    const target = join(root, fixture.file);
    let source = readFileSync(target, 'utf8');
    if (fixture.resourceId) {
      const marker = `  - resource_id: ${fixture.resourceId}`;
      const start = source.indexOf(marker);
      const next = source.indexOf('\n  - resource_id:', start + marker.length);
      if (start < 0) throw new Error(`resource marker missing: ${fixture.resourceId}`);
      const end = next < 0 ? source.length : next;
      const block = source.slice(start, end).replace('binding_status: binding_pending', 'binding_status: anchored');
      source = source.slice(0, start) + block + source.slice(end);
    } else {
      if (!source.includes(fixture.from)) throw new Error(`fixture source missing: ${fixture.from}`);
      source = source.split(fixture.from).join(fixture.to);
    }
    writeFileSync(target, source);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-800)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-hub-skeleton-doc-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-hub-skeleton-doc-red-fixtures] ok (${fixtures.length} forbidden contract mutations rejected)`);
