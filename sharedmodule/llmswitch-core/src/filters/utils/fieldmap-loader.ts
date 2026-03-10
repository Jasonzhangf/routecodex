import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldMapConfig } from '../types.js';

export async function loadFieldMapConfig(relativeJsonPath: string): Promise<FieldMapConfig | null> {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const p = path.resolve(__dirname, '..', 'config', relativeJsonPath);
    const text = await fsp.readFile(p, 'utf-8');
    const obj = JSON.parse(text) as FieldMapConfig;
    return obj;
  } catch {
    return null;
  }
}

