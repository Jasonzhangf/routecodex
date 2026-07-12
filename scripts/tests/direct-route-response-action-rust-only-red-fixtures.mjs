import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const sourcePath = path.join(root, 'src/server/runtime/http-server/router-direct-pipeline.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-direct-response-action-'));
for (const [index, revival] of [
  'const hasSse = record.sseStream !== undefined;',
  "if (hasSse) return record;",
  "if (!clientModel) return response;",
].entries()) {
  const fixture = path.join(tmp, `router-direct-pipeline-${index}.ts`);
  fs.writeFileSync(fixture, `${source}\n${revival}\n`);
  const verifier = fs.readFileSync(path.join(root, 'scripts/architecture/verify-direct-route-response-action-rust-only.mjs'), 'utf8')
    .replace("const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';", `const tsPath = ${JSON.stringify(fixture)};`);
  const verifierPath = path.join(tmp, `verify-${index}.mjs`);
  fs.writeFileSync(verifierPath, verifier);
  const result = spawnSync(process.execPath, [verifierPath], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('retired TS response action residue')) throw new Error(output);
}
console.log('[test:direct-route-response-action-rust-only-red-fixtures] ok');
