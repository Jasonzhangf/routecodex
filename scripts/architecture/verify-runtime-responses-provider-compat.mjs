#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stripQuotes(value) {
  const trimmed = String(value ?? '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlProvider(raw) {
  const provider = {};
  let inProvider = false;
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const section = clean.match(/^\[([^\]]+)\]$/);
    if (section) {
      inProvider = section[1] === 'provider';
      continue;
    }
    if (!inProvider) continue;
    const match = clean.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    provider[match[1]] = stripQuotes(match[2]);
  }
  return provider;
}

function readProvider(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.toml')) {
    return parseTomlProvider(raw);
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && parsed.provider && typeof parsed.provider === 'object'
    ? parsed.provider
    : {};
}

function listProviderConfigFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const fileName of fs.readdirSync(dir)) {
      const lower = fileName.toLowerCase();
      if (!lower.startsWith('config.v2') || lower.includes('.bak.')) continue;
      if (!lower.endsWith('.toml') && !lower.endsWith('.json')) continue;
      files.push(path.join(dir, fileName));
    }
  }
  return files;
}

const providerRoot = path.resolve(
  readArg('--provider-root')
  ?? process.env.ROUTECODEX_PROVIDER_ROOT
  ?? process.env.RCC_PROVIDER_ROOT
  ?? path.join(os.homedir(), '.rcc', 'provider')
);
const providerIdsArg = readArg('--provider-ids') ?? process.env.ROUTECODEX_RESPONSES_COMPAT_PROVIDER_IDS ?? '1token';
const requiredProviderIds = new Set(
  providerIdsArg.split(',').map((item) => item.trim()).filter(Boolean)
);

const failures = [];
for (const filePath of listProviderConfigFiles(providerRoot)) {
  const providerId = path.basename(path.dirname(filePath));
  if (requiredProviderIds.size && !requiredProviderIds.has(providerId)) continue;
  const provider = readProvider(filePath);
  const type = String(provider.type ?? provider.providerType ?? '').trim().toLowerCase();
  if (type !== 'responses') continue;
  const profile = String(provider.compatibilityProfile ?? '').trim();
  if (!profile.startsWith('responses:')) {
    failures.push(`${filePath}: provider "${providerId}" must declare compatibilityProfile = "responses:*"`);
  }
}

if (failures.length) {
  console.error('[verify:runtime-responses-provider-compat] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[verify:runtime-responses-provider-compat] ok providerRoot=${providerRoot}`);
