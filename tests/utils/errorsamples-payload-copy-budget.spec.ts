import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

// feature_id: debug.errorsample_payload_copy_budget
describe('errorsample payload copy budget', () => {
  it('serializes with inline redaction instead of a complete redacted payload clone', () => {
    const tsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/debug/errorsamples.ts'),
      'utf8',
    );
    const jsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/debug/errorsamples.js'),
      'utf8',
    );
    const writerName = ['writeErrorsample', 'Json'].join('');
    const writerStart = tsSource.indexOf(`export async function ${writerName}(`);
    const writerEnd = tsSource.indexOf('\nexport async function __flushErrorsampleQueueForTests', writerStart);
    const writer = tsSource.slice(writerStart, writerEnd);

    expect(writerStart).toBeGreaterThanOrEqual(0);
    expect(writerEnd).toBeGreaterThan(writerStart);
    expect(writer).not.toContain('redactSensitiveData(options.payload)');
    expect(tsSource).not.toContain("import { redactSensitiveData } from '../utils/sensitive-redaction.js';");
    expect(tsSource).toContain('stringifyRedactedJson');
    expect(jsSource).not.toContain('redactSensitiveData(options.payload)');
    expect(jsSource).not.toContain("import { redactSensitiveData } from '../utils/sensitive-redaction.js';");
    expect(jsSource).toContain('stringifyRedactedJson');
  });

  it('does not create pretty and compact full strings in normal mode', () => {
    const tsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/debug/errorsamples.ts'),
      'utf8',
    );
    const jsSource = fs.readFileSync(
      path.join(process.cwd(), 'src/debug/errorsamples.js'),
      'utf8',
    );
    const serializerName = ['serializePayload', 'ForWrite'].join('');
    const start = tsSource.indexOf(`function ${serializerName}(`);
    const end = tsSource.indexOf('\nasync function collectGroupFiles(', start);
    const body = tsSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).not.toContain('JSON.stringify(payload, null, 2)');
    expect(body).not.toContain('JSON.stringify(payload)');
    expect(jsSource).not.toContain('JSON.stringify(payload, null, 2)');
    expect(jsSource).not.toContain('JSON.stringify(payload)');
  });
});
