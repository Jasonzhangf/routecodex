#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const admissionRoot = resolve(v3Root, 'build-contracts', 'architecture-admission');
const requiredSources = new Map([
  ['repo/.github/workflows/release.yml', '.github/workflows/release.yml'],
  ['repo/.github/workflows/test.yml', '.github/workflows/test.yml'],
  ['repo/docs/architecture/v3-build-tool-module-registry.yml', 'docs/architecture/v3-build-tool-module-registry.yml'],
  ['repo/docs/architecture/v3-function-map.yml', 'docs/architecture/v3-function-map.yml'],
  ['repo/docs/architecture/v3-mainline-call-map.yml', 'docs/architecture/v3-mainline-call-map.yml'],
  ['repo/docs/architecture/v3-resource-operation-map.yml', 'docs/architecture/v3-resource-operation-map.yml'],
  ['repo/docs/architecture/v3-runtime-module-registry.yml', 'docs/architecture/v3-runtime-module-registry.yml'],
  ['repo/docs/architecture/v3-verification-map.yml', 'docs/architecture/v3-verification-map.yml'],
]);
const forbiddenDuplicateMaps = [
  'v3-build-tool-module-registry.yml',
  'v3-function-map.yml',
  'v3-mainline-call-map.yml',
  'v3-resource-operation-map.yml',
  'v3-verification-map.yml',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function collectAdmissionFailures({ root = admissionRoot } = {}) {
  const failures = [];
  for (const duplicate of forbiddenDuplicateMaps) {
    if (existsSync(resolve(root, duplicate))) {
      failures.push(`duplicate architecture admission truth is forbidden: ${duplicate}`);
    }
  }
  const manifestPath = resolve(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return [`missing V3 architecture admission manifest: ${manifestPath}`];
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return [`invalid V3 architecture admission manifest: ${error.message}`];
  }

  const payload = {
    schema_version: manifest.schema_version,
    generator: manifest.generator,
    output_root: manifest.output_root,
    files: manifest.files,
  };
  if (manifest.schema_version !== 1) failures.push('architecture admission schema_version must be 1');
  if (manifest.manifest_digest !== sha256(canonicalJson(payload))) {
    failures.push('architecture admission manifest digest mismatch');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    failures.push('architecture admission must contain a nonempty file inventory');
    return failures;
  }

  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.output_path !== 'string' || seen.has(entry.output_path)) {
      failures.push(`invalid or duplicate architecture admission output: ${entry?.output_path}`);
      continue;
    }
    seen.add(entry.output_path);
    const expectedSource = entry.output_path.startsWith('repo/')
      ? entry.output_path.slice('repo/'.length)
      : undefined;
    if (expectedSource !== entry.source_path) {
      failures.push(`architecture admission source binding mismatch: ${entry.output_path}`);
    }
    if (!/^[0-9a-f]{40}$/.test(String(entry.source_commit ?? ''))) {
      failures.push(`architecture admission source commit invalid: ${entry.output_path}`);
    }
    const filePath = resolve(root, entry.output_path);
    if (!filePath.startsWith(`${root}/`) || !existsSync(filePath)) {
      failures.push(`missing or escaping architecture admission file: ${entry.output_path}`);
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    if (entry.sha256 !== sha256(source)) {
      failures.push(`architecture admission file digest mismatch: ${entry.output_path}`);
      continue;
    }
    if (/\.ya?ml$/u.test(entry.output_path)) {
      try {
        YAML.parse(source);
      } catch (error) {
        failures.push(`architecture admission YAML invalid: ${entry.output_path}: ${error.message}`);
      }
    }
  }

  for (const required of requiredSources.keys()) {
    if (!seen.has(required)) failures.push(`architecture admission missing required source: ${required}`);
  }
  return failures;
}

const failures = collectAdmissionFailures();
if (failures.length > 0) {
  process.stderr.write(`[verify:v3-build-admission] FAIL\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('[verify:v3-build-admission] PASS\n');
}
