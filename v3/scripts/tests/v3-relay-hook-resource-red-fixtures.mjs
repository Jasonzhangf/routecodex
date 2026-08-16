#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const verifier = resolve(repoRoot, 'scripts/architecture/verify-v3-relay-hook-resources.mjs');
const fixtures = [
  {
    name: 'provider payload leak',
    file: 'v3/crates/routecodex-v3-config/src/validate.rs',
    mutate: (source) => source.replace('may_enter_provider_body: false', 'may_enter_provider_body: true'),
    diagnostic: /side-channel isolated/,
  },
  {
    name: 'runtime config read',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    append: '\nfn config_read() { let _ = std::fs::read_to_string("config.v3.toml"); }\n',
    diagnostic: /must not read config/,
  },
  {
    name: 'dynamic hook loading',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    append: '\nfn dynamic_hook_discovery() {}\n',
    diagnostic: /dynamic hook/,
  },
  {
    name: 'business payload clone',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    append: '\nfn clone_payload(payload: &Vec<u8>) { let _ = payload.clone(); }\n',
    diagnostic: /unbounded clone/,
  },
  {
    name: 'JSON round-trip clone',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    append: '\nfn json_clone(value: &serde_json::Value) { let _ = serde_json::to_string(value); }\n',
    diagnostic: /JSON round-trip/,
  },
  {
    name: 'Manifest bypass',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    mutate: (source) => source.replace("published: &'manifest V3Config05ManifestPublished", "published: &'manifest V3HubV1Manifest"),
    diagnostic: /must consume V3Config05ManifestPublished/,
  },
  {
    name: 'owned hook payload',
    file: 'v3/crates/routecodex-v3-runtime/src/hub_v1/resource_hooks.rs',
    mutate: (source) => source.replace("value: &'node T", 'value: T'),
    diagnostic: /scoped borrowed view/,
  },
  {
    name: 'implicit resource permissions',
    file: 'v3/crates/routecodex-v3-config/src/types.rs',
    mutate: (source) => source.replace('    pub allowed_resources: Vec<String>,', '    #[serde(default)]\n    pub allowed_resources: Vec<String>,'),
    diagnostic: /must be explicit/,
  },
];

const failures = [];
for (const fixture of fixtures) {
  const root = mkdtempSync(join(tmpdir(), 'routecodex-v3-relay-hook-resource-'));
  try {
    cpSync(resolve(repoRoot, 'v3'), join(root, 'v3'), {
      recursive: true,
      filter: (source) => !source.includes('/target/'),
    });
    const target = join(root, fixture.file);
    const source = readFileSync(target, 'utf8');
    writeFileSync(target, fixture.mutate ? fixture.mutate(source) : source + fixture.append);
    const result = spawnSync(process.execPath, [verifier], { cwd: root, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status === 0) failures.push(`${fixture.name}: gate unexpectedly passed`);
    else if (!fixture.diagnostic.test(output)) failures.push(`${fixture.name}: wrong diagnostic: ${output.slice(-600)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error('[test:v3-relay-hook-resource-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[test:v3-relay-hook-resource-red-fixtures] ok (${fixtures.length} forbidden mutations rejected)`);
