#!/usr/bin/env node
/**
 * verify:function-map-compile-gate
 *
 * The function map must parse as YAML and keep structural invariants:
 * every feature has a unique feature_id, required_gates use the npm run
 * prefix, and each declared gate resolves to a package.json script.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const failures = [];
const functionPath = path.join(root, 'docs', 'architecture', 'v3-function-map.yml');
const verificationPath = path.join(root, 'docs', 'architecture', 'v3-verification-map.yml');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let functionMap;
try {
  functionMap = YAML.parse(fs.readFileSync(functionPath, 'utf8'));
} catch (error) {
  console.error(`[verify:function-map-compile-gate] failed: ${functionPath} YAML parse failed: ${error.message}`);
  process.exit(1);
}
let verificationMap;
try {
  verificationMap = YAML.parse(fs.readFileSync(verificationPath, 'utf8'));
} catch (error) {
  console.error(`[verify:function-map-compile-gate] failed: ${verificationPath} YAML parse failed: ${error.message}`);
  process.exit(1);
}

const features = functionMap?.features ?? [];
const verificationFeatures = verificationMap?.features ?? [];
const seen = new Set();
for (const feature of features) {
  const featureId = feature?.feature_id;
  if (!featureId) {
    failures.push('function map feature missing feature_id');
    continue;
  }
  if (seen.has(featureId)) failures.push(`duplicate feature_id: ${featureId}`);
  seen.add(featureId);
  for (const gate of feature?.required_gates ?? []) {
    if (!String(gate).startsWith('npm run ')) continue;
    const scriptName = String(gate).slice('npm run '.length).trim().split(/\s+/)[0];
    if (!packageJson.scripts?.[scriptName]) {
      failures.push(`${featureId}: package script missing: ${scriptName}`);
    }
  }
}
const verificationSeen = new Set();
for (const feature of verificationFeatures) {
  const featureId = feature?.feature_id;
  if (!featureId) {
    failures.push('verification map feature missing feature_id');
    continue;
  }
  if (verificationSeen.has(featureId)) failures.push(`duplicate verification feature_id: ${featureId}`);
  verificationSeen.add(featureId);
}

if (failures.length) {
  console.error('[verify:function-map-compile-gate] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[verify:function-map-compile-gate] ok: ${features.length} features, ${verificationFeatures.length} verification features`);
