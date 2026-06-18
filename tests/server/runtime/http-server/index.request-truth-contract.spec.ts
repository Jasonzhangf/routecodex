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

  it('does not write preselected route into flat routecodex payload metadata', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const matches = source.match(/__routecodexPreselectedRoute/g) ?? [];
    expect(matches).toHaveLength(0);
    expect(source).toContain('writeMetadataCenterRuntimeControl(');
    expect(source).toContain("'preselectedRoute'");
  });

  it('does not write retry provider pin into flat routecodex payload metadata', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const matches = source.match(/__routecodexRetryProviderKey/g) ?? [];
    expect(matches).toHaveLength(0);
    expect(source).toContain('writeMetadataCenterRuntimeControl(');
    expect(source).toContain("'retryProviderKey'");
  });

  it('does not write stopMessage control into flat request metadata', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf8');
    const metadataBlock = source.slice(
      source.indexOf('const metadata: Record<string, unknown> = {'),
      source.indexOf('const portSessionDir = this.resolvePortSessionDir', source.indexOf('const metadata: Record<string, unknown> = {'))
    );
    const directMetadataBlock = source.slice(
      source.indexOf('const metadataForHub: Record<string, unknown> = {'),
      source.indexOf('const portSessionDir = this.resolvePortSessionDir', source.indexOf('const metadataForHub: Record<string, unknown> = {'))
    );

    expect(metadataBlock).not.toContain('stopMessageEnabled:');
    expect(metadataBlock).not.toContain('stopMessageExcludeDirect:');
    expect(metadataBlock).not.toContain('routecodexPortStopMessageEnabled:');
    expect(directMetadataBlock).not.toContain('stopMessageEnabled:');
    expect(directMetadataBlock).not.toContain('stopMessageExcludeDirect:');
    expect(source).toContain("'stopMessageEnabled'");
    expect(source).toContain("'stopMessageExcludeDirect'");
    expect(source).toContain('writeMetadataCenterRuntimeControl(');
  });
});
