import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src');
const FORBIDDEN = /client_passthrough_patch|apply_client_passthrough_patch|build_client_passthrough_patch/;

function collectRustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      out.push(full);
    }
  }
  return out;
}

describe('Hub relay response projection has no client passthrough patch', () => {
  it('does not keep relay passthrough patch helpers or exports', () => {
    const offenders = collectRustFiles(ROOT).filter((file) => FORBIDDEN.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
