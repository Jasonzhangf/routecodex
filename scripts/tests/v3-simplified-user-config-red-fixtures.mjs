#!/usr/bin/env node
import {
  loadSimplifiedUserConfigSources,
  verifySimplifiedUserConfig,
} from '../architecture/verify-v3-simplified-user-config.mjs';

const baseline = loadSimplifiedUserConfigSources();
const cases = [
  {
    name: 'second Config05 compiler',
    mutate: (sources) => ({
      ...sources,
      userSource: `${sources.userSource}\nfn duplicate() { publish_v3_config_05_manifest_from_v3_config_04(); }`,
    }),
    diagnostic: /must not publish Config05/u,
  },
  {
    name: 'runtime parser import',
    mutate: (sources) => ({
      ...sources,
      forbiddenSources: {
        ...sources.forbiddenSources,
        'v3/crates/routecodex-v3-runtime/src/injected.rs':
          'use routecodex_v3_config::parse_v3_user_config_02_routing;',
      },
    }),
    diagnostic: /runtime-side module must not import/u,
  },
  {
    name: 'legacy dual read',
    mutate: (sources) => ({
      ...sources,
      userSource: `${sources.userSource}\nconst LEGACY: &str = "config.v3.toml";`,
    }),
    diagnostic: /must not dual-read/u,
  },
  {
    name: 'programmatic Config02 validation bypass',
    mutate: (sources) => ({
      ...sources,
      userSource: sources.userSource.replace(
        'let user = validate_v3_user_config_02_routing(user)?;',
        'let user = user;',
      ),
    }),
    diagnostic: /must share one invariant validator/u,
  },
  {
    name: 'dispatcher parser retry',
    mutate: (sources) => ({
      ...sources,
      storeSource: sources.storeSource.replace(
        'V3ConfigStore::new(path).load_snapshot_with_source_identity()',
        'V3ConfigStore::new(path).load_snapshot_with_source_identity().or_else(|_| unreachable!())',
      ),
    }),
    diagnostic: /must not retry another parser/u,
  },
  {
    name: 'legacy default filename',
    mutate: (sources) => ({
      ...sources,
      storeSource: sources.storeSource.replace(
        '.join(".rcc").join("config.toml")',
        '.join(".rcc").join("config.v3.toml")',
      ),
    }),
    diagnostic: /default path must resolve only/u,
  },
  {
    name: 'lifecycle legacy store reread',
    mutate: (sources) => ({
      ...sources,
      lifecycleSource: `${sources.lifecycleSource}\nfn legacy() { V3ConfigStore::new("config.toml"); }`,
    }),
    diagnostic: /lifecycle must not directly select/u,
  },
  {
    name: 'CLI duplicate filename selection',
    mutate: (sources) => ({
      ...sources,
      cliSource: `${sources.cliSource}\nfn duplicate(path: &std::path::Path) { let _ = path.file_name() == Some(std::ffi::OsStr::new("config.toml")); }`,
    }),
    diagnostic: /CLI must not duplicate/u,
  },
  {
    name: 'internal schema field',
    mutate: (sources) => ({
      ...sources,
      userSource: sources.userSource.replace(
        'pub version: u16,',
        'pub version: u16,\n    pub route_groups: String,',
      ),
    }),
    diagnostic: /must not expose internal field route_groups/u,
  },
  {
    name: 'payload metadata leakage',
    mutate: (sources) => ({
      ...sources,
      userSource: `${sources.userSource}\nfn leak() { payload.metadata = "route"; }`,
    }),
    diagnostic: /must not enter payload/u,
  },
];

const failures = [];
for (const testCase of cases) {
  const diagnostics = verifySimplifiedUserConfig(testCase.mutate(baseline));
  if (!diagnostics.some((diagnostic) => testCase.diagnostic.test(diagnostic))) {
    failures.push(`${testCase.name}: expected diagnostic ${testCase.diagnostic}`);
  }
}

if (failures.length > 0) {
  console.error('[test:v3-simplified-user-config-red-fixtures] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[test:v3-simplified-user-config-red-fixtures] ok (${cases.length} red fixtures)`);
