#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.cwd().endsWith('/v3') && existsSync(resolve(process.cwd(), 'crates'))) {
  process.chdir(resolve(process.cwd(), '..'));
}
const repo = process.cwd();
const verifierRelative = 'v3/scripts/architecture/verify-v3-servertool-center-skeleton.mjs';
const runtimeSrc = 'v3/crates/routecodex-v3-runtime/src';

function runCase(name, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'rcc-servertool-center-'));
  const src = join(dir, runtimeSrc);
  cpSync(join(repo, runtimeSrc), src, { recursive: true });
  const sse = join(dir, 'v3/crates/routecodex-v3-sse');
  cpSync(join(repo, 'v3/crates/routecodex-v3-sse'), sse, { recursive: true });
  cpSync(join(repo, 'docs/architecture/v3-function-map.yml'), join(dir, 'docs/architecture/v3-function-map.yml'));
  cpSync(join(repo, 'docs/architecture/v3-mainline-call-map.yml'), join(dir, 'docs/architecture/v3-mainline-call-map.yml'));
  cpSync(join(repo, 'docs/architecture/v3-resource-operation-map.yml'), join(dir, 'docs/architecture/v3-resource-operation-map.yml'));
  cpSync(join(repo, 'docs/design/v3-servertool-center-skeleton.md'), join(dir, 'docs/design/v3-servertool-center-skeleton.md'));
  mutate(dir, src, sse);
  const result = spawnSync(process.execPath, [join(dir, verifierRelative)], { cwd: dir, encoding: 'utf8' });
  if (result.status === 0) {
    console.error(`[red-fixture] ${name}: expected verify to fail but it passed`);
    process.exit(1);
  }
  console.log(`[red-fixture] ${name}: verify correctly failed`);
}

runCase('hook outside fixed governance nodes must fail', (dir, src, _sse) => {
  writeFileSync(
    join(src, 'hub_v1/server_resp_outbound_06_client_frame.rs'),
    'use super::servertool_hooks::apply_v3_stop_servertool_hook_at_resp03;\nfn frame() { let _ = apply_v3_stop_servertool_hook_at_resp03; }\n',
    'utf8'
  );
});

console.log('[test:v3-servertool-center-skeleton-red-fixtures] ok');
