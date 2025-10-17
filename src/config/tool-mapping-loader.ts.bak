import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export interface MappingPattern {
  type: 'bracket' | 'invoke_tag' | 'function_block' | 'markup_regex';
  regex?: string;
  json_path?: string;
  fallback_paths?: string[];
  fields?: Record<string, unknown>;
  on_missing?: { fields?: Record<string, unknown> };
}

export interface ToolMapping {
  patterns?: MappingPattern[];
  aliases?: Record<string, string>;
  postprocess?: Array<
    | { ensure_array: { field: string; default_shell?: boolean } }
    | { wrap_object: { field: string } }
  >;
}

export interface ToolMappingsConfig {
  global?: {
    strip_think_blocks?: boolean;
    max_tool_calls?: number;
  };
  tools: Record<string, ToolMapping>;
}

function readIfExists(file: string): unknown | null {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return null;
}

export function loadToolMappings(provider: string): ToolMappingsConfig | null {
  // Priority: user home override -> repo config
  const homePath = path.join(homedir(), '.routecodex', 'config', 'tool-mappings', `${provider}.json`);
  const repoPath = path.join(process.cwd(), 'config', 'tool-mappings', `${provider}.json`);

  const raw = readIfExists(homePath) ?? readIfExists(repoPath);
  if (!raw) { return null; }

  // Basic shape validation with narrowing
  if (typeof raw !== 'object' || raw === null) {
    return { tools: {} };
  }
  const maybe = raw as { tools?: unknown };
  if (!maybe.tools || typeof maybe.tools !== 'object') {
    return { tools: {} };
  }
  return raw as ToolMappingsConfig;
}
