import fs from 'fs/promises';
import path from 'path';

type Source = 'codex' | 'claude';

export class SystemPromptLoader {
  private static instance: SystemPromptLoader | null = null;
  private cache: Map<Source, string | null> = new Map();
  private lastScanAt: number = 0;

  public static getInstance(): SystemPromptLoader {
    if (!this.instance) {
      this.instance = new SystemPromptLoader();
    }
    return this.instance;
  }

  public async getPrompt(source: Source): Promise<string | null> {
    // Simple cache with 5s staleness window
    const now = Date.now();
    if (this.cache.has(source) && now - this.lastScanAt < 5000) {
      return this.cache.get(source) ?? null;
    }
    let value: string | null = null;
    try {
      if (source === 'codex') {
        value = await this.findLatestCodexPrompt();
      } else if (source === 'claude') {
        value = await this.findLatestClaudePrompt();
      }
    } catch {
      value = null;
    }
    this.cache.set(source, value);
    this.lastScanAt = now;
    return value;
  }

  private getSamplesDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, '.routecodex', 'codex-samples');
  }

  private async listFiles(): Promise<Array<{ name: string; full: string; mtimeMs: number }>> {
    const dir = this.getSamplesDir();
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: Array<{ name: string; full: string; mtimeMs: number }> = [];
      for (const e of entries) {
        if (!e.isFile()) {continue;}
        const full = path.join(dir, e.name);
        try {
          const st = await fs.stat(full);
          files.push({ name: e.name, full, mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
      // newest first
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return files;
    } catch {
      return [];
    }
  }

  private async readJson(p: string): Promise<unknown | null> {
    try {
      const txt = await fs.readFile(p, 'utf8');
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  private extractSystemFromOpenAIShape(j: unknown): string | null {
    // Accept shapes: { data: { messages: [...] } } or { body: { messages: [...] } } or { messages: [...] }
    const candidates: unknown[] = [];
    if (j && typeof j === 'object') {
      const obj = j as Record<string, unknown>;
      if (obj.data && typeof obj.data === 'object') {candidates.push(obj.data);}
      if (obj.body && typeof obj.body === 'object') {candidates.push(obj.body);}
      candidates.push(j);
    }
    for (const obj of candidates) {
      const msgs = (obj as Record<string, unknown>)?.messages;
      if (Array.isArray(msgs) && msgs.length) {
        for (const m of msgs) {
          const msg = m as Record<string, unknown>;
          if (msg && msg.role === 'system' && typeof msg.content === 'string' && msg.content.trim().length > 0) {
            return msg.content as string;
          }
        }
      }
    }
    return null;
  }

  private extractSystemFromAnthropicShape(j: unknown): string | null {
    // Accept shapes: { data: { system: string } } or { body: { system: string } } or { system: string }
    const candidates: unknown[] = [];
    if (j && typeof j === 'object') {
      const obj = j as Record<string, unknown>;
      if (obj.data && typeof obj.data === 'object') {candidates.push(obj.data);}
      if (obj.body && typeof obj.body === 'object') {candidates.push(obj.body);}
      candidates.push(j);
    }
    for (const obj of candidates) {
      const candidate = obj as Record<string, unknown>;
      if (candidate && typeof candidate.system === 'string' && candidate.system.trim().length > 0) {
        return candidate.system as string;
      }
    }
    return null;
  }

  private async findLatestCodexPrompt(): Promise<string | null> {
    const files = await this.listFiles();
    // First pass: look for a recognizable Codex CLI system prompt
    for (const f of files) {
      if (!/^(pipeline-in-|chat-req_)/.test(f.name)) {continue;}
      const j = await this.readJson(f.full);
      if (!j) {continue;}
      const sys = this.extractSystemFromOpenAIShape(j);
      if (sys && /Codex CLI/i.test(sys)) {
        return sys;
      }
    }
    // Fallback: return the latest system message regardless of content
    for (const f of files) {
      if (!/^(pipeline-in-|chat-req_)/.test(f.name)) {continue;}
      const j = await this.readJson(f.full);
      if (!j) {continue;}
      const sys = this.extractSystemFromOpenAIShape(j);
      if (sys) {return sys;}
    }
    return null;
  }

  private async findLatestClaudePrompt(): Promise<string | null> {
    const files = await this.listFiles();
    // First, look for anthropic canonical captures with system field
    for (const f of files) {
      if (!/^pipeline-in-/.test(f.name)) {continue;}
      const j = await this.readJson(f.full);
      if (!j) {continue;}
      // Ensure it was a /v1/messages request if metadata present
      const obj = j as Record<string, unknown>;
      const metadata = obj.metadata as Record<string, unknown> | undefined;
      const url = metadata?.url as string | undefined;
      if (url && !url.includes('/v1/messages') && !url.includes('/anthropic/messages')) {
        continue;
      }
      const sys = this.extractSystemFromAnthropicShape(j);
      if (sys) {return sys;}
    }
    // Fallback: any recent chat/pipeline-in file that contains a Claude-flavored system string
    for (const f of files) {
      if (!/^(pipeline-in-|chat-req_)/.test(f.name)) {continue;}
      const j = await this.readJson(f.full);
      if (!j) {continue;}
      const sys = this.extractSystemFromOpenAIShape(j);
      if (sys && /claude|anthropic/i.test(sys)) {
        return sys;
      }
    }
    return null;
  }
}

export function shouldReplaceSystemPrompt(): Source | null {
  const sel = (process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE || '').toLowerCase();
  if (sel === 'codex') {return 'codex';}
  if (sel === 'claude') {return 'claude';}
  return null;
}

export function replaceSystemInOpenAIMessages(messages: unknown[], systemText: string): unknown[] {
  if (!Array.isArray(messages)) {return messages;}
  const out = [...messages];
  const idx = out.findIndex((m) => {
    const msg = m as Record<string, unknown>;
    return msg && msg.role === 'system';
  });
  if (idx >= 0) {
    const m = { ...(out[idx] as Record<string, unknown> || {}) } as Record<string, unknown>;
    m.content = systemText;
    out[idx] = m;
  } else {
    out.unshift({ role: 'system', content: systemText });
  }
  return out;
}
