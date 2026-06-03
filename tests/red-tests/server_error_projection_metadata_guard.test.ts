/**
* Phase Server-D red test: server.error_projection must NOT include
* internal metadata/metaCarrier/errorCarrier/__rt/snapshot fields in
* public error body or SSE error event. Must fail-fast.
*
* This test asserts that respondWithPipelineError calls the
* assertClientErrorBodyHasNoInternalCarriers guard on both SSE and JSON exits.
*/

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HU = 'src/server/handlers/handler-utils.ts';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('server.error_projection internal carrier guard (Phase Server-D)', () => {
  it('handler-utils imports the assertClientErrorBodyHasNoInternalCarriers helper', () => {
    const src = readSrc(HU);
    expect(src).toContain('assertClientErrorBodyHasNoInternalCarriers');
  });

  it('respondWithPipelineError calls guard on mapped.body before SSE branch', () => {
    const src = readSrc(HU);
    const sseMatch = src.match(/assertClientErrorBodyHasNoInternalCarriers\(mapped\.body, effectiveRequestId\);[\s\S]{0,80}if \(options\?\.forceSse\)/);
    expect(sseMatch).not.toBeNull();
  });

  it('respondWithPipelineError calls guard on the SSE error payload before write', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/const payload = mapped\.body\?\.error[\s\S]{0,200}assertClientErrorBodyHasNoInternalCarriers\(payload, effectiveRequestId\)/);
  });

  it('respondWithPipelineError calls guard on mapped.body before res.json()', () => {
    const src = readSrc(HU);
    expect(src).toMatch(/assertClientErrorBodyHasNoInternalCarriers\(mapped\.body, effectiveRequestId\);[\s\S]{0,80}res\.status\(mapped\.status\)\.json\(mapped\.body\)/);
  });
});
