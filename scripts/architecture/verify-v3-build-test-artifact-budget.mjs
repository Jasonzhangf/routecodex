#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export function collectV3BuildTestArtifactBudgetFailures(sources) {
  const failures = [];
  const requireMatch = (text, pattern, message) => {
    if (!pattern.test(text)) failures.push(message);
  };

  requireMatch(sources.cargoManifest, /\[profile\.test\][\s\S]*debug\s*=\s*0[\s\S]*incremental\s*=\s*false[\s\S]*codegen-units\s*=\s*16/u, 'V3 test profile must use debug=0, incremental=false, and codegen-units=16');
  requireMatch(sources.wrapper, new RegExp(`MAX_DEBUG_BYTES\\s*=\\s*${REQUIRED_BUDGET_BYTES}`), 'V3 test wrapper must hard-code the 2 GiB debug budget');
  requireMatch(sources.wrapper, /function releaseOwnedTestArtifacts|export async function releaseOwnedTestArtifacts/u, 'V3 test wrapper must own test-artifact release');
  requireMatch(sources.wrapper, /function verifyV3DebugBudget|export function verifyV3DebugBudget/u, 'V3 test wrapper must verify the post-test budget');
  requireMatch(sources.wrapper, /function enforceV3DebugBudget|export function enforceV3DebugBudget/u, 'V3 test wrapper must own over-budget cache eviction');
  requireMatch(sources.wrapper, /refusing cache eviction while V3 builders are active/u, 'V3 test wrapper must refuse cache eviction during another active build');
  requireMatch(sources.wrapper, /'clean',[\s\S]*'--profile',[\s\S]*'test'/u, 'V3 test wrapper must use Cargo test-profile cleanup for over-budget eviction');
  requireMatch(sources.wrapper, /finally[\s\S]*releaseOwnedTestArtifacts[\s\S]*enforceV3DebugBudget/u, 'V3 test cleanup and budget enforcement must run from the terminal finally path');
  requireMatch(sources.wrapper, /isAbsolute\(suppliedCargoTargetDir\)[\s\S]*resolve\(repoRoot,\s*suppliedCargoTargetDir\)[\s\S]*join\(repoRoot,\s*'v3',\s*'target'\)/u, 'V3 test wrapper must resolve relative CARGO_TARGET_DIR against repoRoot before falling back to v3/target');
  requireMatch(sources.wrapper, /join\(suppliedTargetRoot,\s*'routecodex-v3-test'\)/u, 'V3 test wrapper must isolate an explicit shared CARGO_TARGET_DIR under a RouteCodex-owned namespace');
  requireMatch(sources.wrapper, /CARGO_TARGET_DIR:\s*targetDir/u, 'V3 test wrapper must pass the normalized absolute CARGO_TARGET_DIR to Cargo');
  requireMatch(sources.wrapper, /owner\.json[\s\S]*createOwnedLock[\s\S]*reclaimStaleLock[\s\S]*ownProcessIdentity[\s\S]*currentProcessIdentity[\s\S]*lockOwnerMatchesProcess/u, 'V3 test wrapper must initialize locks without process enumeration and recover stale locks by validating PID and process-start identity');
  requireMatch(sources.wrapper, /function writeLockOwner\(\)\s*\{\s*const identity = ownProcessIdentity\(\);/u, 'V3 test lock acquisition must derive the current wrapper identity without process enumeration');
  requireMatch(sources.wrapper, /spawnSync\('ps',[\s\S]*LC_ALL:\s*'C'/u, 'V3 test lock inspection must use locale-stable process-start output');
  requireMatch(sources.wrapper, /function currentProcessIdentity\(pid\)\s*\{[\s\S]*if \(!processExists\(pid\)\) return null;[\s\S]*if \(result\.error\) return \{ pid, processStartedAt: null \};[\s\S]*if \(result\.status !== 0\) return \{ pid, processStartedAt: null \};/u, 'V3 test lock inspection must not require ps access when the PID is still alive');
  requireMatch(sources.wrapper, /processStartedAt:\s*identity\.processStartedAt[\s\S]*owner\.processStartedAt\s*===\s*liveIdentity\?\.processStartedAt/u, 'V3 test lock owner must record and compare the process-start identity');
  requireMatch(sources.wrapper, /writeLockOwner\(\);\s*\} catch \(error\) \{\s*removePath\(lockDir\);\s*throw error;\s*\}\s*\}/u, 'V3 test wrapper must remove a newly created lock when owner initialization fails');
  requireMatch(sources.wrapper, /belongsToExecutable[\s\S]*removePath\(path\)/u, 'V3 test wrapper must release only rcgu objects matching executables from this invocation');
  requireMatch(sources.wrapper, /-p\\s\+routecodex-v3/u, 'V3 test wrapper must detect cargo test -p routecodex-v3-* builders without manifest or target paths');
  requireMatch(sources.wrapper, /function isBareWorkspaceCargoBuildOrTest\(command\)[\s\S]*cargo\\s\+[\s\S]*\(\?:build\|test\)[\s\S]*--workspace/u, 'V3 test wrapper must detect bare cargo build/test --workspace builders');
  requireMatch(sources.wrapper, /function currentProcessCwd\(pid\)[\s\S]*readlinkSync\(`\/proc\/\$\{pid\}\/cwd`\)[\s\S]*'lsof',\s*\['-a',\s*'-p',\s*String\(pid\),\s*'-d',\s*'cwd',\s*'-Fn'\]/u, 'V3 test wrapper must inspect builder cwd before treating bare workspace commands as V3 builders');
  if (/createdByFailedInvocation/u.test(sources.wrapper)) {
    failures.push('V3 test wrapper must not timestamp-delete rcgu objects from other Cargo invocations');
  }
  if (/unable to inspect process/u.test(sources.wrapper)) {
    failures.push('V3 test wrapper must not fail Cargo tests when ps inspection is unavailable');
  }
  requireMatch(sources.runner, /runV3CargoTest/u, 'The canonical V3 test entry must delegate to runV3CargoTest');
  requireMatch(sources.architectureCi, /'verify:v3-build-test-artifact-budget'/u, 'V3 architecture CI must run the artifact budget gate');
  requireMatch(sources.architectureCi, /'test:v3-build-test-artifact-budget-red-fixtures'/u, 'V3 architecture CI must run the artifact budget red fixtures');
  requireMatch(sources.moduleRegistry, /status:\s*active/u, 'V3 build-tool module registry must be active');
  requireMatch(sources.moduleRegistry, /module_id:\s*v3-build-test-artifact-budget/u, 'V3 build-tool module registry must declare the unique owner');

  const rawV3CargoTest = /cargo(?: \+stable)? test (?=[^"\n]*(?:--manifest-path v3\/Cargo\.toml|-p routecodex-v3))/u;
  const packageJson = JSON.parse(sources.packageJson);
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (rawV3CargoTest.test(command)) failures.push(`package script ${name} bypasses scripts/run-v3-cargo-test.mjs`);
  }
  if (packageJson.scripts?.['v3:cargo:test'] !== 'node scripts/run-v3-cargo-test.mjs') {
    failures.push('package script v3:cargo:test must bind the canonical wrapper');
  }
  return failures;
}

export function readV3BuildTestArtifactBudgetSources(root) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  return {
    packageJson: read('package.json'),
    cargoManifest: read('v3/Cargo.toml'),
    wrapper: read('scripts/run-v3-cargo-test.mjs'),
    runner: read('scripts/cargo-test-artifact-runner.mjs'),
    architectureCi: read('scripts/architecture/verify-v3-architecture-ci.mjs'),
    moduleRegistry: read('docs/architecture/v3-build-tool-module-registry.yml'),
  };
}

function main() {
  const root = resolve(process.argv[2] ?? '.');
  let failures;
  try {
    failures = collectV3BuildTestArtifactBudgetFailures(readV3BuildTestArtifactBudgetSources(root));
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)];
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`[v3-build-test-artifact-budget] ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write('[v3-build-test-artifact-budget] PASS\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
