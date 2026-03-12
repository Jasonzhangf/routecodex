import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';

import { createUserConfigMigrateCommand } from '../../src/commands/migrate-user-config.js';

async function createTempHome(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('migrate-user-config command', () => {
  it('prints a dry-run plan and excludes non-config artifacts', async () => {
    const home = await createTempHome('rcc-migrate-config-dryrun-');
    const legacyRoot = path.join(home, '.routecodex');
    await fs.mkdir(path.join(legacyRoot, 'provider', 'openai'), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, 'auth'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'config.json'), '{"ok":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'provider', 'openai', 'config.v2.json'), '{"providerId":"openai"}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'auth', 'token.json'), '{"secret":true}\n', 'utf8');

    const output: string[] = [];
    const program = new Command();
    program.addCommand(createUserConfigMigrateCommand({ log: (line) => output.push(line), error: (line) => output.push(`ERR:${line}`) }));

    await program.parseAsync(['node', 'routecodex', 'migrate-user-config', '--home', home], { from: 'node' });

    const text = output.join('\n');
    expect(text).toContain('config.json');
    expect(text).toContain('provider/openai/config.v2.json');
    expect(text).not.toContain('auth/token.json');
    expect(text).toContain('Dry-run only');
  });

  it('copies config and provider when --apply is used', async () => {
    const home = await createTempHome('rcc-migrate-config-apply-');
    const legacyRoot = path.join(home, '.routecodex');
    await fs.mkdir(path.join(legacyRoot, 'provider', 'openai'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'config.json'), '{"ok":true}\n', 'utf8');
    await fs.writeFile(path.join(legacyRoot, 'provider', 'openai', 'config.v2.json'), '{"providerId":"openai"}\n', 'utf8');

    const output: string[] = [];
    const program = new Command();
    program.addCommand(createUserConfigMigrateCommand({ log: (line) => output.push(line), error: (line) => output.push(`ERR:${line}`) }));

    await program.parseAsync(['node', 'routecodex', 'migrate-user-config', '--home', home, '--apply'], { from: 'node' });

    expect(await fs.readFile(path.join(home, '.rcc', 'config.json'), 'utf8')).toContain('"ok":true');
    expect(await fs.readFile(path.join(home, '.rcc', 'provider', 'openai', 'config.v2.json'), 'utf8')).toContain('"providerId":"openai"');
    expect(output.join('\n')).toContain('Applied: copied=');
  });
});
