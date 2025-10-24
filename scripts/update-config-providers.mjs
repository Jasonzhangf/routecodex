#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const CONFIG_JSON = path.join(HOME, '.routecodex', 'config.json');
const CONFIG_DIR = path.join(HOME, '.routecodex', 'config');

const isOpenAIDomain = (u) => /api\.openai\.com/i.test(String(u || ''));

async function readJson(file) {
  const txt = await fs.readFile(file, 'utf-8');
  return JSON.parse(txt);
}

async function writeJson(file, obj) {
  const txt = JSON.stringify(obj, null, 2);
  await fs.writeFile(file, txt, 'utf-8');
}

function updateProvidersInConfig(cfg, file) {
  let changed = false;
  const vr = cfg?.virtualrouter || cfg?.virtualRouter || cfg?.router;
  if (!vr || typeof vr !== 'object') return { changed, cfg };
  const providers = vr.providers;
  if (!providers || typeof providers !== 'object') return { changed, cfg };
  for (const [pid, pv] of Object.entries(providers)) {
    if (!pv || typeof pv !== 'object') continue;
    // Accept various casings
    const base = pv.baseURL ?? pv.baseUrl ?? pv.base;
    const type = pv.type;
    // Only rewrite third-party openai-compatible endpoints that currently use 'openai' provider type
    if (String(type).toLowerCase() === 'openai' && base && !isOpenAIDomain(base)) {
      pv.type = 'generic-openai-provider';
      changed = true;
      console.log(`[update] ${file} :: providers.${pid}.type => generic-openai-provider (baseUrl=${base})`);
    }
  }
  return { changed, cfg };
}

async function updateFile(file) {
  try {
    const cfg = await readJson(file);
    const { changed, cfg: newCfg } = updateProvidersInConfig(cfg, file);
    if (changed) {
      await writeJson(file, newCfg);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[skip] Failed to read/parse ${file}:`, e.message || String(e));
    return false;
  }
}

async function main() {
  let totalChanged = 0;
  // Top-level config.json
  try {
    const exists = await fs.stat(CONFIG_JSON).then(() => true).catch(() => false);
    if (exists) {
      if (await updateFile(CONFIG_JSON)) totalChanged++;
    }
  } catch {}

  // Dir configs
  try {
    const entries = await fs.readdir(CONFIG_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.json') continue;
      const file = path.join(CONFIG_DIR, e.name);
      if (await updateFile(file)) totalChanged++;
    }
  } catch {}

  if (totalChanged === 0) {
    console.log('No changes applied (either already generic-openai-provider or no third-party openai endpoints).');
  } else {
    console.log(`Applied changes to ${totalChanged} file(s).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

