import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const sourcePath = path.join(root, 'src/server/runtime/http-server/router-direct-pipeline.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-direct-audit-'));
for (const [index, revival] of [
  "const OBSERVABLE_FIELDS = ['model', 'reasoning', 'thinking', 'max_tokens'];",
  'ctx.observedFields.push({ field: "model", value: payload.model });',
].entries()) {
  const fixture = path.join(tmp, `router-direct-pipeline-${index}.ts`);
  fs.writeFileSync(fixture, `${source}\n${revival}\n`);
  const verifier = fs.readFileSync(path.join(root, 'scripts/architecture/verify-direct-route-audit-projection-rust-only.mjs'), 'utf8')
    .replace("const tsPath = 'src/server/runtime/http-server/router-direct-pipeline.ts';", `const tsPath = ${JSON.stringify(fixture)};`);
  const verifierPath = path.join(tmp, `verify-${index}.mjs`);
  fs.writeFileSync(verifierPath, verifier);
  const result = spawnSync(process.execPath, [verifierPath], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes('retired TS audit semantic residue')) throw new Error(output);
}
console.log('[test:direct-route-audit-projection-rust-only-red-fixtures] ok');
