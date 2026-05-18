import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'conversion-matrix');

function isToolChoiceRequiringDeclaredTools(toolChoice: unknown): boolean {
  if (typeof toolChoice === 'string') {
    const v = toolChoice.trim().toLowerCase();
    return v === 'auto' || v === 'required';
  }
  if (!toolChoice || typeof toolChoice !== 'object') return false;
  const t = String((toolChoice as any).type || '').trim().toLowerCase();
  return t === 'auto' || t === 'required' || t === 'function';
}

function listFixtureDirs(): string[] {
  if (!fs.existsSync(FIXTURE_ROOT)) return [];
  return fs
    .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURE_ROOT, d.name))
    .sort();
}

function readJsonIfExists(filePath: string): any | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAtPath(source: any, pathExpr: string): any {
  const normalized = String(pathExpr || '').trim();
  if (!normalized) return undefined;
  const parts = normalized.split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as any)[part];
  }
  return current;
}

describe('conversion matrix fixtures contract', () => {
  const fixtureDirs = listFixtureDirs();

  it('has at least one fixture case', () => {
    expect(fixtureDirs.length).toBeGreaterThan(0);
  });

  it.each(fixtureDirs)('request shape contract: %s', (fixtureDir) => {
    const reqPath = path.join(fixtureDir, 'provider-request.json');
    const assertions = readJsonIfExists(path.join(fixtureDir, 'assertions.json')) ?? {};
    const errorsample = readJsonIfExists(path.join(fixtureDir, 'errorsample.json'));

    if (assertions.expected_marker) {
      expect(errorsample?.marker).toBe(assertions.expected_marker);
    }

    if (!fs.existsSync(reqPath)) {
      return;
    }
    const req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as Record<string, any>;
    const body = (req?.body ?? req) as Record<string, any>;
    const choice = body?.tool_choice;
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const assert = assertions?.assert ?? {};

    if (isToolChoiceRequiringDeclaredTools(choice)) {
      expect(tools.length).toBeGreaterThan(0);
    }

    if (Array.isArray(assert.forbid_root_keys)) {
      for (const key of assert.forbid_root_keys) {
        expect(body?.[key]).toBeUndefined();
      }
    }

    if (Array.isArray(assert.forbid_paths)) {
      for (const pathExpr of assert.forbid_paths) {
        expect(readAtPath(req, pathExpr)).toBeUndefined();
      }
    }
  });
});
