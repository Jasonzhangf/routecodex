import { buildStructuredPatch, isStructuredApplyPatchPayload } from '../sharedmodule/llmswitch-core/src/tools/apply-patch/structured.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const ERROR_SAMPLES_DIR = join(process.env.HOME || '', '.routecodex/errorsamples/apply_patch/invalid_file');

describe('apply_patch shape compatibility improvements', () => {
  describe('missing file field detection', () => {
    test('should detect missing file field in changes', () => {
      const payload = {
        changes: [
          {
            kind: 'replace',
            target: 'old line',
            lines: 'new line'
          }
        ]
      };
      
      expect(() => buildStructuredPatch(payload)).toThrow('missing "file"');
    });

    test('should accept top-level file field', () => {
      const payload = {
        file: 'src/test.ts',
        changes: [
          {
            kind: 'replace',
            target: 'old line',
            lines: 'new line'
          }
        ]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('*** Update File: src/test.ts');
    });
  });

  describe('file path normalization', () => {
    test('should normalize Windows paths to Unix', () => {
      const payload = {
        file: 'src\\modules\\file.ts',
        changes: [{ kind: 'replace', target: 'old', lines: 'new' }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('src/modules/file.ts');
      expect(result).not.toContain('\\\\');
    });

    test('should handle multi-line file path gracefully', () => {
      const payload = {
        file: 'src/test.ts\nextra',
        changes: [{ kind: 'replace', target: 'old', lines: 'new' }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('src/test.ts');
    });
  });

  describe('empty file field handling', () => {
    test('should reject empty string file path', () => {
      const payload = {
        file: '   ',
        changes: [{ kind: 'replace', target: 'old', lines: 'new' }]
      };
      
      expect(() => buildStructuredPatch(payload)).toThrow('must not be empty');
    });

    test('should handle null/undefined file gracefully', () => {
      const payload1 = {
        file: null,
        changes: [{ kind: 'replace', target: 'old', lines: 'new' }]
      };
      
      const payload2 = {
        file: undefined,
        changes: [{ kind: 'replace', target: 'old', lines: 'new' }]
      };
      
      expect(() => buildStructuredPatch(payload1)).toThrow('missing "file"');
      expect(() => buildStructuredPatch(payload2)).toThrow('missing "file"');
    });
  });

  describe('lines field normalization', () => {
    test('should handle empty array', () => {
      const payload = {
        file: 'test.ts',
        changes: [{ kind: 'replace', target: 'old', lines: [] }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('*** Update File: test.ts');
    });

    test('should convert string to lines array', () => {
      const payload = {
        file: 'test.ts',
        changes: [{
          kind: 'replace',
          target: 'old',
          lines: 'line1\nline2\nline3'
        }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('+line1');
      expect(result).toContain('+line2');
      expect(result).toContain('+line3');
    });

    test('should handle escaped newlines', () => {
      const payload = {
        file: 'test.ts',
        changes: [{
          kind: 'replace',
          target: 'old',
          lines: 'line1\\nline2\\nline3'
        }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('+line1');
      expect(result).toContain('+line2');
      expect(result).toContain('+line3');
    });

    test('should handle null/undefined in lines array', () => {
      const payload = {
        file: 'test.ts',
        changes: [{
          kind: 'replace',
          target: 'old',
          lines: ['line1', null, 'line2', undefined, 'line3']
        }]
      };
      
      const result = buildStructuredPatch(payload);
      expect(result).toContain('+line1');
      expect(result).toContain('+');  // empty line for null
      expect(result).toContain('+line2');
      expect(result).toContain('+');  // empty line for undefined
      expect(result).toContain('+line3');
    });
  });

  describe('error regression tests from samples', () => {
    test('should handle sample with missing file gracefully', () => {
      // This is a common pattern from error samples
      const payload = {
        changes: [{
          kind: 'replace',
          target: 'function old() {}',
          lines: 'function new() {}'
        }]
      };
      
      expect(() => buildStructuredPatch(payload)).toThrow();
    });
  });

  describe('isStructuredApplyPatchPayload', () => {
    test('should detect valid structured payload', () => {
      expect(isStructuredApplyPatchPayload({ changes: [] })).toBe(true);
      expect(isStructuredApplyPatchPayload({ changes: [{ kind: 'replace' }] })).toBe(true);
    });

    test('should reject invalid payloads', () => {
      expect(isStructuredApplyPatchPayload(null)).toBe(false);
      expect(isStructuredApplyPatchPayload({})).toBe(false);
      expect(isStructuredApplyPatchPayload({ changes: 'not array' })).toBe(false);
    });
  });
});
