import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

interface RegistryEntry {
  path: string;
}

interface RegistryIndex {
  samples: RegistryEntry[];
}

const registryPath = path.join(process.cwd(), 'samples', 'mock-provider', '_registry', 'index.json');
const sampleRoot = path.join(process.cwd(), 'samples', 'mock-provider');

function safeReadJson<T = unknown>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function containsToolUsage(node: unknown): boolean {
  if (!node) return false;
  if (Array.isArray(node)) {
    return node.some((entry) => containsToolUsage(entry));
  }
  if (typeof node === 'object') {
    const candidate = node as Record<string, unknown>;
    if (Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0) {
      return true;
    }
    if (Array.isArray(candidate.tools) && candidate.tools.length > 0) {
      return true;
    }
    if (Array.isArray(candidate.tool_outputs) && candidate.tool_outputs.length > 0) {
      return true;
    }
    return Object.values(candidate).some((value) => containsToolUsage(value));
  }
  return false;
}

describe('codex samples tool coverage', () => {
  const registryExists = fs.existsSync(registryPath);

  (registryExists ? it : it.skip)('includes at least one sample exercising tool usage', () => {
    const registry = safeReadJson<RegistryIndex>(registryPath);
    expect(registry).not.toBeNull();
    expect(Array.isArray(registry?.samples)).toBe(true);

    const hasToolCoverage = (registry?.samples ?? []).some((entry) => {
      if (!entry?.path) return false;
      const responsePath = path.join(sampleRoot, entry.path, 'response.json');
      if (!fs.existsSync(responsePath)) return false;
      const responseJson = safeReadJson(responsePath);
      return containsToolUsage(responseJson);
    });

    expect(hasToolCoverage).toBe(true);
  });
});
