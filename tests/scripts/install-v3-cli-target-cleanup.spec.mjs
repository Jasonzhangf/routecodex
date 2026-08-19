import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runInterruptibleCommand,
  withOwnedV3CargoTarget,
} from '../../scripts/install-v3-cli.mjs';

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processGroupId(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return Number.parseInt(result.stdout.trim(), 10);
}

test('removes an internally owned Cargo target after success', async () => {
  let targetDir;

  await withOwnedV3CargoTarget((build) => {
    targetDir = build.cargoTargetDir;
    assert.equal(build.ownsCargoTargetDir, true);
    assert.equal(fs.existsSync(targetDir), true);
  }, {});

  assert.equal(fs.existsSync(targetDir), false);
});

test('removes an internally owned Cargo target after failure', async () => {
  let targetDir;

  await assert.rejects(
    () => withOwnedV3CargoTarget((build) => {
      targetDir = build.cargoTargetDir;
      throw new Error('controlled build failure');
    }, {}),
    /controlled build failure/,
  );

  assert.equal(fs.existsSync(targetDir), false);
});

test('preserves an explicitly supplied Cargo target', async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-external-target-'));
  try {
    await withOwnedV3CargoTarget((build) => {
      assert.equal(build.cargoTargetDir, targetDir);
      assert.equal(build.ownsCargoTargetDir, false);
    }, { CARGO_TARGET_DIR: targetDir });

    assert.equal(fs.existsSync(targetDir), true);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('missing child command rejects once without invalid process-group wait', async () => {
  const build = { activeChild: null, interruptedSignal: null };

  await assert.rejects(
    () => runInterruptibleCommand(
      '/definitely/missing-routecodex-command',
      [],
      { stdio: 'ignore' },
      build,
      'missing command',
    ),
    /missing command could not start:/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(build.activeChild, null);
});

test('does not spawn a command after interruption is already observed', async () => {
  const marker = path.join(os.tmpdir(), `routecodex-v3-pre-spawn-${process.pid}`);
  const build = {
    activeChild: null,
    activeChildRootPid: null,
    interruptedSignal: 'SIGTERM',
    interruptedPids: [],
  };

  await assert.rejects(
    () => runInterruptibleCommand(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      { stdio: 'ignore' },
      build,
      'pre-interrupted child',
    ),
    /V3 install interrupted by SIGTERM/,
  );

  assert.equal(fs.existsSync(marker), false);
});

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`stops the command tree before removing an owned target after ${signal}`, async () => {
    const modulePath = new URL('../../scripts/install-v3-cli.mjs', import.meta.url).href;
    const descendantMarker = path.join(
      os.tmpdir(),
      `routecodex-v3-descendant-${process.pid}-${signal}`,
    );
    const readyMarker = path.join(
      os.tmpdir(),
      `routecodex-v3-descendant-ready-${process.pid}-${signal}`,
    );
    const descendantSource = `
      const { spawnSync } = require('node:child_process');
      const pgid = Number.parseInt(
        spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim(),
        10,
      );
      require('node:fs').writeFileSync(
        process.env.DESCENDANT_READY_MARKER,
        JSON.stringify({ pid: process.pid, pgid, rootPid: Number(process.env.OWNED_ROOT_PID) }),
      );
      setTimeout(() => {
        require('node:fs').writeFileSync(process.env.DESCENDANT_MARKER, 'still-running');
      }, 300);
      setTimeout(() => {}, 30000);
    `;
    const childSource = `
      require('node:child_process').spawn(
        process.execPath,
        ['-e', ${JSON.stringify(descendantSource)}],
        {
          env: { ...process.env, OWNED_ROOT_PID: String(process.pid) },
          stdio: 'ignore',
        },
      );
      setTimeout(() => {}, 30000);
    `;
    const source = `
      import { runInterruptibleCommand, withOwnedV3CargoTarget } from ${JSON.stringify(modulePath)};
      try {
        await withOwnedV3CargoTarget(async (build) => {
          process.stdout.write(build.cargoTargetDir + '\\n');
          await runInterruptibleCommand(
            process.execPath,
            ['-e', ${JSON.stringify(childSource)}],
            {
              env: {
                ...process.env,
                DESCENDANT_MARKER: ${JSON.stringify(descendantMarker)},
                DESCENDANT_READY_MARKER: ${JSON.stringify(readyMarker)},
              },
              stdio: 'ignore',
            },
            build,
            'controlled child',
          );
        }, {});
      } catch (error) {
        process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
      }
    `;
    const installer = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const targetDir = await new Promise((resolve, reject) => {
      installer.once('error', reject);
      installer.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    });

    assert.equal(fs.existsSync(targetDir), true);
    await waitForFile(readyMarker);
    const ready = JSON.parse(fs.readFileSync(readyMarker, 'utf8'));
    assert.equal(ready.rootPid > 0, true);
    assert.equal(ready.pid > 0, true);
    assert.equal(ready.pgid, processGroupId(ready.rootPid));
    installer.kill(signal);
    const exitCode = await new Promise((resolve) => {
      installer.once('close', resolve);
    });

    assert.equal(exitCode, expectedCode);
    assert.equal(fs.existsSync(targetDir), false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.existsSync(descendantMarker), false);
    fs.rmSync(readyMarker, { force: true });
  });
}
