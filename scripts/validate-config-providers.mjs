#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const CONFIG_JSON = path.join(HOME, '.routecodex', 'config.json');
const CONFIG_DIR = path.join(HOME, '.routecodex', 'config');

const isOpenAIDomain = (u) => /api\.openai\.com/i.test(String(u || ''));

async function readJson(file) {
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function* iterProvidersFromConfig(cfg) {
  try {
    const vr = cfg?.virtualrouter || cfg?.virtualRouter || cfg?.router || {};
    const providers = vr?.providers || {};
    for (const [pid, pv] of Object.entries(providers)) {
      const type = pv?.type || '';
      const base = pv?.baseURL || pv?.baseUrl || pv?.base || '';
      yield { file: 'config.json', providerId: pid, type, baseUrl: base };
    }
  } catch {}
}

function classify(p) {
  const base = String(p.baseUrl || '').trim();
  if (!base) return { ...p, classification: 'missing_baseurl' };
  return isOpenAIDomain(base)
    ? { ...p, classification: 'openai_official' }
    : { ...p, classification: 'third_party' };
}

async function scanConfigJson() {
  const out = [];
  const cfg = await readJson(CONFIG_JSON);
  if (cfg) {
    for (const p of iterProvidersFromConfig(cfg)) out.push(p);
  }
  return out;
}

async function scanConfigDir() {
  const out = [];
  try {
    const entries = await fs.readdir(CONFIG_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext !== '.json') continue; // narrow to JSON for now
      const file = path.join(CONFIG_DIR, e.name);
      const cfg = await readJson(file);
      if (!cfg) continue;
      const vr = cfg?.virtualrouter || cfg?.virtualRouter || cfg?.router || {};
      const providers = vr?.providers || {};
      for (const [pid, pv] of Object.entries(providers)) {
        const type = pv?.type || '';
        const base = pv?.baseURL || pv?.baseUrl || pv?.base || '';
        out.push({ file: file, providerId: pid, type, baseUrl: base });
      }
    }
  } catch {}
  return out;
}

async function main() {
  const rows = [...await scanConfigJson(), ...await scanConfigDir()].map(classify);
  if (rows.length === 0) {
    console.log('No providers found in ~/.routecodex/config.json or ~/.routecodex/config/*.json');
    return;
  }
  const suggest = [];
  for (const r of rows) {
    const line = `${r.file} :: providerId=${r.providerId} type=${r.type || '(unset)'} baseUrl=${r.baseUrl || '(unset)'} => ${r.classification}`;
    console.log(line);
    if (r.classification === 'third_party' && String(r.type).toLowerCase() === 'openai-provider') {
      suggest.push(r);
    }
  }
  if (suggest.length) {
    console.log('\nSuggested changes for third-party OpenAI-compatible endpoints:');
    for (const s of suggest) {
      console.log(`- ${s.file} :: providers.${s.providerId}.type: openai-provider -> generic-openai-provider`);
    }
  } else {
    console.log('\nNo third-party OpenAI providers using openai-provider detected.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

