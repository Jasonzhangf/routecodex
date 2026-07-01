import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.resolve(__dirname, '../../../../src/server/runtime/http-server/http-server-bootstrap.ts');

describe('http server bootstrap daemon admin UI', () => {
  it('does not keep packaged legacy daemon admin UI fallback', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('packagedLegacyFile');
    expect(source).not.toContain('daemon-admin-ui.html');
    expect(source).not.toContain('registerDaemonAdminUiRoute.readPackagedIndex');
    expect(source).not.toContain('fallback: packagedLegacyFile');
  });
});
