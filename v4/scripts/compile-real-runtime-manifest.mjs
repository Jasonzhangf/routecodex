#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'generated/real-runtime-admission/manifest.compiled.json');
const source = path.join(root, 'contracts/real-runtime-admission.manifest.json');

const home = process.env.HOME;
if (!home) throw new Error('HOME is required to resolve provider config handles');
const listenAddress = process.env.RCCV4_LISTEN;
if (!listenAddress) throw new Error('RCCV4_LISTEN is required; V4 has no hardcoded listener fallback');

const candidates = [
  {
    provider_id: 'minimax_responses',
    config_path: path.join(home, '.rcc/provider/minimax_responses/config.v2.toml'),
    protocol: 'responses',
    model: 'MiniMax-M3',
    priority: 10,
    entry_models: ['MiniMax-M3'],
    execution_mode: 'direct',
  },
  {
    provider_id: 'minimax_responses',
    config_path: path.join(home, '.rcc/provider/minimax_responses/config.v2.toml'),
    protocol: 'responses',
    model: 'MiniMax-M3',
    priority: 20,
    entry_models: ['MiniMax-M3-relay'],
    execution_mode: 'relay',
  },
];

const contract = JSON.parse(fs.readFileSync(source, 'utf8'));
const unsigned = {
  schema_version: contract.schema_version,
  manifest_id: contract.manifest_id,
  runtime_identity: contract.runtime_identity,
  listen_address: listenAddress,
  candidates,
};

// Rust serde_json uses sorted object keys in this workspace. Keep the
// compiler's digest bytes identical to the binary's cold-start verifier.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

const canonical = JSON.stringify(canonicalize(unsigned));
const compiled = {
  ...unsigned,
  manifest_digest: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(compiled, null, 2)}\n`);
console.log(`[v4 manifest] compiled ${path.relative(root, output)} ${compiled.manifest_digest}`);
