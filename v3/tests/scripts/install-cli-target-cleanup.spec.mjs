import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runInterruptibleCommand,
  withOwnedV3CargoTarget,
} from '../../scripts/install-cli.mjs';

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
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-v3-external-target-'));
  try {
    await assert.rejects(
      () => withOwnedV3CargoTarget(() => {}, { CARGO_TARGET_DIR: targetDir }),
      /external CARGO_TARGET_DIR is forbidden/,
    );
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

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`stops the command tree before removing an owned target after ${signal}`, async () => {
    const modulePath = new URL('../../scripts/install-cli.mjs', import.meta.url).href;
    const descendantMarker = path.join(
      os.tmpdir(),
      `routecodex-v3-descendant-${process.pid}-${signal}`,
    );
    const descendantSource = `
      setTimeout(() => {
        require('node:fs').writeFileSync(process.env.DESCENDANT_MARKER, 'still-running');
      }, 300);
      setTimeout(() => {}, 30000);
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
      import { runInterruptibleCommand, withOwnedV3CargoTarget } from ${JSON.stringify(modulePath)};
      try {
        await withOwnedV3CargoTarget(async (build) => {
          process.stdout.write(build.cargoTargetDir + '\\n');
          await runInterruptibleCommand(
            process.execPath,
            ['-e', ${JSON.stringify(childSource)}],
            {
              env: { ...process.env, DESCENDANT_MARKER: ${JSON.stringify(descendantMarker)} },
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
    installer.kill(signal);
    const exitCode = await new Promise((resolve) => {
      installer.once('close', resolve);
    });

    assert.equal(exitCode, expectedCode);
    assert.equal(fs.existsSync(targetDir), false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.existsSync(descendantMarker), false);
  });
}
