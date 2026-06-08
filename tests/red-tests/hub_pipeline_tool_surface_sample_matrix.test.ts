import fs from 'node:fs';
import path from 'node:path';
import { sanitizeProviderOutboundPayloadWithNative } from '../../sharedmodule/llmswitch-core/dist/native/router-hotpath/native-hub-bridge-policy-semantics.js';

type JsonObject = Record<string, any>;

const sampleRoots = [
  path.join(process.env.HOME ?? '', '.rcc/codex-samples/openai-responses/port-5555'),
  path.join(process.env.HOME ?? '', '.rcc/codex-samples/openai-responses/ports/5555'),
].filter(Boolean);

function walkFiles(root: string, out: string[] = []): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && entry.name === 'provider-request.json') out.push(full);
  }
  return out;
}

function readJson(file: string): JsonObject | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

function findNamespacePaths(value: unknown, base = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findNamespacePaths(entry, `${base}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const row = value as JsonObject;
  const here = row.type === 'namespace' ? [base] : [];
  return here.concat(
    Object.entries(row).flatMap(([key, child]) => findNamespacePaths(child, `${base}.${key}`)),
  );
}

function findRecentNamespaceSamples(): string[] {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  return sampleRoots
    .flatMap((root) => walkFiles(root))
    .filter((file) => {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoffMs) return false;
      const json = readJson(file);
      return findNamespacePaths(json?.body).length > 0;
    })
    .sort()
    .slice(-20);
}

function collectFunctionNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .flatMap((tool: any) => {
      if (tool?.type === 'namespace' && Array.isArray(tool.tools)) return collectFunctionNames(tool.tools);
      const name = tool?.function?.name ?? tool?.name;
      return typeof name === 'string' && name.trim() ? [name.trim()] : [];
    })
    .sort();
}

describe('hub pipeline tool surface sample matrix', () => {
  it('normalizes real OpenAI Responses provider requests before provider wire transport', () => {
    const samples = findRecentNamespaceSamples();
    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      const snapshot = readJson(sample);
      const body = snapshot?.body;
      expect(body && typeof body === 'object').toBe(true);

      const beforeNames = collectFunctionNames((body as JsonObject).tools);
      const sanitized = sanitizeProviderOutboundPayloadWithNative({
        protocol: 'openai-responses',
        payload: body as JsonObject,
      }) as JsonObject;
      const afterNames = collectFunctionNames(sanitized.tools);

      expect(findNamespacePaths(sanitized)).toEqual([]);
      expect(afterNames).toEqual(beforeNames);
    }
  });

  it('locks the latest MiniMax namespace failure sample into the matrix when present', () => {
    const latestFailure = sampleRoots
      .flatMap((root) => walkFiles(root))
      .find((file) => file.includes('req_1780576607463_03a61dfa'));
    if (!latestFailure) return;

    const body = readJson(latestFailure)?.body as JsonObject;
    expect(findNamespacePaths(body)).toContain('$.tools[11]');
    const sanitized = sanitizeProviderOutboundPayloadWithNative({
      protocol: 'openai-responses',
      payload: body,
    }) as JsonObject;
    expect(findNamespacePaths(sanitized)).toEqual([]);
    expect((sanitized.tools as any[]).some((tool) => tool?.function?.name === 'close_agent')).toBe(true);
    expect((sanitized.tools as any[]).some((tool) => tool?.function?.name === 'wait_agent')).toBe(true);
  });
});
