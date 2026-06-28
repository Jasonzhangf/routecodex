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
  const STOPLESS_PROMPT_SRC = path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/src/servertool/assets');
  const STOPLESS_PROMPT_DIST = path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/servertool/assets');
  const promptCopied = [];
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

    try {
      for await (const file of walk(STOPLESS_PROMPT_SRC)) {
        const stats = await fs.stat(file);
        if (stats.isFile()) {
          const rel = path.relative(STOPLESS_PROMPT_SRC, file);
          const dest = path.join(STOPLESS_PROMPT_DIST, rel);
          await ensureDir(path.dirname(dest));
          await fs.copyFile(file, dest);
        }
      }
    } catch (stoplessPromptErr) {
      if (stoplessPromptErr && stoplessPromptErr.code !== 'ENOENT') throw stoplessPromptErr;
    }
    console.log(`[copy-compat-assets] prompts copied: ${promptCopied.length}`);
  } catch (err) {
    console.error('[copy-compat-assets] failed:', err?.message || String(err));
    process.exit(1);
  }
}

main();
