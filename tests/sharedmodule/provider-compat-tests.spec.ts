import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

function loadSamples(samplesPath: string): { requests: any[]; responses: any[] } {
  const requests: any[] = [];
  const responses: any[] = [];

  if (!fs.existsSync(samplesPath)) {
    return { requests, responses };
  }

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name === 'request.json') {
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          requests.push(content);
        } catch (e) {
          console.warn(`Failed to parse ${fullPath}: ${e}`);
        }
      } else if (entry.name === 'response.json') {
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          responses.push(content);
        } catch (e) {
          console.warn(`Failed to parse ${fullPath}: ${e}`);
        }
      }
    }
  }

  walkDir(samplesPath);
  return { requests, responses };
}

function hasApplyPatch(requests: any[]): boolean {
  return requests.some(req => {
    const body = req?.body || req;
    const toolOutputs = body?.tool_outputs;
    if (!Array.isArray(toolOutputs)) {
      return false;
    }
    return toolOutputs.some((t: any) => typeof t?.tool_call_id === 'string' && t.tool_call_id.startsWith('apply_patch'));
  });
}

describe('Provider compat tests', () => {
  it('verifies apply_patch in submit_tool_outputs samples', () => {
    const samplesPath = path.join('samples/mock-provider', 'openai-responses.submit_tool_outputs');
    const allSamples = loadSamples(samplesPath);
    expect(allSamples.requests.length).toBeGreaterThan(0);
    expect(hasApplyPatch(allSamples.requests)).toBe(true);
  });

  it('anthropic-messages samples exist', () => {
    const samplesPath = path.join('samples/mock-provider', 'anthropic-messages');
    expect(fs.existsSync(samplesPath)).toBe(true);
  });

  it('openai-chat samples exist', () => {
    const samplesPath = path.join('samples/mock-provider', 'openai-chat');
    expect(fs.existsSync(samplesPath)).toBe(true);
  });
});
