#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userSourcePath = 'v3/crates/routecodex-v3-config/src/user_config.rs';
const forbiddenRoots = [
  'v3/crates/routecodex-v3-runtime/src',
  'v3/crates/routecodex-v3-server/src',
  'v3/crates/routecodex-v3-virtual-router/src',
  'v3/crates/routecodex-v3-target/src',
  'v3/crates/routecodex-v3-provider-responses/src',
  'v3/crates/routecodex-v3-error/src',
];

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function rustSources(relativeRoot) {
  const absoluteRoot = join(repoRoot, relativeRoot);
  const out = {};
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (extname(entry.name) === '.rs') {
        const relativePath = absolutePath.slice(repoRoot.length + 1);
        out[relativePath] = readFileSync(absolutePath, 'utf8');
      }
    }
  };
  visit(absoluteRoot);
  return out;
}

export function loadSimplifiedUserConfigSources() {
  return {
    userSource: read(userSourcePath),
    libSource: read('v3/crates/routecodex-v3-config/src/lib.rs'),
    storeSource: read('v3/crates/routecodex-v3-config/src/store.rs'),
    cliSource: read('v3/crates/routecodex-v3-cli/src/main.rs'),
    lifecycleSource: read('v3/crates/routecodex-v3-lifecycle/src/lib.rs'),
    resourceMap: read('docs/architecture/v3-resource-operation-map.yml'),
    functionMap: read('docs/architecture/v3-function-map.yml'),
    mainlineMap: read('docs/architecture/v3-mainline-call-map.yml'),
    verificationMap: read('docs/architecture/v3-verification-map.yml'),
    forbiddenSources: Object.assign({}, ...forbiddenRoots.map(rustSources)),
  };
}

export function verifySimplifiedUserConfig(sources) {
  const failures = [];
  const requiredUserSymbols = [
    'V3UserConfig01FileSource',
    'V3UserConfig02RoutingSelectionParsed',
    'parse_v3_user_config_02_routing',
    'project_v3_user_config_03_authoring',
  ];
  for (const symbol of requiredUserSymbols) {
    if (!sources.userSource.includes(symbol) || !sources.libSource.includes(symbol)) {
      failures.push(`user-config API must define and export ${symbol}`);
    }
  }

  if (sources.userSource.includes('publish_v3_config_05_manifest_from_v3_config_04')) {
    failures.push('user_config.rs must not publish Config05 or implement a second compiler');
  }
  if (/config\.v3\.toml|parse_v3_config_02_authoring\s*\(/u.test(sources.userSource)) {
    failures.push('user_config.rs must not dual-read, sniff, or retry the legacy config format');
  }
  for (const marker of [
    'validate_v3_user_config_02_routing(toml::from_str(raw)?)',
    'let user = validate_v3_user_config_02_routing(user)?;',
  ]) {
    if (!sources.userSource.includes(marker)) {
      failures.push('parsed and programmatic Config02 selections must share one invariant validator');
    }
  }

  for (const marker of [
    'load_v3_config_snapshot_from_path',
    'Some("config.toml")',
    'V3UserConfigStore::new(path).load_snapshot_with_source_identity()',
    'V3ConfigStore::new(path).load_snapshot_with_source_identity()',
  ]) {
    if (!sources.storeSource.includes(marker)) {
      failures.push(`Config-owned exact filename dispatcher must contain ${marker}`);
    }
  }
  if (/load_v3_config_snapshot_from_path[\s\S]{0,700}\.(?:or_else|or)\s*\(/u.test(sources.storeSource)) {
    failures.push('Config-owned exact filename dispatcher must not retry another parser');
  }
  const defaultPathOwner = sources.storeSource.match(
    /pub fn default_v3_config_path[\s\S]*?\n\}/u,
  )?.[0] ?? '';
  if (!defaultPathOwner.includes('.join("config.toml")') || defaultPathOwner.includes('config.v3.toml')) {
    failures.push('Config-owned default path must resolve only ~/.rcc/config.toml');
  }
  if (!sources.cliSource.includes('load_v3_config_snapshot_from_path(config)?.manifest')) {
    failures.push('CLI must consume the Config-owned exact filename snapshot loader');
  }
  if (/file_name\(\)[\s\S]{0,160}config\.toml/u.test(sources.cliSource)) {
    failures.push('CLI must not duplicate exact filename config-owner selection');
  }
  if (!sources.cliSource.includes('Ok(default_v3_config_path(home))')) {
    failures.push('CLI default path resolution must consume the Config-owned config.toml path');
  }
  if (!sources.lifecycleSource.includes('load_v3_config_snapshot_from_path(&self.config_path)?')) {
    failures.push('lifecycle must consume the Config-owned loaded snapshot');
  }
  if (/\bV3ConfigStore\b/u.test(sources.lifecycleSource)) {
    failures.push('lifecycle must not directly select or invoke the legacy config store');
  }

  const parsedStruct = sources.userSource.match(
    /struct V3UserConfig02RoutingSelectionParsed\s*\{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body ?? '';
  for (const field of ['route_groups', 'pipelines', 'providers', 'features', 'error', 'debug', 'admin_webui']) {
    if (new RegExp(`\\bpub\\s+${field}\\s*:`, 'u').test(parsedStruct)) {
      failures.push(`strict user schema must not expose internal field ${field}`);
    }
  }

  if (/body\.metadata|payload\.metadata|serde_json::Value/u.test(sources.userSource)) {
    failures.push('user-config control data must not enter payload or protocol metadata');
  }
  for (const [path, source] of Object.entries(sources.forbiddenSources)) {
    if (/parse_v3_user_config_02_routing|project_v3_user_config_03_authoring/u.test(source)) {
      failures.push(`runtime-side module must not import or call the user parser/projector: ${path}`);
    }
  }

  for (const [name, source, marker] of [
    ['resource map', sources.resourceMap, 'resource_id: v3.user_config.file_source'],
    ['function map', sources.functionMap, 'feature_id: v3.simplified_user_config'],
    ['mainline map', sources.mainlineMap, 'chain_id: v3.user_config.compile'],
    ['verification map', sources.verificationMap, 'feature_id: v3.simplified_user_config'],
  ]) {
    if (!source.includes(marker)) failures.push(`${name} must register simplified user config`);
  }
  return failures;
}

function run() {
  const failures = verifySimplifiedUserConfig(loadSimplifiedUserConfigSources());
  if (failures.length > 0) {
    console.error('[verify:v3-simplified-user-config] failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[verify:v3-simplified-user-config] ok');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
