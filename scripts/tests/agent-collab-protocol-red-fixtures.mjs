import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = path.join(repoRoot, 'scripts/architecture/verify-agent-collab-protocol.mjs');

const cases = [
  {
    name: 'missing PROTOCOL.md',
    expect: 'PROTOCOL.md is missing',
    mutate(root) {
      fs.rmSync(path.join(root, '.agent-collab/PROTOCOL.md'));
    },
  },
  {
    name: 'invalid JSON schema',
    expect: 'is not parseable JSON',
    mutate(root) {
      fs.writeFileSync(path.join(root, '.agent-collab/schema/owner.schema.json'), '{ invalid json');
    },
  },
  {
    name: 'owner claim missing semantic_id',
    expect: 'owner.json missing required field: semantic_id',
    mutate(root) {
      const file = path.join(root, '.agent-collab/examples/owner.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete json.semantic_id;
      fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    },
  },
  {
    name: 'actor missing run_id',
    expect: 'actor.json missing required field: run_id',
    mutate(root) {
      const file = path.join(root, '.agent-collab/examples/actor.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete json.run_id;
      fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    },
  },
  {
    name: 'heartbeat missing updated_at',
    expect: 'heartbeat.json missing required field: updated_at',
    mutate(root) {
      const file = path.join(root, '.agent-collab/examples/heartbeat.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete json.updated_at;
      fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    },
  },
  {
    name: 'evidence missing result',
    expect: 'evidence.jsonl:1 missing required field: result',
    mutate(root) {
      const file = path.join(root, '.agent-collab/examples/evidence.jsonl');
      const json = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      delete json.result;
      fs.writeFileSync(file, `${JSON.stringify(json)}\n`);
    },
  },
  {
    name: 'protocol omits stale heartbeat non-takeover rule',
    expect: 'stale heartbeat automatic takeover',
    mutate(root) {
      const file = path.join(root, '.agent-collab/PROTOCOL.md');
      const text = fs.readFileSync(file, 'utf8')
        .replace('Heartbeat timeout only means `stale`. A stale heartbeat is not automatic takeover permission.', 'Heartbeat timeout only means `stale`.')
        .replace('Stale heartbeat does not authorize high-risk takeover of production writes, deletes, migrations, releases, auth, secrets, payment-related work, global install mutation, or live runtime mutation. High-risk takeover needs explicit Jason approval or a separate checked handoff decision.', 'High-risk takeover needs explicit Jason approval or a separate checked handoff decision.');
      fs.writeFileSync(file, text);
    },
  },
  {
    name: 'protocol omits evidence-required completion rule',
    expect: 'completion requires evidence.jsonl',
    mutate(root) {
      const file = path.join(root, '.agent-collab/PROTOCOL.md');
      const text = fs.readFileSync(file, 'utf8')
        .replace('A completion claim is invalid without `evidence.jsonl`.', 'A completion claim must be reviewed.');
      fs.writeFileSync(file, text);
    },
  },
  {
    name: 'protocol omits merge-queue/handoff rule',
    expect: 'merge/handoff defaults',
    mutate(root) {
      const file = path.join(root, '.agent-collab/PROTOCOL.md');
      const text = fs.readFileSync(file, 'utf8')
        .replace('Cross-worker integration defaults to `handoff/` or `merge-queue/`.', 'Cross-worker integration must be reviewed.')
        .replace(/A checker should verify scope, unrelated dirty work, required gates, and evidence before merge when feasible\.\n/, '');
      fs.writeFileSync(file, text);
    },
  },
];

function copyFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-agent-collab-red-'));
  fs.cpSync(path.join(repoRoot, '.agent-collab'), path.join(tmp, '.agent-collab'), { recursive: true });
  return tmp;
}

const failures = [];

for (const redCase of cases) {
  const root = copyFixture();
  try {
    redCase.mutate(root);
    const result = spawnSync(process.execPath, [verifier, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0) {
      failures.push(`${redCase.name}: verifier unexpectedly passed`);
    } else if (!output.includes(redCase.expect)) {
      failures.push(`${redCase.name}: expected failure containing "${redCase.expect}", got:\n${output}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error('[test:agent-collab-protocol-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[test:agent-collab-protocol-red-fixtures] ok');
console.log(`- red fixtures checked: ${cases.length}`);
