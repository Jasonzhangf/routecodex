import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertInstallCommandOwnershipSupported,
  runInterruptibleCommand,
  withOwnedV3CargoTarget,
} from '../../scripts/install-cli.mjs';

async function waitForFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

test('rejects an explicitly supplied Cargo target outside V3', async () => {
  const targetDir = path.join(
    path.parse(process.cwd()).root,
    'tmp',
    `routecodex-v3-external-target-${process.pid}`,
  );
  assert.equal(fs.existsSync(targetDir), false);
  await assert.rejects(
    () => withOwnedV3CargoTarget(() => {}, { CARGO_TARGET_DIR: targetDir }),
    /external CARGO_TARGET_DIR is forbidden/,
  );
  assert.equal(fs.existsSync(targetDir), false);
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
  const marker = path.join(
    os.tmpdir(),
    `routecodex-v3-pre-spawn-${process.pid}-${Date.now()}`,
  );
  const build = {
    activeChild: null,
    interruptedSignal: 'SIGTERM',
    interruptedProcessGroupPid: null,
  };

  try {
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
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('rejects Windows command spawn until a Job Object owner exists', () => {
  assert.throws(
    () => assertInstallCommandOwnershipSupported('win32'),
    /Windows install command ownership requires a Job Object/,
  );
});

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`stops the owned command group before removing its target after ${signal}`, async () => {
    const modulePath = new URL('../../scripts/install-cli.mjs', import.meta.url).href;
    const caseId = `${process.pid}-${signal}-${Date.now()}`;
    const readyMarker = path.join(
      os.tmpdir(),
      `routecodex-v3-descendant-ready-${caseId}`,
    );
    const signalMarker = path.join(os.tmpdir(), `routecodex-v3-descendant-signal-${caseId}`);
    const exitMarker = path.join(os.tmpdir(), `routecodex-v3-descendant-exit-${caseId}`);
    const delayedMarker = path.join(os.tmpdir(), `routecodex-v3-descendant-delayed-${caseId}`);
    const errorMarker = path.join(os.tmpdir(), `routecodex-v3-installer-error-${caseId}`);
    const descendantSource = `
      const fs = require('node:fs');
      let stopping = false;
      const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        fs.writeFileSync(
          process.env.DESCENDANT_SIGNAL_MARKER,
          JSON.stringify({ signal, targetExists: fs.existsSync(process.env.OWNED_TARGET_DIR) }),
        );
        setTimeout(() => process.exit(0), 75);
      };
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('exit', () => {
        fs.writeFileSync(
          process.env.DESCENDANT_EXIT_MARKER,
          JSON.stringify({ targetExists: fs.existsSync(process.env.OWNED_TARGET_DIR) }),
        );
      });
      fs.writeFileSync(process.env.DESCENDANT_READY_MARKER, 'ready');
      setTimeout(() => {
        fs.writeFileSync(process.env.DESCENDANT_DELAYED_MARKER, 'still-running');
      }, 300);
      setTimeout(() => process.exit(0), 1000);
    `;
    const childSource = `
      require('node:child_process').spawn(
        process.execPath,
        ['-e', ${JSON.stringify(descendantSource)}],
        { env: process.env, stdio: 'ignore' },
      );
      setTimeout(() => {}, 30000);
    `;
    const source = `
      import fs from 'node:fs';
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
                OWNED_TARGET_DIR: build.cargoTargetDir,
                DESCENDANT_READY_MARKER: ${JSON.stringify(readyMarker)},
                DESCENDANT_SIGNAL_MARKER: ${JSON.stringify(signalMarker)},
                DESCENDANT_EXIT_MARKER: ${JSON.stringify(exitMarker)},
                DESCENDANT_DELAYED_MARKER: ${JSON.stringify(delayedMarker)},
              },
              stdio: 'ignore',
            },
            build,
            'controlled child',
          );
        }, {});
      } catch (error) {
        fs.writeFileSync(
          ${JSON.stringify(errorMarker)},
          JSON.stringify({ message: error?.message, exitCode: error?.exitCode }),
        );
        process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
      }
    `;
    const installer = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const targetDir = await new Promise((resolve, reject) => {
        installer.once('error', reject);
        installer.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
      });

      assert.equal(fs.existsSync(targetDir), true);
      await waitForFile(readyMarker);
      installer.kill(signal);
      const exitCode = await new Promise((resolve) => {
        installer.once('close', resolve);
      });
      await waitForFile(exitMarker);

      const installerError = fs.existsSync(errorMarker)
        ? fs.readFileSync(errorMarker, 'utf8')
        : 'missing installer error evidence';
      assert.equal(exitCode, expectedCode, installerError);
      assert.equal(fs.existsSync(signalMarker), true, 'descendant must observe the group signal');
      const signalEvidence = JSON.parse(fs.readFileSync(signalMarker, 'utf8'));
      const exitEvidence = JSON.parse(fs.readFileSync(exitMarker, 'utf8'));
      assert.deepEqual(signalEvidence, { signal, targetExists: true });
      assert.deepEqual(exitEvidence, { targetExists: true });
      assert.equal(fs.existsSync(targetDir), false);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(fs.existsSync(delayedMarker), false);
    } finally {
      if (installer.exitCode === null && installer.signalCode === null) {
        installer.kill('SIGTERM');
      }
      fs.rmSync(readyMarker, { force: true });
      fs.rmSync(signalMarker, { force: true });
      fs.rmSync(exitMarker, { force: true });
      fs.rmSync(delayedMarker, { force: true });
      fs.rmSync(errorMarker, { force: true });
    }
  });
}
