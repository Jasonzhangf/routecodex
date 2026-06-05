import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const stagePolicy = read('src/utils/snapshot-stage-policy.ts');
const cliStart = read('src/cli/commands/start.ts');
const contractDoc = read('docs/architecture/snapshot-stage-contract.md');
const routeDoc = read('docs/agent-routing/10-runtime-ssot-routing.md');
const archReadme = read('docs/architecture/README.md');
const testsToRequire = [
  'tests/utils/snapshot-stage-policy.spec.ts',
  'tests/providers/core/utils/snapshot-writer.release-gating.spec.ts',
  'tests/debug/snapshot-store-port-isolation.red.spec.ts',
  'tests/provider/http-request-executor-sse-snapshot.spec.ts',
  'tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts',
];

for (const rel of testsToRequire) {
  if (!fs.existsSync(path.join(root, rel))) {
    failures.push(`missing required snapshot coverage test: ${rel}`);
  }
}

for (const token of ['client-request', 'provider-request', 'provider-response', 'client-response']) {
  if (!stagePolicy.includes(`'${token}'`)) {
    failures.push(`default snapshot selector missing edge stage: ${token}`);
  }
  if (!contractDoc.includes(`- \`${token}\``)) {
    failures.push(`snapshot contract doc missing default edge stage: ${token}`);
  }
}

for (const token of [
  'provider-request-contract',
  'provider-request.retry',
  'provider-response-contract',
  'provider-response.retry',
  'provider-error',
  'client-response.error',
  'chat_process.req.*',
  'chat_process.resp.*',
  'hub_followup.*',
  'servertool.*',
]) {
  if (!contractDoc.includes(token)) {
    failures.push(`snapshot contract doc missing stage family: ${token}`);
  }
}

if (!cliStart.includes("--snap") || !cliStart.includes("--snap-stages")) {
  failures.push('CLI start contract missing --snap / --snap-stages options');
}

if (!archReadme.includes('snapshot-stage-contract.md')) {
  failures.push('architecture README must reference snapshot-stage-contract.md');
}

if (!routeDoc.includes('snapshot-stage-contract.md')) {
  failures.push('runtime routing doc must reference snapshot-stage-contract.md');
}

if (failures.length > 0) {
  console.error('[verify:architecture-snapshot-stage-contract] failed');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('[verify:architecture-snapshot-stage-contract] ok');
console.log(`- checked required tests: ${testsToRequire.length}`);
