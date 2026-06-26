import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const converterPath = join(
  repoRoot,
  'src/server/runtime/http-server/executor/provider-response-converter.ts'
);

describe('provider response converter Rust-only projection boundary', () => {
  it('does not keep provider-specific response bridge branches', () => {
    const source = readFileSync(converterPath, 'utf8');

    expect(source).not.toMatch(/providerFamily\s*===\s*['"](?!string['"])[a-z0-9_-]+['"]/i);
    expect(source).not.toMatch(/convert\.bridge\.[a-z0-9_-]+_native_[a-z0-9_-]+_direct/i);
  });

  it('does not rebuild Responses payloads after bridge conversion with TS shape predicates', () => {
    const source = readFileSync(converterPath, 'utf8');

    expect(source).not.toMatch(/function\s+hasChatToolCalls\b/);
    expect(source).not.toMatch(/function\s+hasResponsesFunctionCalls\b/);
    expect(source).not.toContain('hasChatToolCalls(');
    expect(source).not.toContain('hasResponsesFunctionCalls(');
    expect(source).not.toContain('buildResponsesPayloadFromChatWithNative');
    expect(source).not.toMatch(/!\s*hasResponsesFunctionCalls/);
  });

  it('does not read providerProtocol truth from adapterContext ahead of pipeline metadata', () => {
    const source = readFileSync(converterPath, 'utf8');

    expect(source).not.toContain('const adapterContextProviderProtocol =');
    expect(source).not.toContain('readRuntimeControlForProviderResponseConverter(args.adapterContext)');
  });
});
