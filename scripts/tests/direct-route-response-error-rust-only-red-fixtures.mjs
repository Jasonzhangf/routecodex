import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const original = path.join(root, 'src/server/runtime/http-server/router-direct-pipeline.ts');
const backup = fs.readFileSync(original, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-direct-response-error-'));
for (const [index, revival] of [
  'function isRouterDirectRecoverableResponseStatus(status) { return status >= 500; }',
  'function buildRouterDirectResponseError(response, status) { return new Error(`HTTP_${status}`); }',
].entries()) {
  const fixture = path.join(tmp, `router-direct-pipeline-${index}.ts`);
  fs.writeFileSync(fixture, `${backup}\n${revival}\n`);
  const verifier = fs.readFileSync(path.join(root, 'scripts/architecture/verify-direct-route-response-error-rust-only.mjs'), 'utf8')
    .replace("const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';", `const tsPath = ${JSON.stringify(fixture)};`);
  const verifierPath = path.join(tmp, `verify-${index}.mjs`);
  fs.writeFileSync(verifierPath, verifier);
  const result = spawnSync(process.execPath, [verifierPath], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('retired TS semantic residue')) throw new Error(output);
}
console.log('[test:direct-route-response-error-rust-only-red-fixtures] ok');
