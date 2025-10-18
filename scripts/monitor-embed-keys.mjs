#!/usr/bin/env node
// Read shell init files to resolve env-based auth in ~/.routecodex/monitor.json,
// then embed as transparent.authorization and inline values in transparent.auth.

import fs from 'node:fs/promises';
import path from 'node:path';

async function readJsonMaybe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

async function readShellVar(name) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const files = ['.zshrc', '.zprofile', '.bash_profile', '.bashrc'];
  const rx = new RegExp(`^(?:export\\s+)?${name}=(?:\"([^\"]*)\"|'([^']*)'|([^#\\n]+))`, 'm');
  for (const f of files) {
    try {
      const txt = await fs.readFile(path.join(home, f), 'utf-8');
      const m = txt.match(rx);
      if (m) {
        const val = (m[1] || m[2] || m[3] || '').trim();
        if (val) return val;
      }
    } catch {}
  }
  return null;
}

async function resolveAuth(spec) {
  if (!spec || typeof spec !== 'string') return null;
  if (/^env:/i.test(spec)) {
    const varName = spec.slice(4).trim();
    const envv = process.env[varName] || await readShellVar(varName);
    if (!envv) return null;
    return /^Bearer\s+/i.test(envv) ? envv : `Bearer ${envv}`;
  }
  return spec; // already literal
}

async function main() {
  const monPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'monitor.json');
  const j = await readJsonMaybe(monPath);
  if (!j) { console.error('[monitor-embed-keys] not found or invalid:', monPath); process.exit(2); }
  j.transparent = j.transparent || {};
  const t = j.transparent;
  t.auth = t.auth || {};

  const openaiSpec = t.auth.openai || null;
  const openaiAuth = await resolveAuth(openaiSpec);
  if (openaiAuth) {
    t.authorization = openaiAuth; // used by monitor-diff loader
    t.auth.openai = openaiAuth;   // inline embed (no env: prefix)
  }
  if (t.auth.anthropic) {
    const ant = await resolveAuth(t.auth.anthropic);
    if (ant) t.auth.anthropic = ant;
  }

  await fs.writeFile(monPath, JSON.stringify(j, null, 2), 'utf-8');
  console.log('[monitor-embed-keys] updated:', monPath);
}

main().catch(e => { console.error('[monitor-embed-keys] fatal', e?.message || String(e)); process.exit(1); });

