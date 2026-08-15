#!/usr/bin/env node
/**
 * v4_compat_gate_responses_direct
 *
 * Locks the V3 Responses Direct compatibility evidence slice (Phase 8):
 * 1. All six required surfaces are present: request path / response path /
 *    error path / streaming / lifecycle / audit.
 * 2. Every V3 stage maps to exactly one V4 container + checkpoint + resource
 *    + verification gate with evidence.
 * 3. Referenced v4 resources exist in v4-resource-operation-map.yml and every
 *    verification gate exists in verification-map.json.
 * 4. unexplained_diff must be 0: no entry may carry diff_status=unexplained.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const failures = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const readYaml = (file) => {
  try {
    return yaml.load(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: cannot read/parse: ${error.message}`);
    return null;
  }
};

const slice = readYaml('v4/docs/architecture/v4-responses-direct-compatibility-slice.yml');
const verification = readJson('v4/.appsdk/maps/verification-map.json');
const resourceMap = readYaml('v4/docs/architecture/v4-resource-operation-map.yml');

if (!slice || !verification || !resourceMap) process.exit(1);

const gateIds = new Set((verification.gates ?? []).map((gate) => gate.gate_id));
const resourceIds = new Set((resourceMap.resources ?? []).map((resource) => resource.resource_id));

const requiredSurfaces = ['request_path', 'response_path', 'error_path', 'streaming', 'lifecycle', 'audit'];
const surfaces = slice.surfaces ?? [];
const present = new Set(surfaces.map((surface) => surface.surface_id));

for (const surfaceId of requiredSurfaces) {
  if (!present.has(surfaceId)) {
    failures.push(`responses-direct slice: missing required surface ${surfaceId}`);
  }
}

let unexplained = 0;
let entryTotal = 0;
for (const surface of surfaces) {
  for (const entry of surface.entries ?? []) {
    entryTotal += 1;
    const id = `${surface.surface_id}.${entry.v3_stage ?? '?'}`;
    if (!entry.v3_stage) {
      failures.push(`${id}: missing v3_stage`);
    }
    if (!entry.v3_resource) {
      failures.push(`${id}: missing v3_resource`);
    }
    if (!entry.v4_container?.family || !entry.v4_container?.role) {
      failures.push(`${id}: v4 container must have family + role`);
    }
    if (!entry.v4_checkpoint?.node_id || !entry.v4_checkpoint?.semantic) {
      failures.push(`${id}: v4 checkpoint must have node_id + semantic`);
    }
    if (!entry.v4_resource) {
      failures.push(`${id}: missing v4_resource`);
    } else if (!resourceIds.has(entry.v4_resource)) {
      failures.push(`${id}: v4_resource ${entry.v4_resource} not in v4-resource-operation-map.yml`);
    }
    if (!Array.isArray(entry.verification_gates) || entry.verification_gates.length === 0) {
      failures.push(`${id}: missing verification gates`);
    } else {
      for (const gate of entry.verification_gates) {
        if (!gateIds.has(gate)) {
          failures.push(`${id}: verification gate ${gate} not in verification-map.json`);
        }
      }
    }
    const evidence = entry.evidence ?? '';
    if (!evidence || evidence === 'pending_skeleton_vslice') {
      failures.push(`${id}: evidence pending (${evidence || 'empty'})`);
    }
    if (entry.diff_status === 'unexplained') {
      unexplained += 1;
    }
  }
}

if (slice.unexplained_diff !== 0 || unexplained !== 0) {
  failures.push(
    `responses-direct slice: unexplained_diff must be 0 (declared=${slice.unexplained_diff} actual=${unexplained})`,
  );
}

if (failures.length > 0) {
  console.error('[v4_compat_gate_responses_direct] FAIL');
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `[v4_compat_gate_responses_direct] OK surfaces=6 entries=${entryTotal} unexplained_diff=0`,
);
