import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.js';

const mockNormalizeApplyPatchArgumentsJson = jest.fn((inputJson: string) => {
  const input = JSON.parse(inputJson) as { arguments?: { patch?: string; filePath?: string; fileContent?: string } };
  const args = input.arguments ?? {};
  return JSON.stringify({
    normalizedArguments: JSON.stringify({
      patch: args.patch,
      filePath: args.filePath,
      fileContent: args.fileContent
    }),
    repaired: true
  });
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.js',
  () => ({
    loadNativeRouterHotpathBindingForInternalUse: () => ({
      normalizeApplyPatchArgumentsJson: mockNormalizeApplyPatchArgumentsJson
    })
  })
);

const { normalizeApplyPatchArgumentsWithNative } = await import(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-governance-semantics.js'
);

describe('apply_patch native governance wiring', () => {
  beforeEach(() => {
    mockNormalizeApplyPatchArgumentsJson.mockClear();
  });

  it('keeps normalizeApplyPatchArgumentsJson as the single required native owner', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('normalizeApplyPatchArgumentsJson');
  });

  it('uses the single native owner for internal line-edit shaped payloads', () => {
    const result = normalizeApplyPatchArgumentsWithNative({
      patch: '= 1 abc123\nworld',
      filePath: 'note.txt',
      fileContent: 'hello'
    });

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.normalizedArguments)).toMatchObject({
      patch: '= 1 abc123\nworld',
      filePath: 'note.txt',
      fileContent: 'hello'
    });
    expect(result.repaired).toBe(true);
  });

  it('accepts file_path alias for line-edit payloads', () => {
    const result = normalizeApplyPatchArgumentsWithNative({
      patch: '+ 2 deadbeef\nhello',
      file_path: 'note.txt',
      fileContent: 'hello'
    });

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.normalizedArguments)).toMatchObject({
      patch: '+ 2 deadbeef\nhello'
    });
    expect(result.repaired).toBe(true);
  });

  it('accepts nested input.patch plus nested input.filePath', () => {
    const result = normalizeApplyPatchArgumentsWithNative({
      input: {
        patch: '- 3 cafe1234\nbye',
        filePath: 'nested.txt'
      },
      fileContent: 'bye'
    });

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
  });

  it('keeps nested-input fixture on native normalization path', () => {
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/conversion-matrix/2026-05-21-apply-patch-hashline-nested-input/request.json'
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    const args = JSON.parse(fixture.tool_calls[0]!.function.arguments);

    const result = normalizeApplyPatchArgumentsWithNative(args);

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
  });

  it('routes canonical patch plus stray filePath through the single native owner too', () => {
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/conversion-matrix/2026-05-22-apply-patch-canonical-with-stray-filepath/request.json'
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    const args = JSON.parse(fixture.tool_calls[0]!.function.arguments);

    const result = normalizeApplyPatchArgumentsWithNative(args);

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.normalizedArguments)).toMatchObject({
      patch: expect.stringContaining('*** Begin Patch')
    });
    expect(result.repaired).toBe(true);
  });

  it('routes add-file canonical patch plus stray filePath through the single native owner too', () => {
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/conversion-matrix/2026-05-22-apply-patch-addfile-with-stray-filepath/request.json'
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    const args = JSON.parse(fixture.tool_calls[0]!.function.arguments);

    const result = normalizeApplyPatchArgumentsWithNative(args);

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.normalizedArguments)).toMatchObject({
      patch: expect.stringContaining('*** Begin Patch')
    });
    expect(result.repaired).toBe(true);
  });

  it('fails closed when the single native owner returns invalid payload', () => {
    mockNormalizeApplyPatchArgumentsJson.mockImplementationOnce(() => JSON.stringify({ repaired: true }));

    expect(() =>
      normalizeApplyPatchArgumentsWithNative({
        patch: '+ 2 deadbeef\nhello',
        filePath: 'note.txt',
        fileContent: 'hello'
      })
    ).toThrow(/normalizeApplyPatchArgumentsJson/i);

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the single native owner throws', () => {
    mockNormalizeApplyPatchArgumentsJson.mockImplementationOnce(() => {
      throw new Error('normalize-native-boom');
    });

    expect(() =>
      normalizeApplyPatchArgumentsWithNative({
        patch: '= 1 abc123\nworld',
        filePath: 'note.txt',
        fileContent: 'hello'
      })
    ).toThrow(/normalize-native-boom/i);

    expect(mockNormalizeApplyPatchArgumentsJson).toHaveBeenCalledTimes(1);
  });
});
