import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockNormalizeApplyPatchArgumentsWithNative = jest.fn();
const mockPrepareRespProcessToolGovernancePayloadWithNative = jest.fn();
const mockApplyRespProcessToolGovernanceWithNative = jest.fn();
const mockRepairArgumentsToString = jest.fn((value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? {})
);
const mockParseLenient = jest.fn(() => ({}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-governance-semantics.js',
  () => ({
    normalizeApplyPatchArgumentsWithNative: mockNormalizeApplyPatchArgumentsWithNative,
    validateApplyPatchArgumentsWithNative: jest.fn(),
    applyRespProcessToolGovernanceWithNative: mockApplyRespProcessToolGovernanceWithNative,
    prepareRespProcessToolGovernancePayloadWithNative: mockPrepareRespProcessToolGovernancePayloadWithNative
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-shared-conversion-semantics.js',
  () => ({
    parseLenientJsonishWithNative: mockParseLenient,
    repairArgumentsToStringWithNative: mockRepairArgumentsToString,
    chunkStringWithNative: jest.fn(() => []),
    flattenByCommaWithNative: jest.fn((value: unknown) => value),
    packShellArgsWithNative: jest.fn((value: unknown) => value),
    repairFindMetaWithNative: jest.fn((value: unknown) => String(value ?? '')),
    splitCommandStringWithNative: jest.fn(() => []),
    cloneRuntimeMetadataWithNative: jest.fn(() => undefined),
    ensureRuntimeMetadataCarrierWithNative: jest.fn((value: unknown) => value),
    readRuntimeMetadataWithNative: jest.fn(() => undefined)
  })
);

const requestModule = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.js'
);
const responseModule = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-response.js'
);

describe('tool governor apply_patch fail-fast', () => {
  beforeEach(() => {
    mockNormalizeApplyPatchArgumentsWithNative.mockReset();
    mockPrepareRespProcessToolGovernancePayloadWithNative.mockReset();
    mockApplyRespProcessToolGovernanceWithNative.mockReset();
    mockRepairArgumentsToString.mockClear();
    mockParseLenient.mockClear();
  });

  it('does not swallow request-side apply_patch native failures', () => {
    mockNormalizeApplyPatchArgumentsWithNative.mockImplementationOnce(() => {
      throw new Error('hashline-request-native-boom');
    });

    const request = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: {
                  patch: '+ 2 deadbeef\nhello',
                  filePath: 'note.txt',
                  fileContent: 'hello'
                }
              }
            }
          ]
        }
      ]
    };

    expect(() => requestModule.normalizeRequestToolCalls(request as any)).toThrow(
      /hashline-request-native-boom/i
    );
  });

  it('does not expose response-side apply_patch TS normalizer helper anymore', () => {
    expect((responseModule as any).normalizeResponseToolCalls).toBeUndefined();
  });

  it('does not swallow response-side apply_patch native failures from chat process response governance', () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: {
                    patch: '+ 2 deadbeef\nhello',
                    filePath: 'note.txt',
                    fileContent: 'hello'
                  }
                }
              }
            ]
          }
        }
      ]
    };

    mockPrepareRespProcessToolGovernancePayloadWithNative.mockImplementationOnce(() => {
      throw new Error('chat-response-native-boom');
    });
    expect(() => responseModule.processChatResponseTools(response as any)).not.toThrow();
  });
});
