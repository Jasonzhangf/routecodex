import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  applyUserConfigMigrationPlan,
  collectUserConfigMigrationPlan
} from '../../src/config/user-config-migration.js';

async function createTempHome(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('user-config-migration', () => {
  it('plans only config-owned artifacts and excludes generated/runtime directories', async () => {
    const home = await createTempHome('rcc-user-config-plan-');
    const legacyRoot = path.join(home, '.routecodex');

    await fs.mkdir(path.join(legacyRoot, 'provider', 'openai'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'provider', 'openai', 'samples', 'mock-provider'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'config', 'multi'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'auth'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'logs'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'config.json'), '{"ok":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'provider', 'openai', 'config.v2.json'), '{"providerId":"openai"}\n', 'utf8');
    await fs.writeFile(
      path.join(legacyRoot, 'provider', 'openai', 'samples', 'mock-provider', 'request.json'),
      '{"sample":true}\n',
      'utf8'
    );
    await fs.writeFile(path.join(legacyRoot, 'config', 'multi', 'team.json'), '{"team":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'auth', 'token.json'), '{"secret":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'logs', 'server.log'), 'runtime\n', 'utf8');

    const plan = await collectUserConfigMigrationPlan({ homeDir: home });
    const targets = plan.items.map((item) => item.targetPath);

    expect(targets).toContain(path.join(home, '.rcc', 'config.json'));
    expect(targets).toContain(path.join(home, '.rcc', 'provider', 'openai', 'config.v2.json'));
    expect(targets).toContain(path.join(home, '.rcc', 'config', 'multi', 'team.json'));
    expect(targets.some((target) => target.includes(`${path.sep}provider${path.sep}openai${path.sep}samples${path.sep}`))).toBe(false);
    expect(targets.some((target) => target.includes(`${path.sep}auth${path.sep}`))).toBe(false);
    expect(targets.some((target) => target.includes(`${path.sep}logs${path.sep}`))).toBe(false);
  });

  it('applies copy actions and preserves conflicts unless overwrite is enabled', async () => {
    const home = await createTempHome('rcc-user-config-apply-');
    const legacyRoot = path.join(home, '.routecodex');
    const targetRoot = path.join(home, '.rcc');

    await fs.mkdir(path.join(legacyRoot, 'provider', 'openai'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'config.json'), '{"legacy":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'provider', 'openai', 'config.v2.json'), '{"legacy":"provider"}\n', 'utf8');

    await fs.mkdir(path.join(targetRoot, 'provider', 'openai'), { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'provider', 'openai', 'config.v2.json'), '{"new":"provider"}\n', 'utf8');

    const plan = await collectUserConfigMigrationPlan({ homeDir: home });
    expect(plan.summary.copy).toBe(1);
    expect(plan.summary.conflict).toBe(1);

    const result = await applyUserConfigMigrationPlan(plan);
    expect(result.copied).toBe(1);
    expect(result.skippedConflicts).toBe(1);
    expect(await fs.readFile(path.join(targetRoot, 'config.json'), 'utf8')).toContain('"legacy":true');
    expect(await fs.readFile(path.join(targetRoot, 'provider', 'openai', 'config.v2.json'), 'utf8')).toContain('"new":"provider"');

    const overwritePlan = await collectUserConfigMigrationPlan({ homeDir: home, overwrite: true });
    expect(overwritePlan.summary.overwrite).toBe(1);
    const overwriteResult = await applyUserConfigMigrationPlan(overwritePlan);
    expect(overwriteResult.overwritten).toBe(1);
    expect(await fs.readFile(path.join(targetRoot, 'provider', 'openai', 'config.v2.json'), 'utf8')).toContain('"legacy":"provider"');
  });
});
