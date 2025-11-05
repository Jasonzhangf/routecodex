import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function safeReadJson(p: string): any | null {
  try {
    const s = fs.readFileSync(p, 'utf-8');
    return JSON.parse(s);
  } catch { return null; }
}

function distRoot(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/server/utils -> dist/server/utils at runtime; dist root is ../../..
    return path.resolve(here, '../../..');
  } catch {
    return process.cwd();
  }
}

export function getAppVersion(): string {
  try {
    const root = distRoot();
    const pkg = safeReadJson(path.join(root, 'package.json'));
    const v = pkg?.version;
    return typeof v === 'string' && v ? v : 'dev';
  } catch { return 'dev'; }
}

export function getCoreVersion(): string {
  try {
    const root = distRoot();
    // Vendored core under vendor/rcc-llmswitch-core
    const pkg = safeReadJson(path.join(root, 'vendor', 'rcc-llmswitch-core', 'package.json'))
      || safeReadJson(path.join(root, 'node_modules', 'rcc-llmswitch-core', 'package.json'));
    const v = pkg?.version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch { return 'unknown'; }
}

