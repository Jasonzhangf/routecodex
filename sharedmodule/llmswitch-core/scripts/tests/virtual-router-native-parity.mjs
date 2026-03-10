#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function toSorted(result) {
  const tiers = [];
  for (const priority of result.priorities) {
    const rows = (result.buckets.get(priority) || []).map((entry) => ({
      key: entry.key,
      penalty: entry.penalty,
      order: entry.order
    }));
    tiers.push({ priority, rows });
  }
  return tiers;
}

function createCase(rng, count, nowMs) {
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const hasQuota = rng() > 0.2;
    const inPool = rng() > 0.15;
    const cooldown = rng() > 0.8 ? nowMs + Math.floor(rng() * 10_000) : undefined;
    const blacklist = rng() > 0.85 ? nowMs + Math.floor(rng() * 10_000) : undefined;
    const priorityTier = hasQuota ? Math.floor(rng() * 4) : undefined;
    const selectionPenalty = hasQuota ? Math.floor(rng() * 5) : undefined;
    entries.push({
      key: `p${i + 1}`,
      order: i,
      hasQuota,
      inPool,
      ...(cooldown ? { cooldownUntil: cooldown } : {}),
      ...(blacklist ? { blacklistUntil: blacklist } : {}),
      ...(priorityTier !== undefined ? { priorityTier } : {}),
      ...(selectionPenalty !== undefined ? { selectionPenalty } : {})
    });
  }
  return entries;
}

async function main() {
  const mod = await import(
    path.join(repoRoot, 'dist', 'router', 'virtual-router', 'engine-selection', 'native-router-hotpath.js')
  );
  const { buildQuotaBucketsWithMode, getNativeRouterHotpathSource } = mod;
  if (typeof buildQuotaBucketsWithMode !== 'function') {
    throw new Error('buildQuotaBucketsWithMode is not available');
  }

  const source = getNativeRouterHotpathSource();
  if (source !== 'native') {
    console.log('[virtual-router-native-parity] skipped (native binding unavailable)');
    return;
  }

  const rng = createSeededRandom(0x20260220);
  const nowMs = Date.now();
  for (let i = 0; i < 200; i += 1) {
    const entries = createCase(rng, 8 + (i % 5), nowMs + i);
    const auto = buildQuotaBucketsWithMode(entries, nowMs + i, 'auto');
    const nativeOnly = buildQuotaBucketsWithMode(entries, nowMs + i, 'native-only');
    const left = JSON.stringify(toSorted(auto));
    const right = JSON.stringify(toSorted(nativeOnly));
    if (left !== right) {
      throw new Error(`native mode mismatch at case #${i + 1}`);
    }
  }
  console.log('[virtual-router-native-parity] ok (200 cases, auto/native-only)');
}

main().catch((error) => {
  console.error('[virtual-router-native-parity] failed', error);
  process.exit(1);
});
