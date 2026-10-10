#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXPECTED_VERSION = '0.1.0014';
const EXPECTED_CLI_VERSION = `appsdk ${EXPECTED_VERSION} (rust)`;
const PROJECT_ROOTS = ['.', 'v3', 'v4'];

const root = resolve(process.argv[2] ?? '.');
const appsdk = process.env.APPSDK_BIN ?? 'appsdk';
const failures = [];
const deliveryGaps = [];
const projects = new Map();

function runAppsdk(args) {
  return spawnSync(appsdk, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

function readJson(relativePath) {
  const path = join(root, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function requireVersion(relativePath, actual) {
  if (actual !== EXPECTED_VERSION) {
    failures.push(
      `${relativePath}: expected ${EXPECTED_VERSION}, got ${JSON.stringify(actual)}`,
    );
  }
}

function readFrozenModuleIds(project, relativePath) {
  if (!project || !Array.isArray(project.modules)) {
    failures.push(`${relativePath}: expected modules array`);
    return [];
  }

  const frozenModules = project.modules.filter(
    (module) => module?.stage === 'frozen',
  );
  const invalidModule = frozenModules.find(
    (module) =>
      typeof module.module_id !== 'string' || module.module_id.length === 0,
  );
  if (invalidModule) {
    failures.push(`${relativePath}: frozen module is missing module_id`);
    return [];
  }

  return frozenModules.map((module) => module.module_id);
}

function emitProcessOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

const versionResult = runAppsdk(['version']);
emitProcessOutput(versionResult);
if (versionResult.error) {
  failures.push(`cannot run ${appsdk}: ${versionResult.error.message}`);
} else if (versionResult.status !== 0) {
  failures.push(`${appsdk} version exited ${versionResult.status}`);
} else if (versionResult.stdout.trim() !== EXPECTED_CLI_VERSION) {
  failures.push(
    `${appsdk} version: expected ${JSON.stringify(EXPECTED_CLI_VERSION)}, got ${JSON.stringify(versionResult.stdout.trim())}`,
  );
}

for (const projectRoot of PROJECT_ROOTS) {
  const prefix = projectRoot === '.' ? '' : `${projectRoot}/`;
  const project = readJson(`${prefix}.appsdk/project.json`);
  const lock = readJson(`${prefix}.appsdk/sdk.lock`);
  const bundle = readJson(`${prefix}.appsdk/contracts/sdk-bundle.manifest.json`);
  const resources = readJson(`${prefix}.appsdk/sdk-resources.json`);

  if (project) {
    projects.set(projectRoot, project);
    if (project.sdk?.name !== 'appsdk') {
      failures.push(
        `${prefix}.appsdk/project.json: expected sdk.name=appsdk, got ${JSON.stringify(project.sdk?.name)}`,
      );
    }
    requireVersion(`${prefix}.appsdk/project.json`, project.sdk?.version);
  }
  if (lock) requireVersion(`${prefix}.appsdk/sdk.lock`, lock.version);
  if (bundle) {
    requireVersion(
      `${prefix}.appsdk/contracts/sdk-bundle.manifest.json`,
      bundle.version,
    );
  }
  if (resources) requireVersion(`${prefix}.appsdk/sdk-resources.json`, resources.version);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[appsdk-admission] FAIL ${failure}`);
  process.exit(1);
}

for (const projectRoot of PROJECT_ROOTS) {
  const target = projectRoot === '.' ? '.' : projectRoot;
  console.log(`[appsdk-admission] verify ${target}`);
  const result = runAppsdk(['verify', target]);
  emitProcessOutput(result);

  if (result.error) {
    failures.push(`${target}: cannot run ${appsdk} verify: ${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      target === 'v4' &&
      result.status === 1 &&
      combinedOutput.length === 1 &&
      combinedOutput[0] === 'ACTIVE_ARTIFACT_MISSING'
    ) {
      const frozenModules = readFrozenModuleIds(
        projects.get(target),
        `${target}/.appsdk/project.json`,
      );
      let reviewAdmissionPassed = frozenModules.length > 0;
      if (!reviewAdmissionPassed) {
        failures.push(`${target}: ACTIVE_ARTIFACT_MISSING has no frozen modules`);
      }

      for (const moduleId of frozenModules) {
        console.log(
          `[appsdk-admission] review-admission ${target} ${moduleId}`,
        );
        const reviewResult = runAppsdk([
          'verify',
          '--review-admission',
          target,
          '--module',
          moduleId,
        ]);
        emitProcessOutput(reviewResult);

        if (reviewResult.error) {
          failures.push(
            `${target}: cannot run ${appsdk} review-admission ${moduleId}: ${reviewResult.error.message}`,
          );
          reviewAdmissionPassed = false;
          continue;
        }
        if (reviewResult.status !== 0) {
          failures.push(
            `${target}: review-admission ${moduleId} exited ${reviewResult.status}`,
          );
          reviewAdmissionPassed = false;
          continue;
        }

        let reviewVerdict;
        try {
          reviewVerdict = JSON.parse(reviewResult.stdout);
        } catch (error) {
          failures.push(
            `${target}: review-admission ${moduleId} returned non-JSON stdout: ${error.message}`,
          );
          reviewAdmissionPassed = false;
          continue;
        }
        if (reviewVerdict.ok !== true) {
          failures.push(
            `${target}: review-admission ${moduleId} returned ok=${JSON.stringify(reviewVerdict.ok)}`,
          );
          reviewAdmissionPassed = false;
        }
      }

      if (reviewAdmissionPassed) {
        const gap = `${target}: ACTIVE_ARTIFACT_MISSING`;
        deliveryGaps.push(gap);
        console.warn(
          `[appsdk-admission] DELIVERY_GAP ${gap} (active artifact absent; frozen review-admission gates passed)`,
        );
      }
      continue;
    }
    failures.push(`${target}: appsdk verify exited ${result.status}`);
    continue;
  }

  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`${target}: appsdk verify returned non-JSON stdout: ${error.message}`);
    continue;
  }

  // Ordinary verify evaluates the contract, not delivery. A false top-level
  // "ok" is expected when delivery is not assessed, but the contract must be
  // current and development-ready. Delivery admission is not inferred here
  // because v4 active artifacts are intentionally gitignored.
  if (verdict.baseline_status !== 'current') {
    failures.push(
      `${target}: baseline_status=${JSON.stringify(verdict.baseline_status)}`,
    );
  }
  if (verdict.command_ok !== true) {
    failures.push(`${target}: command_ok=${JSON.stringify(verdict.command_ok)}`);
  }
  if (verdict.development_ready !== true) {
    failures.push(
      `${target}: development_ready=${JSON.stringify(verdict.development_ready)}`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[appsdk-admission] FAIL ${failure}`);
  process.exit(1);
}

if (deliveryGaps.length > 0) {
  const message = `${deliveryGaps.join(', ')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## AppSDK contract admission\n\nContract checks: PASS\n\nDelivery gaps: ${message}`,
    );
  }
}

console.log(
  `[appsdk-admission] ${deliveryGaps.length === 0 ? 'PASS' : 'CONTRACT_PASS'} roots=${PROJECT_ROOTS.join(',')} sdk=${EXPECTED_VERSION} delivery_gaps=${deliveryGaps.length}`,
);
