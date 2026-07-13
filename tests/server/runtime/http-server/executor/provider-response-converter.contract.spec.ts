import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const PROVIDER_RESPONSE_CONVERTER_PATH = path.join(
  ROOT,
  'src/server/runtime/http-server/executor/provider-response-converter.ts'
);

function countMatches(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

describe('provider-response-converter contract', () => {
  it('does not read followup control or post-bridge responses normalization from host converter', () => {
    const source = fs.readFileSync(PROVIDER_RESPONSE_CONVERTER_PATH, 'utf8');

    expect(countMatches(source, '__routecodex')).toBe(0);
    expect(source).not.toContain('options.requestSemantics?.__routecodex');
    expect(source).not.toContain('__routecodex =');
    expect(source).not.toContain('metadata?.__routecodex');
    expect(source).not.toContain('response.metadata');
    expect(source).not.toContain('seed.metadata');
    expect(source).not.toContain('normalizeResponsesToolCallsViaRustSsot');
    expect(source).not.toContain('normalizeResponsesToolCallArgumentsForClientWithNative');
    expect(source).not.toContain('clientToolsRaw: options.entryOriginRequest.tools');
    expect(source).not.toContain('entryOriginRequest: args.entryOriginRequest');
    expect(source).not.toContain('entryOriginRequest: options.entryOriginRequest');
    expect(source).not.toContain('syncAdapterContextRuntimeBackToPipelineMetadata');
    expect(source).not.toContain('provider response stopless runtime pipeline sync');
    expect(source).not.toContain('provider response hub-stage-top debug snapshot sync');
    expect(source).not.toContain('runtimeControl.stopless');
    expect(source).not.toContain('runtimeControl.stopMessageCompareContext');
    expect(source).not.toContain('debugSnapshot.hubStageTop');
    expect(source).toContain('planProviderResponseMetadataSyncEffectNative');
    expect(source).not.toContain('adapterContext?: Record<string, unknown>');
    expect(source).not.toContain('args.metadata ?? args.adapterContext');
    expect(source).not.toContain('adapterContext\n    });');
    expect(source).not.toContain('typeof (adapterContext as Record<string, unknown>).entryEndpoint');
    expect(source).not.toContain('((adapterContext as Record<string, unknown>).entryEndpoint as string)');
    expect(source).not.toContain('restoreDirectChatVisibleContentFromSse');
    expect(source).not.toContain('recoverVisibleAssistantContentFromChatSseText');
    expect(source).not.toContain('isImagePathLike');
    expect(source).not.toContain('containsBroadKillCommand');
    expect(source).not.toContain('importCoreDist');
    expect(source).not.toContain('NativeRespSemanticsModule');
    expect(source).not.toContain('resolveRelayResponsesClientSseStreamForHttp');
    expect(source).not.toContain('reprojectDirectChatToolCallStreamForHttp');
  });
});
