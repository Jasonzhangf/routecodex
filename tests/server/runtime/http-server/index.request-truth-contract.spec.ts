import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, 'src/server/runtime/http-server/index.ts');

describe('http-server index request truth contract', () => {
  it('usage-log session reader no longer falls back to tmux metadata', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const fnMatch = source.match(
      /function readSessionIdForUsageLog\(metadata: Record<string, unknown>\): string \| undefined \{([\s\S]*?)\n\}/
    );
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch?.[1] ?? '';
    expect(fnBody).toContain('readRuntimeRequestTruthIdentifiers(metadata).sessionId');
    expect(fnBody).not.toContain('clientTmuxSessionId');
    expect(fnBody).not.toContain('tmuxSessionId');
  });

  it('direct responses retention reads conversation truth via the centralized reader', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    expect(source).toContain('conversationId: readConversationIdForUsageLog(inputMetadata)');
  });

  it('keeps the remaining preselected-route flat residue localized to the router-direct relay edge', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const matches = source.match(/__routecodexPreselectedRoute/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(source).toContain('__routecodexPreselectedRoute: directResult.preselectedRoute');
  });

  it('keeps retry provider pin residue localized to metadataForHub request-route control writes', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const matches = source.match(/__routecodexRetryProviderKey/g) ?? [];
    expect(matches).toHaveLength(3);
    expect(source).toContain(
      'metadataForHub.__routecodexRetryProviderKey = retryState.retryProviderKey;'
    );
    expect(source).toContain("delete metadataForHub.__routecodexRetryProviderKey;");
  });
});
