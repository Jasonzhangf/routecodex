import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('provider metadata isolation redlines', () => {
  it('forbids provider runtimes from consuming request body metadata as control input', () => {
    const files = [
      'src/providers/core/runtime/http-transport-provider.ts',
      'src/providers/core/runtime/responses-provider.ts',
      'src/providers/core/runtime/responses-provider-helpers.ts',
      'src/providers/core/runtime/windsurf-chat-provider.ts',
      'src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts',
      'src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-request-exec.ts',
      'src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-remote-image.ts',
      'src/providers/mock/mock-provider-runtime.ts',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs'
    ];
    const forbidden = [
      /bodyMetadata/,
      /rawBody\.metadata/,
      /body\.metadata\.(?!toBeUndefined)/,
      /openaiProviderOptions\.metadata/,
      /providerOptions\.metadata/,
      /next\.metadata\s*=/,
      /payload\.metadata\.context/,
      /value\.get\("metadata"\)[\s\S]{0,120}value\.get\("context"\)/
    ];

    const violations: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
