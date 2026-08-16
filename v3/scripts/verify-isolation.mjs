#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const pinnedRustToolchain = '1.96.1';
const require = createRequire(import.meta.url);

const requiredLocalFiles = [
  'package.json',
  'package-lock.json',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo/config.toml',
];

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function readLocal(path) {
  return readFileSync(resolve(v3Root, path), 'utf8');
}

function cargoMetadataFailures(env = process.env) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--locked', '--format-version', '1', '--manifest-path', resolve(v3Root, 'Cargo.toml')],
    { cwd: v3Root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    return [`cargo metadata failed: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`];
  }
  const metadata = JSON.parse(result.stdout);
  const failures = [];
  if (resolve(metadata.workspace_root) !== v3Root) {
    failures.push(`Cargo workspace root escapes V3: ${metadata.workspace_root}`);
  }
  const suppliedTarget = String(env.CARGO_TARGET_DIR ?? '').trim();
  const expectedTarget = suppliedTarget
    ? resolve(isAbsolute(suppliedTarget) ? suppliedTarget : resolve(v3Root, suppliedTarget))
    : resolve(v3Root, 'target');
  if (resolve(metadata.target_directory) !== expectedTarget || !isInside(v3Root, expectedTarget)) {
    failures.push(`Cargo target directory escapes V3 or differs from the active V3 target: ${metadata.target_directory}`);
  }
  for (const pkg of metadata.packages) {
    for (const dependency of pkg.dependencies) {
      if (dependency.path && !isInside(v3Root, resolve(dependency.path))) {
        failures.push(`${pkg.name} dependency ${dependency.name} escapes V3: ${dependency.path}`);
      }
    }
  }
  for (const crate of ['provider-compat-core', 'servertool-core', 'stop-message-core']) {
    const owners = metadata.packages.filter((pkg) => pkg.name === crate);
    if (owners.length !== 1 || !isInside(v3Root, resolve(owners[0]?.manifest_path ?? '/'))) {
      failures.push(`${crate} must have one V3-local Cargo owner`);
    }
  }
  return failures;
}

export function collectIsolationFailures({
  env = process.env,
  fileExists = (path) => existsSync(resolve(v3Root, path)),
  read = readLocal,
  inspectCargo = cargoMetadataFailures,
  resolveNodeDependency = (name) => require.resolve(name),
} = {}) {
  const failures = [];
  for (const path of requiredLocalFiles) {
    if (!fileExists(path)) failures.push(`missing V3-local contract: ${path}`);
  }

  const suppliedTarget = String(env.CARGO_TARGET_DIR ?? '').trim();
  if (suppliedTarget) {
    const resolvedTarget = isAbsolute(suppliedTarget)
      ? resolve(suppliedTarget)
      : resolve(v3Root, suppliedTarget);
    if (!isInside(v3Root, resolvedTarget)) {
      failures.push(`external CARGO_TARGET_DIR is forbidden: ${resolvedTarget}`);
    }
  }

  const suppliedToolchain = String(env.RUSTUP_TOOLCHAIN ?? '').trim();
  if (suppliedToolchain && suppliedToolchain !== pinnedRustToolchain) {
    failures.push(`external RUSTUP_TOOLCHAIN is forbidden: ${suppliedToolchain}`);
  }

  if (fileExists('rust-toolchain.toml')) {
    const toolchainContract = read('rust-toolchain.toml');
    if (!toolchainContract.includes(`channel = "${pinnedRustToolchain}"`)) {
      failures.push(`V3 Rust toolchain must pin ${pinnedRustToolchain}`);
    }
  }

  if (fileExists('package.json')) {
    const pkg = JSON.parse(read('package.json'));
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    if (/\+(?:stable|nightly|\d+(?:\.\d+){1,2})\b/u.test(scripts)) {
      failures.push('V3 package scripts must consume rust-toolchain.toml without an explicit toolchain override');
    }
    for (const forbidden of ['../scripts/', '../package.json', '../dist', '../artifacts', '../src/build-info']) {
      if (scripts.includes(forbidden)) failures.push(`V3 package scripts reference forbidden root input: ${forbidden}`);
    }
  }

  try {
    const yamlPath = resolve(resolveNodeDependency('yaml'));
    if (!isInside(resolve(v3Root, 'node_modules'), yamlPath)) {
      failures.push(`V3 Node dependency yaml resolved outside v3/node_modules: ${yamlPath}`);
    }
  } catch (error) {
    failures.push(`V3 Node dependency yaml is unavailable locally: ${error.message}`);
  }

  failures.push(...inspectCargo(env));
  return failures;
}

function main() {
  const failures = collectIsolationFailures();
  if (failures.length > 0) {
    process.stderr.write(`[verify:v3-isolation] FAIL\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('[verify:v3-isolation] PASS\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
