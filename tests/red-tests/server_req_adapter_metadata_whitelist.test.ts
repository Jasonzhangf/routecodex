/**
* Phase Server-B red test: server.req_adapter must fail-fast on
* route/provider/runtime control fields in client request body metadata.
* Unknown fields must also be rejected, not silently dropped.
*/

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HU = 'src/server/handlers/handler-utils.ts';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('server.req_adapter metadata whitelist (Phase Server-B)', () => {
  it('handler-utils declares PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS whitelist', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/PIPELINE_METADATA_ALLOWED_CLIENT_FIELDS\s*=\s*new Set/);
  });

  it('handler-utils declares PIPELINE_METADATA_DENIED_CLIENT_FIELDS denial list', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/PIPELINE_METADATA_DENIED_CLIENT_FIELDS\s*=\s*new Set/);
  });

  it('denial list explicitly forbids routeHint, __rt, providerKey, errorCarrier, metaCarrier', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/['"]routeHint['"]/);
    expect(src).toMatch(/['"]__rt['"]/);
    expect(src).toMatch(/['"]providerKey['"]/);
    expect(src).toMatch(/['"]errorCarrier['"]/);
    expect(src).toMatch(/['"]metaCarrier['"]/);
  });

  it('sanitizer throws on denied client metadata field (no silent drop)', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/forbidden client metadata field: \$\{key\}/);
  });

  it('sanitizer throws on unknown client metadata field (no silent drop)', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/unsupported client metadata field: \$\{key\}/);
  });
});
