#!/usr/bin/env node
/**
 * v4_parity_gate_plane_isolation
 *
 * Locks data/control plane physical isolation (Phase 2/3):
 * 1. Every control-axis resource must never enter provider body or client body.
 * 2. Data payload resources must forbid control/metadata writers.
 * 3. forbidden_direct_edges in v4-resource-operation-map.yml must be respected:
 *    control -> payload / payload -> MetadataCenter / snapshot -> runtime decision
 *    are all red.
 * 4. Debug/diagnostic resources must declare may_enter_metadata_center=false.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

const readYaml = (file) => {
  try {
    return yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const resourceMap = readYaml('docs/architecture/v4-resource-operation-map.yml');
if (!resourceMap) process.exit(1);

const byId = new Map((resourceMap.resources ?? []).map((resource) => [resource.resource_id, resource]));

const controlOwnerNodes = [];
for (const resource of resourceMap.resources ?? []) {
  if (resource.axis === 'control') {
    // Typed error projection is the single sanctioned control->client surface:
    // ErrorErr06ClientProjected may carry only its declared client_visible_fields.
    const errorProjectionOnly =
      resource.resource_id === 'v4.error.client_projection' &&
      Array.isArray(resource.semantic_contract?.client_visible_fields);
    const clientBodyAllowed = resource.may_enter_client_body === true && errorProjectionOnly;
    if (resource.may_enter_provider_body !== false || (resource.may_enter_client_body !== false && !clientBodyAllowed)) {
      failures.push(`${resource.resource_id}: control resource must never enter provider/client body`);
    }
    controlOwnerNodes.push(resource.owner_node);
  }
  if (resource.axis === 'diagnostic') {
    const contract = resource.semantic_contract ?? {};
    if (contract.may_enter_metadata_center !== false) {
      failures.push(`${resource.resource_id}: diagnostic resource must declare may_enter_metadata_center=false`);
    }
  }
  if (resource.axis === 'data') {
    const forbidden = new Set(resource.forbidden_writers ?? []);
    for (const owner of controlOwnerNodes) {
      if (!forbidden.has(owner)) {
        failures.push(`${resource.resource_id}: missing forbidden writer ${owner} (control owner)`);
      }
    }
    if (resource.may_enter_provider_body === true && !forbidden.has('V4ControlMetadataCenter')) {
      failures.push(`${resource.resource_id}: provider-visible data must forbid V4ControlMetadataCenter`);
    }
  }
}

for (const edge of resourceMap.forbidden_direct_edges ?? []) {
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (!from) {
    failures.push(`forbidden_direct_edges: unknown from ${edge.from}`);
    continue;
  }
  if (!to) {
    failures.push(`forbidden_direct_edges: unknown to ${edge.to}`);
    continue;
  }
  const readerSet = new Set(from.allowed_readers ?? []);
  const writerSet = new Set(from.allowed_writers ?? []);
  const toOwner = to.owner_node;
  if (readerSet.has(toOwner) || writerSet.has(toOwner)) {
    failures.push(`forbidden_direct_edges: ${edge.from} may not reach ${edge.to} (owner ${toOwner})`);
  }
}

if (failures.length > 0) {
  console.error('[v4_parity_gate_plane_isolation] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('[v4_parity_gate_plane_isolation] OK control/data/diagnostic isolation locked');
