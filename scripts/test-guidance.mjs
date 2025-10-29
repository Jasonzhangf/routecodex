#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

const HOME = os.homedir();
const base = path.join(HOME, '.routecodex', 'codex-samples');
const guidanceMod = path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/guidance/index.js');

async function loadGuidance() {
  const mod = await import(pathToFileURL(guidanceMod).href);
  const { refineSystemToolGuidance, augmentOpenAITools, augmentAnthropicTools, buildSystemToolGuidance } = mod;
  return { refineSystemToolGuidance, augmentOpenAITools, augmentAnthropicTools, buildSystemToolGuidance };
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function collectFiles(dir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isFile()) out.push(full);
    }
  } catch { /* ignore */ }
  return out;
}

function extractRequest(obj) {
  // Try common capture shapes
  if (obj && typeof obj === 'object') {
    if (obj.body && typeof obj.body === 'object') return obj.body;
    if (obj.data && typeof obj.data === 'object') return obj.data;
  }
  return obj;
}

function hasOpenAITools(tools) {
  return Array.isArray(tools) && tools.some(t => t && typeof t === 'object' && t.function && typeof t.function === 'object');
}

function hasAnthropicTools(tools) {
  return Array.isArray(tools) && tools.some(t => t && typeof t === 'object' && t.input_schema);
}

async function main() {
  const { refineSystemToolGuidance, augmentOpenAITools, augmentAnthropicTools } = await loadGuidance();
  const targets = [
    path.join(base, 'openai-chat'),
    path.join(base, 'responses-replay'),
    path.join(base, 'anth-replay')
  ];

  let total = 0, refined = 0, augmented = 0;

  for (const d of targets) {
    const files = collectFiles(d);
    for (const f of files) {
      const j = readJsonSafe(f);
      if (!j) continue;
      const req = extractRequest(j);
      if (!req || typeof req !== 'object') continue;
      total++;
      // Refine system/instructions
      try {
        if (Array.isArray(req.messages) && req.messages.length && req.messages[0]?.role === 'system' && typeof req.messages[0].content === 'string') {
          const before = req.messages[0].content || '';
          const after = refineSystemToolGuidance(before);
          if (after !== before) refined++;
        } else if (typeof req.instructions === 'string' && req.instructions) {
          const before = req.instructions;
          const after = refineSystemToolGuidance(before);
          if (after !== before) refined++;
        }
      } catch { /* ignore */ }
      // Augment tools
      try {
        if (hasOpenAITools(req.tools)) {
          const before = JSON.stringify(req.tools);
          const t = augmentOpenAITools(req.tools);
          const after = JSON.stringify(t);
          if (after !== before) augmented++;
        } else if (hasAnthropicTools(req.tools)) {
          const before = JSON.stringify(req.tools);
          const t = augmentAnthropicTools(req.tools);
          const after = JSON.stringify(t);
          if (after !== before) augmented++;
        }
      } catch { /* ignore */ }
    }
  }

  console.log(JSON.stringify({ base, scannedDirs: targets, total, refined, augmented }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
