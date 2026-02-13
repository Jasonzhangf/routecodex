#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(entry);
    else yield entry;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function main() {
  const PROMPT_SRC = path.resolve(process.cwd(), 'src/config/system-prompts');
  const PROMPT_DIST = path.resolve(process.cwd(), 'dist/config/system-prompts');
  const CAMOUFOX_SRC = path.resolve(process.cwd(), 'scripts/camoufox');
  const CAMOUFOX_DIST = path.resolve(process.cwd(), 'dist/scripts/camoufox');
  const DEEPSEEK_SRC = path.resolve(process.cwd(), 'scripts/deepseek');
  const DEEPSEEK_DIST = path.resolve(process.cwd(), 'dist/scripts/deepseek');
  const promptCopied = [];
  const camoufoxCopied = [];
  const deepseekCopied = [];
  try {
    // copy system prompt artifacts only; provider compat assets are owned by llmswitch-core
    try {
      for await (const file of walk(PROMPT_SRC)) {
        const stats = await fs.stat(file);
        if (stats.isFile()) {
          const rel = path.relative(PROMPT_SRC, file);
          const dest = path.join(PROMPT_DIST, rel);
          await ensureDir(path.dirname(dest));
          await fs.copyFile(file, dest);
          promptCopied.push(rel);
        }
      }
    } catch (promptErr) {
      if (promptErr && promptErr.code !== 'ENOENT') throw promptErr;
    }
    // 不再复制 provider compat 资产；兼容层由 sharedmodule/llmswitch-core 提供
    try {
      for await (const file of walk(CAMOUFOX_SRC)) {
        const stats = await fs.stat(file);
        if (stats.isFile()) {
          const rel = path.relative(CAMOUFOX_SRC, file);
          const dest = path.join(CAMOUFOX_DIST, rel);
          await ensureDir(path.dirname(dest));
          await fs.copyFile(file, dest);
          camoufoxCopied.push(rel);
        }
      }
    } catch (camoufoxErr) {
      if (camoufoxErr && camoufoxErr.code !== 'ENOENT') throw camoufoxErr;
    }
    try {
      for await (const file of walk(DEEPSEEK_SRC)) {
        const stats = await fs.stat(file);
        if (stats.isFile()) {
          const rel = path.relative(DEEPSEEK_SRC, file);
          const dest = path.join(DEEPSEEK_DIST, rel);
          await ensureDir(path.dirname(dest));
          await fs.copyFile(file, dest);
          deepseekCopied.push(rel);
        }
      }
    } catch (deepseekErr) {
      if (deepseekErr && deepseekErr.code !== 'ENOENT') throw deepseekErr;
    }
    console.log(`[copy-compat-assets] prompts copied: ${promptCopied.length}`);
    console.log(`[copy-compat-assets] camoufox assets copied: ${camoufoxCopied.length}`);
    console.log(`[copy-compat-assets] deepseek assets copied: ${deepseekCopied.length}`);
  } catch (err) {
    console.error('[copy-compat-assets] failed:', err?.message || String(err));
    process.exit(1);
  }
}

main();
