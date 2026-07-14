#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-module-boundaries.mjs');
const fixtures = [
  {
    name: 'provider transport outside provider owner',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_transport_owner() { let _ = reqwest::Client::new(); }\n',
    diagnostic: /provider transport outside provider crate/,
  },
  {
    name: 'duplicate request node owner',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\npub struct V3Server03HttpRequestRaw;\n',
    diagnostic: /duplicate V3 Server03 request node/,
  },
  {
    name: 'server route shortcut',
    file: 'v3/crates/routecodex-v3-server/src/lib.rs',
    mutation: '\nfn forbidden_route_shortcut() { hit_opaque_target_once(); }\n',
    diagnostic: /Server cannot select routes or interpret targets/,
  },
  {
    name: 'provider identity special case',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\nfn forbidden_provider_case(provider_id: &str) -> bool { provider_id == "cc" }\n',
    diagnostic: /generic Responses Provider contains deployment provider identity branch/,
  },
  {
    name: 'obsolete provider prototype node',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\ntype ForbiddenOldProviderNode = V3Provider07ResponsesWirePayload;\n',
    diagnostic: /obsolete Provider prototype node name is forbidden/,
  },
  {
    name: 'provider imports target interpreter',
    file: 'v3/crates/routecodex-v3-provider-responses/src/wire.rs',
    mutation: '\nuse routecodex_v3_target::V3TargetInterpreter;\n',
    diagnostic: /generic Responses Provider cannot import or interpret Router\/Target\/Forwarder resources/,
  },
  {
    name: 'repair or fallback semantics',
    file: 'v3/crates/routecodex-v3-runtime/src/lib.rs',
    mutation: '\nfn forbidden_response_repair() {}\n',
    diagnostic: /forbidden V3 MVP lifecycle\/fallback wording/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-source-red-'));
  try {
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), {
      recursive: true,
      filter: (source) => !source.includes('/target/'),
    });
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    const testModule = source.indexOf('#[cfg(test)]');
    writeFileSync(
      target,
      testModule === -1
        ? source + fixture.mutation
        : source.slice(0, testModule) + fixture.mutation + source.slice(testModule),
    );
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-500)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('[test:v3-source-gate-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-source-gate-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
